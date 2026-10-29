# 7. 上下文管理：截断与手动压缩

## 本章目标

弄清消息为什么会越来越长、本项目在哪两处减小上下文，以及 `/compact` 如何在不改写原始会话文件的前提下替换后续请求的活动消息。

主要源码：[src/tools.ts](../src/tools.ts) 的 `truncateResult()`、[src/agent.ts](../src/agent.ts) 的 `compact()`、[src/session.ts](../src/session.ts) 的 `compact` 事件和 `applyEvent()`。

## 消息数组为什么不断增长

一条用户输入可能带来多次模型请求：assistant 提出工具调用，user 消息携带结果，assistant 再继续。每一个内容块都会留在 `state.messages`，下一次聊天又把数组传给模型。

```text
第 1 轮：user → assistant
第 2 轮：user → assistant(tool_use) → user(tool_result) → assistant
第 3 轮：继续追加……
```

读取大型文件或输出大量测试日志时，单个工具结果就可能很大。即使单次结果不大，多轮累计也会让请求变慢、消耗 token，甚至超出服务限制。

当前项目没有自动检测上下文窗口比例、没有自动压缩，也没有教程里的多层 budget/snip/microcompact 流水线。现有控制主要是两项：**单条工具结果截断**和用户手动触发的 **`/compact`**。

## 第一道：截断单个工具结果

`truncateResult()` 对结果的 JavaScript 字符串长度做检查，最多保留 50,000 个字符单位。超长时保留前后各约 24,970 个单位，中间写出被省略的数量。

```typescript
// src/tools.ts，节选
if (result.length <= MAX_RESULT_CHARS) return result;

const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
return result.slice(0, keepEach) +
  `\n\n[... truncated ${result.length - keepEach * 2} chars ...]\n\n` +
  result.slice(-keepEach);
```

头部经常包含错误标题、文件开头；尾部可能包含最终报错或结论。保留两头通常比只保留前面更有信息量，但中间依然会丢失，不能据此断言已经看过完整文件。

这个阈值是字符串长度，不是 token 数，不考虑不同语言的 token 化差异；也没有把完整结果保存到磁盘供模型继续读取。`web_fetch` 还会先在读取响应体时限制 1 MiB，这是另一层不同单位的限制。

## 第二道：手动 `/compact`

在 TUI 输入 `/compact` 后，`ReplController` 调用 `Agent.compact()`。它要求当前有消息并获得独占访问，然后把**整个当前 messages 数组**序列化为 JSON 字符串，作为一条 user 消息交给模型，请求生成摘要。

```text
当前活动 messages
    ↓ JSON.stringify（作为数据，而不是原样重放工具协议）
单独的一次 messages.create() 摘要请求
    ↓
提取 text + 检查结束原因
    ↓
生成一条带 <conversation-summary> 的 user 消息
    ↓
确认序列化长度变短，记录 compact 事件
```

这和教程中“保留最近 N 条、只摘要更老消息”的实现不同：当前代码不保留最近几条原文，而是用一条摘要消息替换整个活动数组。把转录当字符串提供，也避免直接重放一段可能在工具调用中途被截断的消息协议。

## 摘要保留什么

system 指令要求摘要保留用户目标、决定、文件修改、工具结果、未解决的问题和下一步，并要求只返回摘要、不调用工具。得到的文本会放入：

```text
<conversation-summary>
模型生成的摘要
</conversation-summary>
Continue from this summary when the user sends the next message.
```

创建这一条消息时还会经过 `withInstructions()`，如果当前会话有项目指令，就把指令放在摘要前。摘要是有损压缩：它可能遗漏细节或误解先前的结果，不能把它当成可验证的完整历史。

## 什么情况下不提交压缩

`compact()` 在记录压缩事件之前检查：

1. 模型确实返回了非空的 text。
2. `stop_reason` 是 `end_turn`，不是截断或其他结束原因。
3. 新 messages 序列化后的字符串长度小于旧 messages 的序列化长度。

任何一项不满足都会抛错，原活动 messages 保留。第三项比较的是**字符串长度**，不是服务商 tokenizer 的真实 token 数；即使字符更短，也不能精确证明 token 比例。

一次摘要响应的 usage 会在摘要校验前记录到总量；如果模型返回了响应但摘要后来被判为无效，用量仍可能增加。上下文保留和费用是否发生是两件不同的事。

### 看一眼请求和校验的代码

下面是 `compact()` 的核心步骤，省略了完整的 system 提示和摘要包装：

```typescript
// src/agent.ts，节选
const response = await this.client.messages.create({
  model: this.config.model,
  max_tokens: 2048,
  system: "...摘要要求...",
  messages: [{ role: "user", content: JSON.stringify(this.state.messages) }],
});
this.recordUsage(response, "compact");
const summary = response.content
  .filter(block => block.type === "text")
  .map(block => block.text)
  .join("\n")
  .trim();
if (!summary || response.stop_reason !== "end_turn") {
  throw new Error("压缩失败：模型未返回完整摘要，原上下文已保留");
}
```

