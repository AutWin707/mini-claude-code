# 6. 权限与安全

## 本章目标

Agent 的工具可以读取和修改真实文件、执行 Shell 和访问网络。本章在 **Agent 调用工具之前**增加一层简化的权限检查：配置规则、权限模式、危险操作检测和用户确认。它参考原教程第 6 章，但**不实现 Plan Mode**。

主要源码：[src/permissions.ts](../src/permissions.ts)、[src/agent.ts](../src/agent.ts)、[src/repl.ts](../src/repl.ts)、[src/ui.ts](../src/ui.ts)；测试：[test/permissions.test.mjs](../test/permissions.test.mjs)。

> **不是安全沙箱。** Shell 正则和字符串前缀匹配无法识别所有危险操作；默认模式并不会询问每个 Shell 或文件修改。请只在可信的临时目录练习。

## 工具调用怎么过权限闸

每次模型请求执行工具，Agent 根据 `checkPermission()` 的结果决定是否执行，顺序是：

```text
工具调用
  → deny 规则命中？                 是 → 拒绝
  → bypassPermissions 模式？       是 → 放行
  → allow 规则命中？                是 → 放行
  → 读工具，或 acceptEdits 下的编辑工具？是 → 放行
  → 命中内置危险检测？
      ├─ dontAsk 模式               → 拒绝
      └─ 其他模式                   → 需要确认
           → confirmedActions Set 中已有相同确认描述？
               ├─ 有                → 放行，不再询问
               └─ 没有              → 询问用户
                    ├─ 同意         → 加入 Set → 放行
                    └─ 拒绝         → 不加入 Set → 拒绝
  → 以上均未决定                    → 默认放行
```

`deny` 的优先级最高，即使 `bypassPermissions` 模式也不能绕过。规则命中 `allow` 时不会再进行内置危险检测；例如 `allow: ["run_shell"]` 会放行 `git push`，除非它同时匹配 `deny`。

被规则拒绝或用户拒绝时，Agent **不运行工具**，而是将带 `is_error: true` 的 `tool_result` 返回模型。工具的 `tool_use_id` 仍然配对，模型可以看到拒绝结果并继续回应。

### 流式提前执行也必须检查

`read_file`、`list_files`、`grep_search`、`web_fetch` 可以在模型流尚未结束时提前执行。在 `contentBlock` 回调中，只有权限结果是 `allow` 才会启动；被拒绝或需要确认时不会提前执行，并阻止后续工具提前启动。完整响应到达后，正常工具循环也要检查权限。这样给读取工具配置 `deny` 时，不会在拒绝前已经读取了文件。

这些检查位于 Agent 路径，直接在程序中调用 `executeTool()` 不会自动经过权限闸，因此不能把它当作系统级访问控制。

## 规则配置在哪里

Agent 创建时读取并合并以下两个文件的 `permissions`，不修改文件：

- 用户级：`~/.claude/settings.json`。
- 项目级：**当前工作目录**的 `.claude/settings.json`；不是向上搜索父目录。

例如，可在可信的练习项目手动创建项目级配置：

```json
{
  "permissions": {
    "allow": ["read_file", "run_shell(git status)"],
    "deny": ["run_shell(rm -rf*)", "write_file(secret*)"]
  }
}
```

两个文件的数组追加合并，所有 `deny` 先于所有 `allow` 判断；因此项目级 allow 不能覆盖用户级 deny，反过来也一样。缺少文件或 `permissions` 时视为没有相应规则；JSON 损坏、`permissions` 格式错误或规则不是字符串数组时，创建 Agent 会报错，避免静默忽略可能的 deny。

`~/.claude/settings.json` 可能也是其他 Claude 相关程序使用的配置。编辑前先确认现有内容，不要覆盖已有设置。本项目只认识自身工具名称，不保证兼容其他程序的规则语法。

### 规则怎么匹配

| 规则 | 含义 |
| --- | --- |
| `read_file` | 匹配该工具的所有调用 |
| `run_shell(git status)` | Shell 命令完全等于 `git status` |
| `run_shell(npm test*)` | Shell 命令以 `npm test` 开头 |
| `write_file(secret*)` | `file_path` 以 `secret` 开头 |

只有**末尾**的 `*` 有前缀匹配含义；其他位置不做通配符解析。`run_shell` 匹配原始 `command`，其他工具匹配原始 `file_path`，不会规范化路径。`list_files`、`grep_search`、`web_fetch` 没有 `file_path`，不能用带参数规则筛选其路径或 URL；可以用裸工具名匹配全部调用。和教程示例不同，带参数规则找不到相应字段时**不匹配**，不会退化为匹配整个工具。

