import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoryDir } from "../src/memory.ts";
import { applyEvent, emptyState } from "../src/session.ts";
import { makeAgent, message, mockClient, text, toolUse, useTempDir } from "./helpers.mjs";

const searchTool = id => message([toolUse(id, "tool_search", { query: "example_tool" })]);
const selection = () => text('{"selected_memories":["project_deploy.md"]}');

function fixture(t) {
  useTempDir(t);
  const file = join(getMemoryDir(), "project_deploy.md");
  writeFileSync(file, "---\nname: deploy\ndescription: deployment target\ntype: project\n---\nDeploy to staging.");
  return file;
}

test("prefetch runs alongside the first request and is injected once on a later iteration", async t => {
  const file = fixture(t);
  const sideReply = Promise.withResolvers();
  const events = [];
  // 召回请求在主请求之前发出；主请求进行中召回才完成。
  const mock = mockClient([
    () => sideReply.promise,
    async () => {
      assert.equal(mock.creates.length, 1);
      sideReply.resolve(selection());
      await new Promise(resolve => setImmediate(resolve));
      return searchTool("one");
    },
    searchTool("two"), text("done"), text("done"),
  ]);
  const agent = makeAgent(mock.client, { maxContext: null, onEvent: event => events.push(event) });

  await agent.chat("部署到哪里");
  const sideRequest = mock.creates[0].params.messages[0].content;
  assert.match(sideRequest, /Query: 部署到哪里/);
  assert.match(sideRequest, /project_deploy\.md/);
  assert.doesNotMatch(sideRequest, /Deploy to staging/); // 选择时只看描述，不看正文。
  assert.doesNotMatch(JSON.stringify(mock.streams[0].messages), /Deploy to staging/);
  for (const request of mock.streams.slice(1, 3)) {
    assert.equal(JSON.stringify(request.messages).split("Deploy to staging").length - 1, 1);
  }
  assert.ok(agent.alreadySurfacedMemories.has(file));
  assert.ok(agent.sessionMemoryBytes > 0);

  await agent.chat("部署方式");
  assert.equal(mock.creates.length, 1); // 已展示的记忆不会再次交给选择模型。
  assert.equal(events.filter(event => event.type === "message" && typeof event.message.content === "string"
    && event.message.content.includes("<system-reminder>")).length, 1);
  const replayed = emptyState();
  for (const event of events) applyEvent(replayed, event);
  assert.deepEqual(replayed, agent.snapshot());
});

test("a slow prefetch does not delay a response without tool iterations", { timeout: 1000 }, async t => {
  fixture(t);
  const sideReply = Promise.withResolvers();
  const mock = mockClient([() => sideReply.promise, text("done")]);
  const agent = makeAgent(mock.client, { maxContext: null });

  await agent.chat("部署到哪里"); // 此时召回还没有完成。
  assert.equal(mock.creates.length, 1);
  assert.doesNotMatch(JSON.stringify(agent.snapshot().messages), /Deploy to staging/);
  sideReply.resolve(selection());
  await new Promise(resolve => setImmediate(resolve));
});
