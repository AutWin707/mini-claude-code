import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.ts";

for (const [name, model, thinking, expected] of [
  ["disabled", "test-model", false, undefined],
  ["enabled", "test-model", true, { type: "enabled", budget_tokens: 4095 }],
  ["adaptive", "MiniMax-M3.1", false, { type: "enabled", budget_tokens: 10000 }],
]) {
  test(`thinking ${name}: request parameters and filtered history`, async () => {
    let request;
    const events = [];
    const response = {
      id: "test", type: "message", role: "assistant", model, stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "private", signature: "signature" }, { type: "text", text: "answer" }],
      usage: { input_tokens: 10, output_tokens: 2 },
    };
    const client = { messages: { stream(params) {
      request = structuredClone(params);
      return { on() {}, async finalMessage() { return response; } };
    } } };
    const agent = new Agent({ config: { model }, thinking, client, instructions: "", onOutput() {}, onEvent: event => events.push(event) });
    await agent.chat("hello");
    assert.deepEqual(request.thinking, expected);
    if (expected) assert.ok(expected.budget_tokens < request.max_tokens);
    assert.deepEqual(agent.snapshot().messages.at(-1).content, [{ type: "text", text: "answer" }]);
    assert.ok(!JSON.stringify(events).includes("private"));
  });
}
