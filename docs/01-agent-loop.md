# 1. Agent Loop — 核心循环

## 本章目标

把模型的文本、工具请求和本地执行接成一个闭环：用户问一次，程序可能请求模型多次、执行多个工具，直到某次响应不再包含 `tool_use`。

主要代码：[src/agent.ts](../src/agent.ts)、[src/session.ts](../src/session.ts)。工具的具体实现留到[第 2 章](02-tools.md)。

## 先从一次聊天想起

最简单的聊天只有两条动作：把用户消息放进数组，调用一次模型。这样的程序能回答一般问题，却不能知道本地文件内容。即使模型输出“我要读取文件”，如果程序没有把这段话识别成工具调用，它也只是一段文字。

Agent 多出来的不是“更聪明的提示词”，而是协议和循环：请求里提供 `tools`，响应里寻找 `tool_use`，真正执行工具，再按同一个调用 ID 把结果发回模型。

```text
user: 请读取 hello.txt
assistant: tool_use(id=call_1, name=read_file, input=...)
user: tool_result(tool_use_id=call_1, content=文件内容)
assistant: 文件内容是……
```

注意工具结果在协议里属于 `user` 消息中的 `tool_result` block；这里的 `user` 是消息角色，不表示终端用户又手工输入了一次。

## Agent 里保存了什么

`Agent` 构造时建立模型客户端、请求参数和会话状态。为了支持恢复，它允许从 `AgentOptions.state` 接收旧状态，并使用 `structuredClone()` 避免直接修改传入对象。

| 字段 | 作用 |
| --- | --- |
| `config` | 当前模型及可选服务地址 |
| `state.messages` | 下一次模型请求会使用的消息 |
| `state.messageCount` | 累计 message 事件数量，用于压缩检查点，不等于当前数组长度 |
| `readFileState` | 路径 → 读取时的 mtime，给修改保护使用 |
| `activatedTools` | 本 Agent 已激活的延迟工具 |
| `permissionMode` / `permissionRules` | 当前权限模式及创建时读取的规则快照 |
| `confirmedActions` | 当前 Agent 已确认的操作描述，不写入会话 |
| `lastApiCallTime` | 最近一次成功聊天请求的时间，用于空闲微清理；不写入会话 |
| `onEvent` | 可选的持久化回调 |
| `onOutput` | 可选的界面输出回调 |
| `busy` | 防止一个 Agent 同时运行两个互斥操作 |

`snapshot()` 返回克隆后的 `AgentState`。外部拿到快照，即使修改它也不会直接改坏 Agent 内部状态。

## 一条消息如何进入循环

`chat(userMessage, signal)` 先拒绝空白输入，再进入 `exclusive()`。互斥并不是排队锁：如果正在忙，第二个操作会直接报错。

进入后，执行顺序大致如下：

```text
repairInterruptedTools()
record(turn_start)
record(user message)
while true:
    callAnthropicStream()
    record(usage)
    过滤 thinking，record(assistant message)
    找 tool_use
    没有 tool_use → record(turn_end)，返回
    检查权限 → 执行/复用工具或返回拒绝，收集 tool_result
    record(user message containing all results)
```

这是为了复习而省略细节的流程，不是可直接复制的完整实现。源码还要处理权限、取消、提前执行、截断、工具状态、错误和界面输出。权限流程见[第 6 章](06-permissions.md)。

第一次用户消息还可能被 `withInstructions()` 包上一段 `<project-instructions>`。这些指令从当前项目和祖先目录读取，细节见[第 3 章](03-system-prompt.md)。

## 把 `chat()` 按执行顺序展开

下面摘出源码的主干，省略了提前执行、工具状态合并和取消检查。重点看每一条消息什么时候记录：

