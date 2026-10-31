import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export interface SkillDefinition {
    name: string;
    description: string;
    whenToUse?: string;
    userInvocable: boolean;
    promptTemplate: string;
    skillDir: string;
}

// 扫描 <root>/<技能目录>/SKILL.md；同名技能后加载的覆盖先加载的。
function loadSkillsFromDir(root: string, skills: Map<string, SkillDefinition>): void {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root)) {
        const skillDir = join(root, entry);
        const file = join(skillDir, "SKILL.md");
        if (!existsSync(file)) continue;
        const { meta, body } = parseFrontmatter(readFileSync(file, "utf-8"));
        const name = meta.name || entry;
        skills.set(name, {
            name,
            description: meta.description ?? "",
            whenToUse: meta.when_to_use,
            userInvocable: meta["user-invocable"] !== "false",
            promptTemplate: body,
            skillDir,
        });
    }
}

// 先用户级再项目级，项目技能覆盖同名用户技能。不缓存，新增技能立即可用。
// 使用 .mini-claude 目录，与正版 Claude Code 的 .claude/skills 分开。
export function discoverSkills(cwd = process.cwd(), home = homedir()): SkillDefinition[] {
    const skills = new Map<string, SkillDefinition>();
    loadSkillsFromDir(join(home, ".mini-claude", "skills"), skills);
    loadSkillsFromDir(join(cwd, ".mini-claude", "skills"), skills);
    return [...skills.values()];
}

// 替换占位符；模板没有 $ARGUMENTS 时把参数追加到末尾，避免丢失用户输入。
export function resolveSkillPrompt(skill: SkillDefinition, args: string): string {
    const hasArgs = /\$ARGUMENTS|\$\{ARGUMENTS\}/.test(skill.promptTemplate);
    // 用函数替换，参数里的 $& 等不会被当作替换模式。
    const prompt = skill.promptTemplate
        .replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, () => args)
        .replace(/\$\{CLAUDE_SKILL_DIR\}/g, () => skill.skillDir);
    return hasArgs || !args ? prompt : `${prompt}\n\nARGUMENTS: ${args}`;
}

// 把 "/名字 参数" 展开为技能 prompt；不是可由用户调用的技能时返回 null。
export function expandSkillCommand(input: string): string | null {
    const match = input.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!match) return null;
    const skill = discoverSkills().find(s => s.name === match[1] && s.userInvocable);
    return skill ? resolveSkillPrompt(skill, match[2].trim()) : null;
}

export function buildSkillsPromptSection(): string {
    const skills = discoverSkills();
    if (!skills.length) return "";
    const lines = skills.map(s => `- ${s.name}: ${s.description}${s.whenToUse ? ` When to use: ${s.whenToUse}` : ""}`);
    return `# Skills
When a task matches a skill below, call the skill tool with its name to load its instructions, then follow them.
${lines.join("\n")}`;
}
