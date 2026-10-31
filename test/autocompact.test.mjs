import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, AUTO_COMPACT_RATIO, DEFAULT_MAX_CONTEXT } from "../src/agent.ts";
import { ReplController } from "../src/repl.ts";
import { SessionStore } from "../src/session.ts";

const rules = { allow: [], deny: [] };
const msg = (content, usage = { input_tokens: 10, output_tokens: 2 }, stop_reason = "end_turn") => ({
  id: "test", type: "message", role: "assistant", model: "test", content, stop_reason, usage,
});
const text = (value, usage) => msg([{ type: "text", text: value }], usage);

function mockClient(streamReplies, summaryReplies = []) {
  const streams = [];
  const summaries = [];
  const client = { messages: {
    stream(params) {
      streams.push(structuredClone(params));
      const reply = streamReplies.shift();
      if (!reply) throw new Error("unexpected stream");
      const listeners = {};
      return { on(event, listener) { listeners[event] = listener; }, async finalMessage() {
        for (const block of reply.content) listeners.contentBlock(block);
        return structuredClone(reply);
      } };
    },
    async create(params, options) {
      summaries.push({ params: structuredClone(params), options });
      const reply = summaryReplies.shift();
      if (reply instanceof Error) throw reply;
      if (!reply) throw new Error("unexpected summary");
      return structuredClone(reply);
    },
  } };
  return { client, streams, summaries };
}
function agentFor(client, options = {}) {
  return new Agent({ config: { model: "test" }, instructions: "", permissionRules: rules,
    client, onOutput() {}, ...options });
}

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

test("auto compact uses last usage including cache, preserves the new user input and persists replayable state", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mini-autocompact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new SessionStore(join(dir, "sessions"));
  const session = store.create(dir, { model: "test" }, "");
  const usage = { input_tokens: 3000, output_tokens: 10, cache_read_input_tokens: 4000, cache_creation_input_tokens: 3000 };
  const mock = mockClient([text("old answer", usage), text("new answer")], [text("concise summary")]);
  const output = [];
  const agent = agentFor(mock.client, { state: session.state, maxContext: 10000,
    onEvent: event => store.append(session.header.id, event), onOutput: entry => output.push(entry) });
  const first = "original request " + "x".repeat(5000);
  const latest = "最新请求必须原样保留";
  await agent.chat(first);
  assert.equal(mock.summaries.length, 0);
  const abort = new AbortController();
  await agent.chat(latest, abort.signal);
  assert.equal(mock.summaries.length, 1);
  assert.equal(mock.summaries[0].options.signal, abort.signal);
  const transcript = mock.summaries[0].params.messages[0].content;
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
  assert.equal(AUTO_COMPACT_RATIO, 0.8);
});

test("when usage is unavailable the size estimate triggers compaction", async () => {
  const firstResponse = text("old answer");
  delete firstResponse.usage;
  const mock = mockClient([firstResponse, text("done")], [text("summary")]);
  const agent = agentFor(mock.client);
  await agent.chat("a".repeat(50000));
  assert.equal(agent.contextAnchor, undefined);
  agent.setMaxContext(10000);
  await agent.chat("continue");
  assert.equal(mock.summaries.length, 1);
  assert.equal(mock.streams[1].messages.at(-1).content, "continue");
});

test("auto compact defaults to 256K and triggers at 80 percent", async () => {
  const below = mockClient([text("old"), text("next")]);
  const idle = agentFor(below.client);
  await idle.chat("old");
  // 留出余量：新用户消息本身也会计入估算。
  idle.contextAnchor = { tokens: Math.floor(DEFAULT_MAX_CONTEXT * AUTO_COMPACT_RATIO) - 100, bytes: idle.contextAnchor.bytes };
  await idle.chat("next");
  assert.equal(below.summaries.length, 0);
  const atThreshold = mockClient([text("old"), text("done")], [text("summary")]);
  const agent = agentFor(atThreshold.client);
  // 历史需比摘要长，否则压缩会因未缩短上下文而被拒绝。
  await agent.chat("old " + "x".repeat(2000));
  agent.contextAnchor = { tokens: Math.floor(DEFAULT_MAX_CONTEXT * AUTO_COMPACT_RATIO), bytes: agent.contextAnchor.bytes };
  await agent.chat("next");
  assert.equal(atThreshold.summaries.length, 1);
});

test("auto compact can be switched off", async () => {
  const mock = mockClient([text("first", { input_tokens: 100000, output_tokens: 1 }), text("second"), text("third")]);
  const agent = agentFor(mock.client);
  assert.equal(agent.maxContext, DEFAULT_MAX_CONTEXT);
  await agent.chat("one");
  await agent.chat("two");
  agent.setMaxContext(10000);
  agent.setMaxContext(null);
  await agent.chat("three");
  assert.equal(mock.summaries.length, 0);
});

test("failed or truncated automatic summaries keep the old context and the new user message", async () => {
  const mock = mockClient([text("old answer", { input_tokens: 10000, output_tokens: 1 })],
    [msg([{ type: "text", text: "partial" }], { input_tokens: 1, output_tokens: 1 }, "max_tokens")]);
  const events = [];
  const agent = agentFor(mock.client, { maxContext: 10000, onEvent: event => events.push(event) });
  const old = "old request " + "x".repeat(5000);
  await agent.chat(old);
  await assert.rejects(agent.chat("new request"), /原上下文已保留/);
  assert.equal(mock.streams.length, 1);
  assert.equal(events.some(event => event.type === "compact"), false);
  assert.equal(agent.snapshot().messages[0].content, old);
  assert.equal(agent.snapshot().messages.at(-1).content, "new request");
});

