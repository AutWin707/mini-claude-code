import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { addUsage, emptyUsage, type TokenUsage } from "./usage.ts";

export interface ModelConfig { model: string; baseURL?: string }
export interface AgentState {
    messages: Anthropic.MessageParam[];
    messageCount: number;
    readFiles: [string, number][];
    activatedTools: string[];
    totalUsage: TokenUsage;
    lastTurnUsage: TokenUsage;
    completedTurns: number;
    title?: string;
    thinking?: string;
}
export type SessionEvent =
    | { type: "turn_start" }
    | { type: "turn_end" }
    | { type: "message"; message: Anthropic.MessageParam }
    | { type: "usage"; purpose: "chat" | "compact" | "title"; usage: TokenUsage }
    | { type: "tool_state"; readFiles: [string, number][]; activatedTools: string[] }
    | { type: "title"; title: string }
    | { type: "microcompact"; through: number; targets: [number, number][] }
    | { type: "compact"; summary: string; through: number; messages: Anthropic.MessageParam[] };

export const MICROCOMPACT_PLACEHOLDER = "[Old result cleared]";
export interface SessionHeader {
    type: "session";
    version: 1;
    id: string;
    cwd: string;
    config: ModelConfig;
    instructions: string;
    createdAt: string;
}
export interface LoadedSession { header: SessionHeader; state: AgentState }

// 新建会话的初始状态：没有消息、工具状态和 token 用量。
export function emptyState(): AgentState {
    return { messages: [], messageCount: 0, readFiles: [], activatedTools: [],
        totalUsage: emptyUsage(), lastTurnUsage: emptyUsage(), completedTurns: 0 };
}

// 把一条会话事件应用到内存状态；实时执行和 JSONL 重放共用这段逻辑。
export function applyEvent(state: AgentState, event: SessionEvent): void {
    switch (event.type) {
        case "turn_start": state.lastTurnUsage = emptyUsage(); break;
        case "turn_end": state.completedTurns++; break;
        case "message": state.messages.push(event.message); state.messageCount++; break;
        case "usage":
            state.totalUsage = addUsage(state.totalUsage, event.usage);
            if (event.purpose === "chat") state.lastTurnUsage = addUsage(state.lastTurnUsage, event.usage);
            break;
        case "tool_state": state.readFiles = event.readFiles; state.activatedTools = event.activatedTools; break;
        case "title": state.title = event.title; break;
        case "microcompact": {
            if (event.through !== state.messageCount) throw new Error("microcompact 检查点范围不匹配");
            const blocks: Anthropic.ToolResultBlockParam[] = [];
            const seen = new Set<string>();
            for (const [messageIndex, blockIndex] of event.targets) {
                const key = `${messageIndex}:${blockIndex}`;
                const message = state.messages[messageIndex];
                const block = message?.role === "user" && Array.isArray(message.content) ? message.content[blockIndex] : undefined;
                if (seen.has(key) || block?.type !== "tool_result") throw new Error("microcompact 工具结果位置无效");
                seen.add(key);
                blocks.push(block);
            }
            // 全部验证通过后才修改，避免中途失败造成部分清理。
            for (const block of blocks) block.content = MICROCOMPACT_PLACEHOLDER;
            break;
        }
        case "compact":
            if (event.through !== state.messageCount) throw new Error("compact 检查点范围不匹配");
            state.messages = event.messages;
            break;
    }
}

// 从环境变量读取模型配置；模型必填，不使用默认值。
export function modelConfigFromEnv(): ModelConfig {
    const model = process.env.ANTHROPIC_MODEL?.trim();
    if (!model) throw new Error("缺少 ANTHROPIC_MODEL，请在 .env 或环境变量中配置。");
    const baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || process.env.ANTHROPIC_API_URL?.trim();
    const config = { model, ...(baseURL ? { baseURL } : {}) };
    validateConfig(config);
    return config;
}

// 校验模型名和 API 地址，拒绝携带凭据或额外 URL 成分的地址。
function validateConfig(config: ModelConfig): void {
    if (!config || typeof config.model !== "string" || !config.model.trim()) throw new Error("会话模型配置无效");
    if (config.baseURL !== undefined) {
        const url = new URL(config.baseURL);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error("API 地址必须为不含凭据、查询参数或片段的 HTTP(S) base URL");
        }
    }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 检查 JSONL 中的消息是否具有合法角色和内容。
