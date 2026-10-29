# 2. 工具系统

## 本章目标

让模型能检查和修改项目，但仍由程序决定工具实际能做什么。本章从工具 schema、分发和每个工具出发，重点复习文件保护、输出截断、延迟加载及它们的边界。

主要源码：[src/tools.ts](../src/tools.ts)；调用流程在 [src/agent.ts](../src/agent.ts)。

## 一个工具由哪几部分组成

模型需要知道工具的名称、用途和参数；程序则需要有能执行它的函数。两边靠工具名连接：

```text
工具定义（发给模型）       工具执行（本地）
name + description     →   executeTool 的 switch
input_schema           →   读取 input 并调用具体函数
                         →   返回字符串给 Agent
```

`toolDefinitions` 使用 SDK 的 `Anthropic.Tool` 类型，附加一个只在本地使用的 `deferred?: boolean`。例如 `read_file` 的 schema 声明参数是对象，需要 `file_path`：

```typescript
// src/tools.ts，节选
{
  name: "read_file",
  description: "Read the contents of a file. Returns the file content with line numbers.",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string", description: "The path to the file to read" } },
    required: ["file_path"],
  },
}
```

模型根据 description 和 schema 选择工具；schema **不是安全边界**。模型或兼容服务仍可能给出错误参数，本地执行时需要做检查。当前代码对若干必填参数做了类型检查，但并没有通用的 JSON Schema 验证器。

## 工具清单

| 工具 | 输入重点 | 做什么 | 状态 |
| --- | --- | --- | --- |
| `read_file` | `file_path` | 异步读取 UTF-8，加行号，记录 mtime | 常驻 |
| `write_file` | `file_path`、`content` | 创建或覆盖文件，必要时创建父目录 | 常驻 |
| `edit_file` | 路径、`old_string`、`new_string` | 唯一匹配后替换 | 常驻 |
| `list_files` | `pattern`、可选 `path` | 使用 glob，最多展示 200 项 | 常驻 |
| `grep_search` | `pattern`、`path`、`include` | 用 ripgrep 搜索，最多展示 100 行 | 常驻 |
| `run_shell` | `command` | 执行 Shell 命令 | 常驻，危险 |
| `web_fetch` | `url` | 抓取文本，简化 HTML | 常驻 |
| `tool_search` | `query` | 查找并激活延迟工具 | 常驻 |
| `example_tool` | `message` | 用于演示延迟激活 | 延迟 |

工具输出是字符串，不是直接打印给模型。`Agent` 把字符串包装成 `tool_result`，并把它和工具调用 ID 配对。具体执行异常会被转换为错误字符串；详见[第 1 章](01-agent-loop.md)。

## 分发：模型只能选择，程序才执行

`executeTool(toolUse, readFileState, activated, signal)` 根据 `toolUse.name` 进入对应的 `case`。`input` 来自模型，是 `unknown`，代码按该工具期望的形状读取。函数最后返回 `Promise<string>`，使异步读文件、glob、grep 和网络请求都可以统一等待。

一个重要区别：`toolDefinitions` 的描述只是发给模型看的接口文档；是否真的执行、有没有安全检查、失败时怎么返回，取决于 `executeTool()` 和各个工具函数。

## read_file：读取与状态记录

文件读取使用 `fs/promises.readFile()`，按换行拆开后在前面加行号：

```text
   1 | export class Agent {
   2 |   // ...
```

行号有助于模型定位内容，但工具返回的是文本，不是编辑用的补丁。读取成功后，代码把 `resolve(file_path)` 和 `statSync(path).mtimeMs` 放进读取状态；读取失败或 stat 失败则删除该路径的旧记录。

为什么要删除旧记录？假设之前成功读过文件，但之后文件被删除或当前读取报错；继续保留旧 mtime，就可能错误地认为模型仍掌握该文件的当前内容。读取状态和文件内容不是同一份数据：前者用于修改前检查，后者通过工具结果进入模型上下文。

异步读取可接受 `AbortSignal`，在流式响应中提前启动而不必同步阻塞事件循环。`read_file` 是四个可提前执行的工具之一，临时读取状态合并的细节见[第 5 章](05-streaming.md)。

### 把 `read_file` 分支拆开看

模型请求到达时，`toolUse.input` 并不天然可信。当前代码先取 `file_path` 并检查它是非空字符串，接着把路径转成绝对路径，异步读取内容，再决定更新还是删除读取记录：