前缀不是 Shell 语法分析。例如允许 `run_shell(npm test*)` 时，`npm test; 其他命令` 也会命中 allow；写 `deny: ["run_shell(rm -rf*)"]` 也不会匹配出现在命令中间的 `rm -rf`。不要依赖这种规则抵御恶意 Shell。

### 什么时候读取、修改会不会自动生效

规则是每个 Agent 创建时加载的一份内存快照，不是教程原版的模块级全局缓存。用户修改配置后，已有 Agent 不会自动重读；需要重启或重新创建 Agent。REPL 切换会话会为目标工作目录创建新 Agent，重新读取该目录的项目规则。

用户在确认框选择同意或拒绝**不会追加**配置文件。

## 内置危险检测

没有规则决定结果时，默认模式会对以下操作返回 `confirm`：

- `run_shell` 的命令命中危险正则，包括常见的 `rm`、`git push` / `reset` / `clean`、`sudo`、`mkfs`、`dd`、`kill`、`shutdown` 及部分 Windows 命令。
- `write_file` 或 `edit_file` 的目标文件不存在。

已有文件的写入或编辑**不会仅因为是编辑而询问**；但工具层仍要求先读取已有文件，并检查 mtime。不存在的文件即使审批通过，`edit_file` 本身也可能因文件不存在而失败。

内置检测未命中的操作默认允许，包括许多 Shell 命令、对已有文件的编辑、网络请求及没有明确拒绝规则的其他工具。正则可能漏掉危险命令，也可能误报；`web_fetch` 虽按教程归为读工具，仍然有网络副作用和 SSRF 风险。

## 权限模式与 REPL 命令

启动交互式界面后输入：

```text
/permission                       查看当前模式和可选值
/permission default               默认模式
/permission acceptEdits           自动允许文件写入和编辑
/permission dontAsk               本来需要确认的操作自动拒绝
/permission bypassPermissions     跳过普通确认，仍受 deny 约束
```

| 模式 | 行为 |
| --- | --- |
| `default` | 规则无决定时，对命中危险检测的操作请求确认，其余默认允许 |
| `acceptEdits` | 编辑工具自动允许；危险 Shell 仍需确认 |
| `dontAsk` | 本来需要确认的操作自动拒绝；其他操作仍可能执行 |
| `bypassPermissions` | 除 deny 命中外直接放行；不是沙箱 |

切换命令只改变当前 REPL 运行时模式，不发送给模型、不写入会话 JSONL，也不改变已有对话。忙碌时不能切换。REPL 切换会话后沿用当前模式，但为新 Agent 重新加载规则并清空临时确认。退出再启动恢复 `default`。

程序集成可以通过 `new Agent({ permissionMode })` 设置初始值，也可以空闲时调用 `agent.setPermissionMode(mode)` 更新；不支持 `plan`。单次 prompt 模式使用 `default`，没有权限模式命令行参数。

## 确认与会话内 Set

需要确认时，Ink 界面显示操作并等待 `y` 同意、`n` 或 `Esc` 拒绝；`Ctrl+C` 取消当前聊天和确认等待。单次 prompt 在交互终端询问；没有交互终端时，需要确认的操作自动拒绝，不等待输入。

用户同意后，Agent 将确认描述加入自身的 `confirmedActions` Set。同一个 Agent 再次遇到相同描述且权限判断仍为 `confirm` 时，会先查这个 Set：命中就不再询问，否则再次询问。Shell 用完整命令字符串；新文件使用包含路径的描述。用户拒绝不会加入任何 deny，也不会被记住，后续仍可能再问。

对应 `src/agent.ts` 中的核心流程（省略取消处理）：

```typescript
// confirmedActions 是 Agent 实例上的 Set<string>
if (permission.action === "confirm" && permission.message &&
    !this.confirmedActions.has(permission.message)) {
  const confirmed = await this.confirmPermission?.(permission.message, signal) ?? false;
  if (confirmed) this.confirmedActions.add(permission.message);
  else denied = "Error: 用户拒绝了此操作。";
}
// denied 有值时返回拒绝结果；否则才执行工具。
```

Set 在**每次需要确认时**检查，不是每次对话开始时读取；它不写 JSONL，重启或创建新 Agent 后消失。Set 在工具实际执行前就记录批准，即使后续执行失败，该批准在当前 Agent 生命周期内仍然存在。更高优先级的 deny 仍会先拦截。

## 验证

```bash
node --test test/permissions.test.mjs test/stream-tools.test.mjs
npm run typecheck
npm run check
```

自动化测试覆盖规则合并和优先级、权限模式、流式读取拦截、确认及拒绝、实例隔离、Ink 输入、取消和 REPL 切换模式。项目原有部分旧测试 mock 仍未适配当前流式模型接口；详见[测试指南](14-testing.md)。

继续阅读[上下文管理](07-context.md)。