test("cannot compact a first oversized prompt and does not start a request", async () => {
  const mock = mockClient([]);
  const agent = agentFor(mock.client, { maxContext: 100 });
  await assert.rejects(agent.chat("first prompt"), /没有可压缩的历史/);
  assert.equal(mock.streams.length, 0);
  assert.equal(mock.summaries.length, 0);
  assert.equal(agent.snapshot().messages.at(-1).content, "first prompt");
});

test("rejects an insufficient compacted context without replacing original messages", async () => {
  const mock = mockClient([text("old answer", { input_tokens: 20000, output_tokens: 1 })], [text("s".repeat(12000))]);
  const events = [];
  const agent = agentFor(mock.client, { onEvent: event => events.push(event) });
  const original = "old " + "x".repeat(50000);
  await agent.chat(original);
  agent.setMaxContext(2000);
  await assert.rejects(agent.chat("continue"), /压缩后仍达到最大上下文/);
  assert.equal(events.some(event => event.type === "compact"), false);
  assert.equal(agent.snapshot().messages[0].content, original);
  assert.equal(agent.snapshot().messages.at(-1).content, "continue");
});

test("manual compact still summarizes all activity and does not preserve the last message separately", async () => {
  const mock = mockClient([text("answer")], [text("short summary")]);
  const agent = agentFor(mock.client);
  await agent.chat("long request ".repeat(200));
  await agent.compact();
  assert.equal(agent.snapshot().messages.length, 1);
  assert.match(agent.snapshot().messages[0].content, /short summary/);
  assert.match(mock.summaries[0].params.messages[0].content, /long request/);
});

test("automatic compact runs at a user turn boundary, not between paired tool calls", async () => {
  const call = { type: "tool_use", id: "read", name: "list_files", input: { pattern: "*" } };
  const usage = { input_tokens: 10000, output_tokens: 1 };
  const mock = mockClient([msg([call], usage, "tool_use"), text("done", usage)]);
  const agent = agentFor(mock.client, { maxContext: 10000 });
  agent.runTool = async () => "tool output";
  await agent.chat("list");
  assert.equal(mock.streams.length, 2);
  assert.equal(mock.summaries.length, 0);
  const result = mock.streams[1].messages.at(-1).content[0];
  assert.equal(result.tool_use_id, "read");
  assert.equal(result.content, "tool output");
});

test("cancelling an automatic summary preserves the conversation and releases the Agent", async () => {
  const started = Promise.withResolvers();
  const mock = mockClient([text("answer", { input_tokens: 10000, output_tokens: 1 })]);
  mock.client.messages.create = (_params, { signal }) => new Promise((_, reject) => {
    started.resolve();
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const agent = agentFor(mock.client, { maxContext: 10000 });
  await agent.chat("old " + "x".repeat(5000));
  const cancel = new AbortController();
  const next = agent.chat("new", cancel.signal);
  await started.promise;
  cancel.abort();
  await assert.rejects(next, /abort/i);
  assert.equal(agent.snapshot().messages.at(-1).content, "new");
  assert.doesNotThrow(() => agent.setMaxContext(null));
});

test("REPL /maxcontext validates and changes the runtime Agent setting across session switches", async t => {
  const cwd = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "mini-maxcontext-"));
  t.after(() => { process.chdir(cwd); rmSync(dir, { recursive: true, force: true }); });
  const store = new SessionStore(join(dir, "sessions"));
  const other = store.create(dir, { model: "test" }, "");
  const controller = new ReplController({ store, config: { model: "test" }, permissionRules: rules });
  assert.equal(controller.getSnapshot().maxContext, DEFAULT_MAX_CONTEXT);
  await controller.submit("/maxcontext");
  await controller.submit("/maxcontext 10000");
  assert.equal(controller.getSnapshot().maxContext, 10000);
  assert.equal(controller.agent.maxContext, 10000);
  for (const invalid of ["0", "-1", "1.5", "1e4", "9007199254740992", "plan"]) {
    await assert.rejects(controller.submit(`/maxcontext ${invalid}`), /用法/);
    assert.equal(controller.getSnapshot().maxContext, 10000);
  }
  controller.switchSession(other.header.id);
  assert.equal(controller.getSnapshot().maxContext, 10000);
  assert.equal(controller.agent.maxContext, 10000);
  await controller.submit("/maxcontext off");
  assert.equal(controller.getSnapshot().maxContext, null);
  assert.equal(controller.agent.maxContext, null);
  await controller.submit("/maxcontext");
  assert.match(controller.getSnapshot().entries.at(-1).text, new RegExp(`默认 ${DEFAULT_MAX_CONTEXT}`));
  await controller.submit("/maxcontext 262144");
  await controller.submit("/maxcontext");
  assert.match(controller.getSnapshot().entries.at(-1).text, /达到 209715/);
  await controller.submit("/maxcontext 10000");
  await controller.submit("/maxcontext");
  assert.match(controller.getSnapshot().entries.at(-1).text, /达到 8000/);

  assert.deepEqual(store.load(other.header.id).state.messages, []);
});
