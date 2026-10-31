import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { SessionStore } from "../src/session.ts";
import { addUsage, formatUsage, readUsage } from "../src/usage.ts";

const response = usage => ({
  id: "test", type: "message", role: "assistant", model: "test", stop_reason: "end_turn",
  content: [{ type: "text", text: "done" }], usage,
});

test("cache reads and writes are included in input and displayed separately", () => {
  const usage = readUsage({ input_tokens: 108, output_tokens: 91,
    cache_read_input_tokens: 14813, cache_creation_input_tokens: 0 });
  assert.deepEqual(usage, { input: 14921, output: 91, cacheRead: 14813, cacheWrite: 0 });
  assert.equal(formatUsage(usage), "输入 14921 / 输出 91（缓存命中 14813 / 缓存写入 0）");
  assert.deepEqual(readUsage({ input_tokens: 10 }), { input: 10, output: null });
  assert.deepEqual(addUsage({ input: 10, output: 2 }, usage),
    { input: 14931, output: 93, cacheRead: 14813, cacheWrite: 0 });
});

test("turn and session totals include cache usage and survive session replay", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mini-cache-usage-"));
  const previousDir = process.cwd();
  const previousHome = process.env.HOME;
  process.chdir(dir);
  process.env.HOME = dir;
  t.after(() => {
    process.chdir(previousDir);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  });
  const store = new SessionStore(join(dir, "sessions"));
  const session = store.create(dir, { model: "test" }, "");
  // 旧格式的使用记录没有缓存字段，仍然可以读取和累加。
  store.append(session.header.id, { type: "usage", purpose: "chat", usage: { input: 7, output: 2 } });
  const replies = [
    response({ input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 }),
    response({ input_tokens: 108, output_tokens: 91, cache_read_input_tokens: 14813, cache_creation_input_tokens: 0 }),
  ];
  const client = { messages: { stream() {
    const reply = replies.shift();
    return { on() {}, async finalMessage() { return reply; } };
  } } };
  const agent = new Agent({ config: { model: "test" }, state: store.load(session.header.id).state,
    instructions: "", maxContext: null, permissionRules: { allow: [], deny: [] }, client,
    onEvent: event => store.append(session.header.id, event), onOutput() {} });

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
