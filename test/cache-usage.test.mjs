import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionStore } from "../src/session.ts";
import { addUsage, formatUsage, readUsage } from "../src/usage.ts";
import { makeAgent, mockClient, text, useTempDir } from "./helpers.mjs";

test("cache reads and writes are included in input and displayed separately", () => {
  const usage = readUsage({ input_tokens: 108, output_tokens: 91, cache_read_input_tokens: 14813, cache_creation_input_tokens: 0 });
  assert.deepEqual(usage, { input: 14921, output: 91, cacheRead: 14813, cacheWrite: 0 });
  assert.equal(formatUsage(usage), "输入 14921 / 输出 91（缓存命中 14813 / 缓存写入 0）");
  assert.deepEqual(readUsage({ input_tokens: 10 }), { input: 10, output: null });
  assert.deepEqual(addUsage({ input: 10, output: 2 }, usage), { input: 14931, output: 93, cacheRead: 14813, cacheWrite: 0 });
});

test("turn and session totals include cache usage and survive session replay", async t => {
  const dir = useTempDir(t);
  const store = new SessionStore(join(dir, "sessions"));
  const session = store.create(dir, { model: "test" }, "");
  // 旧格式的用量记录没有缓存字段，仍然可以读取和累加。
  store.append(session.header.id, { type: "usage", purpose: "chat", usage: { input: 7, output: 2 } });
  const mock = mockClient([
    text("done", { usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 } }),
    text("done", { usage: { input_tokens: 108, output_tokens: 91, cache_read_input_tokens: 14813, cache_creation_input_tokens: 0 } }),
  ]);
  const agent = makeAgent(mock.client, { state: store.load(session.header.id).state, maxContext: null,
    onEvent: event => store.append(session.header.id, event) });

  await agent.chat("one");
  assert.equal(agent.contextAnchor.tokens, 2050);
  await agent.chat("two");
  assert.equal(agent.contextAnchor.tokens, 15012); // 缓存 token 只计入一次。
  assert.deepEqual(agent.snapshot().lastTurnUsage, { input: 14921, output: 91, cacheRead: 14813, cacheWrite: 0 });
  assert.deepEqual(agent.snapshot().totalUsage, { input: 16928, output: 143, cacheRead: 14813, cacheWrite: 1000 });
  assert.deepEqual(store.load(session.header.id).state, agent.snapshot());
  assert.throws(() => store.append(session.header.id, { type: "usage", purpose: "chat",
    usage: { input: 1, output: 1, cacheRead: -1 } }), /无效/);
});
