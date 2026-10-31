# 09 技能系统

把反复使用的提示词保存为文件，用 `/名字` 一键调用，模型也能自己判断何时调用。本章对应 `src/skills.ts`，以及 `src/tools.ts`、`src/repl.ts`、`src/run.ts`、`src/prompt.ts` 中的接入点。

## 技能文件

每个技能是一个目录，里面放 `SKILL.md`：

```markdown
---
name: commit
description: Write a commit message for the current changes
when_to_use: When the user asks to commit
user-invocable: true
---
Look at the git diff and write a conventional commit message.
The user's request: $ARGUMENTS
Templates are in ${CLAUDE_SKILL_DIR}.
```

frontmatter 复用记忆系统的 `parseFrontmatter` 解析（`src/frontmatter.ts`），正文就是 prompt 模板。

| 字段 | 作用 |
| --- | --- |
| `name` | 技能名；省略时用目录名 |
| `description` | 写进 system prompt，让模型知道技能做什么 |
| `when_to_use` | 写给模型看的触发条件 |
| `user-invocable` | 写 `false` 时只能由模型通过 `skill` 工具调用，`/名字` 不会展开 |

## 存放位置

| 级别 | 目录 |
| --- | --- |
| 用户级 | `~/.mini-claude/skills/<名字>/SKILL.md` |
| 项目级 | `<工作目录>/.mini-claude/skills/<名字>/SKILL.md` |

和会话 JSONL（`~/.mini-claude/sessions/`）、记忆一样放在 `.mini-claude` 下，不读取正版 Claude Code 的 `.claude/skills`，两边互不影响。

`discoverSkills()` 先加载用户级、再加载项目级，写入同一个 `Map`，同名时项目级覆盖用户级。没有缓存，每次调用都重新扫描，新加的技能立即可用。

## 模板替换

`resolveSkillPrompt()` 在发给模型之前做字符串替换：

- `$ARGUMENTS` / `${ARGUMENTS}` → 用户参数
- `${CLAUDE_SKILL_DIR}` → 技能目录，技能可以引用目录里的其他文件

两点细节：

- 替换用函数形式 `replace(re, () => args)`，参数里的 `$&` 等不会被当成替换模式。
- 模板里没有 `$ARGUMENTS` 但用户传了参数时，追加 `ARGUMENTS: ...`，避免参数被丢掉。

## 两条调用路径

```text
用户输入 "/commit 修复类型"          用户输入 "帮我提交一下"
        │                                  │
  repl.ts / run.ts                  模型看到 system prompt 中的技能清单
  expandSkillCommand()                     │
        │                           调用 skill 工具 (tools.ts)
        │                                  │
        └──────── resolveSkillPrompt() ────┘
```

**用户路径**：`ReplController.submit()` 先匹配内置命令（`/clear`、`/compact`、`/permission`、`/maxcontext`、`/chat`），剩下的 `/名字` 交给 `expandSkillCommand()`。展开结果作为用户消息发给模型，界面上只显示原始的 `/commit ...`。找不到技能时报错，不会把 `/xxx` 当普通消息发出去。单次模式 `npm start -- "/commit"` 同样会展开。

**模型路径**：`buildSkillsPromptSection()` 把所有技能的名字、描述和 `when_to_use` 写进 system prompt。模型调用 `skill` 工具，得到 `[Skill "commit" activated]` 加展开后的 prompt，并在后续回合按它执行。这是一个"元工具"：返回值不是数据，而是指令。`skill` 只读取本地文件，权限检查默认放行。

两条路径都经过 `resolveSkillPrompt()`，替换逻辑只有一份。

## 和教程的差异

- **没有 fork**：所有技能都是 inline，直接进入当前对话。fork 需要子 agent（独立的 system prompt、工具集、权限传递和用量回收），留到多 Agent 章节一起做。
- **`allowed-tools` 不生效**：inline 模式下技能 prompt 进入主对话，后续工具调用无法区分是否"属于"这个技能，所以不解析这个字段。
- **目录分开**：教程使用 `.claude/skills`，这里用 `.mini-claude/skills`。
- **不缓存**：教程缓存扫描结果，这里每次都扫描。

## 已知行为

- JSONL 里记录的是展开后的 prompt，恢复会话时会看到完整技能文本，而不是 `/commit`。
- 技能名和内置命令同名时，内置命令优先，技能无法通过 `/` 调用（模型仍可通过 `skill` 工具调用）。

## 测试

`test/skills.test.ts` 在临时 `HOME` 和工作目录中运行，覆盖：项目级覆盖用户级且忽略 `.claude/skills`、占位符替换、`user-invocable: false` 不能用 `/` 调用、`skill` 工具返回展开后的 prompt、system prompt 列出技能。
