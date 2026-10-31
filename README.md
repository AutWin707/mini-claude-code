# Coding Agent Lab

从 `claude-code-from-scratch/practice` 整理出来的独立 TypeScript 练习项目。只迁入已经写好的部分，不依赖原仓库，不搬教程成品或空模块。原项目保持不动。本项目与 Anthropic 无官方关联。

按教程目录整理的 TypeScript 复习文档见 [docs/README.md](docs/README.md)，内容以本项目当前实现为准。

## 运行

需要 Node.js 24+；`grep_search` 需要 PATH 中有 `rg`（macOS 可用 `brew install ripgrep`）。

```bash
npm install
cp .env.example .env
# 编辑 .env：配置密钥、API 地址和模型
npm start -- "看看这个项目的目录结构"
```

- `ANTHROPIC_API_KEY`：密钥，未从旧项目复制。
- `ANTHROPIC_BASE_URL`：兼容 Anthropic Messages API 的服务地址；也支持原来的 `ANTHROPIC_API_URL`，新变量优先。
- `ANTHROPIC_MODEL`：必填，不设默认值。在 `.env` 或环境变量中填写与服务地址匹配的模型名；未设置、空字符串或纯空白都会在请求前报错。

`npm start -- "问题"` 运行一次内存对话后退出；无参数时在交互式终端启动 TUI；`--help` 展示帮助，不调用模型。要在别的项目目录运行，使用本项目 `run.sh` 的绝对路径；它不会改变当前工作目录：

```bash
/path/to/coding-agent-lab/run.sh "看看当前项目"
```

同一个 `Agent` 实例可以多次调用 `chat()`，保留历史消息和文件读取状态。TUI 会把会话事件写入 `~/.mini-claude/sessions/`（为兼容旧数据保留原目录），可在输入框为空时按左箭头选择并恢复会话；单次 prompt 模式不会创建 JSONL 会话。

在 TUI 输入 `/permission` 查看权限模式，输入 `/permission dontAsk` 等命令切换模式；需要确认的操作通过 `y` / `n` 回答。具体模式和限制见 [第 6 章](docs/06-permissions.md)。

可以让模型记住长期偏好或项目决定。记忆按工作目录隔离，保存在 `~/.mini-claude/projects/<项目哈希>/memory/`；通过 `write_file` 或 `edit_file` 保存时会自动更新 `MEMORY.md` 索引，并遵循现有权限规则。直接在外部编辑或删除文件不会自动更新索引。异步召回不会等待，可能来不及用于当前回答。详见 [第 8 章](docs/08-memory.md)。

可以把常用提示词保存为技能：在 `~/.mini-claude/skills/<名字>/SKILL.md`（用户级）或项目的 `.mini-claude/skills/<名字>/SKILL.md`（项目级，同名覆盖用户级）中编写，与正版 Claude Code 的 `.claude/skills` 分开。TUI 或单次模式输入 `/<名字> 参数` 直接调用，模型也会根据技能描述通过 `skill` 工具自动调用。暂不支持 fork 子 agent 执行，`allowed-tools` 也不生效。详见 [第 9 章](docs/09-skills.md)。

用量中的输入包含服务返回的缓存命中和缓存写入 token；如返回明细，界面会分别显示。历史记录中未保存的缓存明细无法补算，记忆召回使用的辅助模型调用目前也不计入用量。

## 代码地图

```text
src/
  agent.ts       模型调用 → 工具执行 → 工具结果 → 再次调用模型
  tools.ts       工具定义、分发与执行
  permissions.ts 权限规则、模式与危险操作检测
  prompt.ts      静态/动态提示词、项目指令加载
  memory.ts      记忆索引、保存说明与异步召回
  skills.ts      技能发现、模板替换与 /命令展开
  frontmatter.ts 简单 Markdown 元数据解析
  run.ts         单次执行与交互式入口
  repl.ts        交互控制器与会话切换
  ui.ts          React + Ink 终端界面
  session.ts     JSONL 会话与状态重放
  transcript.ts  对话显示与工具预览
  markdown.ts    终端 Markdown 渲染
  usage.ts       token 用量统计
test/            自动化测试
docs/            按教程目录整理的实现与复习文档
```

已保留的练习：

- Agent Loop、多轮消息与工具调用配对。
- 读写/编辑文件、glob 查找、ripgrep 搜索、Shell、网页抓取。
- 修改前必须读取文件，检查 mtime 防止覆盖外部变更。
- 工具执行前的 allow/deny 规则、危险操作确认与会话内授权。
- 工具输出截断、空闲后的旧工具结果清理、手动和可配置自动压缩。
- 延迟工具搜索与激活。
- system prompt、运行环境、父目录项目指令、规则文件及 `@路径` 引用。
- 按项目隔离的文件记忆、自动索引与异步语义召回。
- 技能：SKILL.md 定义提示词模板，支持 `/命令` 和 `skill` 工具两种调用方式。

迁移时恢复了被注释的 system prompt，移除了写死的测试提问和完整响应调试输出，模型改为环境配置，并修正了文件工具使用 Windows 专用 `dirname` 的问题。

**注意：这是学习用 agent，不是安全沙箱。** 权限检查使用简单规则和正则，并不能识别所有危险 Shell；默认也会放行部分写入、命令和网络请求。请在可信的临时项目中运行，详见 [权限与安全](docs/06-permissions.md)。

## 验证

```bash
npm run check     # 类型检查 + 编译 + 测试
npm run typecheck
npm run build     # 输出 dist/，无需依赖原项目
npm test          # 使用 mock，不需要 API key，也不访问真实模型
```

编译后也可运行 `node --env-file-if-exists=.env dist/run.js "你的问题"`。目前未配置独立 linter。

## 下一步

React + Ink CLI、JSONL 会话、简化版权限审批与文件记忆已实现，`docs/04-cli-session-plan.md` 保留为早期方案记录。Plan Mode、技能、多 Agent、MCP 和自治等功能尚未实现；已有实现从 [复习目录](docs/README.md) 开始阅读。

保留原项目的 MIT 许可，见 `LICENSE`。
