import { test } from "node:test";
import assert from "node:assert/strict";
import { makeAgent, message, mockClient, useTempDir } from "./helpers.mjs";

for (const [name, model, thinking, expected] of [
  ["disabled", "test-model", false, undefined],
  ["enabled", "test-model", true, { type: "enabled", budget_tokens: 4095 }],
  ["model default", "MiniMax-M3.1", false, { type: "enabled", budget_tokens: 10000 }],
]) {
  test(`thinking ${name}: request parameters and filtered history`, async t => {
    useTempDir(t);
    const events = [];
    const mock = mockClient([message([{ type: "thinking", thinking: "private", signature: "signature" }, { type: "text", text: "answer" }])]);
    const agent = makeAgent(mock.client, { config: { model }, thinking, onEvent: event => events.push(event) });
    await agent.chat("hello");
    const request = mock.requests[0];
    assert.deepEqual(request.thinking, expected);
    if (expected) assert.ok(expected.budget_tokens < request.max_tokens);
    assert.deepEqual(agent.snapshot().messages.at(-1).content, [{ type: "text", text: "answer" }]);
    assert.ok(!JSON.stringify(events).includes("private")); // thinking 不进入历史和 JSONL。
  });
}
