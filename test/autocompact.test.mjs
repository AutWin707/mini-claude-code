import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { AUTO_COMPACT_RATIO, DEFAULT_MAX_CONTEXT } from "../src/agent.ts";
import { ReplController } from "../src/repl.ts";
import { SessionStore } from "../src/session.ts";
import { emptyRules, makeAgent, message, mockClient, text, toolUse, useTempDir } from "./helpers.mjs";

test("auto compact uses last usage including cache, preserves the new user input and persists replayable state", async t => {
  const dir = useTempDir(t);
  const store = new SessionStore(join(dir, "sessions"));
  const session = store.create(dir, { model: "test" }, "");
  const usage = { input_tokens: 3000, output_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 3000 };
  const mock = mockClient([text("old answer", { usage }), text("concise summary"), text("new answer")]);
  const output = [];
  const agent = makeAgent(mock.client, { state: session.state, maxContext: 10000,
    onEvent: event => store.append(session.header.id, event), onOutput: entry => output.push(entry) });
  const latest = "最新请求必须原样保留";
  await agent.chat("original request " + "x".repeat(5000));
  assert.equal(mock.creates.length, 0); // 缓存 token 计入后才超过 80%。
  const abort = new AbortController();
  await agent.chat(latest, abort.signal);

  assert.equal(mock.creates.length, 1);
  assert.equal(mock.creates[0].options.signal, abort.signal);
  const transcript = mock.creates[0].params.messages[0].content;
  assert.match(transcript, /original request/);
  assert.match(transcript, /old answer/);
  assert.ok(!transcript.includes(latest));
  const request = mock.streams[1].messages;
  assert.equal(request.length, 2);
  assert.match(request[0].content, /concise summary/);
  assert.equal(request[1].content, latest);
  assert.deepEqual(store.load(session.header.id).state, agent.snapshot());
  assert.equal(agent.snapshot().messageCount, 4);
  assert.deepEqual(output.filter(entry => entry.type === "note").map(entry => entry.text),
    [`上下文达到上限的 ${AUTO_COMPACT_RATIO * 100}%，正在自动压缩…`, "上下文已自动压缩。"]);
});

test("when usage is unavailable the size estimate triggers compaction", async t => {
  useTempDir(t);
  const mock = mockClient([text("old answer", { usage: null }), text("summary"), text("done")]);
  const agent = makeAgent(mock.client);
  await agent.chat("a".repeat(50000));
  assert.equal(agent.contextAnchor, undefined);
  agent.setMaxContext(10000);
  await agent.chat("continue");
  assert.equal(mock.creates.length, 1);
  assert.equal(mock.streams[1].messages.at(-1).content, "continue");
});

test("auto compact defaults to 256K and triggers at 80 percent", async t => {
  useTempDir(t);
  const threshold = Math.floor(DEFAULT_MAX_CONTEXT * AUTO_COMPACT_RATIO);
  assert.equal(AUTO_COMPACT_RATIO, 0.8);

  const below = mockClient([text("old"), text("next")]);
  const idle = makeAgent(below.client);
  await idle.chat("old");
  // 留出余量：新用户消息本身也会计入估算。
  idle.contextAnchor = { ...idle.contextAnchor, tokens: threshold - 100 };
  await idle.chat("next");
  assert.equal(below.creates.length, 0);

  const at = mockClient([text("old"), text("summary"), text("done")]);
  const agent = makeAgent(at.client);
  // 历史需比摘要长，否则压缩会因未缩短上下文而被拒绝。
  await agent.chat("old " + "x".repeat(2000));
  agent.contextAnchor = { ...agent.contextAnchor, tokens: threshold };
  await agent.chat("next");
  assert.equal(at.creates.length, 1);
});

test("auto compact can be switched off", async t => {
  useTempDir(t);
  const mock = mockClient([text("first", { usage: { input_tokens: 100000, output_tokens: 1 } }), text("second"), text("third")]);
  const agent = makeAgent(mock.client);
  assert.equal(agent.maxContext, DEFAULT_MAX_CONTEXT);
  await agent.chat("one");
  await agent.chat("two");
  agent.setMaxContext(10000);
  agent.setMaxContext(null);
  await agent.chat("three");
  assert.equal(mock.creates.length, 0);
});

test("failed or truncated automatic summaries keep the old context and the new user message", async t => {
  useTempDir(t);
  const mock = mockClient([text("old answer", { usage: { input_tokens: 10000, output_tokens: 1 } }),
    text("partial", { stop_reason: "max_tokens" })]);
  const events = [];
  const agent = makeAgent(mock.client, { maxContext: 10000, onEvent: event => events.push(event) });
  const old = "old request " + "x".repeat(5000);
  await agent.chat(old);
  await assert.rejects(agent.chat("new request"), /原上下文已保留/);
  assert.equal(mock.streams.length, 1);
  assert.equal(events.some(event => event.type === "compact"), false);
  assert.equal(agent.snapshot().messages[0].content, old);
  assert.equal(agent.snapshot().messages.at(-1).content, "new request");
});

