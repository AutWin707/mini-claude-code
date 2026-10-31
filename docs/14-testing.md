# 14. 功能测试指南

## 本章目标

把前面学过的功能逐项验证：工具能不能正确返回结果？修改前保护有没有生效？会话能不能恢复？流式 thinking 和工具提前执行有没有走到预期分支？

本章只列当前项目已有的功能和测试，不使用教程中未实现的 `/plan`、Skill、MCP、多 Agent 或自治命令。自动化测试使用 mock 或临时目录；真实模型手动测试则需要密钥、网络，且可能产生费用。

## 先准备一个安全环境

当前 Agent 能真实执行 Shell 和修改文件。**不要在生产仓库、包含敏感文件的目录里做写入实验**。建议准备一个临时目录，里面只放练习文件：

```bash
mkdir -p /tmp/coding-agent-lab-demo
cd /tmp/coding-agent-lab-demo
printf 'hello agent\n' > greeting.txt
```

接下来通过本项目 `run.sh` 的**绝对路径**运行交互界面，这样 `process.cwd()` 是临时目录；配置仍从本项目加载。请将命令中的占位路径替换成本机实际路径：

```bash
/path/to/coding-agent-lab/run.sh
```

确保模型服务兼容 Anthropic Messages API、`ANTHROPIC_MODEL` 和 API key 已配置；不要把真实密钥贴到终端截图、会话示例或测试报告里。需要验证 grep 时还要安装 `rg`。

## 自动化测试入口

在项目目录执行：

```bash
npm run typecheck  # TypeScript 类型检查
npm run build      # 编译到 dist/
npm test           # Node 测试运行器
npm run check      # 上述三个步骤顺序执行
```

测试文件按职责组织：

| 文件 | 重点 |
| --- | --- |
| `test/prompt.test.ts` | 指令发现、`@` 引用、换行和动态提示 |
| `test/tool-state.test.ts` | 读后修改、mtime、防重复覆盖、延迟工具 |
| `test/list-files.test.ts` | glob 匹配、忽略规则与上限 |
| `test/grep.test.ts` | ripgrep 参数、过滤、数量上限、缺少可执行文件 |
| `test/web-fetch.test.ts` | URL、内容类型、解码、响应截断、超时 |
| `test/truncate-result.test.ts` | 工具结果截断边界 |
| `test/microcompact.test.mjs` | 空闲阈值、旧结果清理、会话重放和失败保护 |
| `test/autocompact.test.mjs` | 自动压缩阈值、轮次边界、失败保护和 `/maxcontext` |
| `test/transcript.test.ts` | Markdown、终端控制字符、显示条目 |
| `test/thinking.test.mjs`、`test/thinking-ui.test.mjs` | thinking 参数、流式展示、历史过滤 |
| `test/stream-tools.test.mjs` | 提前执行、去重、顺序屏障、取消、SDK SSE |
| `test/permissions.test.mjs` | 规则和模式、会话确认、提前执行拦截、Ink、非交互模式 |
| `test/agent.test.mjs`、`test/session.test.mjs` | Agent 与会话场景：多轮状态、压缩、标题、切换、忙碌锁、中断修复 |
| `test/run.test.mjs` | CLI 子进程及模拟 SSE API |
| `test/memory-save.test.mjs`、`test/memory-prefetch.test.mjs` | 记忆保存、索引、项目隔离与异步召回 |
| `test/cache-usage.test.mjs` | 缓存 token 计入用量与上下文锚点 |
| `test/skills.test.ts` | 技能发现、覆盖、模板替换、`/命令` 与 `skill` 工具 |

### 共用测试工具

`test/helpers.mjs` 不是测试文件（不匹配 `*.test.*`），提供各测试共用的工具：

