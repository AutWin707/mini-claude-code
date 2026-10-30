# Coding Agent Lab 复习目录

这是一份围绕本仓库 **TypeScript 实现**写的学习笔记。目录编号参考 [Claude Code from Scratch](https://github.com/Windy3f3f3f3f/claude-code-from-scratch) 的中文教程，内容重新按当前 `src/` 的代码解释：哪些已经跑通、请求和状态怎么流转、为什么这么设计、哪些地方还只是下一步。

> 阅读原则：**代码是事实来源，教程是对照材料**。本项目不是原教程最终版的逐行移植；同名功能的实现和使用方式可能不同。代码片段会标明是源码摘录还是为了讲思路而省略细节的示意。

## 从哪里开始

| 章 | 主题 | 本项目状态 | 主要源码 |
| --- | --- | --- | --- |
| [00](00-introduction.md) | 引言：项目与运行方式 | 已实现 | `src/run.ts` |
| [01](01-agent-loop.md) | Agent Loop | 已实现 | `src/agent.ts` |
| [02](02-tools.md) | 工具系统 | 已实现 | `src/tools.ts` |
| [03](03-system-prompt.md) | System Prompt 与项目指令 | 已实现 | `src/prompt.ts` |
| [04](04-cli-session.md) | CLI、TUI 与会话 | 已实现 | `src/run.ts`、`src/repl.ts`、`src/session.ts`、`src/ui.ts` |
| [05](05-streaming.md) | 流式输出、thinking 与提前执行 | 已实现一套 Anthropic 兼容接口 | `src/agent.ts`、`src/transcript.ts` |
| [06](06-permissions.md) | 权限规则、危险检测与确认 | 简化实现，不含 Plan Mode | `src/permissions.ts`、`src/agent.ts`、`src/repl.ts` |
| [07](07-context.md) | 上下文管理 | 截断、微清理、手动和自动压缩 | `src/agent.ts`、`src/session.ts` |
| [14](14-testing.md) | 自动化与手动测试 | 有测试；部分旧 mock 待适配流式接口 | `test/` |

建议按 00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 的顺序读，再用 [第 14 章](14-testing.md) 的测试和练习巩固。章节编号保留教程的顺序；记忆、Skill、Plan Mode、多 Agent、MCP 和自治等尚未实现的功能暂不写对应章节。

## 配套文件怎么读

- `src/agent.ts` 是引擎：模型请求、消息循环、提前执行、重试和手动压缩。
- `src/tools.ts` 是工具箱：定义工具、执行分发、文件状态和结果截断。
- `src/permissions.ts` 加载规则并检查权限；用户确认由 Agent 和界面配合处理。
- `src/prompt.ts` 管理静态提示、动态环境和项目指令。
- `src/session.ts` 维护事件与 JSONL；`src/usage.ts` 维护 token 数量。
- `src/repl.ts` 是交互控制器；`src/ui.ts` 是 Ink 界面；`src/transcript.ts` 与 `src/markdown.ts` 负责展示。
- `docs/04-cli-session-plan.md` 是开发前的**历史方案记录**，不是当前实现说明；当前行为以 [04-cli-session.md](04-cli-session.md) 和代码为准。

## 注意安全

权限检查不是沙箱，Shell 正则和前缀匹配无法覆盖所有危险情况，文件和网络工具也有真实副作用。请在可信的临时目录里练习；会话 JSONL、工具输出和项目指令可能包含敏感内容，不要把 `.env` 或会话文件提交到仓库。

---

从 [00 引言](00-introduction.md) 开始。