# Mini Claude Code

从 `claude-code-from-scratch/practice` 整理出来的独立 TypeScript 练习项目。只迁入已经写好的部分，不依赖原仓库，不搬教程成品或空模块。原项目保持不动。

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

`npm start` 是临时练习入口，每次启动新建一个内存会话。无参数或 `--help` 只展示帮助，不调用模型。要在别的项目目录运行，使用本项目 `run.sh` 的绝对路径；它不会改变当前工作目录：

```bash
/path/to/mini-claude-code/run.sh "看看当前项目"
```

同一个 `Agent` 实例可以多次调用 `chat()`，保留历史消息和文件读取状态。暂未实现磁盘会话、交互界面和恢复功能。

## 代码地图

```text
src/
  agent.ts       模型调用 → 工具执行 → 工具结果 → 再次调用模型
  tools.ts       工具定义、分发与执行
  prompt.ts      静态/动态提示词、项目指令加载
  run.ts         临时运行入口
test/            原 practice 回归测试和运行入口测试
docs/
  04-cli-session-plan.md  原来的第 4 章方案，仍为待实现
```

已保留的练习：

- Agent Loop、多轮消息与工具调用配对。
- 读写/编辑文件、glob 查找、ripgrep 搜索、Shell、网页抓取。
- 修改前必须读取文件，检查 mtime 防止覆盖外部变更。
- 工具输出截断、延迟工具搜索与激活。
- system prompt、运行环境、父目录项目指令、规则文件及 `@路径` 引用。

迁移时恢复了被注释的 system prompt，移除了写死的测试提问和完整响应调试输出，模型改为环境配置，并修正了文件工具使用 Windows 专用 `dirname` 的问题。

**注意：这是学习用 agent，不是安全沙箱。** 工具可以直接执行 Shell、写文件和访问网络，尚无权限确认机制；提示词中的“先询问”不是强制保护。请在可信的临时项目中运行。延迟工具激活状态目前仍是进程级，不支持并发独立会话。

## 验证

```bash
npm run check     # 类型检查 + 编译 + 测试
npm run typecheck
npm run build     # 输出 dist/，无需依赖原项目
npm test          # 使用 mock，不需要 API key，也不访问真实模型
```

编译后也可运行 `node --env-file-if-exists=.env dist/run.js "你的问题"`。目前未配置独立 linter。

## 下一步

按 `docs/04-cli-session-plan.md` 继续讨论/实现 React + Ink CLI 与 JSONL 会话。原先空的 `cli/session/ui/context/permissions/memory/skills/subagent/mcp/autonomy/frontmatter` 模块没有迁入，做到哪一步再新增，避免目录再次堆满占位文件。

保留原项目的 MIT 许可，见 `LICENSE`。
