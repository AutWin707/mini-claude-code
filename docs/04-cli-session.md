# 4. CLI 与会话

## 本章目标

给 Agent 一张能聊天的“脸”，并让 REPL 对话可以恢复。读完应该能分清：入口和 TUI 谁负责什么、会话事件怎样写入与重放、`/clear` 和 `/compact` 为什么不是一回事。

主要源码：[src/run.ts](../src/run.ts)、[src/ui.ts](../src/ui.ts)、[src/repl.ts](../src/repl.ts)、[src/session.ts](../src/session.ts)。同目录下 `04-cli-session-plan.md` 是开发前的方案，不等于当前实现。

## 一个入口，两种模式

`src/run.ts` 从参数决定下一步：

```text
--help / -h  → 展示帮助并退出
有 prompt    → 创建 Agent，调用一次 chat()，退出
没有 prompt  → 检查终端和 API key，启动 Ink REPL
```

有 prompt 的单次模式只使用内存 Agent，结束后打印本轮 token；它不通过 `SessionStore` 创建 JSONL。无 prompt 时必须有交互式 stdin/stdout，才进入 TUI。

```bash
npm start -- --help
npm start -- "解释项目结构"
npm start
```

入口默认从项目安装目录加载 `.env`；`MINI_CLAUDE_ENV_FILE` 可以指向其他配置文件。已有的进程环境变量优先。模型名从 `ANTHROPIC_MODEL` 获取；API 地址优先 `ANTHROPIC_BASE_URL`，再考虑旧的 `ANTHROPIC_API_URL`。当前没有教程中的 `--resume`、`--yolo`、`--plan` 等参数；交互模式通过 `/permission` 查看和切换权限模式。

## TUI 不直接负责模型调用

React + Ink 的 `ReplApp` 订阅 `ReplController`：

```text
键盘输入 ─> ReplApp.useInput()
                 ↓
          ReplController.submit()
                 ↓
          Agent.chat() / compact()
                 ↓
    onOutput / onEvent 更新显示与 JSONL
                 ↓
      publish() → useSyncExternalStore → 重新渲染
```

界面维护输入内容、光标位置、会话列表和终端尺寸；控制器维护当前会话、Agent、显示条目、忙碌状态和取消信号。这样测试控制器时不必真的启动 Ink。

`transcript.ts` 把 user、assistant、thinking、tool、result 等条目渲染成终端行。助手正文经过 Markdown 渲染；thinking 在当前界面用灰色斜体展示。`markdown.ts` 和界面中的 `safeText()` 会清理终端控制字符，避免内容直接控制终端。

## 交互操作

| 操作 | 当前行为 |
| --- | --- |
| 普通文本 | 作为用户消息发给当前 Agent |
| `/chat 内容` | 显式发送聊天内容 |
| `/clear` | 只清空当前显示区 |
| `/compact` | 请求模型生成摘要，替换活动上下文 |
| `/maxcontext [token数|off]` | 查看或设置自动压缩上限；达到上限 80% 时触发，默认约 209,715 token，详见 [第 7 章](07-context.md) |
| `/permission [模式]` | 查看或切换权限模式；不发送给模型，详见 [第 6 章](06-permissions.md) |
| 权限确认时 `y` / `n` / `Esc` | 同意 / 拒绝当前操作 |
| 空输入时左箭头 | 打开会话列表 |
| 列表中的上下键、回车、Esc | 选择、切换、返回 |
| 忙碌时 `Ctrl+C` | 请求取消当前聊天的模型调用/重试等待 |
| 空闲时 `Ctrl+C` | 退出 TUI |

输入框非空时，左箭头移动光标，不打开会话列表。忙碌期间控制器拒绝重复聊天、清屏、切换和压缩，避免两个操作同时修改当前状态。

## 新会话从哪里开始

`ReplController` 构造时调用 `store.create(process.cwd(), config, loadProjectInstructions())`，生成 UUID，建立会话头，再创建对应 Agent。默认目录为：

```text
~/.mini-claude/sessions/<UUID>.jsonl
```

项目改名后仍保留原目录，以兼容已有会话，不会自动迁移或删除旧数据。

目录按 `0o700` 创建，文件按 `0o600` 创建。会话头白名单保存模型名、可选 base URL、工作目录、项目指令快照和创建时间，**不保存 API key**。但消息、工具结果和项目指令仍可能包含敏感信息，文件不是加密存储。

## 为什么用 JSONL 事件

JSONL 是一行一个 JSON 对象。本项目第一行是会话头，后面逐行追加事件。下面只是示意，不是完整可重放文件：

```json
{"type":"session","version":1,"id":"<uuid>","cwd":"/project","config":{"model":"<model>"},"instructions":"","createdAt":"<date>"}
{"type":"turn_start"}
{"type":"message","message":{"role":"user","content":"你好"}}
{"type":"usage","purpose":"chat","usage":{"input":10,"output":2}}
{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"你好"}]}}
{"type":"turn_end"}
```

事件类型还包括 `tool_state`、`title`、`microcompact`、`compact`。`applyEvent()` 是唯一的状态应用逻辑：实时执行时调用它，重启读取 JSONL 时也依次调用它。相同事件序列应产生相同的 Agent 状态。

在 REPL 中，Agent 的 `record()` 先交给 `SessionStore.append()`，写成功后再应用到内存。这不是跨进程数据库事务，但比“先改内存、再尝试写盘”更容易保证失败时上下文不被悄悄替换。

## 事件如何重建 `AgentState`

会话文件记录的是“发生了什么”，不是每次都覆盖一份完整状态。`applyEvent()` 根据事件类型更新状态，下面列出最关键的几种：

