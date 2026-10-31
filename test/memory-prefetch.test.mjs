import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { getMemoryDir } from "../src/memory.ts";
import { applyEvent, emptyState } from "../src/session.ts";

const message = (content, stop_reason = "end_turn") => ({
  id: "test", type: "message", role: "assistant", model: "test", content, stop_reason,
  usage: { input_tokens: 10, output_tokens: 2 },
});
const done = () => message([{ type: "text", text: "done" }]);
const tool = id => message([{ type: "tool_use", id, name: "tool_search", input: { query: "example_tool" } }], "tool_use");
const selection = () => message([{ type: "text", text: '{"selected_memories":["project_deploy.md"]}' }]);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mini-memory-prefetch-"));
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
  const file = join(getMemoryDir(), "project_deploy.md");
  writeFileSync(file, "---\nname: deploy\ndescription: deployment target\ntype: project\n---\nDeploy to staging.");
  return file;
}

function agentFor(client, onEvent = () => {}) {
  return new Agent({ config: { model: "test" }, instructions: "", maxContext: null,
    permissionRules: { allow: [], deny: [] }, client, onEvent, onOutput() {} });
}

test("prefetch runs alongside the first request and is injected once on a later iteration", async t => {
  const file = fixture(t);
  const sideReply = Promise.withResolvers();
  const requests = [];
  const events = [];
  const replies = [tool("one"), tool("two"), done(), done()];
  let sideCalls = 0;
  let sideRequest;
  const client = { messages: {
    create(params) {
      sideCalls++;
      sideRequest = structuredClone(params);
      return sideReply.promise;
    },
    stream(params) {
      const index = requests.length;
      requests.push(structuredClone(params));
      return { on() {}, async finalMessage() {
        if (index === 0) {
          assert.equal(sideCalls, 1); // sideQuery 未完成，主请求已开始。
          sideReply.resolve(selection());
          await new Promise(resolve => setImmediate(resolve));
        }
        return replies[index];
      } };
    },
  } };
  const agent = agentFor(client, event => events.push(event));

  await agent.chat("部署到哪里");
  assert.match(sideRequest.messages[0].content, /Query: 部署到哪里/);
  assert.match(sideRequest.messages[0].content, /project_deploy\.md/);
  assert.doesNotMatch(sideRequest.messages[0].content, /Deploy to staging/);
  assert.doesNotMatch(JSON.stringify(requests[0].messages), /Deploy to staging/);
  for (const request of requests.slice(1, 3)) {
    assert.equal(JSON.stringify(request.messages).split("Deploy to staging").length - 1, 1);
  }
  assert.ok(agent.alreadySurfacedMemories.has(file));
  assert.ok(agent.sessionMemoryBytes > 0);

  await agent.chat("部署方式");
  assert.equal(sideCalls, 1); // 已展示的记忆不会再次交给选择模型。
  assert.equal(events.filter(event => event.type === "message" &&
    typeof event.message.content === "string" && event.message.content.includes("<system-reminder>")).length, 1);
  const replayed = emptyState();
  for (const event of events) applyEvent(replayed, event);
  assert.deepEqual(replayed, agent.snapshot());
});

test("a slow prefetch does not delay a response without tool iterations", { timeout: 1000 }, async t => {
  fixture(t);
  const sideReply = Promise.withResolvers();
  let sideCalls = 0;
  const client = { messages: {
    create() { sideCalls++; return sideReply.promise; },
    stream() { return { on() {}, async finalMessage() { return done(); } }; },
  } };
  const agent = agentFor(client);

  await agent.chat("部署到哪里"); // 此时 sideReply 还没有完成。
  assert.equal(sideCalls, 1);
  assert.doesNotMatch(JSON.stringify(agent.snapshot().messages), /Deploy to staging/);
  sideReply.resolve(selection());
  await new Promise(resolve => setImmediate(resolve));
});
