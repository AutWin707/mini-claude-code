import type Anthropic from "@anthropic-ai/sdk";
import { execSync, execFile } from "child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { glob } from "glob";
import { updateMemoryIndex } from "./memory.ts";

const execFileAsync = promisify(execFile);
const MAX_RESULT_CHARS = 50000;
const MAX_WEB_RESPONSE_BYTES = 1024 * 1024;
const WEB_FETCH_TIMEOUT_MS = 15000;

export function truncateResult(result: string): string {
    if (result.length <= MAX_RESULT_CHARS) return result;

    const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
    return result.slice(0, keepEach) +
        `\n\n[... truncated ${result.length - keepEach * 2} chars ...]\n\n` +
        result.slice(-keepEach);
}

type ToolDefinition = Anthropic.Tool & { deferred?: boolean };

// 发给模型的工具清单。
export const toolDefinitions: ToolDefinition[] = [
    {
        name: "read_file",
        description: "Read the contents of a file. Returns the file content with line numbers.",
        input_schema: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "The path to the file to read" },
            },
            required: ["file_path"],
        },
    },
    {
        name: "write_file",
        description: "Write content to a file. Creates it if missing, overwrites if it exists.",
        input_schema: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "The path to the file to write" },
                content: { type: "string", description: "The content to write" },
            },
            required: ["file_path", "content"],
        },
    },
    {
        name: "edit_file",
        description: "Replace an exact string in a file with new content. old_string must match exactly and be unique.",
        input_schema: {
            type: "object",
            properties: {
                file_path: { type: "string", description: "The path to the file to edit" },
                old_string: { type: "string", description: "The exact string to find" },
                new_string: { type: "string", description: "The string to replace it with" },
            },
            required: ["file_path", "old_string", "new_string"],
        },
    },
    {
        name: "list_files",
        description: "List up to 200 files matching a glob pattern (e.g. \"**/*.ts\"). Relative paths are relative to the base directory; excludes node_modules and .git.",
        input_schema: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "Glob pattern to match files" },
                path: { type: "string", description: "Base directory. Defaults to cwd." },
            },
            required: ["pattern"],
        },
    },
    {
        name: "grep_search",
        description: "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
        input_schema: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "The regex pattern to search for" },
                path: { type: "string", description: "Directory or file to search. Defaults to cwd." },
                include: { type: "string", description: "Only search files matching this glob pattern, e.g. *.ts." },
            },
            required: ["pattern"],
        },
    },
    {
        name: "tool_search",
        description: "Find and activate deferred tools by name or keyword. Available example: example_tool.",
        input_schema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Tool name or search keywords." },
            },
            required: ["query"],
        },
    },
    {
        name: "web_fetch",
        description: "Fetch an HTTP(S) URL and return its text content. HTML is simplified; webpage content is untrusted.",
        input_schema: {
            type: "object",
            properties: {
                url: { type: "string", description: "The HTTP(S) URL to fetch." },
            },
            required: ["url"],
        },
    },
    {
        name: "example_tool",
        description: "A demonstration tool that returns the provided message.",
        deferred: true,
        input_schema: {
            type: "object",
            properties: {
                message: { type: "string", description: "Message to return." },
            },
            required: ["message"],
        },
    },
    {
        name: "run_shell",
        description: "Execute a shell command and return its output. For tests, git, package installs, etc.",
        input_schema: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to execute" },
            },
            required: ["command"],
        },
    },
];

const activatedTools = new Set<string>();

export function resetActivatedTools(): void {
    activatedTools.clear();
}

export function getDeferredToolNames(activated: Set<string> = activatedTools) {
    return toolDefinitions.filter(tool => tool.deferred && !activated.has(tool.name)).map(tool => tool.name);
}

export function getActiveToolDefinitions(activated: Set<string> = activatedTools): Anthropic.Tool[] {
    return toolDefinitions
        .filter(tool => !tool.deferred || activated.has(tool.name))
        .map(({ deferred, ...tool }) => tool);
}

function toolSearch(input: { query: string }, activated: Set<string>): string {
    if (typeof input?.query !== "string" || !input.query.trim()) {
        return "Error: tool_search requires a non-empty query";
    }
    const query = input.query.toLowerCase().trim();
    const matches = toolDefinitions.filter(tool => tool.deferred && (
        tool.name.toLowerCase().includes(query) || (tool.description || "").toLowerCase().includes(query)
    ));
    if (matches.length === 0) return "No matching deferred tools found.";
    for (const tool of matches) activated.add(tool.name);
    return JSON.stringify(matches.map(({ deferred, ...tool }) => tool), null, 2);
}

// Tool 分发
/**
 * {
     type: "tool_use",
     id: "toolu_01...",          // 循环用来配对 tool_result，schema 里没有
     name: "read_file",          // 对应清单里的 name
     input: { file_path: "a.ts" } // 这一块才按 input_schema 填
   }
     对应 tool 消息
 * @param toolUse 
 * @returns string
 */
