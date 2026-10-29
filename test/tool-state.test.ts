import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { executeTool, getActiveToolDefinitions, resetActivatedTools } from "../src/tools.ts";

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "practice-tool-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(state: Map<string, number>, name: string, input: unknown): Promise<string> {
  return executeTool({ type: "tool_use", id: "test", name, input }, state);
}

test("existing files must be read before editing or overwriting", async (t) => {
  const file = join(fixture(t), "example.txt");
  writeFileSync(file, "hello");
  const state = new Map<string, number>();

  assert.match(await run(state, "edit_file", { file_path: file, old_string: "hello", new_string: "hi" }), /read_file/);
  assert.match(await run(state, "write_file", { file_path: file, content: "new" }), /read_file/);
  assert.equal(readFileSync(file, "utf-8"), "hello");

  assert.match(await run(state, "read_file", { file_path: relative(process.cwd(), file) }), /hello/);
  assert.equal(await run(state, "edit_file", { file_path: file, old_string: "hello", new_string: "hi" }), "File edited successfully");
  assert.equal(await run(state, "write_file", { file_path: file, content: "new" }), "File written successfully");
  assert.equal(readFileSync(file, "utf-8"), "new");
});

test("a changed mtime blocks writes until the file is read again", async (t) => {
  const file = join(fixture(t), "example.txt");
  writeFileSync(file, "hello");
  const state = new Map<string, number>();
  await run(state, "read_file", { file_path: file });
  const later = new Date(statSync(file).mtimeMs + 10000);
  writeFileSync(file, "external");
  utimesSync(file, later, later);

  assert.match(await run(state, "edit_file", { file_path: file, old_string: "external", new_string: "changed" }), /changed since last read/);
  assert.match(await run(state, "write_file", { file_path: file, content: "changed" }), /changed since last read/);
  assert.equal(readFileSync(file, "utf-8"), "external");
  await run(state, "read_file", { file_path: file });
  assert.equal(await run(state, "edit_file", { file_path: file, old_string: "external", new_string: "changed" }), "File edited successfully");
});

test("a new file can be created without a prior read", async (t) => {
  const file = join(fixture(t), "new", "example.txt");
  const state = new Map<string, number>();
  assert.equal(await run(state, "write_file", { file_path: file, content: "created" }), "File written successfully");
  assert.equal(await run(state, "edit_file", { file_path: file, old_string: "created", new_string: "edited" }), "File edited successfully");
  assert.equal(readFileSync(file, "utf-8"), "edited");
});

test("read state is separate for each Map", async (t) => {
  const file = join(fixture(t), "example.txt");
  writeFileSync(file, "hello");
  const first = new Map<string, number>();
  const second = new Map<string, number>();
  await run(first, "read_file", { file_path: file });
  assert.match(await run(second, "write_file", { file_path: file, content: "new" }), /read_file/);
  assert.equal(readFileSync(file, "utf-8"), "hello");
});

test("tool_search activates the example deferred tool", async (t) => {
  resetActivatedTools();
  t.after(resetActivatedTools);
  const state = new Map<string, number>();
  assert.ok(getActiveToolDefinitions().some(tool => tool.name === "tool_search"));
  assert.ok(getActiveToolDefinitions().some(tool => tool.name === "web_fetch"));
  assert.ok(!getActiveToolDefinitions().some(tool => tool.name === "example_tool"));
  assert.match(await run(state, "example_tool", { message: "hi" }), /tool_search/);
  assert.equal(await run(state, "tool_search", { query: "unknown" }), "No matching deferred tools found.");

  const matches = JSON.parse(await run(state, "tool_search", { query: "EXAMPLE" }));
  assert.equal(matches[0].name, "example_tool");
  assert.equal("deferred" in matches[0], false);
  assert.ok(getActiveToolDefinitions().some(tool => tool.name === "example_tool"));
  assert.ok(getActiveToolDefinitions().every(tool => !("deferred" in tool)));
  assert.equal(await run(state, "example_tool", { message: "hi" }), "Example: hi");
});