| 事件 | 应用后的变化 |
| --- | --- |
| `turn_start` | 把最近一轮 token 置为初始值 |
| `message` | 将消息压入数组，累计 `messageCount` 加一 |
| `usage` | 累加总用量；`purpose` 为 `chat` 时还累加本轮用量 |
| `tool_state` | 用事件中的读取文件与激活工具快照更新状态 |
| `title` | 设置会话列表显示的标题 |
| `microcompact` | 校验检查点及位置，清理旧工具结果内容 |
| `compact` | 校验检查点后替换活动 messages |
| `turn_end` | 完成轮次加一 |

这是事件重放最重要的性质：重启时不需要重新运行工具，也不需要再次调用模型。比如 `tool_state` 已经保存读取状态；恢复只应用它，不应该为了重建 Map 再偷偷执行一遍 Shell 或写文件。

这也是事件日志与普通应用日志的区别。普通日志可以只写“发生了某个错误”；会话事件必须包含足以恢复目标状态的数据，同时保持顺序和版本规则。当前实现版本为 `1`，不是通用事件溯源框架。

## 半条记录和损坏的区别

`SessionStore.parse()` 只把最后一个换行符之前的完整行当作已提交数据。如果文件尾部是没有换行的半条记录，读取时忽略；下一次追加之前会截掉这段尾巴。这样进程在写入时异常终止，不必因为最后半行就丢弃整份会话。

但中间出现损坏行、事件不合法或会话头不合法时会报错，不会默默跳过。`list()` 对每个会话分别尝试加载，返回可用会话和错误列表，让一份损坏文件不至于让所有列表都消失。

`append()` 每次重新解析和验证既有文件，简单但随着文件增长会有额外开销；当前也没有跨进程文件锁。

## 会话切换恢复了什么

空输入按左箭头后，控制器列出所有可解析的会话，按创建时间倒序。切换时：

1. 加载目标 JSONL 并重放事件。
2. 检查记录中的工作目录仍然存在且是目录。
3. 用目标会话的模型配置、指令和状态构造新 Agent。
4. 切换当前进程工作目录，再更新控制器与显示条目。

恢复的是对话、工具状态、用量、模型配置及工作目录；**不会回滚磁盘文件内容**。如果目录不存在，切换报错并保留当前会话。

### 为什么要在提交切换前检查目录

假设列表中有一个会话记录着 `/old/project`，但目录已经被删除。若先把控制器当前会话改掉，再执行 `process.chdir()`，一旦切换目录失败，界面可能指向旧会话的状态，却仍在另一个目录运行工具。

当前流程先加载目标、确认目录有效、构造新 Agent，再执行 `chdir` 并提交控制器切换。这样目录不存在时可以报错，保留原会话；也提醒我们工作目录是 Agent 工具行为的一部分，而不只是标题栏上的文本。

进程工作目录是 Node 进程级状态，不是每个 Agent 自动隔离的私有目录；这也是为什么当前控制器在忙碌时禁止切换。

## `/clear`：清屏，不是删历史

`clear()` 只把控制器的 `entries` 设为空，并发布新视图；`onClear` 配合 Ink 清理显示。它不会改变：

- Agent 的 `state.messages`；
- 会话 UUID 和 JSONL；
- 已读取文件、已激活工具；
- 本轮和累计 token。

下一次输入仍会把之前的上下文发给模型。切换离开再回来，界面可以从持久化消息重建；thinking 没存入消息历史，所以不会恢复。

## `/compact`：改变活动上下文，不删原始事件

控制器调用 `Agent.compact()`，用额外的模型请求总结当前消息。成功后追加一个 `compact` 事件，以摘要消息替换内存里的活动 messages；旧 JSONL 行仍在，恢复时按事件顺序重放到这个检查点。

摘要失败、不是 `end_turn` 或没有缩短序列化后的上下文时，不提交 compact 事件。具体算法与限制看[第 7 章](07-context.md)。不要将清屏、压缩和删除历史视为同一个操作。

## 标题与用量

首个成功对话后，`ensureTitle()` 使用模型生成一次短标题。最多尝试四次；都失败则使用包含会话 ID 的兜底名称。生成标题和压缩的 API 用量计入会话总量，不计入最近一次聊天的用量。

界面显示“本轮”和“累计”输入/输出 token。它们来自服务商返回的 usage，不是本地精确的上下文窗口测量；缺少用量时显示“不可用”。

## 展示历史与发送历史是两层数据

控制器中的 `entries` 为人类展示而组织，Agent 的 `state.messages` 则按模型协议保存。两者不必完全相同：

- 一个流式回答可能分很多 `text` 片段到达，界面合并为一条 assistant 条目。
- 工具结果在界面上会转成单行预览，发给模型的是经过限制的结果内容。
- 项目指令在重建展示时会被剥去包装，但仍属于会话消息的一部分。
- 普通 thinking 可以在本次界面出现，因为已从消息过滤，不会从 JSONL 重建。

理解这一点，就不会把“屏幕清空了”误以为“模型忘了之前的对话”。

## 动手复习

1. 在临时目录启动 REPL，聊两轮，记录 UUID。
2. 执行 `/clear`，确认 UUID 和用量没有变化，再继续提问。
3. 空输入按左箭头，切到另一个会话；留意模型和工作目录恢复。
4. 对较长对话尝试 `/compact`，比较活动上下文和原始 JSONL 的区别。
5. 检查 `~/.mini-claude/sessions/` 时注意里面可能有敏感内容。

自动测试入口和目前旧 mock 的限制见[第 14 章](14-testing.md)。下一章看[流式输出](05-streaming.md)。