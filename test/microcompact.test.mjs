import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { applyEvent, emptyState, MICROCOMPACT_PLACEHOLDER, SessionStore } from "../src/session.ts";

const IDLE_MS = 5 * 60 * 1000;
const tool = id => ({ type: "tool_use", id: `tool-${id}`, name: "read_file", input: { file_path: `${id}.txt` } });
const result = (id, content = `result-${id}`) => ({ type: "tool_result", tool_use_id: `tool-${id}`, content });
const response = { id: "test", type: "message", role: "assistant", model: "test", stop_reason: "end_turn",
  content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 2 } };
const rules = { allow: [], deny: [] };

function history(count = 5) {
  const ids = Array.from({ length: count }, (_, i) => i);
  return [
    { role: "user", content: "start" },
    { role: "assistant", content: ids.map(tool) },
    { role: "user", content: ids.map(id => result(id)) },
    { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
  ];
}
function clientFor() {
  const requests = [];
  return { requests, client: { messages: { stream(params) {
    requests.push(structuredClone(params));
    return { on() {}, async finalMessage() { return structuredClone(response); } };
  } } } };
}
function makeAgent(messages, client, onEvent) {
  const state = emptyState();
  state.messages = structuredClone(messages);
  state.messageCount = messages.length;
  return new Agent({ config: { model: "test" }, instructions: "", client, state,
    permissionRules: rules, onOutput() {}, onEvent });
}
function getResults(messages) {
  return messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
    ? message.content.filter(block => block.type === "tool_result") : []);
}

test("after five idle minutes old results are cleared and JSONL replays the same state", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mini-microcompact-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const messages = history();
  messages[2].content[0] = { ...result(0, [{ type: "text", text: "large original" }]), is_error: true };
  const original = structuredClone(messages);
  const store = new SessionStore(join(dir, "sessions"));
  const session = store.create(dir, { model: "test" }, "");
  for (const message of messages) store.append(session.header.id, { type: "message", message });
  const mock = clientFor();
  const agent = new Agent({ config: session.header.config, instructions: "", state: store.load(session.header.id).state,
    client: mock.client, permissionRules: rules, onOutput() {}, onEvent: event => store.append(session.header.id, event) });
  agent.lastApiCallTime = now - IDLE_MS;
  await agent.chat("continue");

  const sent = mock.requests[0].messages;
  const results = getResults(sent);
  assert.deepEqual(results.map(block => block.content), [MICROCOMPACT_PLACEHOLDER, MICROCOMPACT_PLACEHOLDER,
    "result-2", "result-3", "result-4"]);
  assert.deepEqual(results.map(block => block.tool_use_id), original[2].content.map(block => block.tool_use_id));
  assert.equal(results[0].is_error, true);
  assert.deepEqual(sent[1], original[1]); // tool_use 和 id 不变
  assert.equal(sent[3].content[0].text, "previous answer");
  assert.deepEqual(store.load(session.header.id).state, agent.snapshot());
  const log = readFileSync(store.path(session.header.id), "utf8");
  assert.match(log, /large original/); // 原始事件仍在 JSONL
  const micro = log.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "microcompact");
  assert.deepEqual(micro.targets, [[2, 0], [2, 1]]);
  assert.equal(agent.lastApiCallTime, now);
  assert.equal(agent.snapshot().lastApiCallTime, undefined); // 空闲计时不持久化
  const restored = new Agent({ config: { model: "test" }, instructions: "", client: mock.client,
    state: store.load(session.header.id).state, permissionRules: rules, onOutput() {} });
  assert.equal(restored.lastApiCallTime, 0);
});

