import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoryDir } from "../src/memory.ts";
import { buildUserSystemPrompt } from "../src/prompt.ts";
import { executeTool } from "../src/tools.ts";
import { makeAgent, message, mockClient, text, toolUse, useTempDir } from "./helpers.mjs";

const call = (name, input) => toolUse("test-tool", name, input);

test("agent saves a memory, rebuilds the index and includes it in the next prompt", async t => {
  const dir = useTempDir(t);
  const memoryDir = getMemoryDir();
  const index = join(memoryDir, "MEMORY.md");
  const file = join(memoryDir, "user_concise.md");
  const body = "---\nname: concise\ndescription: prefers concise replies\ntype: user\n---\nReply briefly.";
  const state = new Map();
  assert.equal(await executeTool(call("write_file", { file_path: join(dir, "ordinary.txt"), content: "ordinary" }), state),
    "File written successfully");
  assert.equal(existsSync(index), false); // 普通文件不触发索引。

  // 开始时没有记忆，所以不会发起召回请求。
  const mock = mockClient([message([call("write_file", { file_path: file, content: body })]), text("saved")]);
  let confirmations = 0;
  const agent = makeAgent(mock.client, { maxContext: null, confirmPermission: async () => { confirmations++; return true; } });
  await agent.chat("记住我喜欢简洁的回复");

  assert.equal(confirmations, 1); // 保存仍经过原有权限确认。
  assert.equal(readFileSync(file, "utf-8"), body);
  assert.match(readFileSync(index, "utf-8"), /\[concise\]\(user_concise\.md\).*prefers concise replies/);
  const [first, second] = mock.requests;
  assert.ok(first.system.includes(memoryDir));
  assert.match(first.system, /No memories saved yet/);
  assert.match(second.system, /\[concise\]\(user_concise\.md\)/);
  assert.doesNotMatch(second.system, /Reply briefly\./); // 索引不包含正文。

  await executeTool(call("read_file", { file_path: file }), state);
  assert.equal(await executeTool(call("edit_file", { file_path: file,
    old_string: "description: prefers concise replies", new_string: "description: prefers short answers" }), state),
  "File edited successfully");
  assert.match(readFileSync(index, "utf-8"), /prefers short answers/);
  assert.doesNotMatch(readFileSync(index, "utf-8"), /prefers concise replies/);
  assert.match(buildUserSystemPrompt(), /prefers short answers/);
});

test("memory indexes are isolated by project directory", async t => {
  const dir = useTempDir(t);
  await executeTool(call("write_file", { file_path: join(getMemoryDir(), "project_one.md"),
    content: "---\nname: project one\ndescription: first project\ntype: project\n---\nProject one." }));
  assert.match(buildUserSystemPrompt(), /first project/);

  const other = join(dir, "other-project");
  mkdirSync(other);
  process.chdir(other);
  assert.doesNotMatch(buildUserSystemPrompt(), /first project/);
  assert.match(buildUserSystemPrompt(), /No memories saved yet/);
});
