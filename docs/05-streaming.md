# 5. 流式输出、Thinking 与提前执行

## 本章目标

回答三个问题：模型的文字怎样边生成边展示？thinking 为什么能显示但不进入普通历史？为什么某些工具还没等整条响应结束就已经开始执行？

主要源码：[src/agent.ts](../src/agent.ts)、[src/repl.ts](../src/repl.ts)、[src/transcript.ts](../src/transcript.ts)。本项目只有 **Anthropic Messages API 兼容路径**，没有原教程中的 OpenAI 兼容双后端。

## 一次性返回和流式返回

非流式请求要等整条消息生成完成才处理结果。流式请求把响应拆成事件：文字来了就展示，最后再等 SDK 把事件汇总成完整消息。

```typescript
// src/agent.ts，核心思路
const stream = this.client.messages.stream(this.createParams, { signal });
stream.on("text", text => this.output({ type: "text", text }));
const response = await stream.finalMessage();
```

`text` 是增量，不一定是完整句子；`finalMessage()` 返回完整内容，供 Agent 找 `tool_use`、保存 assistant 消息以及统计 usage。不能把每个文字增量都当成一条独立的 assistant 消息放进历史。

标题和 `/compact` 走 `client.messages.create()` 非流式请求；主要聊天使用 `stream()`。

## 数据怎样从 SDK 走到屏幕

```text
SDK text / thinking 事件
    ↓
AgentOutput { type, text }
    ↓
ReplController.note() 合并相邻同类型片段
    ↓
TranscriptEntry[]
    ↓
renderTranscript() → Ink Text
```

连续 `text` 片段拼成 assistant 条目；连续 `thinking` 片段拼成 thinking 条目。类型发生变化时产生新条目，避免把思考文字和最终回答混在一起。界面能显示更新，但显示条目本身不等于下一次 API 请求的 `messages`。

## Thinking 参数从哪来

构造 Agent 时，`resolveThinkingMode()` 的规则是：

1. 显式传 `AgentOptions.thinking: true` → `enabled`。
2. 否则模型名以 `MiniMax-M3.1` 开头 → 内部标记为 `adaptive`。
3. 其他模型 → `disabled`。

这只是当前程序的规则，不是对所有模型能力的自动发现。当前 TUI 没有 thinking 模式或深度选择菜单；程序使用者可以通过 `new Agent({ thinking: true })` 显式启用。

| 内部模式 | `max_tokens` | 请求中的 `thinking` |
| --- | --- | --- |
| disabled | 4096 | 不设置 |
| enabled | 4096 | `{ type: "enabled", budget_tokens: 4095 }` |
| adaptive | 10001 | `{ type: "enabled", budget_tokens: 10000 }` |

这里名字叫 `adaptive`，发给服务的仍是 `type: "enabled"` 加固定预算，**不是**原生 `type: "adaptive"` 请求。预算被设到非常接近输出上限，最坏情况下留给正文和工具调用的空间很小；不同模型对参数及上限的支持也可能不同。

## Thinking 如何显示和过滤

Agent 监听 `thinking` 增量并发送 `AgentOutput`。如果 block 完成时没有收到增量，`contentBlock` 处理会尝试显示完整的 `block.thinking`；如果连 block 事件也没有收到，则在最终响应里兜底。已有增量不会再把同一个完整 block 重复显示。

TUI 的 thinking 经过 Markdown 文本转换，再去掉内部 ANSI 重置序列，统一套用灰色和斜体。若服务只在最终消息提供 thinking，兜底显示可能晚于已经流式输出的正文。

在 `chat()` 写 assistant 历史之前，当前代码执行：

```typescript
response.content = response.content.filter(block => block.type !== "thinking");
```

因此普通 thinking 文本不会作为消息写入会话 JSONL，也不会在切换会话后重建显示。注意过滤条件只针对 `thinking`，**没有过滤** `redacted_thinking`。另外，部分 API 在工具循环中要求保留并回传签名后的 thinking block；当前过滤策略可能与这些服务的协议不兼容，需要在接入时验证。

## 为什么要在流里启动工具

假设模型先完成一个读取工具的 block，接下来还要生成另一段内容。若程序等完整响应后才启动读取，等待时间是：

```text
模型剩余生成时间 + 工具运行时间
```

如果该工具只读、且不会依赖前面的写操作，就可以在 block 完成时启动，让部分工具时间与模型后续生成重叠：

```text
模型继续生成 ───────────────────┐
工具开始读取 ───────────┐        │
                        └─ 等待两者完成后复用结果
```

这是时间重叠，不代表程序在收到工具开始事件时就执行：当前使用 SDK 的 `contentBlock` 事件，等对应 block 完整接收后才读完整的名称、ID 和参数。

## 哪些工具允许提前启动

当前白名单：`read_file`、`list_files`、`grep_search`、`web_fetch`。其他工具，包括 `write_file`、`edit_file`、`run_shell` 和 `tool_search`，不在流中提前执行。

即使工具在白名单中，也必须先通过权限检查；被拒绝或需要确认的调用不会提前执行，并阻止后续调用提前执行。前面如果已经出现了非白名单工具，也不会提前启动后面的读取。原因是模型可能先要求写文件、再读同一个文件：如果读提前跑，就会看到写入前的旧状态。完整响应后仍按原顺序处理结果。

`read_file` 和 `grep_search` 的主要 I/O 使用异步接口，避免在模型流窗口里同步阻塞事件循环；`run_shell` 仍使用同步执行，但不会被提前启动。

### block 到达时到底做了什么