| 工具 | 作用 |
| --- | --- |
| `mockClient(replies)` | 假模型客户端。`stream()` 和 `create()` **共用一个回复队列**，按真实调用顺序消费；回复可以是消息、`Error`，或 `({ params, options, emit }) => 消息` 的函数，用来精确控制流式事件和时序。`requests` / `streams` / `creates` 记录收到的请求 |
| `message()`、`text()`、`toolUse()` | 构造模型回复；含 `tool_use` 时 `stop_reason` 自动为 `tool_use`，`usage: null` 模拟服务不返回用量 |
| `makeAgent(client, options)` | 不读取真实权限配置的 Agent |
| `useTempDir(t)` | 临时目录，同时把 cwd 和 **HOME** 指向它，测试结束恢复 |
| `mockApiServer(t, respond)` | 本地假 API 服务，流式请求返回 SSE，供子进程测试使用 |

共用一个队列的好处是：REPL 一轮聊天后会再发一次 `create()` 生成标题，测试按"流式回答 → 标题"的顺序写回复即可，不用分别维护两个队列。隔离 HOME 是因为记忆、技能和会话都存放在 `~/.mini-claude` 下，不隔离就会读写真实目录。

## 分组跑已有测试

### 1. 文件保护与搜索

```bash
node --test test/tool-state.test.ts test/grep.test.ts test/list-files.test.ts
```

重点看：已有文件未读不能覆盖；外部修改后旧 mtime 不再有效；grep pattern 不经过 Shell；列表和搜索结果有数量上限。没有 `rg` 的环境会影响需要 ripgrep 的场景。

### 2. 网页和长结果

```bash
node --test test/web-fetch.test.ts test/truncate-result.test.ts
```

测试模拟 `fetch`，覆盖 URL 检查、HTTP 错误、内容类型、UTF-8 跨 chunk 解码、响应体上限和结果截断。它不证明 `web_fetch` 有完整 SSRF 防护，也不需要访问真实网页。

### 3. Prompt 和终端显示

```bash
node --test test/prompt.test.ts test/transcript.test.ts
```

确认项目指令按预期读取、重复引用被去重，终端控制字符被清理，thinking 行使用灰色斜体。字体是否能真正显示斜体仍取决于终端。

### 4. 流式和提前执行

```bash
node --test test/stream-tools.test.mjs test/thinking-ui.test.mjs test/thinking.test.mjs
```

流式工具测试检查四种安全工具在完整响应结束前启动、重复事件不触发重复执行、写操作形成顺序屏障、取消/重试时临时读取状态不被提交；还启动本地模拟服务，用真正的 Anthropic SDK 验证 `content_block_stop`。

thinking 测试覆盖增量、完整 block、最终响应兜底，以及显示内容不写入普通会话历史。测试不代表所有兼容服务都支持相同 thinking 协议。

### 5. 权限规则与确认

```bash
node --test test/permissions.test.mjs test/stream-tools.test.mjs
```

覆盖 deny 优先、模式切换、会话内确认、流式提前读取拦截、Ink 确认与取消、切换项目时重新加载规则，以及单次 prompt 在非交互环境下拒绝需要确认的操作。权限规则和模式的具体边界见[第 6 章](06-permissions.md)。

### 6. 空闲后的工具结果清理

```bash
node --test test/microcompact.test.mjs
```

测试覆盖 5 分钟触发边界、最近 3 个结果保留、工具 ID 不变、JSONL 重放和落盘失败保护。清理规则见[第 7 章](07-context.md)。

### 7. 自动压缩

```bash
node --test test/autocompact.test.mjs
```

测试覆盖 usage 锚点和缓存 token、估算触发、用户输入保留、工具配对边界、失败与取消保护，以及 `/maxcontext` 校验和会话切换。

## 如何读一个流式工具测试

以 `test/stream-tools.test.mjs` 为例，测试不是“等聊天结束后发现文件被读取”，而是在模拟模型流尚未结束时观察执行：

```text
模拟流发出完整 tool_use block
    ↓
测试暂时不放行 finalMessage()
    ↓
确认 read_file / list_files / grep_search / web_fetch 已启动
    ↓
确认正式 readFiles 尚未提交
    ↓
放行模型响应，检查结果只被使用一次并按 ID 配对
```

这样才能区分“确实提前执行”和“最终还是执行了”。另一个场景把 `write_file` 放在 `read_file` 前面：流结束之前不应执行写入或提前读取；响应结束后先写，再读到新内容。

