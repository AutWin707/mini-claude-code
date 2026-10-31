import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsPromptSection, discoverSkills, expandSkillCommand, resolveSkillPrompt } from "../src/skills.ts";
import { executeTool } from "../src/tools.ts";

function writeSkill(root: string, dir: string, content: string): string {
  const skillDir = join(root, ".mini-claude", "skills", dir);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), content);
  return skillDir;
}

// 在临时 HOME 和工作目录中运行，不读取真实的用户技能。
function fixture(t: TestContext): { home: string; cwd: string } {
  // macOS 的 /var 是软链接，取真实路径以便和 process.cwd() 一致。
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mini-skills-")));
  const home = join(base, "home");
  const cwd = join(base, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  const oldHome = process.env.HOME;
  const oldCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(cwd);
  t.after(() => {
    process.env.HOME = oldHome;
    process.chdir(oldCwd);
    rmSync(base, { recursive: true, force: true });
  });
  return { home, cwd };
}

const commit = `---
name: commit
description: Write a commit
when_to_use: When the user asks to commit
---
Commit the changes. Request: $ARGUMENTS
Dir: \${CLAUDE_SKILL_DIR}`;

test("discovers user and project skills, project overrides user, ignores .claude/skills", t => {
  const { home, cwd } = fixture(t);
  writeSkill(home, "commit", "---\nname: commit\ndescription: user version\n---\nuser");
  writeSkill(home, "review", "---\ndescription: review code\n---\nReview it.");
  writeSkill(cwd, "commit", commit);
  mkdirSync(join(cwd, ".claude", "skills", "real"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "skills", "real", "SKILL.md"), "---\nname: real\n---\nreal");

  const skills = discoverSkills(cwd, home);
  assert.deepEqual(skills.map(s => s.name).sort(), ["commit", "review"]);
  assert.equal(skills.find(s => s.name === "commit")!.description, "Write a commit");
  assert.equal(skills.find(s => s.name === "review")!.promptTemplate, "Review it.");
});

test("resolves arguments and skill directory placeholders", t => {
  const { cwd } = fixture(t);
  const dir = writeSkill(cwd, "commit", commit);
  const skill = discoverSkills().find(s => s.name === "commit")!;
  assert.equal(resolveSkillPrompt(skill, "fix $& types"), `Commit the changes. Request: fix $& types\nDir: ${dir}`);

  writeSkill(cwd, "plain", "---\nname: plain\n---\nDo it.");
  const plain = discoverSkills().find(s => s.name === "plain")!;
  assert.equal(resolveSkillPrompt(plain, ""), "Do it.");
  assert.equal(resolveSkillPrompt(plain, "now"), "Do it.\n\nARGUMENTS: now");
});

test("slash command expands only user-invocable skills", t => {
  const { cwd } = fixture(t);
  writeSkill(cwd, "commit", commit);
  writeSkill(cwd, "auto", "---\nname: auto\nuser-invocable: false\n---\nauto only");
  assert.match(expandSkillCommand("/commit fix types")!, /Request: fix types/);
  assert.equal(expandSkillCommand("/auto"), null);
  assert.equal(expandSkillCommand("/missing"), null);
  assert.equal(expandSkillCommand("commit"), null);
});

test("skill tool returns the expanded prompt and the system prompt lists skills", async t => {
  const { cwd } = fixture(t);
  assert.equal(buildSkillsPromptSection(), "");
  writeSkill(cwd, "commit", commit);
  writeSkill(cwd, "auto", "---\nname: auto\ndescription: auto skill\nuser-invocable: false\n---\nauto only");

  const call = (input: object) => executeTool({ type: "tool_use", id: "t", name: "skill", input } as any);
  assert.match(await call({ skill_name: "commit", args: "x" }), /^\[Skill "commit" activated\]\n\nCommit the changes\. Request: x/);
  assert.match(await call({ skill_name: "auto" }), /auto only/);
  assert.equal(await call({ skill_name: "missing" }), "Error: unknown skill missing");

  const section = buildSkillsPromptSection();
  assert.match(section, /- commit: Write a commit When to use: When the user asks to commit/);
  assert.match(section, /- auto: auto skill/);
});
