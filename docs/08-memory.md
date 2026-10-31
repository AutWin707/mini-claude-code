# 08 记忆系统

会话结束后，模型就忘了用户的偏好和项目里做过的决定。本章让 agent 把这些长期有用的信息写成文件，下次对话时再拿回来。

主要源码：`src/memory.ts`（存储、索引、召回）、`src/frontmatter.ts`（元数据解析）、`src/agent.ts` 的 `prefetchMemories()` 和 `injectMemories()`、`src/tools.ts` 中写文件后更新索引的部分、`src/prompt.ts` 中拼接记忆说明的部分。

## 整体流程

```text
保存：模型调用 write_file / edit_file 写入记忆目录
        └→ updateMemoryIndex() 重建 MEMORY.md

使用：
  ① 每次请求的 system prompt 带上 MEMORY.md 索引（只有标题和描述）
  ② 用户发消息后，另开一个模型请求挑出相关记忆（异步）
        └→ 挑好后把正文作为 <system-reminder> 插入对话
```

两种使用方式互补：索引让模型始终知道"有哪些记忆"，可以自己用 `read_file` 去读；召回则主动把最相关的正文送到模型面前。

## 存储位置

```text
~/.mini-claude/projects/<工作目录哈希>/memory/
  MEMORY.md              自动生成的索引，不要手动编辑
  user_concise.md        一条记忆一个文件
  project_deploy.md
```

`getMemoryDir()` 对 `process.cwd()` 取 SHA-256 的前 16 位作为目录名，所以**记忆按项目隔离**：在 A 项目保存的记忆，在 B 项目看不到。切换会话时工作目录会跟着切换，记忆目录也随之变化。

这个目录和会话 JSONL（`~/.mini-claude/sessions/`）、技能（`~/.mini-claude/skills/`）放在同一个根目录下，与正版 Claude Code 的 `~/.claude` 分开。

## 记忆文件格式

```markdown
---
name: concise
description: prefers concise replies
type: user
---
Reply briefly. Skip long explanations unless asked.
```

| 字段 | 作用 |
| --- | --- |
| `name` | 简短名称，出现在索引里 |
| `description` | 一行描述；索引和召回时模型**只看这一行**来判断相关性 |
| `type` | `user`（用户偏好）、`feedback`（对 agent 的反馈）、`project`（项目决定）、`reference`（外部资料） |

文件名约定为 `{type}_{short_name}.md`。frontmatter 由 `parseFrontmatter()` 解析：只认 `---` 之间的 `key: value` 行，值都是字符串，不支持多行值。技能系统（第 9 章）复用了同一个解析器。

## 保存：复用已有的文件工具

记忆没有专门的保存工具。system prompt 告诉模型记忆目录在哪、文件格式是什么，模型直接用 `write_file` 写。好处是：

- **权限规则照常生效**：新建文件仍需要用户确认（第 6 章）。
- **读后修改的保护照常生效**：更新已有记忆前必须先 `read_file`（第 2 章）。

`write_file` / `edit_file` 成功后，`tools.ts` 会调用 `updateMemoryIndex(path)`：

```typescript
// src/memory.ts，节选
export function updateMemoryIndex(filePath: string): void {
  const dir = getMemoryDir();
  const path = resolve(filePath);
  const name = basename(path);
  // 只处理记忆目录下、非 MEMORY.md 的 .md 文件
  if (dirname(path) !== dir || !name.endsWith(".md") || name === "MEMORY.md") return;
  // 重新扫描整个目录，生成每条一行的索引
  ...
}
```

每次都**全量重建**索引，而不是在末尾追加一行，所以修改描述、改名都能正确反映。只有同时有 `name` 和 `type` 的文件才会进索引。索引更新失败时，写文件本身仍算成功，工具结果末尾会附一条警告。

注意：只有经过这两个工具的修改才会触发更新。你在编辑器里直接改或删记忆文件，索引不会变，要等下一次通过工具保存时才会重建。

## 使用方式一：索引放进 system prompt

`buildMemoryPromptSection()` 生成 system prompt 中的 `# Memory System` 一节，内容包括：

- 记忆目录的绝对路径。
- 应该保存什么（长期偏好、反馈、项目决定、参考资料），不该保存什么（密钥、临时任务细节、能从代码里直接看到的事实）。
- 文件格式示例。
- 当前 `MEMORY.md` 的内容，最多 200 行、25000 字符；没有记忆时显示 `(No memories saved yet.)`。

索引里**只有描述，没有正文**，这样记忆再多也不会把 system prompt 撑得太大。system prompt 每次请求都重新生成，所以本轮刚保存的记忆，下一次请求就能在索引里看到。

## 使用方式二：异步语义召回

只有索引时，模型得自己判断要不要去读某条记忆，经常想不到。召回的做法是：用户每发一条消息，就用一个小请求问模型"这些记忆里哪些和这个问题相关"，选中的正文直接送进对话。

### 选择

`selectRelevantMemories()` 的步骤：

