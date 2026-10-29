# 3. System Prompt 工程

## 本章目标

工具接好了，模型还需要知道自己是谁、应该遵守什么约束，以及当前机器处在什么环境。本章拆解本项目的三类输入：静态 system、动态环境和项目指令，弄清它们在哪里构造、何时更新、怎样进入消息。

主要源码：[src/prompt.ts](../src/prompt.ts) 和 [src/agent.ts](../src/agent.ts)。

## 为什么不只发用户问题

用户说“修复测试”，这句话不包含工作目录、操作系统或项目自己的约定。模型可能猜错路径，也可能不知道项目希望先读文件再改。

System Prompt 的作用是提供稳定的工作方式，动态环境提供本次运行的事实；项目指令则把 `CLAUDE.md` 等文件中的约定带进当前会话。它们不是一类东西：前者偏通用规则，环境是当下信息，项目指令来自外部文件。

```text
静态规则 ──┐
           ├─ buildUserSystemPrompt() ──> 请求的 system
动态环境 ──┘

项目指令 ──> <project-instructions> ──> 第一条 user 消息
```

名字 `buildUserSystemPrompt()` 容易误解：它返回的是传给 API `system` 字段的文本，不是用户的聊天消息。

## 静态部分：Agent 的基本行为

`STATIC_PROMPT` 位于 `prompt.ts`，告诉模型它是 coding assistant，要使用工具检查和修改文件、修改前读取已有文件、遵守项目指令、危险操作前询问、回答简洁。

```typescript
// src/prompt.ts，节选
export function buildStaticSystemPrompt(): string {
  return STATIC_PROMPT;
}
```

注意“危险操作前询问”只是给模型的行为要求；本项目没有对应的强制审批层。如果模型仍然调用 `run_shell`，代码不会自动拦截。提示词不是权限系统；现有文件保护见[第 2 章](02-tools.md)。

## 动态部分：当前环境

`buildDynamicSystemPrompt(deferredNames)` 每次构造当前环境字符串，包含：

- `process.cwd()`：工作目录。
- `os.platform()` 和 `os.arch()`：系统与架构。
- Shell：Windows 使用 `ComSpec` 或 `cmd.exe`；其他系统使用 `SHELL` 或 `/bin/sh`。
- 如果还有未激活的工具，提示可通过 `tool_search` 搜索这些名称。

它**不读取 Git 状态**，也不注入记忆、Skill 或子 Agent 列表；这些是原教程其他版本可能涉及的能力，不是当前代码的行为。

```typescript
// src/prompt.ts，节选
export function buildUserSystemPrompt(deferredNames: string[] = []): string {
  return `${buildStaticSystemPrompt()}\n\n${buildDynamicSystemPrompt(deferredNames)}`;
}
```

`Agent.callAnthropicStream()` 每次模型请求前重新调用这个函数。工具被激活后，未激活列表可能变化；切换会话时工作目录也可能变化，动态部分因此要重新生成。

静态与动态分开有助于理解和维护，但目前代码没有给请求设置 Anthropic 的 `cache_control` 断点，不能仅凭“文本静态”就宣称项目已经实现前缀缓存。

## 项目指令从哪里找

`loadProjectInstructions(startDir = process.cwd())` 从当前工作目录一直向上找到根目录，再按**从根到当前目录**的顺序读取：

```text
每个祖先目录：
  CLAUDE.md
  AGENT.md
  AGENTS.md

当前 startDir：
  .claude/rules/*.md（按文件名排序）
```

普通指令文件可以来自祖先目录；`.claude/rules/*.md` 则只从传入的 `startDir` 下读取，代码没有递归收集所有祖先目录的 rules。不存在的文件会跳过。读取到的内容按文件路径分节，合成为一段 `# Project Instructions`。

REPL 创建新会话时，会先加载一份指令并保存在会话头。切换会话后使用该会话头里的指令快照，而不是自动重新读取新修改的指令文件。直接构造 `Agent` 时若没有传入 `instructions`，则在首次需要时懒加载一次。

### 举一个实际的目录例子

假设工作目录为 `/work/app`，文件布局如下：

```text
/work/CLAUDE.md
/work/app/AGENTS.md
/work/app/.claude/rules/style.md
```

调用 `loadProjectInstructions("/work/app")` 时，先向上收集目录，再从根往下依次查找约定名称：`/work/CLAUDE.md` 会先于 `/work/app/AGENTS.md`。最后再读取 `/work/app/.claude/rules/` 下按名字排序的 `.md`。每段前面带文件名，便于模型和人判断内容来源。

