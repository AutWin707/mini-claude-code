import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { SessionStore } from "../src/session.ts";
import { ReplController } from "../src/repl.ts";
import { formatUsage, readUsage } from "../src/usage.ts";
import { emptyRules, makeAgent, message, mockClient, text, toolUse, useTempDir } from "./helpers.mjs";

function fixture(t) {
  const dir = useTempDir(t);
  return { dir, store: new SessionStore(join(dir, "sessions")) };
}
function storedAgent(store, session, client) {
  return new Agent({ config: session.header.config, instructions: session.header.instructions, state: session.state,
    client, permissionRules: emptyRules(), onOutput() {}, onEvent: event => store.append(session.header.id, event) });
}

test("JSONL restores messages, usage and title without storing credentials", t => {
  const { dir, store } = fixture(t);
  const session = store.create(dir, { model: "test-model", apiKey: "never-store-this" }, "rules");
  const id = session.header.id;
  store.append(id, { type: "turn_start" });
  store.append(id, { type: "message", message: { role: "user", content: "hello" } });
  store.append(id, { type: "usage", purpose: "chat", usage: { input: 20, output: 4 } });
  store.append(id, { type: "turn_end" });
  store.append(id, { type: "title", title: "first session" });
  const restored = store.load(id);
  assert.equal(restored.state.messages[0].content, "hello");
  assert.deepEqual(restored.state.totalUsage, { input: 20, output: 4 });
  assert.equal(restored.state.completedTurns, 1);
  assert.equal(restored.state.title, "first session");
  assert.equal(restored.header.instructions, "rules");
  assert.doesNotMatch(readFileSync(store.path(id), "utf8"), /never-store-this|apiKey/);
  assert.throws(() => store.load("../../other"), /UUID/);
  assert.throws(() => store.create(dir, { model: "x", baseURL: "https://user:secret@example.com" }, ""), /凭据/);
});

test("incomplete JSONL tails are ignored and repaired before appending", t => {
  const { dir, store } = fixture(t);
  const id = store.create(dir, { model: "test" }, "").header.id;
  appendFileSync(store.path(id), '{"type":"message","message":"半条');
  assert.deepEqual(store.load(id).state.messages, []);
  store.append(id, { type: "title", title: "repaired" });
  assert.equal(store.load(id).state.title, "repaired");
  assert.doesNotMatch(readFileSync(store.path(id), "utf8"), /半条/);
  appendFileSync(store.path(id), "broken-middle\n");
  const before = readFileSync(store.path(id), "utf8");
  assert.throws(() => store.load(id), /损坏/);
  assert.throws(() => store.append(id, { type: "turn_start" }), /损坏/);
  assert.equal(readFileSync(store.path(id), "utf8"), before);
  assert.equal(store.list().errors.length, 1);
});

test("clear only resets visible entries; chat continues with the same JSONL and context", async t => {
  const { store } = fixture(t);
  const mock = mockClient([text("answer-one"), text("title-one"), text("answer-two")]);
  const controller = new ReplController({ store, config: { model: "test" }, client: mock.client, permissionRules: emptyRules() });
  await controller.submit("/chat first-question");
  const before = controller.getSnapshot();
  assert.deepEqual(before.entries.map(entry => entry.type), ["user", "assistant"]);
  assert.equal(before.entries[0].text, "first-question");
  assert.equal(before.entries[1].text, "answer-one");
  const jsonl = readFileSync(store.path(before.id), "utf8");
  await controller.submit("/clear");
  assert.deepEqual(controller.getSnapshot(), { ...before, entries: [] });
  assert.equal(readFileSync(store.path(before.id), "utf8"), jsonl);
  await controller.submit("second-question");
  assert.equal(controller.getSnapshot().id, before.id);
  assert.deepEqual(mock.calls.map(call => call.kind), ["stream", "create", "stream"]); // 标题只生成一次。
  assert.equal(mock.requests[2].messages[0].content, "first-question");
  assert.equal(mock.requests[2].messages.at(-1).content, "second-question");
  assert.deepEqual(controller.getSnapshot().totalUsage, { input: 30, output: 6 });
  assert.deepEqual(controller.getSnapshot().lastTurnUsage, { input: 10, output: 2 });
});

