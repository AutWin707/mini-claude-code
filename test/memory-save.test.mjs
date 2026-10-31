import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";
import { getMemoryDir } from "../src/memory.ts";
import { buildUserSystemPrompt } from "../src/prompt.ts";
import { executeTool } from "../src/tools.ts";

const message = (content, stop_reason = "end_turn") => ({
  id: "test", type: "message", role: "assistant", model: "test", content, stop_reason,
  usage: { input_tokens: 10, output_tokens: 2 },
});
const call = (name, input) => ({ type: "tool_use", id: "test-tool", name, input });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mini-memory-save-"));
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
  return dir;
}

test("agent saves a memory, rebuilds the index and includes it in the next prompt", async t => {
  const dir = fixture(t);
  const memoryDir = getMemoryDir();
  const index = join(memoryDir, "MEMORY.md");
  const file = join(memoryDir, "user_concise.md");
  const body = "---\nname: concise\ndescription: prefers concise replies\ntype: user\n---\nReply briefly.";
  const state = new Map();
  assert.equal(await executeTool(call("write_file", { file_path: join(dir, "ordinary.txt"), content: "ordinary" }), state),
    "File written successfully");
  assert.equal(existsSync(index), false);

  const replies = [message([call("write_file", { file_path: file, content: body })], "tool_use"),
    message([{ type: "text", text: "saved" }])];
  const requests = [];
  let confirmations = 0;
  const client = { messages: {
    create() { throw new Error("no memories to prefetch yet"); },
    stream(params) {
      requests.push(structuredClone(params));
      const reply = replies.shift();
      return { on() {}, async finalMessage() { return reply; } };
    },
  } };
  const agent = new Agent({ config: { model: "test" }, client, instructions: "", maxContext: null,
    permissionRules: { allow: [], deny: [] }, onOutput() {},
    confirmPermission: async () => { confirmations++; return true; } });
  await agent.chat("记住我喜欢简洁的回复");

  assert.equal(confirmations, 1); // 保存仍经过原有权限确认。
  assert.equal(readFileSync(file, "utf-8"), body);
  assert.match(readFileSync(index, "utf-8"), /\[concise\]\(user_concise\.md\).*prefers concise replies/);
  assert.ok(requests[0].system.includes(memoryDir));
  assert.match(requests[0].system, /No memories saved yet/);
  assert.match(requests[1].system, /\[concise\]\(user_concise\.md\)/);
  assert.doesNotMatch(requests[1].system, /Reply briefly\./); // 索引不包含正文。

  await executeTool(call("read_file", { file_path: file }), state);
  assert.equal(await executeTool(call("edit_file", { file_path: file,
    old_string: "description: prefers concise replies", new_string: "description: prefers short answers" }), state),
  "File edited successfully");
  assert.match(readFileSync(index, "utf-8"), /prefers short answers/);
  assert.doesNotMatch(readFileSync(index, "utf-8"), /prefers concise replies/);
  assert.match(buildUserSystemPrompt(), /prefers short answers/);
});

test("memory indexes are isolated by project directory", async t => {
  const dir = fixture(t);
  const firstMemory = join(getMemoryDir(), "project_one.md");
  await executeTool(call("write_file", { file_path: firstMemory,
    content: "---\nname: project one\ndescription: first project\ntype: project\n---\nProject one." }));
  assert.match(buildUserSystemPrompt(), /first project/);

  const other = join(dir, "other-project");
  mkdirSync(other);
  process.chdir(other);
  assert.doesNotMatch(buildUserSystemPrompt(), /first project/);
  assert.match(buildUserSystemPrompt(), /No memories saved yet/);
});
