import { createElement as h, useState, useSyncExternalStore, useEffect } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import { stripVTControlCharacters } from "node:util";
import { ReplController } from "./repl.ts";
import type { LoadedSession } from "./session.ts";
import { renderTranscript } from "./transcript.ts";
import { formatUsage } from "./usage.ts";

// 去掉标题和路径中的控制符，避免会话数据干扰终端显示。
const safeText = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

// 渲染 REPL：订阅控制器状态，处理输入、会话列表、清屏和聊天提交。
export function ReplApp({ controller, onClear = () => {} }: { controller: ReplController; onClear?: () => void }) {
    const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [size, setSize] = useState({ rows: stdout.rows || 24, columns: stdout.columns || 80 });
    const [input, setInput] = useState("");
    const [cursor, setCursor] = useState(0);
    const [sessions, setSessions] = useState<LoadedSession[] | null>(null);
    const [selected, setSelected] = useState(0);
    useEffect(() => {
        const resize = () => setSize({ rows: stdout.rows || 24, columns: stdout.columns || 80 });
        stdout.on("resize", resize);
        return () => { stdout.off("resize", resize); };
    }, [stdout]);

    const characters = Array.from(input);
    useInput((value, key) => {
        if (key.ctrl && value === "c") {
            if (controller.getSnapshot().busy) controller.cancel();
            else exit();
            return;
        }
        if (view.busy || controller.getSnapshot().busy) return;
        if (sessions) {
            if (key.escape) setSessions(null);
            else if (key.upArrow) setSelected(index => Math.max(0, index - 1));
            else if (key.downArrow) setSelected(index => Math.min(sessions.length - 1, index + 1));
            else if (key.return && sessions[selected]) {
                try { controller.switchSession(sessions[selected].header.id); }
                catch (error) { controller.showError(error); }
                setSessions(null);
            }
            return;
        }
        if (key.leftArrow && !input) {
            try {
                const result = controller.listSessions();
                for (const error of result.errors) controller.showError(error);
                setSessions(result.sessions);
                setSelected(0);
            } catch (error) { controller.showError(error); }
            return;
        }
        if (key.return) {
            if (!input.trim()) return;
            const text = input;
            setInput(""); setCursor(0);
            if (text.trim() === "/clear") onClear();
            void controller.submit(text).catch(error => controller.showError(error));
        } else if (key.leftArrow) setCursor(Math.max(0, cursor - 1));
        else if (key.rightArrow) setCursor(Math.min(characters.length, cursor + 1));
        else if (key.home || (key.ctrl && value === "a")) setCursor(0);
        else if (key.end || (key.ctrl && value === "e")) setCursor(characters.length);
        else if (key.backspace || key.delete) {
            // 常见终端将 Backspace 的 DEL 字节标记为 delete。
            if (cursor > 0) {
                characters.splice(cursor - 1, 1);
                setInput(characters.join("")); setCursor(cursor - 1);
            }
        } else if (!key.ctrl && !key.meta && !key.escape && !key.tab && value) {
            const pasted = Array.from(safeText(value).replace(/\n/g, " "));
            characters.splice(cursor, 0, ...pasted);
            setInput(characters.join("")); setCursor(cursor + pasted.length);
        }
    });

    const height = Math.max(1, size.rows - 7);
    const start = Math.max(0, selected - height + 1);
    const lines = renderTranscript(view.entries, size.columns).slice(-height);
    const body = sessions
        ? sessions.slice(start, start + height).map((session, index) => h(Text, { key: session.header.id,
            color: start + index === selected ? "cyan" : undefined, wrap: "truncate" },
            `${start + index === selected ? ">" : " "} ${safeText(session.state.title ?? "新会话")} · ${session.header.id.slice(0, 8)} · ${safeText(session.header.cwd)}`))
        : lines.map((line, index) => h(Text, { key: index, wrap: "truncate" }, line || " "));
    return h(Box, { flexDirection: "column", width: size.columns },
        h(Text, { bold: true, wrap: "truncate" }, `Mini Claude Code · ${safeText(view.title)} · ${view.id.slice(0, 8)}`),
        h(Text, { dimColor: true, wrap: "truncate" }, `${safeText(view.model)} · ${safeText(view.cwd)}`),
        h(Box, { flexDirection: "column", height, overflow: "hidden" },
            ...body, sessions?.length === 0 ? h(Text, null, "暂无会话") : null),
        h(Text, { dimColor: true, wrap: "truncate" }, `本轮 token: ${formatUsage(view.lastTurnUsage)}`),
        h(Text, { dimColor: true, wrap: "truncate" }, `累计 token: ${formatUsage(view.totalUsage)}`),
        h(Text, { color: view.busy ? "yellow" : undefined, wrap: "truncate" }, view.busy ? "处理中…" :
            sessions ? "↑↓ 选择 · Enter 切换 · Esc 返回" : "← 空输入切换会话 · /chat · /clear · /compact · Ctrl+C 退出"),
        h(Text, { wrap: "truncate-start" }, "❯ ", characters.slice(0, cursor).join(""),
            h(Text, { inverse: !view.busy && !sessions }, characters[cursor] ?? " "), characters.slice(cursor + 1).join("")),
    );
}

// 启动 Ink REPL，直到用户退出后清理终端状态。
export async function startRepl(): Promise<void> {
    const controller = new ReplController();
    const app = render(h(ReplApp, { controller, onClear: () => app.clear() }), { exitOnCtrlC: false });
    try { await app.waitUntilExit(); } finally { app.cleanup(); }
}
