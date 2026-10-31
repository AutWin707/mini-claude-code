import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEvent, emptyState, MICROCOMPACT_PLACEHOLDER, SessionStore } from "../src/session.ts";
import { makeAgent, message, mockClient, text, toolUse, useTempDir } from "./helpers.mjs";

const IDLE_MS = 5 * 60 * 1000;
const NOW = 1_000_000;
const result = (id, content = `result-${id}`) => ({ type: "tool_result", tool_use_id: `tool-${id}`, content });

// 一轮读取了 count 个文件的历史。
function history(count = 5) {
  const ids = Array.from({ length: count }, (_, i) => i);
  return [
    { role: "user", content: "start" },
    { role: "assistant", content: ids.map(id => toolUse(`tool-${id}`, "read_file", { file_path: `${id}.txt` })) },
    { role: "user", content: ids.map(id => result(id)) },
    { role: "assistant", content: [{ type: "text", text: "previous answer" }] },
  ];
}
function agentWithHistory(messages, client, onEvent) {
  const state = emptyState();
  state.messages = structuredClone(messages);
  state.messageCount = messages.length;
  return makeAgent(client, { state, onEvent });
}
const resultContents = messages => messages.flatMap(message => message.role === "user" && Array.isArray(message.content)
  ? message.content.filter(block => block.type === "tool_result").map(block => block.content) : []);

test("after five idle minutes old results are cleared and JSONL replays the same state", async t => {
  const dir = useTempDir(t);
  t.mock.method(Date, "now", () => NOW);
  const messages = history();
  messages[2].content[0] = { ...result(0, [{ type: "text", text: "large original" }]), is_error: true };
  const store = new SessionStore(join(dir, "sessions"));
  const session = store.create(dir, { model: "test" }, "");
  for (const message of messages) store.append(session.header.id, { type: "message", message });
  const mock = mockClient([text("done")]);
  const agent = makeAgent(mock.client, { state: store.load(session.header.id).state,
    onEvent: event => store.append(session.header.id, event) });
  agent.lastApiCallTime = NOW - IDLE_MS;
  await agent.chat("continue");

  const sent = mock.requests[0].messages;
  assert.deepEqual(resultContents(sent), [MICROCOMPACT_PLACEHOLDER, MICROCOMPACT_PLACEHOLDER, "result-2", "result-3", "result-4"]);
  assert.equal(sent[2].content[0].tool_use_id, "tool-0"); // id 与 is_error 保留，tool_use 不变。
  assert.equal(sent[2].content[0].is_error, true);
  assert.deepEqual(sent[1], messages[1]);
  assert.deepEqual(store.load(session.header.id).state, agent.snapshot());
  const log = readFileSync(store.path(session.header.id), "utf8");
  assert.match(log, /large original/); // 原始事件仍在 JSONL。
  const micro = log.trim().split("\n").map(line => JSON.parse(line)).find(event => event.type === "microcompact");
  assert.deepEqual(micro.targets, [[2, 0], [2, 1]]);
  assert.equal(agent.lastApiCallTime, NOW);
  assert.equal(agent.snapshot().lastApiCallTime, undefined); // 空闲计时不持久化。
  assert.equal(makeAgent(mock.client, { state: store.load(session.header.id).state }).lastApiCallTime, 0);
});

test("real chat turns update the clock and clean old tool results on the next turn", async t => {
  useTempDir(t);
  let now = NOW;
  t.mock.method(Date, "now", () => now);
  const calls = Array.from({ length: 5 }, (_, i) => toolUse(`tool-${i}`, "list_files", { pattern: `${i}*` }));
  const mock = mockClient([message(calls), text("done"), text("done")]);
  const agent = makeAgent(mock.client);
  agent.runTool = async call => `output-${call.id}`;
  await agent.chat("first");
  assert.equal(agent.lastApiCallTime, now);
  now += IDLE_MS;
  await agent.chat("second");
  assert.deepEqual(resultContents(mock.requests[2].messages),
    [MICROCOMPACT_PLACEHOLDER, MICROCOMPACT_PLACEHOLDER, "output-tool-2", "output-tool-3", "output-tool-4"]);
  assert.equal(agent.lastApiCallTime, now);
});

test("does not clean before five minutes, without a previous call, or with three results", async t => {
  useTempDir(t);
  t.mock.method(Date, "now", () => NOW);
  for (const [lastCall, count] of [[0, 5], [NOW - IDLE_MS + 1, 5], [NOW - IDLE_MS, 3]]) {
    const events = [];
    const mock = mockClient([text("done")]);
    const agent = agentWithHistory(history(count), mock.client, event => events.push(event));
    agent.lastApiCallTime = lastCall;
    await agent.chat("continue");
    assert.deepEqual(resultContents(mock.requests[0].messages), Array.from({ length: count }, (_, i) => `result-${i}`));
    assert.equal(events.some(event => event.type === "microcompact"), false);
  }
});

test("does not write another event when old results are already cleared", async t => {
  useTempDir(t);
  t.mock.method(Date, "now", () => NOW);
  const messages = history();
  messages[2].content[0].content = MICROCOMPACT_PLACEHOLDER;
  messages[2].content[1].content = MICROCOMPACT_PLACEHOLDER;
  const events = [];
  const agent = agentWithHistory(messages, mockClient([text("done")]).client, event => events.push(event));
  agent.lastApiCallTime = NOW - IDLE_MS;
  await agent.chat("continue");
  assert.equal(events.some(event => event.type === "microcompact"), false);
});

test("failed microcompact persistence preserves results and does not start the API request", async t => {
  useTempDir(t);
  t.mock.method(Date, "now", () => NOW);
  const mock = mockClient([]);
  const agent = agentWithHistory(history(), mock.client, event => {
    if (event.type === "microcompact") throw new Error("disk full");
  });
  agent.lastApiCallTime = NOW - IDLE_MS;
  await assert.rejects(agent.chat("continue"), /disk full/);
  assert.deepEqual(resultContents(agent.snapshot().messages), ["result-0", "result-1", "result-2", "result-3", "result-4"]);
  assert.equal(mock.calls.length, 0);
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
  useTempDir(t);
  t.mock.method(Date, "now", () => NOW);
  const agent = agentWithHistory(history(3), mockClient([new Error("offline")]).client);
  agent.lastApiCallTime = NOW - 1000;
  await assert.rejects(agent.chat("continue"), /offline/);
  assert.equal(agent.lastApiCallTime, NOW - 1000);
});