1. **扫描**：读每个记忆文件的前 30 行解析 frontmatter，按修改时间从新到旧排序，最多取 200 个。
2. **排除**：本会话已经展示过的记忆不再参与选择。
3. **询问**：发一个辅助请求（`max_tokens: 256`，`temperature: 0`），内容是用户问题加上"文件名: 描述"的清单，要求只返回 `{"selected_memories": [...]}`。
4. **解析**：用正则从回复里取出 JSON（模型可能包了代码块），把文件名映射回文件，最多 5 个。
5. **读正文**：单个文件超过 4KB 就截断。修改时间超过 1 天的，附加一句"这条记忆已经 N 天了，使用前请核实"。

召回失败时（网络错误、返回内容不是 JSON）静默返回空列表，**不影响主对话**。

### 什么时候不召回

`startMemoryPrefetch()` 有三道门：

| 条件 | 原因 |
| --- | --- |
| 输入太短：少于 2 个中日韩文字，且不含空格 | "好"、"ok" 这类输入不值得花一次请求 |
| 本会话已注入的记忆超过 60KB | 防止记忆占满上下文 |
| 记忆目录里没有文件 | 没东西可选 |

### 和主请求并行

召回请求和主模型请求**同时发出**，不等待召回完成：

```typescript
// src/agent.ts：chat() 中，省略其他步骤
const prefetch = this.prefetchMemories(userMessage, signal); // 立刻发出召回请求
...
while (true) {
    await this.injectMemories(prefetch);        // 已完成才注入，未完成直接跳过
    const { response, pending } = await this.callModel(signal);
    ...
}
```

```typescript
// src/agent.ts
private async injectMemories(prefetch: MemoryPrefetch | null): Promise<void> {
    if (!prefetch?.settled || prefetch.consumed) return;
    prefetch.consumed = true;
    const memories = await prefetch.promise;
    if (!memories.length) return;
    this.record({ type: "message", message: { role: "user", content: formatMemoriesForInjection(memories) } });
    for (const memory of memories) {
        this.alreadySurfacedMemories.add(memory.path);
        this.sessionMemoryBytes += Buffer.byteLength(memory.content);
    }
}
```

`MemoryPrefetch` 用 `settled` 标记 Promise 是否已完成。每次请求模型前检查一次：完成了就注入（只注入一次），没完成就继续，绝不阻塞。

这样做的代价是：**召回结果通常赶不上第一次请求**。第一次请求发出时，召回请求一般还在进行中；如果模型调用了工具，循环回到开头时召回多半已经完成，就会在第二次请求前注入。如果模型第一次就直接回答、没有调用工具，本轮就用不上召回结果。这是用"不增加延迟"换来的取舍。

注入的内容是一条 user 消息，每条记忆包在 `<system-reminder>` 里，并记入会话 JSONL，所以恢复会话后仍然在上下文中。

## 记录哪些状态

| 状态 | 位置 | 是否持久化 |
| --- | --- | --- |
| 记忆文件和索引 | `~/.mini-claude/projects/<hash>/memory/` | 是，跨会话保留 |
| 已注入的记忆正文 | 会话 JSONL 中的 user 消息 | 是，随会话恢复 |
| 本会话已展示过哪些记忆 `alreadySurfacedMemories` | Agent 内存 | 否 |
| 本会话已注入字节数 `sessionMemoryBytes` | Agent 内存 | 否 |

后两项不持久化，所以恢复会话后，之前展示过的记忆可能被再次选中注入。

## 和教程的差异

- **没有专门的保存工具**：教程用 `save_memory` 函数，这里复用 `write_file` / `edit_file`，由写入路径判断是否更新索引。
- **记忆目录**：放在 `~/.mini-claude/projects/<hash>/memory/`，而不是 `~/.claude` 下。
- **召回不阻塞**：用 `settled` 标记，每次请求前检查，不在第一次请求前等待。

## 已知限制

- 召回使用的辅助请求**不计入 token 用量统计**。
- 召回失败时用 `console.error` 输出，在 TUI 中可能打乱界面显示。
- 在外部直接编辑或删除记忆文件，索引不会自动更新。
- 召回只看 `description`，描述写得含糊，相关记忆就选不中。
- 每个工作目录单独一份记忆；同一项目换个路径（比如重新 clone）就看不到原来的记忆。

## 测试

```bash
node --test test/memory-save.test.mjs test/memory-prefetch.test.mjs
```

- `memory-save`：普通文件不触发索引；模型保存记忆需要权限确认；索引包含描述但不包含正文；修改描述后索引同步更新；不同项目目录互相隔离。
- `memory-prefetch`：召回请求在主请求之前发出、在第二次请求前注入且只注入一次；选择时只发送描述不发送正文；已展示的记忆不再参与选择；会话重放后状态一致；召回很慢时不拖慢没有工具调用的回答。

测试通过 `useTempDir()` 把 HOME 指向临时目录，不会读写真实的记忆。