SDK SSE 测试使用本机 HTTP 服务发送 `message_start`、`content_block_start`、`content_block_delta` 和 `content_block_stop`，暂时不发送 `message_stop`。这可以验证真正的 SDK 事件路径，不依赖线上模型，也不会消耗 API token。

## 手动场景：只读文件

在前面准备的临时目录中启动 TUI，发送：

```text
读取 greeting.txt，并告诉我它的内容。
```

观察模型是否调用 `read_file`、结果是否带行号、最终回答是否基于真实内容。模型的文字和工具选择具有不确定性，不能要求每次逐字相同。

## 手动场景：读取后再编辑

确认目录里只有可丢弃的练习文件，然后提出：

```text
先读 greeting.txt，再把其中的 hello 改成 hi，不要修改其他文件。
```

退出后在终端检查文件。预期工具链是先读再编辑；如果直接编辑一个已有但没有被当前 Agent 读取的文件，工具应返回先读取的错误。想验证 mtime 保护，可以在读取后由外部程序修改文件，再观察原会话尝试编辑时是否要求重读。

这种保护不是权限确认机制；练习文件和工作目录仍应可安全丢弃。

## 手动场景：列文件与搜索

在临时目录再准备一个练习文件，例如在终端运行：

```bash
printf 'first line\nTODO: check this\n' > notes.txt
```

然后给 Agent 一个只读请求：

```text
列出当前目录的 txt 文件，搜索其中的 TODO，并告诉我匹配行。
```

可能出现 `Glob` 和 `Grep` 工具标记。检查结果是否来自当前临时目录、是否包含匹配的文件名和行号。如果没有安装 `rg`，工具应返回安装提示，而不是执行一个名称相似的 Shell 命令。

模型可能选择先列文件、再搜索，也可能选择其他合理步骤。手动场景验证的是工具和模型的配合，不是严格约束模型每次必须生成同一顺序。

## 手动场景：会话和清屏

1. 在同一个 TUI 中发送两条相关消息，观察模型是否能引用上一轮。
2. 记录标题栏中的会话 ID，再执行 `/clear`。
3. 确认显示区被清空，但会话 ID、token 和后续对话上下文没有因此重置。
4. 空输入时按左箭头，选择另一个会话；切回原会话后检查上下文、工作目录和模型配置。

JSONL 默认在 `~/.mini-claude/sessions/`。它可能包含聊天、文件内容与项目指令，查看或分享之前要自行检查隐私。

## 手动场景：压缩

先在一个有足够历史的会话中执行 `/compact`。若模型返回完整且更短的摘要，界面会提示压缩成功；下一次聊天基于摘要继续。若摘要为空、未完整结束、没有缩短或请求出错，原活动上下文应该保留。

原始 JSONL 并不会因为 compact 被清除；它会追加一个压缩事件。关于 usage 即使在压缩校验失败时也可能增加的细节，见[第 7 章](07-context.md)。

## 手动场景：thinking 与网络错误

仅当当前模型配置会启用 thinking 且服务返回相应 block 时，TUI 才会展示灰色斜体思考文本。它不进入普通 thinking 历史，切换会话后不会恢复。其他模型默认未启用，不应把“没有看到 thinking”直接当作界面 bug。

遇到 `Connection error.` 时，它可能来自 SDK 包装的网络异常；当前 TUI 只显示外层 `error.message`，底层原因可能位于 `error.cause`。服务地址、网络、代理和 TLS 都需要分别检查；认证错误通常会表现为带 HTTP 状态的响应。切勿为了排查而公开 API key。

## 复习清单

- [ ] 能解释 `tool_use` 和 `tool_result` 的 ID 如何配对。
- [ ] 能区分先读再改与真正的权限审批。
- [ ] 能解释为什么 `/clear` 不会删除历史，`/compact` 不会删除 JSONL。
- [ ] 能解释安全工具为何可以提前开始、写操作为何要等。
- [ ] 能区分运行真实模型与 mock 测试，知道现有全量测试的流式 mock 限制。

完成后可以回到[目录](README.md)按问题查阅对应章节。