```typescript
// src/tools.ts，节选
const input = toolUse.input as { file_path: string };
if (typeof input?.file_path !== "string" || !input.file_path) {
  return "Error: file_path is required";
}
const path = resolve(input.file_path);
const result = await readFile(input, signal);
if (!result.startsWith("Error")) {
  try { readFileState.set(path, statSync(path).mtimeMs); }
  catch { readFileState.delete(path); }
} else {
  readFileState.delete(path);
}
return result;
```

这里 `resolve()` 是把相对路径标准化，方便后面用同一个 key 检查；它不是把路径限制在工作目录里的安全沙箱。真正读取时仍按进程权限访问路径。异步读取产生的字符串返回给 Agent；mtime 本身不会替代文本内容。

## write_file：新建和覆盖不是一回事

写入前先判断目标是否存在：

1. **不存在**：允许创建；`writeFile()` 会创建缺少的父目录。
2. **存在但没读过**：拒绝覆盖，提示先用 `read_file`。
3. **读过但 mtime 变了**：拒绝覆盖，提示重新读取。
4. **读过且 mtime 未变**：执行写入；成功后刷新 mtime。

写文件是真实副作用，不会在流式 block 刚完成时提前执行。当前没有权限审批、路径沙箱或写入预览，不能把 mtime 检查当作“绝对安全”。

### mtime 检查的三个状态

假设磁盘中已有 `example.txt`：

```text
未读过                 → write_file 报错
read_file 成功         → 保存路径和时间
外部程序修改了文件     → 当前时间与保存值不同，write_file 报错
重新 read_file         → 保存新时间，之后才可再次尝试
```

源码在真正写入前检查 Map 和 `statSync(path).mtimeMs`：

```typescript
// src/tools.ts，write_file 分支节选
if (existsSync(path)) {
  if (!readFileState.has(path)) {
    return "Error: use read_file before overwriting this file";
  }
  if (statSync(path).mtimeMs !== readFileState.get(path)) {
    return "Error: file changed since last read; use read_file again";
  }
}
```

示例省略了源码中对 `statSync` 异常的捕获。写入之后更新 Map，是为了让后续操作比较的是刚写入的新版本；不过如果其他进程刚好在检查之后写入，mtime 检查不能提供事务级保护。

## edit_file：精确替换与引号容错

编辑不是让模型提交整份文件，而是提交一段旧文本和一段新文本：

```text
file_path: 要编辑的文件
old_string: 必须找到的原文
new_string: 替换后的内容
```

内部先直接搜索 `old_string`；找不到时，把常见弯引号和直引号归一化后再搜索，并映射回原文件中的真实片段。找到后检查真实片段出现次数，超过一次就拒绝，避免不知道该改哪一个位置。最终使用字符串替换并写回。

编辑已有文件之前仍先走“已读过 + mtime 一致”的检查。编辑成功后刷新读取状态，使下一次编辑能够基于刚写入的版本继续。

引号容错只是方便匹配常见标点，并不是语法树编辑；项目不会理解函数作用域或语言语义。`old_string` 范围太宽可能改错，太短可能不唯一；外部程序仍可能在检查与写入之间修改文件，因此 mtime 防护也不能替代文件锁或真正的事务。

### 为什么还要检查唯一性

假设文件里两处都写着 `const enabled = true`，模型只给出这一句作为 `old_string`。若直接 `replace()`，JavaScript 默认只替换第一次出现的位置；模型想改的却可能是第二处。因此实现会先计算实际匹配文本出现的次数，超过一次就拒绝，让模型扩大上下文重新尝试。

```typescript
// src/tools.ts，节选
const actual = findActualString(content, input.old_string);
if (actual === null) return "Error: old_string not found in file";
const count = content.split(actual).length - 1;
if (count > 1) return `Error: old_string is not unique in file (found ${count} occurrences)`;
const newContent = content.replace(actual, input.new_string);
```

引号归一化只在直接匹配失败后使用。它在归一化文本中找到索引，再从原始内容截取对应片段，之后仍以原始片段检查唯一性。它不会处理任意 Unicode 规范化、换行风格差异或格式化后的等价代码。

## list_files：只找路径

`list_files` 接收 glob 模式，例如 `**/*.ts`，可指定基目录，默认当前工作目录。它设置 `nodir: true`，排除 `node_modules` 和 `.git`，排序后只返回前 200 项；超出时附一行数量提示。

它适合回答“有哪些文件”，不读取文件正文。输出只代表本次 glob 的结果；忽略规则与工具自身的配置有关，不等价于完整的 Git 文件清单。

## grep_search：只搜索内容

代码组装 `rg` 参数并使用异步 `execFile`，而不是把 pattern 拼进 Shell 字符串：

