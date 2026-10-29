import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool } from "../src/tools.ts";

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "practice-list-files-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function list(input: { pattern: string; path?: string }): Promise<string> {
  return executeTool({ type: "tool_use", id: "test", name: "list_files", input });
}

test("practice list_files matches files recursively and ignores dependencies", async (t) => {
  const dir = fixture(t);
  mkdirSync(join(dir, "nested"));
  mkdirSync(join(dir, "directory.ts"));
  mkdirSync(join(dir, "node_modules", "dependency"), { recursive: true });
  mkdirSync(join(dir, "nested", "node_modules", "dependency"), { recursive: true });
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "a.ts"), "");
  writeFileSync(join(dir, "nested", "b.ts"), "");
  writeFileSync(join(dir, "nested", "other.js"), "");
  writeFileSync(join(dir, "node_modules", "dependency", "index.ts"), "");
  writeFileSync(join(dir, "nested", "node_modules", "dependency", "index.ts"), "");
  writeFileSync(join(dir, ".git", "config"), "");

  assert.equal(await list({ pattern: "**/*.ts", path: dir }), "a.ts\nnested/b.ts");
  assert.equal(await list({ pattern: ".git/**", path: dir }), "No files found matching the pattern.");
});

test("practice list_files defaults to the current directory", async () => {
  assert.equal(await list({ pattern: "package.json" }), "package.json");
});

test("practice list_files reports when there are no matches", async (t) => {
  const dir = fixture(t);
  assert.equal(await list({ pattern: "*.missing", path: dir }), "No files found matching the pattern.");
});

test("practice list_files limits output to 200 results", async (t) => {
  const dir = fixture(t);
  for (let i = 0; i < 205; i++) {
    writeFileSync(join(dir, `file-${String(i).padStart(3, "0")}.txt`), "");
  }

  const lines = (await list({ pattern: "*.txt", path: dir })).split("\n");
  assert.equal(lines.length, 201);
  assert.equal(lines[0], "file-000.txt");
  assert.equal(lines[199], "file-199.txt");
  assert.equal(lines[200], "... and 5 more");
});

test("practice list_files returns invalid pattern errors", async () => {
  const result = await executeTool({
    type: "tool_use", id: "test", name: "list_files", input: { pattern: null },
  });
  assert.match(result, /^Error listing files:/);
});
