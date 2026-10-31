import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, resolve } from "path";
import * as os from "os";
import { buildMemoryPromptSection } from "./memory.ts";

const STATIC_PROMPT = `You are Coding Agent Lab, a coding assistant.
Use the available tools to inspect and change files.
Read existing files before modifying them and keep changes focused.
Follow applicable project instructions provided with the user's request.
Ask before destructive actions, and keep responses concise.`;

const INCLUDE_PATTERN = /^@(\.\/[^\s]+|~\/[^\s]+|\/[^\s]+)[ \t]*\r?$/gm;

// 读取一份指令文件，并处理其中的 @路径 引用。
function readInstructions(filePath: string, seen: Set<string>, depth = 0): string {
    const path = resolve(filePath);
    if (seen.has(path)) return "";
    if (depth >= 5) return `<!-- Include depth limit: ${path} -->`;
    seen.add(path);

    try {
        const content = readFileSync(path, "utf-8");
        return content.replace(INCLUDE_PATTERN, (_match, include: string) => {
            const target = include.startsWith("~/")
                ? join(os.homedir(), include.slice(2))
                : resolve(dirname(path), include);
            return readInstructions(target, seen, depth + 1);
        });
    } catch {
        return `<!-- Could not read: ${path} -->`;
    }
}

// 加载 AGENT.md、CLAUDE.md、AGENTS.md 文件以及 .claude/rules/*.md 文件中的项目指令。
export function loadProjectInstructions(startDir = process.cwd()): string {
    const directories: string[] = [];
    let dir = resolve(startDir);
    while (true) {
        directories.unshift(dir);
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }

    const seen = new Set<string>();
    const parts: string[] = [];
    for (const directory of directories) {
        for (const name of ["CLAUDE.md", "AGENT.md", "AGENTS.md"]) {
            const path = join(directory, name);
            if (!existsSync(path)) continue;
            const content = readInstructions(path, seen);
            if (content.trim()) parts.push(`## ${path}\n${content}`);
        }
    }

    const rulesDir = join(resolve(startDir), ".claude", "rules");
    if (existsSync(rulesDir)) {
        for (const name of readdirSync(rulesDir).filter(name => name.endsWith(".md")).sort()) {
            const content = readInstructions(join(rulesDir, name), seen);
            if (content.trim()) parts.push(`## .claude/rules/${name}\n${content}`);
        }
    }

    return parts.length ? `# Project Instructions\n\n${parts.join("\n\n")}` : "";
}

// 静态 prompt 模板
export function buildStaticSystemPrompt(): string {
    return STATIC_PROMPT;
}

// 动态环境包含工作目录、系统、Shell 和未激活的工具，不包含 Git 状态。
export function buildDynamicSystemPrompt(deferredNames: string[] = []): string {
    const platform = `${os.platform()} ${os.arch()}`;
    const shell = process.platform === "win32"
        ? (process.env.ComSpec || "cmd.exe")
        : (process.env.SHELL || "/bin/sh");
    const deferred = deferredNames.length
        ? `\nDeferred tools available through tool_search: ${deferredNames.join(", ")}`
        : "";
    return `# Environment\nWorking directory: ${process.cwd()}\nPlatform: ${platform}\nShell: ${shell}${deferred}`;
}

export function buildUserSystemPrompt(deferredNames: string[] = []): string {
    return `${buildStaticSystemPrompt()}\n\n${buildDynamicSystemPrompt(deferredNames)}\n\n${buildMemoryPromptSection()}`;
}