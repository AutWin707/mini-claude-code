import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { checkPermission, loadPermissionRules } from "../src/permissions.ts";
import { ReplController } from "../src/repl.ts";
import { SessionStore } from "../src/session.ts";
import { ReplApp } from "../src/ui.ts";
import { emptyRules, makeAgent, message, mockApiServer, mockClient, text, toolUse, useTempDir, waitFor } from "./helpers.mjs";

const rule = (tool, pattern = null) => ({ tool, pattern });
const done = () => text("done");
const call = (id, name, input) => message([toolUse(id, name, input)]);
const fixture = useTempDir;
// REPL 每轮结束后会请求一次标题。
const title = () => text("title");
function controllerFor(dir, mock) {
  return new ReplController({ store: new SessionStore(join(dir, "sessions")), config: { model: "test" },
    client: mock.client, permissionRules: emptyRules() });
}

test("loads and merges user/project rules, and rejects invalid config", t => {
  const dir = fixture(t);
  const home = join(dir, "home");
  const cwd = join(dir, "project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: {
    allow: ["read_file", "run_shell(git status)"], deny: ["run_shell(rm -rf*)"],
  } }));
  writeFileSync(join(cwd, ".claude", "settings.json"), JSON.stringify({ permissions: {
    allow: ["run_shell(npm test*)"], deny: ["write_file(secret*)"],
  } }));
  const rules = loadPermissionRules(cwd, home);
  assert.deepEqual(rules.allow, [rule("read_file"), rule("run_shell", "git status"), rule("run_shell", "npm test*")]);
  assert.deepEqual(rules.deny, [rule("run_shell", "rm -rf*"), rule("write_file", "secret*")]);
  assert.equal(checkPermission("run_shell", { command: "git status" }, rules).action, "allow");
  assert.equal(checkPermission("run_shell", { command: "rm -rf tmp" }, rules).action, "deny");
  assert.equal(checkPermission("write_file", { file_path: "secret.txt" }, rules).action, "deny");
  writeFileSync(join(cwd, ".claude", "settings.json"), '{"permissions":{"deny":"not an array"}}');
  assert.throws(() => loadPermissionRules(cwd, home), /字符串数组/);
  writeFileSync(join(cwd, ".claude", "settings.json"), "{");
  assert.throws(() => loadPermissionRules(cwd, home), /无法读取权限配置/);
});

test("deny, modes, allow and built-in confirmation follow tutorial order", t => {
  const dir = fixture(t);
  const file = join(dir, "new.txt");
  const rules = { allow: [rule("run_shell")], deny: [rule("run_shell", "rm -rf*")] };
  assert.equal(checkPermission("run_shell", { command: "rm -rf tmp" }, rules, "bypassPermissions").action, "deny");
  assert.equal(checkPermission("run_shell", { command: "git push" }, rules).action, "allow");
  assert.equal(checkPermission("run_shell", { command: "git push" }, emptyRules()).action, "confirm");
  assert.equal(checkPermission("run_shell", { command: "git push" }, emptyRules(), "dontAsk").action, "deny");
  assert.equal(checkPermission("run_shell", { command: "git push" }, emptyRules(), "bypassPermissions").action, "allow");
  assert.equal(checkPermission("run_shell", { command: "git status" }, emptyRules()).action, "allow");
  assert.equal(checkPermission("write_file", { file_path: file }, emptyRules()).action, "confirm");
  assert.equal(checkPermission("write_file", { file_path: file }, emptyRules(), "acceptEdits").action, "allow");
  assert.equal(checkPermission("write_file", { file_path: file }, emptyRules(), "dontAsk").action, "deny");
  writeFileSync(file, "old");
  assert.equal(checkPermission("write_file", { file_path: file }, emptyRules()).action, "allow");
  // 带参数的规则不能在没有对应字段的工具上退化为整个工具的匹配。
  assert.equal(checkPermission("list_files", { path: "secret" }, { allow: [], deny: [rule("list_files", "secret*")] }).action, "allow");
});

