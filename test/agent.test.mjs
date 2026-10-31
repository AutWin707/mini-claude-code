import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { emptyRules, mockClient, text, message, toolUse, useTempDir } from "./helpers.mjs";

test("Agent keeps messages and file-read state across chat turns", async t => {
  const dir = useTempDir(t);
  const previousModel = process.env.ANTHROPIC_MODEL;
  t.after(() => {
    if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = previousModel;
  });
  process.env.ANTHROPIC_MODEL = "fixture-model";
  writeFileSync(join(dir, "CLAUDE.md"), "fixture-project-instruction");
  const file = join(dir, "example.txt");
  writeFileSync(file, "hello");

  const mock = mockClient([
    message([toolUse("search", "tool_search", { query: "example_tool" })]),
    message([toolUse("read", "read_file", { file_path: file })]),
    text("first done"),
    message([toolUse("edit", "edit_file", { file_path: file, old_string: "hello", new_string: "hi" })]),
    text("second done"),
  ]);
  // 不传 config 和 instructions：模型取自环境变量，项目指令在首轮懒加载。
  const agent = new Agent({ client: mock.client, permissionRules: emptyRules(), onOutput() {} });
  await agent.chat("first");
  writeFileSync(join(dir, "CLAUDE.md"), "changed-project-instruction");
  await agent.chat("second");

  assert.equal(readFileSync(file, "utf-8"), "hi"); // 第二轮能用第一轮读取的状态编辑文件。
  const requests = mock.streams;
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(request.model, "fixture-model");
    assert.match(request.system, /coding assistant/);
    assert.match(request.system, /# Environment/);
    const firstMessage = request.messages[0].content;
    assert.doesNotMatch(firstMessage, /You are Coding Agent Lab/);
    assert.equal(firstMessage.split("fixture-project-instruction").length - 1, 1);
    assert.doesNotMatch(firstMessage, /changed-project-instruction/);
  }
  assert.match(requests[0].system, /Deferred tools.*example_tool/);
  assert.doesNotMatch(requests[1].system, /Deferred tools/);
  assert.ok(!requests[0].tools.some(tool => tool.name === "example_tool"));
  assert.ok(requests[1].tools.some(tool => tool.name === "example_tool"));
  assert.equal(requests[3].messages.at(-1).content, "second");
});