即使模型响应里混有其他类型的 block，代码也只拼接 `text`。接着构造新的摘要消息，比较 JSON 序列化长度；确认缩短后才调用 `record({ type: "compact", ... })`。对代码顺序来说，模型请求、usage 记录、摘要验证、compact 事件是不同步骤，任何一步都不应被理解成另外一步已经成功。

## 为什么 JSONL 原始历史没有被删除

成功压缩时记录：

```typescript
// src/session.ts 中 SessionEvent 的 compact 分支
// 这里提取为单独类型以便阅读。
type CompactEvent = {
  type: "compact";
  summary: string;
  through: number;
  messages: Anthropic.MessageParam[];
};
```

`through` 使用当前 `messageCount`，`messages` 是压缩后的活动消息。`applyEvent()` 要求 `through` 与当前累计 message 事件数一致，然后替换 `state.messages`，但不会把 `messageCount` 改成新数组的长度。

旧 JSONL 行仍然保留。恢复会话时，从头重放所有消息和事件，遇到 compact 时替换活动数组，随后再应用后续事件。结果是：文件保留原始记录，发送给模型的活动上下文从压缩检查点继续。

这也解释了 `messageCount` 与 `messages.length` 为何不同：前者累计有多少条 message 事件被应用，后者只是当前要发送的消息数量。

## 落盘失败为什么不应该丢上下文

`Agent.record()` 先调用 `onEvent` 写 JSONL，再执行 `applyEvent()`。压缩事件写失败时，不会先把内存 messages 改成摘要。这不是说压缩请求完全没有副作用——模型请求可能已发生，usage 也可能已记录——而是保证活动对话不会因为失败而被悄悄替换。

会话文件中的摘要和旧历史仍可能包含敏感代码或工具输出；保留原始事件也意味着 `/compact` 并不等于隐私删除。

## 清屏、压缩、删除各是什么

| 操作 | 显示区 | 活动上下文 | 原 JSONL |
| --- | --- | --- | --- |
| `/clear` | 清空 | 不变 | 不变 |
| `/compact` 成功 | 添加一条提示 | 替换为摘要消息 | 追加 compact，旧行保留 |
| 外部删除会话文件 | 当前内存不一定立即变化 | 不自动改变 | 文件被外部删除 |

项目目前没有提供专门的会话删除或隐私擦除命令，不要把 `/clear` 当成删除功能。

## Token 统计和上下文长度不是同一指标

`src/usage.ts` 只读取服务商返回的 `input_tokens` 和 `output_tokens`。聊天的一轮可能有多次 API 请求，需要累加；标题和 compact 加入累计用量。只要某次数据缺失，对应累计值会变为 `null`，界面显示“不可用”。

累计输入 token 可能多次计算重复发送的历史；它表示用量，不等于当前上下文窗口占用。当前项目没有完整费用计算、缓存命中统计或自动 token 预算。

## 一次完整的压缩示例

下面数字仅用于理解，不表示项目设定了这些 token 阈值：

```text
压缩前：messageCount = 8，messages.length = 8
模型返回：一段非空摘要，stop_reason = end_turn
长度比较：JSON.stringify(新消息) 比 JSON.stringify(旧消息) 短
记录事件：compact { through: 8, messages: [摘要消息] }
压缩后：messageCount = 8，messages.length = 1
再聊一轮：新的 user / assistant 消息继续追加，messageCount 增长
```

如果重启恢复，重放前八条 message 事件后应用 `compact`；校验 `through === 8` 成功，再把活动数组换成摘要。接下来的消息事件继续追加。原来的八条消息仍在文件中，但不会再次作为活动数组全部发送。

如果把事件中的 `through` 换成不匹配的数，`applyEvent()` 会报 `compact 检查点范围不匹配`。这是一个顺序一致性检查，不是内容完整性或摘要真实性验证。

## 与原教程的区别

| 能力 | 当前项目 |
| --- | --- |
| 单个工具结果限制 | 50,000 字符单位，保留头尾 |
| 大结果落盘再引用 | 没有 |
| Budget / Snip / Microcompact | 没有 |
| 自动阈值与自动 compact | 没有 |
| 手动摘要 | `/compact`，摘要整个活动上下文 |
| 保留原始会话 | 有，JSONL 追加 compact 事件 |
| 前缀缓存断点 | 没有显式配置 |

## 动手复习

```bash
node --test test/truncate-result.test.ts
# session.test.mjs 当前部分 mock 尚未适配流式接口，参见第 14 章
```

思考：为什么摘要请求使用 JSON 字符串而不是截断半组 `tool_use` / `tool_result`？压缩成功为什么不清除旧 JSONL？字符数减少为什么不等于 token 一定按同样比例减少？

完成实现章节后，可以用[测试指南](14-testing.md)复习。