test("denied read is not started during streaming and is returned to the model", async t => {
  const file = join(fixture(t), "secret.txt");
  writeFileSync(file, "secret");
  const mock = mockClient([call("read", "read_file", { file_path: file }), done()]);
  const agent = makeAgent(mock.client, { permissionRules: { allow: [], deny: [rule("read_file")] } });
  let executions = 0;
  const runTool = agent.runTool.bind(agent);
  agent.runTool = (...args) => { executions++; return runTool(...args); };
  await agent.chat("read");
  assert.equal(executions, 0);
  const result = mock.requests[1].messages.at(-1).content[0];
  assert.equal(result.tool_use_id, "read");
  assert.equal(result.is_error, true);
  assert.match(result.content, /权限规则拒绝/);
  assert.deepEqual(agent.snapshot().readFiles, []);
});

test("approvals are exact and per Agent; rejected actions are not cached", async t => {
  fixture(t);
  const commands = ["git push origin main", "git push origin main", "git push origin dev", "git push origin dev"];
  const mock = mockClient(commands.flatMap((command, i) => [call(`shell-${i}`, "run_shell", { command }), done()]));
  const confirmations = [];
  const executed = [];
  const agent = makeAgent(mock.client, { confirmPermission: async command => { confirmations.push(command); return command.endsWith("main"); } });
  agent.runTool = async toolCall => { executed.push(toolCall.input.command); return "success"; };
  for (let i = 0; i < commands.length; i++) await agent.chat(`turn ${i}`);
  assert.deepEqual(confirmations, [commands[0], commands[2], commands[3]]); // 同意过的同一命令不再询问。
  assert.deepEqual(executed, [commands[0], commands[1]]);
  assert.match(mock.requests[5].messages.at(-1).content[0].content, /用户拒绝/);
  assert.match(mock.requests[7].messages.at(-1).content[0].content, /用户拒绝/);

  const other = mockClient([call("other", "run_shell", { command: commands[0] }), done()]);
  let asked = 0;
  const anotherAgent = makeAgent(other.client, { confirmPermission: async () => { asked++; return true; } });
  anotherAgent.runTool = async () => "success";
  await anotherAgent.chat("new session");
  assert.equal(asked, 1); // 授权不跨 Agent。
});

test("a missing confirmation callback denies a new file without side effects", async t => {
  const file = join(fixture(t), "new.txt");
  const mock = mockClient([call("write", "write_file", { file_path: file, content: "hello" }), done()]);
  await makeAgent(mock.client).chat("write");
  assert.equal(existsSync(file), false);
  assert.match(mock.requests[1].messages.at(-1).content[0].content, /用户拒绝/);
});

for (const [answer, created] of [["y", true], ["n", false]]) {
  test(`Ink confirmation answered with ${answer} while busy`, async t => {
    const dir = fixture(t);
    const file = join(dir, "confirmed.txt");
    const mock = mockClient([call("write", "write_file", { file_path: file, content: "hello" }), done(), title()]);
    const controller = controllerFor(dir, mock);
    const app = render(createElement(ReplApp, { controller }));
    t.after(() => app.unmount());
    const chat = controller.submit("write");
    await waitFor(() => controller.getSnapshot().permission !== null);
    assert.equal(controller.getSnapshot().busy, true);
    assert.equal(existsSync(file), false);
    await waitFor(() => app.lastFrame()?.includes("权限确认"));
    assert.match(app.lastFrame(), /允许？y 同意/);
    app.stdin.write(answer);
    await chat;
    assert.equal(existsSync(file), created);
    if (!created) assert.match(mock.requests[1].messages.at(-1).content[0].content, /用户拒绝/);
    assert.equal(controller.getSnapshot().permission, null);
    assert.equal(controller.getSnapshot().busy, false);
  });
}

