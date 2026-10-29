import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { resetActivatedTools } from "../src/tools.ts";

test("Agent keeps messages and file-read state across chat turns", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "practice-agent-"));
  const previousDir = process.cwd();
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousModel = process.env.ANTHROPIC_MODEL;
  resetActivatedTools();
  t.after(() => {
    resetActivatedTools();
    process.chdir(previousDir);
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.ANTHROPIC_MODEL;
    else process.env.ANTHROPIC_MODEL = previousModel;
    rmSync(dir, { recursive: true, force: true });
  });
  t.mock.method(console, "log", () => {});
  process.chdir(dir);
  process.env.ANTHROPIC_API_KEY = "test-only";
  process.env.ANTHROPIC_MODEL = "fixture-model";
  writeFileSync(join(dir, "CLAUDE.md"), "fixture-project-instruction");
  const file = join(dir, "example.txt");
  writeFileSync(file, "hello");

  const requests = [];
  const replies = [
    [{ type: "tool_use", id: "search", name: "tool_search", input: { query: "example_tool" } }],
    [{ type: "tool_use", id: "read", name: "read_file", input: { file_path: file } }],
    [{ type: "text", text: "first done" }],
    [{ type: "tool_use", id: "edit", name: "edit_file", input: { file_path: file, old_string: "hello", new_string: "hi" } }],
    [{ type: "text", text: "second done" }],
  ];
  const agent = new Agent();
  agent.client = {
    messages: {
      create: async (request) => {
        requests.push(structuredClone(request));
        return { content: replies.shift() };
      },
    },
  };

  await agent.chat("first");
  writeFileSync(join(dir, "CLAUDE.md"), "changed-project-instruction");
  await agent.chat("second");

  assert.equal(readFileSync(file, "utf-8"), "hi");
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(request.model, "fixture-model");
    const firstMessage = request.messages[0].content;
    assert.match(request.system, /coding assistant/);
    assert.match(request.system, /# Environment/);
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
