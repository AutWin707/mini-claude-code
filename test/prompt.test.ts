import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { buildDynamicSystemPrompt, buildStaticSystemPrompt, buildUserSystemPrompt, loadProjectInstructions } from "../src/prompt.ts";

function fixture(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "practice-prompt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("static prompt describes the coding assistant", () => {
  const prompt = buildStaticSystemPrompt();
  assert.match(prompt, /coding assistant/);
  assert.match(prompt, /Read existing files before modifying/);
  assert.equal(buildStaticSystemPrompt(), prompt);
});

test("dynamic prompt includes environment and deferred tools without Git", () => {
  const dynamic = buildDynamicSystemPrompt(["example_tool"]);
  assert.ok(dynamic.includes(`Working directory: ${process.cwd()}`));
  assert.ok(dynamic.includes(`Platform: ${platform()} ${arch()}`));
  assert.match(dynamic, /Shell:/);
  assert.match(dynamic, /Deferred tools.*example_tool/);
  assert.doesNotMatch(dynamic, /Git (branch|status):/);
  assert.doesNotMatch(buildDynamicSystemPrompt(), /Deferred tools/);

  const prompt = buildUserSystemPrompt(["example_tool"]);
  assert.ok(prompt.startsWith(buildStaticSystemPrompt()));
  assert.ok(prompt.includes(dynamic));
  assert.doesNotMatch(prompt, /<project-instructions>/);
});

test("project instructions load parent and current CLAUDE and AGENT files", (t) => {
  const root = fixture(t);
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(join(root, "CLAUDE.md"), "parent-instruction");
  writeFileSync(join(project, "CLAUDE.md"), "child-instruction");
  writeFileSync(join(project, "AGENT.md"), "singular-agent-instruction");
  writeFileSync(join(project, "AGENTS.md"), "plural-agents-instruction");

  const result = loadProjectInstructions(project);
  assert.ok(result.indexOf("parent-instruction") < result.indexOf("child-instruction"));
  assert.match(result, /singular-agent-instruction/);
  assert.match(result, /plural-agents-instruction/);
});

test("project instructions resolve includes and avoid duplicate rules", (t) => {
  const dir = fixture(t);
  const rules = join(dir, ".claude", "rules");
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "Project\n@./.claude/rules/one.md");
  writeFileSync(join(rules, "one.md"), "first-rule\n@./two.md");
  writeFileSync(join(rules, "two.md"), "second-rule\n@./one.md");
  writeFileSync(join(rules, "three.md"), "standalone-rule");

  const result = loadProjectInstructions(dir);
  assert.equal(result.match(/first-rule/g)?.length, 1);
  assert.equal(result.match(/second-rule/g)?.length, 1);
  assert.equal(result.match(/standalone-rule/g)?.length, 1);
});

test("project instructions resolve includes in CRLF files", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "CLAUDE.md"), "Before\r\n@./shared.md\r\nAfter");
  writeFileSync(join(dir, "shared.md"), "included-rule");
  assert.match(loadProjectInstructions(dir), /included-rule/);
});

test("project instructions indicate missing included files", (t) => {
  const dir = fixture(t);
  writeFileSync(join(dir, "CLAUDE.md"), "Before\n@./missing.md\nAfter");
  const result = loadProjectInstructions(dir);
  assert.match(result, /Before/);
  assert.match(result, /Could not read: .*missing\.md/);
  assert.match(result, /After/);
});
