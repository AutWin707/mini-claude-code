import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ReplController } from "../src/repl.ts";
import { SessionStore } from "../src/session.ts";
import { ReplApp } from "../src/ui.ts";
import { emptyRules, makeAgent, message, mockClient, text, useTempDir } from "./helpers.mjs";

const thinkingBlock = { type: "thinking", thinking: "First, consider the answer.", signature: "signature" };
const textBlock = { type: "text", text: "The answer." };

// 兼容服务返回 thinking 的三种方式：增量事件、完整块事件、只在最终消息里。
for (const variant of ["delta", "block", "final"]) {
  test(`thinking display handles ${variant} without duplicate output or history`, async t => {
    useTempDir(t);
    const output = [];
    const events = [];
    const mock = mockClient([({ emit }) => {
      if (variant === "delta") {
        emit("thinking", "First, ");
        emit("thinking", "consider the answer.");
      }
      if (variant !== "final") emit("contentBlock", thinkingBlock);
      emit("text", "The answer.");
      return message([thinkingBlock, textBlock]);
    }]);
    const agent = makeAgent(mock.client, { onOutput: entry => output.push(entry), onEvent: event => events.push(event) });
    await agent.chat("hello");
    assert.equal(output.filter(entry => entry.type === "thinking").map(entry => entry.text).join(""), thinkingBlock.thinking);
    assert.equal(output.filter(entry => entry.type === "text").map(entry => entry.text).join(""), textBlock.text);
    if (variant !== "final") assert.equal(output[0].type, "thinking");
    assert.deepEqual(agent.snapshot().messages.at(-1).content, [textBlock]);
    assert.ok(!JSON.stringify(events).includes(thinkingBlock.thinking));
  });
}

test("TUI shows streaming thinking separately and does not persist it", async t => {
  const dir = useTempDir(t);
  const previousColor = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  t.after(() => {
    if (previousColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previousColor;
  });
  const firstChunk = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const mock = mockClient([async ({ emit }) => {
    emit("thinking", "First, ");
    firstChunk.resolve();
    await finish.promise;
    emit("thinking", "consider the answer.");
    emit("contentBlock", thinkingBlock);
    emit("text", "The answer.");
    return message([thinkingBlock, textBlock]);
  }, text("Title")]);
  const store = new SessionStore(join(dir, "sessions"));
  const controller = new ReplController({ store, config: { model: "MiniMax-M3.1" }, client: mock.client, permissionRules: emptyRules() });
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
  assert.match(frame, /Coding Agent Lab/);
  assert.match(frame, /First, consider the answer\./);
  assert.match(frame, /\u001b\[3m/); // 斜体
  assert.match(frame, /\u001b\[90m/); // 灰色
  assert.match(frame, /The answer\./);
  assert.ok(!readFileSync(store.path(controller.getSnapshot().id), "utf8").includes(thinkingBlock.thinking));
});
