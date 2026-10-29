import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeTool, truncateResult } from "../src/tools.ts";

test("truncateResult preserves short text and text exactly at the limit", () => {
  const short = 'first line\n"quoted"\\text';
  assert.equal(truncateResult(short), short);

  const atLimit = "x".repeat(50000);
  assert.equal(truncateResult(atLimit), atLimit);
});

test("truncateResult preserves the beginning and end with an accurate omission count", () => {
  const start = "a".repeat(24970);
  const end = "z".repeat(24970);
  const result = truncateResult(start + "m".repeat(50060) + end);

  assert.equal(result, start + "\n\n[... truncated 50060 chars ...]\n\n" + end);
  assert.ok(result.length <= 50000);
});

test("truncateResult truncates text just over the limit", () => {
  const result = truncateResult("x".repeat(50001));
  assert.match(result, /\[\.\.\. truncated 61 chars \.\.\.\]/);
  assert.ok(result.length <= 50000);
});

test("truncateResult limits a real read_file result without changing the file", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "practice-truncate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "large.txt");
  const original = "BEGIN" + "x".repeat(60000) + "END";
  writeFileSync(file, original);

  const result = await executeTool({
    type: "tool_use", id: "test", name: "read_file", input: { file_path: file },
  });
  const truncated = truncateResult(result);
  assert.ok(result.length > 50000);
  assert.ok(truncated.length <= 50000);
  assert.ok(truncated.startsWith("   1 | BEGIN"));
  assert.ok(truncated.endsWith("END"));
  assert.match(truncated, /\[\.\.\. truncated \d+ chars \.\.\.\]/);
  assert.equal(readFileSync(file, "utf-8"), original);
});
