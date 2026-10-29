import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, toolDefinitions } from "../src/tools.ts";

const hasRipgrep = (() => {
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "practice rg-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function search(input: { pattern: string; path?: string; include?: string }): Promise<string> {
  return executeTool({ type: "tool_use", id: "test", name: "grep_search", input });
}

test("practice grep_search exposes an optional include glob", () => {
  const tool = toolDefinitions.find((definition) => definition.name === "grep_search");
  assert.ok(tool);
  assert.ok((tool.input_schema.properties as Record<string, unknown>).include);
  assert.deepEqual(tool.input_schema.required, ["pattern"]);
});

test("practice grep_search uses ripgrep and respects file filters", { skip: !hasRipgrep }, async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "example.ts"), "first line\nTODO in TypeScript\n-danger\n");
  writeFileSync(join(dir, "example.js"), "TODO in JavaScript\n");
  writeFileSync(join(dir, ".hidden.ts"), "TODO in hidden file\n");
  writeFileSync(join(dir, ".ignore"), "ignored.ts\n");
  writeFileSync(join(dir, "ignored.ts"), "TODO in ignored file\n");

  const all = await search({ pattern: "TODO", path: dir });
  assert.match(all, /example\.ts:2:TODO in TypeScript/);
  assert.match(all, /example\.js:1:TODO in JavaScript/);
  assert.doesNotMatch(all, /hidden|ignored/);

  const typescript = await search({ pattern: "TODO", path: dir, include: "*.ts" });
  assert.match(typescript, /example\.ts:2:TODO in TypeScript/);
  assert.doesNotMatch(typescript, /example\.js/);

  const leadingDash = await search({ pattern: "-danger", path: dir });
  assert.match(leadingDash, /example\.ts:3:-danger/);
  assert.equal(await search({ pattern: "not-present", path: dir }), "No matches found");
});

test("practice grep_search does not execute shell substitutions", { skip: !hasRipgrep }, async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "example.txt"), "INJECTED\n");

  assert.equal(await search({ pattern: "$(printf INJECTED)", path: dir }), "No matches found");
});

test("practice grep_search returns at most 100 matches", { skip: !hasRipgrep }, async (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "many.txt"), "needle\n".repeat(105));

  const result = await search({ pattern: "needle", path: dir });
  const lines = result.split("\n");
  assert.equal(lines.length, 101);
  assert.match(lines[0], /many\.txt:1:needle$/);
  assert.equal(lines[100], "... and 5 more matches");
});

test("practice grep_search reports when ripgrep is unavailable", async (t) => {
  const dir = fixture(t);
  const originalPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    assert.equal(
      await search({ pattern: "anything", path: dir }),
      "Error: ripgrep (rg) is not installed or not in PATH"
    );
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});
