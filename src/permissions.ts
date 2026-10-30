import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const permissionModes = ["default", "acceptEdits", "bypassPermissions", "dontAsk"] as const;
export type PermissionMode = typeof permissionModes[number];
export function isPermissionMode(value: string): value is PermissionMode {
    return (permissionModes as readonly string[]).includes(value);
}
export type PermissionDecision = { action: "allow" | "deny" | "confirm"; message?: string };
export interface PermissionRule { tool: string; pattern: string | null }
export interface PermissionRules { allow: PermissionRule[]; deny: PermissionRule[] }

const readTools = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);
const editTools = new Set(["write_file", "edit_file"]);
const dangerousPatterns = [
    /\brm\s/, /\bgit\s+(push|reset|clean|checkout\s+\.)/, /\bsudo\b/, /\bmkfs\b/,
    /\bdd\s/, />\s*\/dev\//, /\bkill\b/, /\bpkill\b/, /\breboot\b/, /\bshutdown\b/,
    /\bdel\s/i, /\brmdir\s/i, /\bformat\s/i, /\btaskkill\s/i, /\bRemove-Item\s/i, /\bStop-Process\s/i,
];

function parseRule(rule: string): PermissionRule {
    const match = rule.match(/^([a-z_]+)\((.+)\)$/);
    return match ? { tool: match[1], pattern: match[2] } : { tool: rule, pattern: null };
}

// 每个 Agent 加载各自工作目录的快照，避免切换会话后继续使用其他项目的规则。
export function loadPermissionRules(cwd = process.cwd(), home = homedir()): PermissionRules {
    const rules: PermissionRules = { allow: [], deny: [] };
    for (const file of [join(home, ".claude", "settings.json"), join(cwd, ".claude", "settings.json")]) {
        let settings: unknown;
        try { settings = JSON.parse(readFileSync(file, "utf8")); }
        catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw new Error(`无法读取权限配置 ${file}: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error(`无效的权限配置: ${file}`);
        const permissions = (settings as Record<string, unknown>).permissions;
        if (permissions === undefined) continue;
        if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) throw new Error(`无效的 permissions: ${file}`);
        for (const kind of ["allow", "deny"] as const) {
            const entries = (permissions as Record<string, unknown>)[kind];
            if (entries === undefined) continue;
            if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string")) {
                throw new Error(`permissions.${kind} 必须是字符串数组: ${file}`);
            }
            rules[kind].push(...entries.map(parseRule));
        }
    }
    return rules;
}

function matchesRule(rule: PermissionRule, name: string, input: Record<string, unknown>): boolean {
    if (rule.tool !== name) return false;
    if (rule.pattern === null) return true;
    const value = name === "run_shell" ? input.command : input.file_path;
    // 没有可匹配的字段时不把带 pattern 的规则扩大成整个工具。
    if (typeof value !== "string") return false;
    return rule.pattern.endsWith("*") ? value.startsWith(rule.pattern.slice(0, -1)) : value === rule.pattern;
}

export function checkPermission(name: string, rawInput: unknown, rules: PermissionRules, mode: PermissionMode = "default"): PermissionDecision {
    const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
        ? rawInput as Record<string, unknown> : {};
    if (rules.deny.some(rule => matchesRule(rule, name, input))) return { action: "deny", message: `权限规则拒绝 ${name}` };
    if (mode === "bypassPermissions") return { action: "allow" };
    if (rules.allow.some(rule => matchesRule(rule, name, input))) return { action: "allow" };
    if (readTools.has(name) || (mode === "acceptEdits" && editTools.has(name))) return { action: "allow" };

    let message: string | undefined;
    if (name === "run_shell" && typeof input.command === "string" && dangerousPatterns.some(pattern => pattern.test(input.command as string))) {
        message = input.command;
    } else if (editTools.has(name) && typeof input.file_path === "string" && input.file_path && !existsSync(input.file_path)) {
        message = `${name === "write_file" ? "write new file" : "edit non-existent file"}: ${input.file_path}`;
    }
    if (message) return mode === "dontAsk"
        ? { action: "deny", message: `dontAsk 模式自动拒绝: ${message}` }
        : { action: "confirm", message };
    return { action: "allow" };
}