test("compact preserves original JSONL and restores the checkpoint on restart", async t => {
  const { dir, store } = fixture(t);
  const session = store.create(dir, { model: "test" }, "preserved instruction");
  const mock = mockClient([text("long answer ".repeat(200)), text("short summary"), text("continued")]);
  const agent = storedAgent(store, session, mock.client);
  await agent.chat("long request ".repeat(200));
  const original = readFileSync(store.path(session.header.id), "utf8");
  const before = agent.snapshot();
  await agent.compact();
  const after = agent.snapshot();
  assert.equal(after.messages.length, 1);
  assert.match(after.messages[0].content, /short summary/);
  assert.match(after.messages[0].content, /preserved instruction/);
  assert.equal(after.messageCount, before.messageCount);
  assert.deepEqual(after.lastTurnUsage, before.lastTurnUsage);
  assert.deepEqual(after.totalUsage, { input: 20, output: 4 });
  assert.ok(readFileSync(store.path(session.header.id), "utf8").startsWith(original)); // 只追加，不改写原记录。
  const restored = storedAgent(store, store.load(session.header.id), mock.client);
  assert.deepEqual(restored.snapshot(), after);
  await restored.chat("next");
  assert.equal(mock.requests[1].tools, undefined); // 压缩请求不带工具。
  assert.equal(mock.requests[2].messages.length, 2);
  assert.match(mock.requests[2].messages[0].content, /short summary/);
  assert.doesNotMatch(JSON.stringify(mock.requests[2].messages), /long answer/);
});

test("failed, truncated and non-shrinking compact responses preserve context", async t => {
  const { dir, store } = fixture(t);
  const session = store.create(dir, { model: "test" }, "");
  const mock = mockClient([text("answer ".repeat(200)), new Error("offline"),
    text("partial", { stop_reason: "max_tokens" }), text("huge".repeat(10000))]);
  const agent = storedAgent(store, session, mock.client);
  await agent.chat("request");
  const before = agent.snapshot().messages;
  for (const expected of [/offline/, /完整摘要/, /未缩短/]) {
    await assert.rejects(agent.compact(), expected);
    assert.deepEqual(agent.snapshot().messages, before);
  }
  assert.doesNotMatch(readFileSync(store.path(session.header.id), "utf8"), /"type":"compact"/);
  assert.deepEqual(agent.snapshot().totalUsage, { input: 30, output: 6 }); // 失败请求不计用量。
});

test("compact persistence failure never replaces the in-memory context", async t => {
  useTempDir(t);
  const mock = mockClient([text("answer ".repeat(200)), text("summary")]);
  const agent = makeAgent(mock.client, { onEvent: event => { if (event.type === "compact") throw new Error("disk full"); } });
  await agent.chat("hello");
  const before = agent.snapshot().messages;
  await assert.rejects(agent.compact(), /disk full/);
  assert.deepEqual(agent.snapshot().messages, before);
});

test("title retries at most three times and persists a unique fallback only once", async t => {
  const { dir, store } = fixture(t);
  const session = store.create(dir, { model: "test" }, "");
  const mock = mockClient([text("answer"), text(""), text(""), text(""), text("")]);
  const agent = storedAgent(store, session, mock.client);
  await agent.chat("hello");
  await agent.ensureTitle(session.header.id);
  await agent.ensureTitle(session.header.id);
  assert.equal(mock.creates.length, 4);
  assert.equal(store.load(session.header.id).state.title, `会话 ${session.header.id}`);
  assert.deepEqual(agent.snapshot().totalUsage, { input: 50, output: 10 });
  assert.deepEqual(agent.snapshot().lastTurnUsage, { input: 10, output: 2 }); // 标题用量不计入本轮。
});