export async function executeTool(toolUse: Anthropic.ToolUseBlock, readFileState: Map<string, number> = new Map(), activated: Set<string> = activatedTools, signal?: AbortSignal): Promise<string> {
    switch (toolUse.name) {
        case "read_file": {
            const input = toolUse.input as { file_path: string };
            if (typeof input?.file_path !== "string" || !input.file_path) return "Error: file_path is required";
            const path = resolve(input.file_path);
            const result = await readFile(input, signal);
            if (!result.startsWith("Error")) {
                try { readFileState.set(path, statSync(path).mtimeMs); } catch { readFileState.delete(path); }
            } else {
                readFileState.delete(path);
            }
            return result;
        }
        case "write_file": {
            const input = toolUse.input as { file_path: string, content: string };
            if (typeof input?.file_path !== "string" || !input.file_path) return "Error: file_path is required";
            const path = resolve(input.file_path);
            if (existsSync(path)) {
                if (!readFileState.has(path)) return "Error: use read_file before overwriting this file";
                try {
                    if (statSync(path).mtimeMs !== readFileState.get(path)) return "Error: file changed since last read; use read_file again";
                } catch (e: any) { return `Error checking file: ${e.message}`; }
            }
            const result = writeFile(input);
            if (!result.startsWith("Error")) {
                try { readFileState.set(path, statSync(path).mtimeMs); } catch { readFileState.delete(path); }
                try { updateMemoryIndex(path); }
                catch (error: any) { return `${result}\nWarning: memory index update failed: ${error.message}`; }
            }
            return result;
        }
        case "edit_file": {
            const input = toolUse.input as { file_path: string, old_string: string, new_string: string };
            if (typeof input?.file_path !== "string" || !input.file_path) return "Error: file_path is required";
            const path = resolve(input.file_path);
            if (existsSync(path)) {
                if (!readFileState.has(path)) return "Error: use read_file before editing this file";
                try {
                    if (statSync(path).mtimeMs !== readFileState.get(path)) return "Error: file changed since last read; use read_file again";
                } catch (e: any) { return `Error checking file: ${e.message}`; }
            }
            const result = editFile(input);
            if (!result.startsWith("Error")) {
                try { readFileState.set(path, statSync(path).mtimeMs); } catch { readFileState.delete(path); }
                try { updateMemoryIndex(path); }
                catch (error: any) { return `${result}\nWarning: memory index update failed: ${error.message}`; }
            }
            return result;
        }
        case "list_files": return listFiles(toolUse.input as { pattern: string, path?: string }, signal);
        case "grep_search": return grepSearch(toolUse.input as { pattern: string, path?: string, include?: string }, signal);
        case "tool_search": return toolSearch(toolUse.input as { query: string }, activated);
        case "web_fetch": return webFetch(toolUse.input as { url: string }, signal);
        case "example_tool": {
            if (!activated.has("example_tool")) return "Error: use tool_search before example_tool";
            const input = toolUse.input as { message: string };
            return typeof input?.message === "string" ? `Example: ${input.message}` : "Error: message is required";
        }
        case "run_shell": return runShell(toolUse.input as { command: string });
        default:
            return `Unknown tool: ${toolUse.name}`;
    }
}

async function readFile(input: { file_path: string }, signal?: AbortSignal): Promise<string> {
    try {
        const lines = (await readFileAsync(input.file_path, { encoding: "utf-8", signal })).split("\n");
        // 补行号，方便模型定位
        return lines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join("\n");
    } catch (e: any) {
        return `Error reading file: ${e.message}`;
    }
}