test("real chat turns update the clock and clean old tool results on the next request", async t => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const calls = Array.from({ length: 5 }, (_, i) => ({ type: "tool_use", id: `tool-${i}`,
    name: "list_files", input: { pattern: `${i}*` } }));
  const replies = [{ ...response, stop_reason: "tool_use", content: calls }, response, response];
  const requests = [];
  const client = { messages: { stream(params) {
    requests.push(structuredClone(params));
    const reply = replies.shift();
    const listeners = {};
    return { on(event, listener) { listeners[event] = listener; }, async finalMessage() {
      for (const block of reply.content) listeners.contentBlock(block);
      return structuredClone(reply);
    } };
  } } };
  const agent = new Agent({ config: { model: "test" }, instructions: "", client, permissionRules: rules, onOutput() {} });
  agent.runTool = async call => `output-${call.id}`;
  await agent.chat("first");
  assert.equal(agent.lastApiCallTime, now);
  assert.deepEqual(getResults(agent.snapshot().messages).map(block => block.content),
    ["output-tool-0", "output-tool-1", "output-tool-2", "output-tool-3", "output-tool-4"]);
  now += IDLE_MS;
  await agent.chat("second");
  assert.deepEqual(getResults(requests[2].messages).map(block => block.content),
    [MICROCOMPACT_PLACEHOLDER, MICROCOMPACT_PLACEHOLDER, "output-tool-2", "output-tool-3", "output-tool-4"]);
  assert.equal(agent.lastApiCallTime, now);
});

test("does not clean before five minutes, without a previous call, or with three results", async t => {
  const now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  for (const [lastCall, count] of [[0, 5], [now - IDLE_MS + 1, 5], [now - IDLE_MS, 3]]) {
    const events = [];
    const mock = clientFor();
    const agent = makeAgent(history(count), mock.client, event => events.push(event));
    agent.lastApiCallTime = lastCall;
    await agent.chat("continue");
    assert.deepEqual(getResults(mock.requests[0].messages).map(block => block.content),
      Array.from({ length: count }, (_, i) => `result-${i}`));
    assert.equal(events.some(event => event.type === "microcompact"), false);
    assert.equal(agent.lastApiCallTime, now);
  }
});

test("does not write another event when old results are already cleared", async t => {
  const now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const messages = history(5);
  messages[2].content[0].content = MICROCOMPACT_PLACEHOLDER;
  messages[2].content[1].content = MICROCOMPACT_PLACEHOLDER;
  const events = [];
  const mock = clientFor();
  const agent = makeAgent(messages, mock.client, event => events.push(event));
  agent.lastApiCallTime = now - IDLE_MS;
  await agent.chat("continue");
  assert.equal(events.some(event => event.type === "microcompact"), false);
});

test("failed microcompact persistence preserves results and does not start the API request", async t => {
  const now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const mock = clientFor();
  const agent = makeAgent(history(), mock.client, event => {
    if (event.type === "microcompact") throw new Error("disk full");
  });
  agent.lastApiCallTime = now - IDLE_MS;
  await assert.rejects(agent.chat("continue"), /disk full/);
  assert.deepEqual(getResults(agent.snapshot().messages).map(block => block.content),
    ["result-0", "result-1", "result-2", "result-3", "result-4"]);
  assert.equal(mock.requests.length, 0);
});

test("microcompact validates checkpoints and all targets before modifying state", () => {
  const state = emptyState();
  state.messages = history();
  state.messageCount = state.messages.length;
  const original = structuredClone(state);
  assert.throws(() => applyEvent(state, { type: "microcompact", through: 0, targets: [[2, 0]] }), /检查点/);
  assert.throws(() => applyEvent(state, { type: "microcompact", through: state.messageCount, targets: [[2, 0], [1, 0]] }), /位置无效/);
  assert.throws(() => applyEvent(state, { type: "microcompact", through: state.messageCount, targets: [[2, 0], [2, 0]] }), /位置无效/);
  assert.deepEqual(state, original);
});

test("failed streaming does not update the last successful API call time", async t => {
  const now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const client = { messages: { stream() { return { on() {}, async finalMessage() { throw new Error("offline"); } }; } } };
  const agent = makeAgent(history(3), client);
  agent.lastApiCallTime = now - 1000;
  await assert.rejects(agent.chat("continue"), /offline/);
  assert.equal(agent.lastApiCallTime, now - 1000);
});