function validMessage(value: any): boolean {
    return value && ["user", "assistant"].includes(value.role) &&
        (typeof value.content === "string" || (Array.isArray(value.content) &&
            value.content.every((block: any) => block && typeof block.type === "string")));
}
// 检查 token 用量；null 表示不可用，负数和其他类型都无效。
function validUsage(value: any): boolean {
    const validCount = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0;
    return value && [value.input, value.output].every(n => n === null || validCount(n)) &&
        [value.cacheRead, value.cacheWrite].every(n => n === undefined || validCount(n));
}
// 按事件类型校验 JSONL 记录，防止损坏数据进入会话状态。
function validateEvent(event: any): asserts event is SessionEvent {
    let valid = false;
    switch (event?.type) {
        case "turn_start": case "turn_end": valid = true; break;
        case "message": valid = validMessage(event.message); break;
        case "usage": valid = ["chat", "compact", "title"].includes(event.purpose) && validUsage(event.usage); break;
        case "title": valid = typeof event.title === "string" && !!event.title.trim(); break;
        case "microcompact": valid = Number.isInteger(event.through) && event.through >= 0 &&
            Array.isArray(event.targets) && event.targets.length > 0 && event.targets.every((target: unknown) =>
                Array.isArray(target) && target.length === 2 && target.every(index => Number.isInteger(index) && index >= 0)); break;
        case "compact": valid = typeof event.summary === "string" && !!event.summary.trim() &&
            Number.isInteger(event.through) && event.through >= 0 && Array.isArray(event.messages) &&
            event.messages.length > 0 && event.messages.every(validMessage); break;
        case "tool_state": valid = Array.isArray(event.activatedTools) && event.activatedTools.every((s: unknown) => typeof s === "string") &&
            Array.isArray(event.readFiles) && event.readFiles.every((pair: any) => Array.isArray(pair) && pair.length === 2 &&
                typeof pair[0] === "string" && typeof pair[1] === "number" && Number.isFinite(pair[1])); break;
    }
    if (!valid) throw new Error("无效的会话事件");
}

export class SessionStore {
    readonly directory: string;
    constructor(directory = join(homedir(), ".mini-claude", "sessions")) {
        // 默认保存到用户主目录，测试可以传入临时目录。
        this.directory = directory;
    }

    // 把会话 UUID 转成 JSONL 路径，并拒绝试图逃出会话目录的 ID。
    path(id: string): string {
        if (!uuidPattern.test(id)) throw new Error("无效的会话 UUID");
        return join(this.directory, `${id}.jsonl`);
    }

    // 创建新会话文件，只保存继续对话所需的非敏感配置。
    create(cwd: string, config: ModelConfig, instructions: string): LoadedSession {
        validateConfig(config);
        if (!isAbsolute(cwd)) throw new Error("会话工作目录必须为绝对路径");
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        // 白名单构造配置，客户端和 API key 永远不序列化。
        const header: SessionHeader = { type: "session", version: 1, id: randomUUID(), cwd,
            config: { model: config.model, ...(config.baseURL ? { baseURL: config.baseURL } : {}) },
            instructions, createdAt: new Date().toISOString() };
        writeFileSync(this.path(header.id), JSON.stringify(header) + "\n", { flag: "wx", mode: 0o600, flush: true });
        return { header, state: emptyState() };
    }

    // 读取并重放会话；只接受换行结尾的完整记录，半条尾记录留待修复。
    private parse(id: string): { session: LoadedSession; validBytes: number; bytes: number } {
        const data = readFileSync(this.path(id));
        // 只有换行结尾的记录被视为提交完成，半条尾记录留到追加时修复。
        const validBytes = data.lastIndexOf(10) + 1;
        const lines = data.subarray(0, validBytes).toString("utf8").trimEnd().split("\n");
        let header: SessionHeader;
        const state = emptyState();
        try {
            header = JSON.parse(lines[0]);
            if (header.type !== "session" || header.version !== 1 || header.id !== id ||
                typeof header.cwd !== "string" || !isAbsolute(header.cwd) || typeof header.instructions !== "string" ||
                typeof header.createdAt !== "string" || !Number.isFinite(Date.parse(header.createdAt))) throw new Error("无效的会话头");
            validateConfig(header.config);
            for (const line of lines.slice(1)) {
                const event: unknown = JSON.parse(line);
                validateEvent(event);
                applyEvent(state, event);
            }
        } catch (error) {
            throw new Error(`会话 ${id} 损坏: ${error instanceof Error ? error.message : String(error)}`);
        }
        return { session: { header, state }, validBytes, bytes: data.length };
    }

    // 加载会话头和重放后的 Agent 状态。
    load(id: string): LoadedSession { return this.parse(id).session; }

    // 校验新事件可以接上现有记录后，再修复文件尾部并追加。
    append(id: string, event: SessionEvent): void {
        validateEvent(event);
        const { session, validBytes, bytes } = this.parse(id);
        // 在写入前验证检查点，坏的中间记录不允许被静默覆盖。
        applyEvent(session.state, event);
        if (validBytes !== bytes) truncateSync(this.path(id), validBytes);
        appendFileSync(this.path(id), JSON.stringify(event) + "\n", { flush: true });
    }

    // 列出可恢复的会话；损坏文件单独返回错误，不影响其他会话。
    list(): { sessions: LoadedSession[]; errors: string[] } {
        let names: string[];
        try { names = readdirSync(this.directory); }
        catch (error: any) { if (error.code === "ENOENT") return { sessions: [], errors: [] }; throw error; }
        const sessions: LoadedSession[] = [];
        const errors: string[] = [];
        for (const name of names.filter(name => name.endsWith(".jsonl"))) {
            try { sessions.push(this.load(name.slice(0, -6))); }
            catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
        }
        sessions.sort((a, b) => b.header.createdAt.localeCompare(a.header.createdAt));
        return { sessions, errors };
    }
}