test("cannot compact a first oversized prompt and does not start a request", async t => {
  useTempDir(t);
  const mock = mockClient([]);
  const agent = makeAgent(mock.client, { maxContext: 100 });
  await assert.rejects(agent.chat("first prompt"), /没有可压缩的历史/);
  assert.equal(mock.calls.length, 0);
  assert.equal(agent.snapshot().messages.at(-1).content, "first prompt");
});

test("rejects an insufficient compacted context without replacing original messages", async t => {
  useTempDir(t);
  const mock = mockClient([text("old answer", { usage: { input_tokens: 20000, output_tokens: 1 } }), text("s".repeat(12000))]);
  const events = [];
  const agent = makeAgent(mock.client, { onEvent: event => events.push(event) });
  const original = "old " + "x".repeat(50000);
  await agent.chat(original);
  agent.setMaxContext(2000);
  await assert.rejects(agent.chat("continue"), /压缩后仍达到最大上下文/);
  assert.equal(events.some(event => event.type === "compact"), false);
  assert.equal(agent.snapshot().messages[0].content, original);
  assert.equal(agent.snapshot().messages.at(-1).content, "continue");
});

test("manual compact summarizes all activity and does not preserve the last message separately", async t => {
  useTempDir(t);
  const mock = mockClient([text("answer"), text("short summary")]);
  const agent = makeAgent(mock.client);
  await agent.chat("long request ".repeat(200));
  await agent.compact();
  assert.equal(agent.snapshot().messages.length, 1);
  assert.match(agent.snapshot().messages[0].content, /short summary/);
  assert.match(mock.creates[0].params.messages[0].content, /long request/);
});

test("automatic compact runs at a user turn boundary, not between paired tool calls", async t => {
  useTempDir(t);
  const usage = { input_tokens: 10000, output_tokens: 1 };
  const mock = mockClient([message([toolUse("read", "list_files", { pattern: "*" })], { usage }), text("done", { usage })]);
  const agent = makeAgent(mock.client, { maxContext: 10000 });
  agent.runTool = async () => "tool output";
  await agent.chat("list");
  assert.equal(mock.streams.length, 2);
  assert.equal(mock.creates.length, 0);
  const result = mock.streams[1].messages.at(-1).content[0];
  assert.equal(result.tool_use_id, "read");
  assert.equal(result.content, "tool output");
});

test("cancelling an automatic summary preserves the conversation and releases the Agent", async t => {
  useTempDir(t);
  const started = Promise.withResolvers();
  const summary = ({ options }) => new Promise((_, reject) => {
    started.resolve();
    options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const mock = mockClient([text("answer", { usage: { input_tokens: 10000, output_tokens: 1 } }), summary]);
  const agent = makeAgent(mock.client, { maxContext: 10000 });
  await agent.chat("old " + "x".repeat(5000));
  const cancel = new AbortController();
  const next = agent.chat("new", cancel.signal);
  await started.promise;
  cancel.abort();
  await assert.rejects(next, /abort/i);
  assert.equal(agent.snapshot().messages.at(-1).content, "new");
  assert.doesNotThrow(() => agent.setMaxContext(null)); // 取消后 Agent 不再忙碌。
});

test("REPL /maxcontext validates and changes the runtime Agent setting across session switches", async t => {
  const dir = useTempDir(t);
  const store = new SessionStore(join(dir, "sessions"));
  const other = store.create(dir, { model: "test" }, "");
  const controller = new ReplController({ store, config: { model: "test" }, permissionRules: emptyRules() });
  const last = () => controller.getSnapshot().entries.at(-1).text;
  assert.equal(controller.getSnapshot().maxContext, DEFAULT_MAX_CONTEXT);
  await controller.submit("/maxcontext");
  assert.match(last(), new RegExp(`默认 ${DEFAULT_MAX_CONTEXT}`));
  await controller.submit("/maxcontext 10000");
  assert.equal(controller.getSnapshot().maxContext, 10000);
  assert.equal(controller.agent.maxContext, 10000);
  for (const invalid of ["0", "-1", "1.5", "1e4", "9007199254740992", "plan"]) {
    await assert.rejects(controller.submit(`/maxcontext ${invalid}`), /用法/);
    assert.equal(controller.getSnapshot().maxContext, 10000);
  }
  await controller.submit("/maxcontext");
  assert.match(last(), /达到 8000/);

  controller.switchSession(other.header.id);
  assert.equal(controller.agent.maxContext, 10000); // 切换会话保留设置。
  await controller.submit("/maxcontext off");
  assert.equal(controller.getSnapshot().maxContext, null);
  assert.equal(controller.agent.maxContext, null);
  assert.deepEqual(store.load(other.header.id).state.messages, []); // 设置命令不进入对话。
});