test("switching restores cwd, model, tool state and usage, with isolated deferred tools", async t => {
  const { dir, store } = fixture(t);
  const firstDir = join(dir, "first");
  const secondDir = join(dir, "second");
  mkdirSync(firstDir);
  mkdirSync(secondDir);
  const file = join(firstDir, "hello.txt");
  writeFileSync(file, "hello");
  const first = store.create(firstDir, { model: "first-model" }, "");
  const second = store.create(secondDir, { model: "second-model" }, "");
  const mock = mockClient([
    message([toolUse("search", "tool_search", { query: "example_tool" }), toolUse("read", "read_file", { file_path: file })]),
    text("first done"), text("first title"),
    text("second done"), text("second title"),
    message([toolUse("edit", "edit_file", { file_path: file, old_string: "hello", new_string: "hi" })]),
    text("edited"),
  ]);
  const controller = new ReplController({ store, config: { model: "initial" }, client: mock.client, permissionRules: emptyRules() });
  controller.switchSession(first.header.id);
  await controller.submit("first");
  assert.equal(store.load(first.header.id).state.activatedTools[0], "example_tool");

  controller.switchSession(second.header.id);
  assert.equal(process.cwd(), secondDir);
  assert.deepEqual(controller.getSnapshot().totalUsage, { input: 0, output: 0 });
  await controller.submit("second");
  assert.equal(mock.requests[3].model, "second-model");
  assert.ok(!mock.requests[3].tools.some(tool => tool.name === "example_tool"));

  controller.switchSession(first.header.id);
  assert.equal(process.cwd(), firstDir);
  assert.deepEqual(controller.getSnapshot().totalUsage, { input: 30, output: 6 });
  await controller.submit("edit the read file");
  assert.equal(mock.requests[5].model, "first-model");
  assert.ok(mock.requests[5].tools.some(tool => tool.name === "example_tool"));
  assert.equal(readFileSync(file, "utf8"), "hi"); // 恢复的读取状态允许编辑。

  const before = controller.getSnapshot();
  const missing = store.create(join(dir, "missing"), { model: "test" }, "");
  assert.throws(() => controller.switchSession(missing.header.id), /无法恢复会话工作目录/);
  assert.deepEqual(controller.getSnapshot(), before);
  assert.equal(process.cwd(), firstDir);
});

test("busy operations reject duplicate chat, switching, clear and compact", async t => {
  const { store } = fixture(t);
  const answer = Promise.withResolvers();
  const mock = mockClient([() => answer.promise, text("title")]);
  const controller = new ReplController({ store, config: { model: "test" }, client: mock.client, permissionRules: emptyRules() });
  const pending = controller.submit("hello");
  assert.equal(controller.getSnapshot().busy, true);
  await assert.rejects(controller.submit("duplicate"), /正在处理/);
  await assert.rejects(controller.submit("/compact"), /正在处理/);
  assert.throws(() => controller.clear(), /正在处理/);
  assert.throws(() => controller.switchSession(controller.getSnapshot().id), /正在处理/);
  answer.resolve(text("done"));
  await pending;
  assert.equal(controller.getSnapshot().busy, false);
});

test("interrupted tool calls receive error results without repeating side effects", async t => {
  const { dir, store } = fixture(t);
  const file = join(dir, "must-not-create.txt");
  const session = store.create(dir, { model: "test" }, "");
  store.append(session.header.id, { type: "message", message: { role: "user", content: "hello" } });
  store.append(session.header.id, { type: "message", message: { role: "assistant", content: [
    toolUse("interrupted", "write_file", { file_path: file, content: "unsafe-repeat" }),
  ] } });
  const mock = mockClient([text("done")]);
  const agent = storedAgent(store, store.load(session.header.id), mock.client);
  await agent.chat("continue carefully");
  assert.equal(existsSync(file), false);
  const result = mock.requests[0].messages[2].content[0];
  assert.equal(result.tool_use_id, "interrupted");
  assert.equal(result.is_error, true);
});

test("missing usage stays unavailable instead of resetting the total to zero", async t => {
  useTempDir(t);
  const mock = mockClient([text("first"), text("second", { usage: null })]);
  const agent = makeAgent(mock.client);
  await agent.chat("one");
  await agent.chat("two");
  assert.deepEqual(agent.snapshot().totalUsage, { input: null, output: null });
  assert.match(formatUsage(agent.snapshot().lastTurnUsage), /不可用/);
  assert.deepEqual(readUsage({ input_tokens: 10 }), { input: 10, output: null });
});