顺序是拼接顺序，不是操作系统强制的权限优先级；如果两份文件存在冲突，当前程序不会解析语义或自动裁决。

## `@路径` 引用怎么展开

支持一整行写入以下形式：

```text
@./rules/conventions.md
@~/shared-guidelines.md
@/absolute/path/to/instructions.md
```

相对路径以**引用它的指令文件所在目录**为基准；`~/` 展开为用户主目录；绝对路径原样处理。引用可继续嵌套，但有深度上限；同一绝对路径通过 `seen` 集合去重，避免循环引用和重复注入。

读不到文件时会生成 `<!-- Could not read: ... -->` 提示；超过深度限制也会留下一条注释。匹配模式只处理完整的一行及规定的路径形式，不能假设任意普通 `@filename` 都会被展开。

### 避免循环引用

假设 `A.md` 引用 `B.md`，而 `B.md` 又引用 `A.md`。如果没有记录已经访问过的路径，递归会不断展开。当前 `readInstructions()` 使用 `seen: Set<string>`：第一次处理路径时加入集合；之后再次遇到同一绝对路径就返回空字符串。

```typescript
// src/prompt.ts，节选
const path = resolve(filePath);
if (seen.has(path)) return "";
if (depth >= 5) return `<!-- Include depth limit: ${path} -->`;
seen.add(path);
```

除了循环，同一份被多个指令文件引用的资料也只合并一次。`seen` 以解析后的路径去重，并非完整的符号链接身份检查；深度限制用于控制展开层数。无论是否引用成功，产出的结果都是字符串，随后进入项目指令快照。

## 指令何时进入对话

聊天开始时，如果 `state.messageCount === 0`，`Agent.withInstructions()` 会将项目指令包进第一条 user 消息：

```text
<project-instructions>
项目规则……
</project-instructions>

用户本次的问题
```

后续消息不会每轮重新附加这整段；它们依靠历史消息继续存在。压缩时，代码会在生成摘要消息时再次调用 `withInstructions()`，让摘要后的活动上下文仍能带上项目指令。

TUI 重建历史显示时会去掉开头的 `<project-instructions>` 包装，避免每次都在屏幕上重复展示规则；不代表这段规则没有进入模型上下文。

## 外部内容和可信边界

项目指令、源码、网页和工具输出都可能被修改。代码当前没有独立的指令可信级别解析器；“遵循项目指令”和“网页内容是数据”的要求主要依赖提示词与模型行为。

需要区分三件事：

1. **规则写了什么**：模型会看到的自然语言。
2. **代码允许什么**：工具能读取或修改哪些资源。
3. **权限由谁控制**：当前没有系统级隔离或审批。

例如指令文件要求“不要修改配置”，不等于 `write_file` 在代码层面无法修改配置。测试和实际使用时仍需要可信目录。

## 一次会话里，哪些内容会重新计算

| 时间点 | 静态/动态 system | 项目指令 |
| --- | --- | --- |
| 创建新 REPL 会话 | 配置 Agent；随后按请求构造 | 读取并保存快照 |
| 第一次聊天 | 根据当前目录和延迟工具重建 | 加进第一条 user 消息 |
| 第二次聊天 | 再次按当前状态重建 | 不再重复追加，依赖已有历史 |
| 切换已保存会话 | 切换工作目录后按该环境构造 | 使用会话头里的旧快照 |
| 手动 compact | 摘要请求使用专门的摘要 system | 摘要消息重新包含当前会话指令 |

因此修改 `CLAUDE.md` 后，在一个已经运行的 REPL 会话里未必立刻生效；创建新会话或明确重建状态才可能读取到新内容。这个行为有助于会话重现，但用户也要知道它不是文件实时监听。

## 与教程的主要区别

| 主题 | 当前项目 |
| --- | --- |
| 静态 + 动态 | 有，拼为一个字符串 |
| 当前目录、系统、Shell | 有 |
| Git 状态 | 没有 |
| 多层指令文件 | 祖先 `CLAUDE.md` / `AGENT.md` / `AGENTS.md`，当前目录 rules |
| `@` 引用 | 支持指定路径形式、去重、深度限制 |
| 指令注入 | 首条 user 消息，压缩摘要时重新包装 |
| Prompt caching、记忆、Skill 注入 | 未实现 |

## 动手复习

```bash
node --test test/prompt.test.ts
```

读完后问自己：为什么 `system` 要在每次请求前重建？如果工作目录里更新了 `CLAUDE.md`，已经创建的 REPL 会话是否自动使用新内容？为什么项目指令可能包含敏感内容，不应随意分享 JSONL？

下一章把它接到[CLI 与会话](04-cli-session.md)。