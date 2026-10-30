import { statSync } from "node:fs";
import { Agent, DEFAULT_MAX_CONTEXT, type AgentOutput, type ModelClient } from "./agent.ts";
import { loadProjectInstructions } from "./prompt.ts";
import { modelConfigFromEnv, SessionStore, type LoadedSession, type ModelConfig } from "./session.ts";
import { entriesFromMessages, preview, toolDetail, type TranscriptEntry } from "./transcript.ts";
import type { TokenUsage } from "./usage.ts";
import { isPermissionMode, permissionModes, type PermissionMode, type PermissionRules } from "./permissions.ts";

export interface ReplView {
    id: string;
    cwd: string;
    model: string;
    title: string;
    entries: TranscriptEntry[];
    busy: boolean;
    permissionMode: PermissionMode;
    maxContext: number | null;
    permission: string | null;
    totalUsage: TokenUsage;
    lastTurnUsage: TokenUsage;
}

// UI 只管理显示；会话和 Agent 不依赖 Ink，便于测试 clear 的无副作用语义。
export class ReplController {
    readonly store: SessionStore;
    private session: LoadedSession;
    private agent: Agent;
    private client?: ModelClient;
    private entries: TranscriptEntry[] = [];
    private busy = false;
    private abortController?: AbortController;
    private permissionMode: PermissionMode;
    private maxContext: number | null = DEFAULT_MAX_CONTEXT;
    private permissionRules?: PermissionRules;
    private pendingPermission?: { message: string; finish: (approved: boolean) => void };
    private listeners = new Set<() => void>();
    private view!: ReplView;

    // 创建新会话和对应 Agent，并把 Agent 事件接到 JSONL 与界面输出。
    constructor(options: { store?: SessionStore; config?: ModelConfig; client?: ModelClient; permissionMode?: PermissionMode; permissionRules?: PermissionRules } = {}) {
        this.store = options.store ?? new SessionStore();
        this.client = options.client;
        this.permissionMode = options.permissionMode ?? "default";
        this.permissionRules = options.permissionRules;
        this.session = this.store.create(process.cwd(), options.config ?? modelConfigFromEnv(), loadProjectInstructions());
        this.agent = this.makeAgent(this.session);
        this.publish();
    }

    // 用指定会话的配置和状态构造 Agent，不在这里切换当前会话。
    private makeAgent(session: LoadedSession): Agent {
        return new Agent({ config: session.header.config, state: session.state,
            instructions: session.header.instructions, client: this.client,
            permissionMode: this.permissionMode, maxContext: this.maxContext,
            permissionCwd: session.header.cwd, permissionRules: this.permissionRules,
            confirmPermission: (message, signal) => this.requestPermission(message, signal),
            onEvent: event => this.store.append(session.header.id, event),
            onOutput: output => { this.note(output); },
        });
    }

    // 生成界面快照并通知所有订阅者重新渲染。
    private publish(): void {
        const state = this.agent.snapshot();
        this.view = { id: this.session.header.id, cwd: this.session.header.cwd, model: this.agent.config.model,
            title: state.title ?? "新会话", entries: [...this.entries], busy: this.busy,
            permissionMode: this.permissionMode, maxContext: this.maxContext, permission: this.pendingPermission?.message ?? null,
            totalUsage: state.totalUsage, lastTurnUsage: state.lastTurnUsage };
        for (const listener of this.listeners) listener();
    }