```typescript
// src/agent.ts：为讲解而省略细节
async chat(userMessage: string, signal?: AbortSignal): Promise<void> {
  if (!userMessage.trim()) throw new Error("聊天内容不能为空");

  return this.exclusive(async () => {
    this.repairInterruptedTools();
    this.record({ type: "turn_start" });
    const content = this.state.messageCount === 0
      ? this.withInstructions(userMessage)
      : userMessage;
    this.record({ type: "message", message: { role: "user", content } });

    while (true) {
      const { response, pending } = await this.callAnthropicStream(signal);
      this.recordUsage(response, "chat");
      response.content = response.content.filter(block => block.type !== "thinking");
      this.record({ type: "message", message: { role: "assistant", content: response.content } });

      const calls = response.content.filter(block => block.type === "tool_use");
      if (!calls.length) {
        this.record({ type: "turn_end" });
        return;
      }

      // 按顺序检查权限并处理 calls；允许时可复用 pending 中已经启动的安全工具。
      // 收集 tool_result 后，再记录为一条 user 消息。
    }
  });
}
```

有几处次序值得留意：先有用户消息，模型才有东西可回答；先记录完整 assistant 响应，才能说明模型究竟请求了哪些工具；先执行工具、收集结果，再把结果一起放进下一条 user 消息。循环回到开头时，`state.messages` 已经包含前面的输入、调用和结果。

### 一轮包含两个工具时

假设模型一次返回两个请求，最终消息可以是这样的结构示意：

```json
{"role":"assistant","content":[
  {"type":"tool_use","id":"call_a","name":"list_files","input":{"pattern":"**/*.ts"}},
  {"type":"tool_use","id":"call_b","name":"read_file","input":{"file_path":"src/run.ts"}}
]}
```

下一条消息不是把两个结果分别伪装成 assistant 文本，而是一条 user 消息中的两个结果：

```json
{"role":"user","content":[
  {"type":"tool_result","tool_use_id":"call_a","content":"src/run.ts"},
  {"type":"tool_result","tool_use_id":"call_b","content":"   1 | ..."}
]}
```

`call_a` 和 `call_b` 不能随意替换。即使工具执行在时间上重叠，程序也按响应里的调用顺序收集结果。结果返回之后还需要再请求模型；工具输出本身不自动成为最终回答。

## 模型请求需要什么

每次调用前，`callAnthropicStream()` 会更新三项：

```typescript
// src/agent.ts，节选
this.createParams.system = buildUserSystemPrompt(getDeferredToolNames(this.activatedTools));
this.createParams.messages = this.state.messages;
this.createParams.tools = getActiveToolDefinitions(this.activatedTools);
```

为什么不只在构造函数里设置一次？因为工具搜索可能激活新工具，消息也在不断追加；下一次调用模型时，工具清单和 system 中的延迟工具说明必须跟着变化。

请求通过 `client.messages.stream()` 发送。`text` 事件用于实时展示，`finalMessage()` 提供完整响应，让后续逻辑处理所有 block。流式显示与最后保存消息是两件事：前者解决“什么时候看到”，后者决定“下一次请求带什么”。

## 工具请求和结果怎样配对

一个 `tool_use` 至少有 `id`、`name` 和 `input`。程序执行对应工具后，构造结果：

```typescript
// 结构示意
const result: Anthropic.ToolResultBlockParam = {
  type: "tool_result",
  tool_use_id: call.id,
  content: truncateResult(toolOutput),
  ...(toolOutput.startsWith("Error") ? { is_error: true } : {}),
};
```

`tool_use_id` 是配对关键。多个工具请求可以出现在同一条 assistant 消息里，程序按顺序收集结果，然后把它们一起放入下一条 user 消息，再次请求模型。结果文本超长时先截断，避免把一份巨大输出原样塞回上下文。

工具执行抛异常时，`runTool()` 会把异常转为 `Error: ...` 字符串；现有工具也经常自行返回以 `Error` 开头的错误。Agent 以这个前缀设置 `is_error`。这是简单约定，不是类型安全的结构化错误协议：正常内容恰好以 `Error` 开头，也可能被误判。

## 什么情况下结束

当前 `chat()` 检查的是：完整响应的 `content` 是否还有 `tool_use`。如果没有，它记录 `turn_end` 并返回；如果有，就执行工具并继续循环。

