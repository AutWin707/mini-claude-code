import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { Agent } from "../src/agent.ts";
import { ReplController } from "../src/repl.ts";
import { SessionStore } from "../src/session.ts";
import { ReplApp } from "../src/ui.ts";

const thinkingBlock = { type: "thinking", thinking: "First, consider the answer.", signature: "signature" };
const textBlock = { type: "text", text: "The answer." };
const response = content => ({
  id: "test", type: "message", role: "assistant", model: "test", stop_reason: "end_turn",
  content, usage: { input_tokens: 10, output_tokens: 2 },
});

for (const variant of ["delta", "block", "final"]) {
  test(`thinking display handles ${variant} without duplicate output or history`, async () => {
    const output = [];
    const events = [];
    const listeners = {};
    const client = { messages: { stream() {
      return {
        on(event, listener) { listeners[event] = listener; },
        async finalMessage() {
          if (variant === "delta") {
            listeners.thinking("First, ");
            listeners.thinking("consider the answer.");
          }
          if (variant !== "final") listeners.contentBlock(thinkingBlock);
          listeners.text("The answer.");
          return response([thinkingBlock, textBlock]);
        },
      };
    } } };
    const agent = new Agent({ config: { model: "test" }, client, instructions: "",
      onOutput: entry => output.push(entry), onEvent: event => events.push(event) });
    await agent.chat("hello");
    assert.equal(output.filter(entry => entry.type === "thinking").map(entry => entry.text).join(""), thinkingBlock.thinking);
    assert.equal(output.filter(entry => entry.type === "text").map(entry => entry.text).join(""), textBlock.text);
    if (variant !== "final") assert.equal(output[0].type, "thinking");
    assert.deepEqual(agent.snapshot().messages.at(-1).content, [textBlock]);
    assert.ok(!JSON.stringify(events).includes(thinkingBlock.thinking));
  });
}

test("TUI shows streaming thinking separately and does not persist it", async t => {
  const dir = mkdtempSync(join(tmpdir(), "mini-thinking-ui-"));
  const previousColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  t.after(() => {
    if (previousColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previousColor;
    rmSync(dir, { recursive: true, force: true });
  });
  const firstChunk = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const client = { messages: {
    stream() {
      const listeners = {};
      return {
        on(event, listener) { listeners[event] = listener; },
        async finalMessage() {
          listeners.thinking("First, ");
          firstChunk.resolve();
          await finish.promise;
          listeners.thinking("consider the answer.");
          listeners.contentBlock(thinkingBlock);
          listeners.text("The answer.");
          return response([thinkingBlock, textBlock]);
        },
      };
    },
    async create() { return response([{ type: "text", text: "Title" }]); },
  } };
  const store = new SessionStore(join(dir, "sessions"));
  const controller = new ReplController({ store, config: { model: "MiniMax-M3.1" }, client });
  const app = render(createElement(ReplApp, { controller }));
  t.after(() => app.unmount());
  const pending = controller.submit("hello");
  await firstChunk.promise;
  assert.deepEqual(controller.getSnapshot().entries.at(-1), { type: "thinking", text: "First, " });
  finish.resolve();
  await pending;
  assert.deepEqual(controller.getSnapshot().entries.map(entry => entry.type), ["user", "thinking", "assistant"]);
  assert.equal(controller.getSnapshot().entries[1].text, thinkingBlock.thinking);
  for (let i = 0; i < 50 && !app.lastFrame()?.includes("consider the answer"); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const frame = app.lastFrame();
  assert.match(frame, /First, consider the answer\./);
  assert.match(frame, /\u001b\[3m/);
  assert.match(frame, /\u001b\[90m/);
  assert.match(frame, /The answer\./);
  assert.ok(!readFileSync(store.path(controller.getSnapshot().id), "utf8").includes(thinkingBlock.thinking));
});