    // 返回当前界面快照；订阅者不应修改其中的数组。
    getSnapshot = (): ReplView => this.view;
    // 订阅界面变化，返回取消订阅函数。
    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    };
    // 把 Agent 的文本、工具调用或工具结果追加到显示区。
    private note(output: AgentOutput): void {
        if (output.type === "text" || output.type === "thinking") {
            const type = output.type === "text" ? "assistant" : "thinking";
            const last = this.entries.at(-1);
            if (last?.type === type) last.text += output.text;
            else if (output.text) this.entries.push({ type, text: output.text });
        } else if (output.type === "tool") {
            this.entries.push({ type: "tool", name: output.name, detail: toolDetail(output.input) });
        } else if (output.type === "note") {
            if (output.text.trim()) this.entries.push({ type: "note", text: output.text });
        } else if (output.text.trim()) {
            this.entries.push({ type: "result", text: preview(output.text), error: output.error });
        }
        this.publish();
    }

    // 在显示区追加错误，不改变会话和 Agent 状态。
    showError(error: unknown): void {
        this.entries.push({ type: "error", text: error instanceof Error ? error.message : String(error) });
        this.publish();
    }

    // 模型或工具仍在执行时，拒绝会并发修改会话的操作。
    private assertIdle(): void {
        if (this.busy) throw new Error("正在处理，请等待当前操作完成");
    }

    // 等待 Ink 界面决策；取消时释放等待，避免聊天永远处于 busy 状态。
    private requestPermission(message: string, signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) return Promise.resolve(false);
        return new Promise(resolve => {
            const finish = (approved: boolean) => {
                signal?.removeEventListener("abort", abort);
                this.pendingPermission = undefined;
                this.publish();
                resolve(approved);
            };
            const abort = () => finish(false);
            this.pendingPermission = { message, finish };
            signal?.addEventListener("abort", abort, { once: true });
            this.publish();
        });
    }

    answerPermission(approved: boolean): void {
        this.pendingPermission?.finish(approved);
    }

    // 取消当前聊天中的模型请求、确认等待或重试等待。
    cancel(): void {
        this.abortController?.abort();
    }

    // 只清空显示区，不切换会话，也不改 Agent 状态、JSONL 和 token 统计。
    clear(): void {
        this.assertIdle();
        this.entries = [];
        this.publish();
    }

    // 读取会话列表；忙碌时不打开，避免处理中途切换。
    listSessions(): ReturnType<SessionStore["list"]> {
        this.assertIdle();
        return this.store.list();
    }

    // 恢复目标会话的上下文、模型和工作目录；任一步失败都保持当前会话不变。
    switchSession(id: string): void {
        this.assertIdle();
        if (id === this.session.header.id) return;
        const next = this.store.load(id);
        try {
            if (!statSync(next.header.cwd).isDirectory()) throw new Error("不是目录");
        } catch { throw new Error(`无法恢复会话工作目录: ${next.header.cwd}`); }
        const agent = this.makeAgent(next);
        // 校验与构造成功后再提交切换，失败不改变当前会话。
        process.chdir(next.header.cwd);
        this.session = next;
        this.agent = agent;
        this.entries = entriesFromMessages(next.state.messages);
        this.publish();
    }

    // 处理输入：/permission 切换权限，/maxcontext 设置上限，/clear 清屏，/compact 压缩上下文。
    async submit(input: string): Promise<void> {
        this.assertIdle();
        const text = input.trim();
        if (!text) return;
        if (text === "/clear") { this.clear(); return; }
        if (/^\/maxcontext(?:\s|$)/.test(text)) {
            const value = text.slice("/maxcontext".length).trim();
            if (value) {
                if (value !== "off" && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
                    throw new Error("用法: /maxcontext <正整数 token 数|off>");
                }
                const maxContext = value === "off" ? null : Number(value);
                this.agent.setMaxContext(maxContext);
                this.maxContext = maxContext;
            }
            this.entries.push({ type: "note", text: `自动压缩上限: ${this.maxContext === null ? "关闭" : `${this.maxContext} token（估算）`}；默认 ${DEFAULT_MAX_CONTEXT}` });
            this.publish();
            return;
        }
        if (/^\/permission(?:\s|$)/.test(text)) {
            const mode = text.slice("/permission".length).trim();
            if (mode) {
                if (!isPermissionMode(mode)) throw new Error(`权限模式可选: ${permissionModes.join("、")}`);
                this.agent.setPermissionMode(mode);
                this.permissionMode = mode;
            }
            this.entries.push({ type: "note", text: `当前权限模式: ${this.permissionMode}；可选: ${permissionModes.join("、")}` });
            this.publish();
            return;
        }
        let prompt = text;
        if (/^\/chat(?:\s|$)/.test(text)) prompt = text.slice(5).trim();
        else if (text.startsWith("/") && text !== "/compact") throw new Error("支持 /chat <内容>、/clear、/compact、/permission [模式]、/maxcontext [token数|off]");
        if (!prompt) throw new Error("用法: /chat <内容>");
        this.busy = true;
        if (text !== "/compact") this.entries.push({ type: "user", text: prompt });
        this.publish();
        try {
            if (text === "/compact") {
                await this.agent.compact();
                this.entries.push({ type: "note", text: "上下文已压缩，原始记录仍保留。" });
            } else {
                this.abortController = new AbortController();
                await this.agent.chat(prompt, this.abortController.signal);
                this.abortController = undefined;
                await this.agent.ensureTitle(this.session.header.id);
            }
        } finally {
            this.abortController = undefined;
            this.busy = false;
            this.publish();
        }
    }
}