这个判断比“检查 `stop_reason` 是否为 `end_turn`”简单，但也意味着：普通聊天循环**没有专门验证**无工具响应是否因为 `max_tokens` 截断。不要把“循环返回”自动理解为模型一定给出了完整答案。`compact()` 和标题生成对 `end_turn` 有另外的检查，见[第 7 章](07-context.md)。

## 事件与状态：先记录，再应用

`record()` 把每一步表示为 `SessionEvent`：

```typescript
private record(event: SessionEvent): void {
  this.onEvent?.(structuredClone(event));
  applyEvent(this.state, event);
}
```

如果接了 `SessionStore`，`onEvent` 会先把事件写入 JSONL；写入成功才把事件应用到当前内存状态。尤其是 `compact`，落盘失败不能先替换内存上下文，否则重启后会出现两份不同的历史。

单次 prompt 模式没有设置持久化回调，事件只更新内存；TUI 模式通过 `ReplController.makeAgent()` 把事件接到当前会话文件。

## 一个请求里发生错误会留下什么

假设 `turn_start` 和用户消息已经记录，接下来模型请求失败：用户消息仍存在于当前状态与已接入的 JSONL，`turn_end` 不会被记录。本轮是否显示错误由调用方处理；TUI 将错误文本放入显示区，单次模式在入口捕获并输出。

再看另一种情况：完整的 assistant 工具调用已经记录，但执行或落盘过程中断。这时历史里可能存在没有结果的 `tool_use`。如果直接追加下一条普通 user 消息，某些 API 会因工具配对不完整而拒绝请求；如果直接重放工具，写文件或运行命令可能发生第二次副作用。恢复逻辑选择补充错误结果，让模型先重新检查实际情况。

注意这不是原子事务：进程退出或磁盘报错可能发生在任意一步，程序不能从 JSONL 单独证明文件系统是否已改变。`repairInterruptedTools()` 只检查最后一条 assistant 消息，覆盖范围有限。

## 中断在工具调用中间怎么办

工具可能已经执行，但进程在结果写入前退出。恢复时，`repairInterruptedTools()` 检查最后一条消息：如果它是带 `tool_use` 的 assistant 消息，就为这些调用补一个 `is_error: true` 的结果，提示“工具可能已执行，先检查实际状态”。

这个处理的目的不是证明工具执行过或没执行过，而是**避免为了补齐协议而自动重放可能有副作用的操作**。它目前只覆盖最后一条消息是未配对 assistant 工具调用的情况，不是完整的事务恢复系统。

## 用量与取消

一次用户输入可能触发多次模型请求。每个模型响应都会按用途记录 usage；聊天请求累加到本轮与总量，压缩和标题请求只计入总量。服务没有返回数字时用 `null` 表示未知，不把未知当成零。

`AbortSignal` 会传到模型流和重试等待；TUI 忙时按 `Ctrl+C` 调用 `cancel()`。提前启动的只读工具也会收到取消信号，但并不是所有同步写操作或 Shell 命令都能在任意时刻被安全中断。

## 设计取舍与复习

| 问题 | 当前做法 | 边界 |
| --- | --- | --- |
| 模型决定做什么 | 返回工具名和参数 | 程序仍需验证和执行 |
| 多轮状态放哪 | `AgentState.messages` | 上下文会持续增长 |
| 多个工具何时运行 | 安全工具可在流中提前启动，其余按顺序处理 | 不是任意工具都能并发 |
| 如何避免重复执行中断工具 | 恢复时补错误结果 | 无法判断外部副作用是否发生 |
| 如何禁止并发修改会话 | `exclusive()` 的 busy 标志 | 不提供等待队列 |

复习时试着回答：

1. `tool_use.id` 和 `tool_result.tool_use_id` 不一致会怎样？
2. 为什么先记录 assistant 的工具请求，再记录结果？
3. `messageCount` 为什么不能简单地用 `messages.length` 替代？
4. 为什么“没有 `tool_use`”不等于一定没有被输出上限截断？

下一章拆开看[工具系统](02-tools.md)。