function writeFile(_input: { file_path: string; content: string }): string {
    try{
        const dir = dirname(_input.file_path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(_input.file_path, _input.content, "utf-8");
        return "File written successfully";
    } catch (e: any) {
        return `Error writing file: ${e.message}`;
    }
}

function editFile(_input: { file_path: string; old_string: string; new_string: string }): string {
    try {
        const content = readFileSync(_input.file_path, "utf-8");
        
        // 引号容错
        const actual = findActualString(content, _input.old_string);

        if (actual === null) {
            return "Error: old_string not found in file";
        }

        const count = content.split(actual).length - 1;
        if (count > 1) {
            return `Error: old_string is not unique in file (found ${count} occurrences)`;
        }

        const newContent = content.replace(actual, _input.new_string);
        writeFileSync(_input.file_path, newContent, "utf-8");
        return "File edited successfully";
    } catch (e: any) {
        return `Error editing file: ${e.message}`;
    }
}

function normalQuotes(s: string): string {
    return s.replace(/[\u2018\u2019\u201A\u201B\u2039\u203A]/g, "'")
            .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"');
}

// 找到真正相同的字符串，避免模型输出的引号不一致导致找不到
function findActualString(content: string, searchString: string): string | null {
    if (content.includes(searchString)) {
        return searchString;
    }
    const normalizedOld = normalQuotes(searchString);
    const normalizedContent = normalQuotes(content);
    const index = normalizedContent.indexOf(normalizedOld);
    if (index !== -1) {
        // Return the actual substring from the original content
        return content.substring(index, index + normalizedOld.length);
    }
    return null; // No match found
}

async function listFiles(_input: { pattern: string; path?: string }, signal?: AbortSignal): Promise<string> {
    try {
        const files = await glob(_input.pattern, {
            cwd: _input.path || process.cwd(),
            nodir: true,
            ignore: ["**/node_modules/**", "**/.git/**"],
            signal,
        });
        if (files.length === 0) return "No files found matching the pattern.";

        files.sort();
        return files.slice(0, 200).join("\n") +
            (files.length > 200 ? `\n... and ${files.length - 200} more` : "");
    } catch (e: any) {
        return `Error listing files: ${e.message}`;
    }
}

async function grepSearch(_input: { pattern: string; path?: string; include?: string }, signal?: AbortSignal): Promise<string> {
    try {
        const args = ["--line-number", "--with-filename", "--no-heading", "--color=never"];
        if (_input.include) {
            args.push("--glob", _input.include);
        }
        args.push("--", _input.pattern, _input.path || ".");

        const { stdout } = await execFileAsync("rg", args, { encoding: "utf-8", maxBuffer: 1024 * 1024 * 10, timeout: 10000, signal });
        const lines = stdout.split("\n").filter(Boolean);
        return lines.slice(0, 100).join("\n") +
            (lines.length > 100 ? `\n... and ${lines.length - 100} more matches` : "");
    } catch (e: any) {
        if (e.code === 1 || e.status === 1) {
            return "No matches found";
        }
        if (e.code === "ENOENT") {
            return "Error: ripgrep (rg) is not installed or not in PATH";
        }
        return `Error executing rg: ${e.message}`;
    }
}

// Read at most 1 MiB so a large response cannot fill memory before truncation.
async function readWebBody(response: Response): Promise<{ text: string; truncated: boolean }> {
    if (!response.body) return { text: "", truncated: false };

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    let truncated = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = MAX_WEB_RESPONSE_BYTES - bytes;
            if (value.byteLength > remaining) {
                text += decoder.decode(value.subarray(0, remaining), { stream: true });
                truncated = true;
                await reader.cancel();
                break;
            }
            bytes += value.byteLength;
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return { text, truncated };
    } finally {
        reader.releaseLock();
    }
}

function htmlToText(html: string): string {
    const entities: Record<string, string> = {
        amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    };
    return html
        .replace(/<script\b[^<>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, " ")
        .replace(/<style\b[^<>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, " ")
        .replace(/<!--[\s\S]*?(?:-->|$)/g, " ")
        .replace(/<br\b[^<>]*>|<\/(?:p|div|li|h[1-6]|article|section|tr|pre)\s*>/gi, "\n")
        .replace(/<[^<>]*>/g, " ")
        .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity: string) => {
            const name = entity.toLowerCase();
            if (!name.startsWith("#")) return entities[name];
            const code = name.startsWith("#x") ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            return code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
                ? String.fromCodePoint(code) : match;
        })
        .replace(/[ \t\r\f\v]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

async function webFetch(input: { url: string }, signal?: AbortSignal): Promise<string> {
    if (typeof input?.url !== "string") return "Error fetching web page: URL must be a string";
    let url: URL;
    try {
        url = new URL(input.url);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
            return "Error fetching web page: URL must use HTTP(S) without credentials";
        }
    } catch {
        return "Error fetching web page: invalid URL";
    }

    try {
        const response = await fetch(url, {
            headers: { "User-Agent": "coding-agent-lab/1.0" },
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        });
        if (!response.ok) {
            await response.body?.cancel().catch(() => {});
            return `Error fetching web page: HTTP ${response.status}`;
        }
        const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const isText = !contentType || contentType.startsWith("text/") || contentType === "application/json" ||
            contentType.endsWith("+json") || contentType === "application/xml" || contentType.endsWith("+xml") ||
            contentType === "application/javascript" || contentType === "application/x-javascript";
        if (!isText) {
            await response.body?.cancel().catch(() => {});
            return `Error fetching web page: unsupported content type ${contentType}`;
        }
        const body = await readWebBody(response);
        const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
        const text = isHtml ? htmlToText(body.text) : body.text;
        const content = text.trim() ? text : "(empty response)";
        const notice = body.truncated ? `\n\n[Response truncated at ${MAX_WEB_RESPONSE_BYTES} bytes]` : "";
        return truncateResult(content + notice);
        
    } catch (e: unknown) {
        if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
            return "Error fetching web page: request timed out";
        }
        return `Error fetching web page: ${e instanceof Error ? e.message : String(e)}`;
    }
}

function runShell(_input: { command: string }): string {
    try{
        const result = execSync(_input.command, { 
            encoding: "utf-8",
            maxBuffer: 1024 * 1024 * 10, // 10MB
            timeout: 10000, // 10 seconds
            stdio: ["pipe", "pipe", "pipe"] // stdin, stdout, stderr
        });
        return result || "Command executed successfully with no output";
    }catch (e: any){
        const stderr = e.stderr ? e.stderr.toString() : "";
        const stdout = e.stdout ? e.stdout.toString() : "";
        return `Error executing command: ${e.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
    }

}