```typescript
const args = ["--line-number", "--with-filename", "--no-heading", "--color=never"];
if (input.include) args.push("--glob", input.include);
args.push("--", input.pattern, input.path || ".");
```

`--` 把后续的 pattern 和路径与命令选项分开。因为调用的是 `execFile("rg", args, ...)`，像 `$(...)` 这样的 pattern 不会被 Shell 当命令替换。进程超时为 10 秒，输出缓冲区上限为 10 MiB，结果最多保留 100 行。没有匹配、没有安装 `rg`、其他执行失败分别返回不同提示。

这不代表所有输入都不会造成高开销：正则、目录规模与文件内容仍可能影响速度。异步子进程的主要好处是工具运行时 Node 仍可处理模型流事件。

## run_shell：有能力，也有风险

`run_shell` 使用 `execSync(command)`，超时 10 秒、缓冲上限 10 MiB，返回标准输出；失败时把错误、stdout 和 stderr 放进字符串。

这是真正的 Shell：重定向、管道以及命令替换都会执行。它目前没有人工确认、命令 allow/deny 规则或沙箱，还是同步调用，会阻塞事件循环。只应在可信环境中练习，不能把“模型被提示要谨慎”当作权限机制。

## web_fetch：网络文本也是不可信输入

工具先解析 URL，只接受无 URL 凭据的 HTTP(S)，再用 `fetch` 请求，默认超时 15 秒。它接收文本、JSON、XML 和 JavaScript 等文本类型；二进制类型会被拒绝。HTML 使用轻量正则清除 script、style、标签与部分实体，并不是完整浏览器或严格 HTML 解析器。

读取响应体时按字节限制在 1 MiB，超限会取消 reader 并附截断提示；最终文本还会经过通用的 50,000 字符截断。网页文本属于外部数据，不应因其中包含“忽略之前的指令”就自动获得更高权限。

当前实现没有完整的 SSRF 防护或重定向目的地策略；尤其不要把可以访问内部网络的进程当成公开服务来运行。

## 工具结果为什么要截断

一次工具输出很容易占满模型上下文，比如读取大文件、构建日志或网页。`truncateResult()` 的上限是 50,000 个 JavaScript 字符单位，超出时保留头尾，并插入省略数量：

```text
[前半段]

[... truncated N chars ...]

[后半段]
```

结果不超过上限时原样返回；当前没有把完整输出另存为可重新访问的 artifact。截断约束的是工具结果，不等于对话总上下文有自动预算控制。

## tool_search：把不常用工具延迟暴露

每个 `Agent` 有自己的 `activatedTools` 集合。`getActiveToolDefinitions()` 返回常驻工具与已激活工具，去掉只用于本地控制的 `deferred` 字段；`getDeferredToolNames()` 把尚未激活的名字写进动态提示。

当模型调用 `tool_search` 并匹配到 `example_tool` 时，该工具加入集合。下一次模型请求前重建 tools 数组，模型才会看到它的正式 schema。直接调用未激活的 `example_tool` 会得到错误。

代码还给单独调用 `executeTool()` 等函数提供了模块级默认集合；Agent 明确传入自己的集合，所以不能把测试辅助默认状态和各会话 Agent 状态混为一谈。`tool_search` 只是本项目的简单工具发现，不是 Skill 或 MCP 系统。

## 从定义到返回：跟一次完整调用

可以把一次 `list_files` 调用拆成五步：

1. 组装请求时，`getActiveToolDefinitions()` 将常驻工具的 schema 放入 `tools`。
2. 模型返回 `{ type: "tool_use", id, name: "list_files", input }`。
3. 完整 block 到达后，若前面没有非安全工具，Agent 可以提前调用 `executeTool()`。
4. `executeTool()` 进入 `list_files` 分支，等待 glob 并返回字符串；出错时返回错误文本。
5. 完整模型响应确认后，Agent 复用或执行结果，截断过长文本，以原 `id` 构造 `tool_result`。

理解这五步，就知道为什么只加一段 description 不够：还得有执行分支；也知道只写一个函数不够：模型的请求工具列表里还得包含对应定义。

## 动手复习

在项目目录运行不依赖真实模型的工具测试：

```bash
node --test test/tool-state.test.ts test/grep.test.ts test/list-files.test.ts
node --test test/web-fetch.test.ts test/truncate-result.test.ts
```

试着解释：为什么读完文件后还要保存 mtime？为何先有 `--` 再传 grep pattern？为什么 `read_file` 可以提前启动，而 `write_file` 不能？如果工具返回一段恰好以 `Error` 开头的正常文本，会发生什么？

下一章看 [System Prompt 与项目指令](03-system-prompt.md)。