test("REPL /permission changes the existing Agent mode without losing the conversation", async t => {
  const dir = fixture(t);
  const shell = id => call(id, "run_shell", { command: "git push origin main" });
  const mock = mockClient([shell("denied"), done(), title(), shell("allowed"), done()]);
  const controller = controllerFor(dir, mock);
  const id = controller.getSnapshot().id;
  let executions = 0;
  controller.agent.runTool = async () => { executions++; return "success"; };
  await controller.submit("/permission");
  assert.equal(controller.getSnapshot().permissionMode, "default");
  assert.equal(mock.calls.length, 0);
  await controller.submit("/permission dontAsk");
  await controller.submit("first");
  assert.equal(executions, 0);
  assert.match(mock.streams[1].messages.at(-1).content[0].content, /dontAsk/);
  await controller.submit("/permission bypassPermissions");
  await controller.submit("second");
  assert.equal(executions, 1);
  assert.equal(controller.getSnapshot().id, id);
  assert.equal(controller.getSnapshot().permissionMode, "bypassPermissions");
  assert.equal(mock.streams[2].messages[0].content, "first");
  await assert.rejects(controller.submit("/permission plan"), /权限模式可选/);
  assert.equal(controller.getSnapshot().permissionMode, "bypassPermissions");
  assert.ok(!JSON.stringify(controller.store.load(id).state.messages).includes("/permission"));
});

test("switching sessions loads rules from the target cwd and preserves the selected mode", async t => {
  const dir = fixture(t);
  const first = join(dir, "first");
  const second = join(dir, "second");
  for (const path of [first, second]) mkdirSync(join(path, ".claude"), { recursive: true });
  writeFileSync(join(first, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["read_file"] } }));
  writeFileSync(join(second, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["web_fetch"] } }));
  const store = new SessionStore(join(dir, "sessions"));
  const a = store.create(first, { model: "test" }, "");
  const b = store.create(second, { model: "test" }, "");
  const controller = new ReplController({ store, config: { model: "test" } });
  await controller.submit("/permission dontAsk");
  controller.switchSession(a.header.id);
  assert.equal(controller.getSnapshot().permissionMode, "dontAsk");
  assert.equal(checkPermission("read_file", {}, controller.agent.permissionRules).action, "deny");
  assert.equal(checkPermission("web_fetch", {}, controller.agent.permissionRules).action, "allow");
  controller.switchSession(b.header.id);
  assert.equal(controller.getSnapshot().permissionMode, "dontAsk");
  assert.equal(checkPermission("read_file", {}, controller.agent.permissionRules).action, "allow");
  assert.equal(checkPermission("web_fetch", {}, controller.agent.permissionRules).action, "deny");
});

test("cancelling a pending confirmation releases it without executing", async t => {
  const dir = fixture(t);
  const file = join(dir, "cancelled.txt");
  const mock = mockClient([call("write", "write_file", { file_path: file, content: "hello" })]);
  const controller = controllerFor(dir, mock);
  const chat = controller.submit("write");
  await waitFor(() => controller.getSnapshot().permission !== null);
  await assert.rejects(controller.submit("/permission dontAsk"), /正在处理/);
  controller.cancel();
  await assert.rejects(chat, /abort/i);
  assert.equal(controller.getSnapshot().permission, null);
  assert.equal(controller.getSnapshot().busy, false);
  assert.equal(existsSync(file), false);
});

test("single prompt without a TTY rejects confirmation instead of hanging or creating a file", async t => {
  const dir = fixture(t);
  const file = join(dir, "noninteractive.txt");
  const api = await mockApiServer(t, turn => turn === 1
    ? call("write", "write_file", { file_path: file, content: "hello" })
    : text("denied"));
  const entry = fileURLToPath(new URL("../src/run.ts", import.meta.url));
  const env = { ...process.env, HOME: dir, MINI_CLAUDE_ENV_FILE: join(dir, "missing.env"),
    ANTHROPIC_API_KEY: "test", ANTHROPIC_MODEL: "test", ANTHROPIC_BASE_URL: api.url };
  const { stdout } = await promisify(execFile)(process.execPath, [entry, "create a file"], { cwd: dir, env, timeout: 10000 });
  assert.match(stdout, /denied/);
  assert.equal(existsSync(file), false);
  assert.equal(api.requests.length, 2);
  assert.match(api.requests[1].messages.at(-1).content[0].content, /用户拒绝/);
});