SDK 通知 `contentBlock` 时，回调先区分工具和 thinking。如果是工具调用，代码检查白名单、权限、取消信号和该 ID 是否已在 `pending` 中：

```typescript
// src/agent.ts，节选
if (block.type === "tool_use") {
  if (!concurrentTools.has(block.name)) canStartEarly = false;
  else if (checkPermission(block.name, block.input, this.permissionRules, this.permissionMode).action !== "allow") {
    canStartEarly = false;
  } else if (canStartEarly && !toolSignal.aborted && !pending.has(block.id)) {
    const readFiles = new Map<string, number>();
    pending.set(block.id, {
      name: block.name,
      input: JSON.stringify(block.input),
      readFiles,
      result: this.runTool(block, readFiles, toolSignal),
    });
  }
  return;
}
```

这里没有 `await`：`runTool()` 返回 Promise 后回调就能返回，流继续处理下一个事件。Map 里保存的是执行任务，不是已经保证成功的字符串。`pending.has(block.id)` 防止同一个完成事件重复通知时再次启动；完整响应处理阶段还会对工具名和参数进行匹配。

如果此时 block 是 `write_file`，回调只把 `canStartEarly` 设为 `false`。之后就算收到 `read_file`，也不启动，因为它可能依赖前面的写入。这个屏障保守地作用于该次流的所有后续工具，而不是尝试推断具体路径是否冲突。

## 如何避免同一个调用执行两次

Agent 用 tool ID 保存 `pending`：名称、参数的序列化结果、执行 Promise 和临时读取状态。完整响应到达后，按响应顺序处理每个 `tool_use`：

1. 若 ID、工具名、参数与提前启动的记录匹配，等待并复用 Promise。
2. 若没有匹配记录，则按原流程调用工具。
3. 一旦前面有非并发安全工具，后面的调用不复用提前结果。
4. 依次构造 `tool_result`，统一加入下一条 user 消息。

结果在完整响应确认后才进入消息和会话；界面的工具调用与结果也在后续处理阶段显示，不能把“提前执行”误以为“工具结果已提前提交给模型”。

## 为什么 read_file 有额外合并步骤

`read_file` 不只返回文本，还会更新路径对应的 mtime。提前执行时它拿到的是临时 `Map`，而不是正式 `readFileState`：如果流失败或被取消，不能把尚未确认的读取写进当前会话状态。

完整响应确认调用后，Agent 才把这个路径的临时 mtime 合并到正式 Map；临时状态中没有该路径则删除旧记录。这样后续 `edit_file` 能识别已经读取过的版本。`list_files`、`grep_search`、`web_fetch` 不改这个读取 Map，因此没有相同的合并步骤。

## 取消和失败重试

流式调用接收聊天的 `AbortSignal`。提前工具使用组合信号：用户取消或该次流请求失败时，相关异步工作会收到取消；提前读取状态保持隔离。已经产生的外部请求不是事务，取消不保证远端完全没有观察到请求。

SDK 客户端设置 `maxRetries: 0`，避免 SDK 自动重试和 Agent 的 `withRetry()` 次数叠加。Agent 对 429、500、502、503、504，外层 `ETIMEDOUT` / `ECONNRESET`，以及包含 `timed out` 的错误做最多 3 次重试；延迟采用指数退避加随机抖动，等待期间也可取消。

一个值得复习的限制：SDK 的 `APIConnectionError` 常把实际网络错误放在 `cause` 或更深的 `cause`，外层消息可能只是 `Connection error.`。当前 `isRetryable()` 不遍历嵌套原因，也不直接判断该 SDK 错误类型，所以这类连接错误**可能不重试**。TUI 的 `showError()` 只显示外层 `message`，具体网络原因可能被隐藏。

### 重试的次数与间隔

`withRetry(action, 3, signal)` 的循环从 `attempt = 0` 开始，所以最多是**第一次请求 + 三次重试**。默认 `baseDelay` 为 1000 毫秒，再叠加不到 1000 毫秒的随机抖动：

| 已失败的尝试 | 下一次等待 |
| --- | --- |
| 第一次请求 | 约 1—2 秒 |
| 第一次重试 | 约 2—3 秒 |
| 第二次重试 | 约 4—5 秒 |
| 第三次重试 | 不再等待，抛出错误 |

是否进入这张表仍由 `isRetryable()` 决定；不是所有异常都重试。`signal.aborted` 时也直接抛出，避免用户取消后仍在后台等待。流请求失败时会先取消该次提前启动的工具，然后外层重试逻辑才可能重新发起模型调用。

## 和原教程的差异

| 特性 | 本项目 |
| --- | --- |
| Anthropic 流式文字 | 有 |
| thinking 显示 | TUI 灰色斜体；普通 thinking 不存历史 |
| OpenAI 兼容后端 | 没有 |
| 四种安全工具提前启动 | 有，前面出现非安全工具后设置顺序屏障 |
| 完整响应后的通用并行批处理 | 没有；未提前启动的工具按顺序执行 |
| SDK + Agent 双重自动重试 | SDK 自动重试关闭，Agent 自己判断 |
| 可选择的 thinking 深度菜单 | 没有 |

## 动手复习

```bash
node --test test/stream-tools.test.mjs test/thinking-ui.test.mjs test/thinking.test.mjs
```

想一想：如果 `write_file` 在前、`read_file` 在后，为何不能提前读？如果在读取后流请求失败，为什么不能把临时 mtime 合并到正式状态？`Connection error.` 的真实原因为什么可能看不到？

接下来讨论已实现的[上下文截断和手动压缩](07-context.md)。