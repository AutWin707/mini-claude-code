# 引言：从一个循环开始，做自己的 Coding Agent

## 本章目标

先搞清楚这个项目要解决什么，再把它跑起来。读完本章应该能回答三个问题：模型和工具分别做什么？一个请求从用户到模型会经过哪些文件？本仓库和原教程有什么区别？

## 从聊天到动手

普通聊天程序接收一句话，把它发给模型，再把答案打印出来。模型可能写出一个修改建议，但它不知道磁盘上文件现在是什么，也不会因为一句“请修改它”就真的拿到文件系统权限。

Coding Agent 多了一个中间环节：**程序向模型声明工具，并在模型请求工具时，由程序执行工具**。模型不能直接操作你的电脑；它返回一个带有工具名和参数的 `tool_use` block，真正的读写动作仍由本地 TypeScript 程序完成。工具结果再作为消息交给模型，模型才能根据实际结果决定下一步。

```text
用户请求
   ↓
Agent 组织 system、messages 和 tools
   ↓
模型返回 text 或 tool_use
   ├─ 需要工具 → 程序执行 → tool_result 加入 messages → 再问模型
   └─ 没有工具 → 本轮结束
```

例如“读一下 `src/agent.ts` 并解释循环”，模型可以请求 `read_file`；程序读取真实文件，把带行号的文本返回；模型再根据工具结果回答。没有后面两步，模型只能猜文件内容。

## 这份实现从哪里来

本项目从 `claude-code-from-scratch/practice` 演进而来，保留教程的主线，但不是原教程全部章节的成品：

| 对照项 | 本项目 |
| --- | --- |
| 语言与运行时 | TypeScript，Node.js 24+ |
| 模型协议 | Anthropic SDK 及兼容其 Messages API 的服务 |
| 模型名 | `ANTHROPIC_MODEL` 必填，不内置默认模型 |
| 终端界面 | React + Ink，外加不启动 TUI 的单次 prompt 模式 |
| 会话 | REPL 用 UUID 命名的 JSONL，事件追加与重放 |
| 上下文 | 截断、空闲微清理、手动和可配置自动压缩；没有完整多层压缩 |
| 工具安全 | 有先读再改、mtime 检查和简化权限审批；没有沙箱 |
| 进阶能力 | 没有原教程的独立记忆、Skill、Plan Mode、多 Agent、MCP、自治系统 |

“兼容 Anthropic Messages API”不等于“支持 OpenAI 格式”。服务地址可以替换，但本项目不会把请求自动转换成另一套 OpenAI 协议。

## 组件之间怎么接

```text
src/run.ts
  ├─ 有 prompt ────────────────> Agent.chat()
  └─ 无 prompt ─> ui.ts ─> ReplController
                                ├─ SessionStore 追加 JSONL
                                └─ Agent.chat()
                                     ├─ prompt.ts 组装 system
                                     ├─ Anthropic SDK 请求模型
                                     ├─ tools.ts 执行工具
                                     └─ usage.ts 统计 token
```

`Agent` 不直接依赖 Ink：它通过 `onOutput` 通知界面，通过 `onEvent` 通知会话存储。单次模式只创建内存 Agent；REPL 则为 Agent 接上 `SessionStore`，因此两种模式的持久化行为不同。

## 技术栈与准备

- Node.js 24+：当前源码入口可以直接运行 `.ts`，构建时再由 TypeScript 编译到 `dist/`。
- `@anthropic-ai/sdk`：消息、工具 block 和流式事件。
- React + Ink：终端交互界面。
- `glob`：文件匹配；`rg`：代码内容搜索，需要单独安装。
- `marked`、`marked-terminal`：终端 Markdown。
- Node 内置测试运行器：自动化测试，不需要真实 API key。

在项目目录准备配置：

```bash
npm install
cp .env.example .env
# 编辑 .env，填入服务提供方的 API key 和模型名
```

```text
ANTHROPIC_API_KEY=你的密钥
ANTHROPIC_MODEL=你的模型名
ANTHROPIC_BASE_URL=兼容 Anthropic Messages API 的服务地址
```

`ANTHROPIC_BASE_URL` 可留空，此时由 SDK 使用默认地址；旧变量 `ANTHROPIC_API_URL` 也受支持，新变量优先。运行环境已经设置的变量优先于 `.env`。不要把真实密钥写进文档或提交到 Git。

## 两种启动方式

```bash
# 单次执行：完成后退出，不创建 REPL JSONL 会话
npm start -- "解释一下 src/agent.ts"

# 交互模式：无 prompt，要求 stdin/stdout 是终端
npm start

# 查看帮助，不需要 API key
npm start -- --help
```

REPL 中直接输入文字即可聊天，也支持 `/chat <内容>`、`/clear` 和 `/compact`。输入框为空时按左箭头打开会话列表；上下键选择，回车切换。运行中按 `Ctrl+C` 请求取消，空闲时按 `Ctrl+C` 退出。详细行为看[第 4 章](04-cli-session.md)。

想让 agent 在另一个项目工作，可以从那个项目的目录调用本仓库的 `run.sh`：脚本定位自己的源码和 `.env`，但不把工作目录切走。工具的相对路径仍以调用时的工作目录为基准。

## 一次最小体验

先准备一个**临时目录**，里面放一个不重要的文本文件，然后启动 REPL，提出类似请求：

```text
请读取 hello.txt，并用一句话说明内容。
```

观察三件事：

1. 界面是否显示 `Read` 工具调用。
2. 工具结果是否包含文件真实内容，而不是模型凭空猜测。
3. 再问一句“刚才那个文件说了什么”，是否复用了同一会话的历史。

模型不一定每次都选相同的工具；这是一项人工观察，不是固定输出测试。也不要让它在不可信目录里试 `run_shell` 或写入工具：**当前项目并不是安全沙箱**。

## 本书的边界

本系列只记录 TypeScript 版。每章以当前源码为准，先解释数据结构，再顺着函数调用走，最后讲限制和复习题。教程中未实现的章节仍保留目录位置，但会明确标成“未实现”。

下一章从最重要的地方开始：[Agent Loop](01-agent-loop.md)。