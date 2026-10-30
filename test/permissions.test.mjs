import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { Agent } from "../src/agent.ts";
import { checkPermission, loadPermissionRules } from "../src/permissions.ts";
import { ReplController } from "../src/repl.ts";
import { SessionStore } from "../src/session.ts";
import { ReplApp } from "../src/ui.ts";

const emptyRules = () => ({ allow: [], deny: [] });
const rule = (tool, pattern = null) => ({ tool, pattern });
const tool = (id, name, input) => ({ type: "tool_use", id, name, input });
const message = content => ({ id: "test", type: "message", role: "assistant", model: "test", content,
  stop_reason: content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 } });
const done = () => message([{ type: "text", text: "done" }]);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mini-permissions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function clientFor(replies) {
  const requests = [];
  return { requests, client: { messages: {
    stream(params) {
      requests.push(structuredClone(params));
      const response = replies.shift();
      if (!response) throw new Error("unexpected stream request");
      const listeners = {};
      return { on(event, listener) { listeners[event] = listener; }, async finalMessage() {
        for (const block of response.content) listeners.contentBlock(block);
        return response;
      } };
    },
    async create() { return message([{ type: "text", text: "title" }]); },
  } } };
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for permission UI");
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
  const call = tool("read", "read_file", { file_path: file });
  const mock = clientFor([message([call]), done()]);
  const agent = new Agent({ config: { model: "test" }, instructions: "", client: mock.client, onOutput() {},
    permissionRules: { allow: [], deny: [rule("read_file")] } });
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

test("approvals are exact and per Agent; rejected actions are not cached", async () => {
  const calls = ["git push origin main", "git push origin main", "git push origin dev", "git push origin dev"];
  const replies = calls.flatMap((command, i) => [message([tool(`shell-${i}`, "run_shell", { command })]), done()]);
  const mock = clientFor(replies);
  const confirmations = [];
  const executed = [];
  const agent = new Agent({ config: { model: "test" }, instructions: "", client: mock.client, onOutput() {},
    permissionRules: emptyRules(), confirmPermission: async command => { confirmations.push(command); return command.endsWith("main"); } });
  agent.runTool = async call => { executed.push(call.input.command); return "success"; };
  for (let i = 0; i < calls.length; i++) await agent.chat(`turn ${i}`);
  assert.deepEqual(confirmations, [calls[0], calls[2], calls[3]]);
  assert.deepEqual(executed, [calls[0], calls[1]]);
  assert.match(mock.requests[5].messages.at(-1).content[0].content, /用户拒绝/);
  assert.match(mock.requests[7].messages.at(-1).content[0].content, /用户拒绝/);

  const second = clientFor([message([tool("other", "run_shell", { command: calls[0] })]), done()]);
  let asked = 0;
  const anotherAgent = new Agent({ config: { model: "test" }, instructions: "", client: second.client, onOutput() {},
    permissionRules: emptyRules(), confirmPermission: async () => { asked++; return true; } });
  anotherAgent.runTool = async () => "success";
  await anotherAgent.chat("new session");
  assert.equal(asked, 1);
});

test("a missing confirmation callback denies a new file without side effects", async t => {
  const file = join(fixture(t), "new.txt");
  const mock = clientFor([message([tool("write", "write_file", { file_path: file, content: "hello" })]), done()]);
  const agent = new Agent({ config: { model: "test" }, instructions: "", client: mock.client, onOutput() {}, permissionRules: emptyRules() });
  await agent.chat("write");
  assert.equal(existsSync(file), false);
  assert.match(mock.requests[1].messages.at(-1).content[0].content, /用户拒绝/);
});

test("Ink confirmation handles approval while busy", async t => {
  const dir = fixture(t);
  const file = join(dir, "approved.txt");
  const mock = clientFor([message([tool("write", "write_file", { file_path: file, content: "hello" })]), done()]);
  const controller = new ReplController({ store: new SessionStore(join(dir, "sessions")), config: { model: "test" }, client: mock.client, permissionRules: emptyRules() });
  const app = render(createElement(ReplApp, { controller }));
  t.after(() => app.unmount());
  const chat = controller.submit("write");
  await waitFor(() => controller.getSnapshot().permission !== null);
  assert.equal(controller.getSnapshot().busy, true);
  assert.equal(existsSync(file), false);
  await waitFor(() => app.lastFrame()?.includes("权限确认"));
  assert.match(app.lastFrame(), /允许？y 同意/);
  app.stdin.write("y");
  await chat;
  assert.equal(existsSync(file), true);
  assert.equal(controller.getSnapshot().permission, null);
  assert.equal(controller.getSnapshot().busy, false);
});

test("Ink confirmation handles rejection without executing", async t => {
  const dir = fixture(t);
  const file = join(dir, "denied.txt");
  const mock = clientFor([message([tool("write", "write_file", { file_path: file, content: "hello" })]), done()]);
  const controller = new ReplController({ store: new SessionStore(join(dir, "sessions")), config: { model: "test" }, client: mock.client, permissionRules: emptyRules() });
  const app = render(createElement(ReplApp, { controller }));
  t.after(() => app.unmount());
  const chat = controller.submit("write");
  await waitFor(() => app.lastFrame()?.includes("权限确认"));
  app.stdin.write("n");
  await chat;
  assert.equal(existsSync(file), false);
  assert.match(mock.requests[1].messages.at(-1).content[0].content, /用户拒绝/);
});

test("REPL /permission changes the existing Agent mode without losing the conversation", async t => {
  const dir = fixture(t);
  const shell = id => message([tool(id, "run_shell", { command: "git push origin main" })]);
  const mock = clientFor([shell("denied"), done(), shell("allowed"), done()]);
  const store = new SessionStore(join(dir, "sessions"));
  const controller = new ReplController({ store, config: { model: "test" }, client: mock.client, permissionRules: emptyRules() });
  const id = controller.getSnapshot().id;
  let executions = 0;
  controller.agent.runTool = async () => { executions++; return "success"; };
  await controller.submit("/permission");
  assert.equal(controller.getSnapshot().permissionMode, "default");
  assert.equal(mock.requests.length, 0);
  await controller.submit("/permission dontAsk");
  await controller.submit("first");
  assert.equal(executions, 0);
  assert.match(mock.requests[1].messages.at(-1).content[0].content, /dontAsk/);
  await controller.submit("/permission bypassPermissions");
  await controller.submit("second");
  assert.equal(executions, 1);
  assert.equal(controller.getSnapshot().id, id);
  assert.equal(controller.getSnapshot().permissionMode, "bypassPermissions");
  assert.equal(mock.requests[2].messages[0].content, "first");
  await assert.rejects(controller.submit("/permission plan"), /权限模式可选/);
  assert.equal(controller.getSnapshot().permissionMode, "bypassPermissions");
  assert.ok(!JSON.stringify(store.load(id).state.messages).includes("/permission"));
});

test("switching sessions loads rules from the target cwd and preserves the selected mode", async t => {
  const dir = fixture(t);
  const previousCwd = process.cwd();
  const previousHome = process.env.HOME;
  const first = join(dir, "first");
  const second = join(dir, "second");
  for (const path of [first, second]) mkdirSync(join(path, ".claude"), { recursive: true });
  writeFileSync(join(first, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["read_file"] } }));
  writeFileSync(join(second, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["web_fetch"] } }));
  process.env.HOME = join(dir, "empty-home");
  const store = new SessionStore(join(dir, "sessions"));
  const a = store.create(first, { model: "test" }, "");
  const b = store.create(second, { model: "test" }, "");
  try {
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
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
});

test("cancelling a pending confirmation releases it without executing", async t => {
  const dir = fixture(t);
  const file = join(dir, "cancelled.txt");
  const mock = clientFor([message([tool("write", "write_file", { file_path: file, content: "hello" })])]);
  const controller = new ReplController({ store: new SessionStore(join(dir, "sessions")), config: { model: "test" }, client: mock.client, permissionRules: emptyRules() });
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
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "message_start", message: { ...message([]), stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 } } });
    if (requests.length === 1) {
      send({ type: "content_block_start", index: 0, content_block: tool("write", "write_file", {}) });
      send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: file, content: "hello" }) } });
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
    } else {
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "denied" } });
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    }
    send({ type: "message_stop" });
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const entry = fileURLToPath(new URL("../src/run.ts", import.meta.url));
  const env = { ...process.env, HOME: dir, MINI_CLAUDE_ENV_FILE: join(dir, "missing.env"),
    ANTHROPIC_API_KEY: "test", ANTHROPIC_MODEL: "test", ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const { stdout } = await promisify(execFile)(process.execPath, [entry, "create a file"], { cwd: dir, env, timeout: 10000 });
  assert.match(stdout, /denied/);
  assert.equal(existsSync(file), false);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content[0].content, /用户拒绝/);
});
