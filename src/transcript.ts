import { styleText, stripVTControlCharacters } from "node:util";
import { renderMarkdown } from "./markdown.ts";

export type TranscriptEntry =
    | { type: "user"; text: string }
    | { type: "assistant"; text: string }
    | { type: "thinking"; text: string }
    | { type: "tool"; name: string; detail: string }
    | { type: "result"; text: string; error: boolean }
    | { type: "error"; text: string }
    | { type: "note"; text: string };

const labels: Record<string, string> = {
    read_file: "Read", write_file: "Write", edit_file: "Edit", list_files: "Glob",
    grep_search: "Grep", run_shell: "Bash", web_fetch: "Fetch", tool_search: "ToolSearch",
    example_tool: "Example",
};

// 把内部工具名显示成简短标签，未知工具保留原名。
export function toolLabel(name: string): string {
    return labels[name] ?? name;
}

// 从工具参数中提取最有用的一项，压缩成单行摘要。
export function toolDetail(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    const record = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "url", "query", "message"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return oneLine(value, 80);
    }
    const json = JSON.stringify(input);
    return json === "{}" ? "" : oneLine(json, 80);
}

// 把工具结果压缩成有限长度的单行预览。
export function preview(text: string, limit = 100): string {
    return oneLine(text, limit);
}

// 合并空白并按字符数截断，超长时保留结尾省略号。
function oneLine(value: string, limit: number): string {
    const text = plain(value).replace(/\s+/g, " ").trim();
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

// 去掉颜色码和控制符，得到可安全计算宽度的纯文本。
function plain(value: string): string {
    return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

// 估算字符宽度；中文等宽字符按两列计算。
function charWidth(char: string): number {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x1100 ? 2 : 1;
}

// 按终端列宽换行，不拆开单个字符。
function wrapPlain(value: string, width: number): string[] {
    const limit = Math.max(8, width);
    const lines: string[] = [];
    for (const paragraph of plain(value).split("\n")) {
        const chars = Array.from(paragraph);
        if (!chars.length) { lines.push(""); continue; }
        let line = "";
        let used = 0;
        for (const char of chars) {
            const widthOfChar = charWidth(char);
            if (used + widthOfChar > limit && line) {
                lines.push(line);
                line = char;
                used = widthOfChar;
            } else {
                line += char;
                used += widthOfChar;
            }
        }
        if (line) lines.push(line);
    }
    return lines.length ? lines : [""];
}

// 给文本添加终端颜色或样式。
function paint(style: Parameters<typeof styleText>[0], text: string): string {
    return styleText(style, text);
}

// 把全部显示条目渲染成终端行：用户用 ❯，工具用 ● / ⎿，助手正文渲染 Markdown。
export function renderTranscript(entries: TranscriptEntry[], columns: number): string[] {
    const width = Math.max(20, columns);
    const lines: string[] = [];
    for (const entry of entries) {
        const next = renderEntry(entry, width);
        if (!next.length) continue;
        if (lines.length) lines.push("");
        lines.push(...next);
    }
    return lines;
}

// 按条目类型渲染一条消息、工具调用、结果、错误或提示。
function renderEntry(entry: TranscriptEntry, width: number): string[] {
    if (entry.type === "user") return prefixed("❯ ", entry.text, width, "cyan");
    if (entry.type === "assistant") {
        const rendered = renderMarkdown(entry.text, width);
        return rendered ? rendered.split("\n") : [];
    }
    if (entry.type === "thinking") {
        // 移除 Markdown 渲染器的重置序列，避免它们覆盖整行的灰色斜体。
        const rendered = stripVTControlCharacters(renderMarkdown(entry.text, width));
        return rendered ? rendered.split("\n").map(line => paint(["gray", "italic"], line)) : [];
    }
    if (entry.type === "tool") {
        const detail = entry.detail ? `  ${entry.detail}` : "";
        return [paint("cyan", "● ") + paint("bold", toolLabel(entry.name)) + plain(detail)];
    }
    if (entry.type === "result") {
        const style = entry.error ? "red" : "dim";
        return wrapPlain(entry.text, width - 4).map((line, index) => paint(style, `${index === 0 ? "⎿ " : "  "}${line}`));
    }
    if (entry.type === "error") return wrapPlain(entry.text, width).map(line => paint("red", line));
    return wrapPlain(entry.text, width).map(line => paint("dim", line));
}

// 首行添加标记，续行保持相同缩进。
function prefixed(marker: string, text: string, width: number, style: Parameters<typeof styleText>[0]): string[] {
    const head = paint(style, marker);
    return wrapPlain(text, width - 2).map((line, index) => index === 0 ? head + line : `  ${line}`);
}

type ContentBlock = {
    type: string;
    text?: string;
    name?: string;
    input?: unknown;
    content?: unknown;
    is_error?: boolean;
};

// 从会话消息重建显示条目，供切换会话后恢复界面内容。
export function entriesFromMessages(messages: Array<{ role: string; content: string | ContentBlock[] }>): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (const message of messages) {
        if (typeof message.content === "string") entries.push(...textEntries(message.role, message.content));
        else for (const block of message.content) entries.push(...blockEntries(message.role, block));
    }
    return entries;
}

// 把文本消息转成显示条目，并识别项目指令和压缩摘要。
function textEntries(role: string, content: string): TranscriptEntry[] {
    const text = content.replace(/^<project-instructions>[\s\S]*?<\/project-instructions>\n\n/, "");
    const summary = text.match(/<conversation-summary>\n([\s\S]*?)\n<\/conversation-summary>/);
    if (summary) {
        const entries: TranscriptEntry[] = [{ type: "note", text: "上下文已压缩，原始记录仍保留。" }];
        if (summary[1].trim()) entries.push({ type: "assistant", text: summary[1].trim() });
        return entries;
    }
    const trimmed = text.trim();
    if (!trimmed) return [];
    return [{ type: role === "user" ? "user" : "assistant", text: trimmed }];
}

// 把文本块、工具调用或工具结果转换成对应的显示条目。
function blockEntries(role: string, block: ContentBlock): TranscriptEntry[] {
    if (block.type === "text" && block.text?.trim()) return textEntries(role, block.text);
    if (block.type === "tool_use" && block.name) return [{ type: "tool", name: block.name, detail: toolDetail(block.input) }];
    if (block.type === "tool_result") {
        const text = preview(blockText(block.content));
        return text ? [{ type: "result", text, error: block.is_error === true || text.startsWith("Error") }] : [];
    }
    return [];
}

// 提取工具结果中的文本，忽略非文本内容。
function blockText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map(part => part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "").join("\n");
}
