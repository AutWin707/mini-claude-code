import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export type SideQueryFn = (system: string, userMessage: string, signal?: AbortSignal) => Promise<string>;

export interface RelevantMemory {
  path: string;
  content: string;
  mtimeMs: number;
  header: string;
}

export interface MemoryPrefetch {
  promise: Promise<RelevantMemory[]>;
  settled: boolean;
  consumed: boolean;
}

interface MemoryHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  description: string;
  type: string;
}

const MAX_MEMORY_BYTES_PER_FILE = 4096;
const MAX_SESSION_MEMORY_BYTES = 60 * 1024;
const SELECT_MEMORIES_PROMPT = `Select up to 5 memories that will clearly help answer the user's query.
Return only a JSON object with a "selected_memories" array of filenames. Return an empty array if none are relevant.`;

// 每个工作目录有自己的记忆目录，文件在不同会话之间保留。
export function getMemoryDir(): string {
  const projectHash = createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
  const dir = join(homedir(), ".mini-claude", "projects", projectHash, "memory");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// 记忆文件经 write_file/edit_file 修改后，重新生成一行一条的索引。
export function updateMemoryIndex(filePath: string): void {
  const dir = getMemoryDir();
  const path = resolve(filePath);
  const name = basename(path);
  if (dirname(path) !== dir || !name.endsWith(".md") || name === "MEMORY.md") return;

  const lines = ["# Memory Index", ""];
  for (const filename of readdirSync(dir).filter(f => f.endsWith(".md") && f !== "MEMORY.md")) {
    const { meta } = parseFrontmatter(readFileSync(join(dir, filename), "utf-8"));
    if (meta.name && meta.type) {
      lines.push(`- **[${meta.name}](${filename})** (${meta.type}) — ${meta.description || ""}`);
    }
  }
  writeFileSync(join(dir, "MEMORY.md"), lines.join("\n"), "utf-8");
}

// 告诉模型如何保存记忆；索引提供目录，正文按需读取或召回。
export function buildMemoryPromptSection(): string {
  const dir = getMemoryDir();
  const indexPath = join(dir, "MEMORY.md");
  const index = existsSync(indexPath)
    ? readFileSync(indexPath, "utf-8").split("\n").slice(0, 200).join("\n").slice(0, 25000)
    : "";
  return `# Memory System
You have persistent project memory in \`${dir}\`.
Save useful long-term user preferences, feedback, project decisions, or references with the write_file tool.
Do not save secrets, temporary task details, or facts easily found in the current code.
Create one Markdown file per memory in that directory, named \`{type}_{short_name}.md\`.
Choose one type: user, feedback, project, or reference. For example:
\`\`\`markdown
---
name: short name
description: one-line description
type: feedback
---
Memory content.
\`\`\`
Use read_file before updating an existing memory. MEMORY.md is an automatically updated index; do not edit it manually.

## Current Memory Index
${index || "(No memories saved yet.)"}`;
}

function scanMemoryHeaders(): MemoryHeader[] {
  const dir = getMemoryDir();
  return readdirSync(dir)
    .filter(filename => filename.endsWith(".md") && filename !== "MEMORY.md")
    .map(filename => {
      const filePath = join(dir, filename);
      const mtimeMs = statSync(filePath).mtimeMs;
      const first30 = readFileSync(filePath, "utf-8").split("\n").slice(0, 30).join("\n");
      const { meta } = parseFrontmatter(first30);
      return { filename, filePath, mtimeMs, description: meta.description || "", type: meta.type || "" };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 200);
}

function formatMemoryManifest(headers: MemoryHeader[]): string {
  return headers.map(h => `- ${h.type ? `[${h.type}] ` : ""}${h.filename}: ${h.description}`).join("\n");
}

function memoryAge(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function memoryFreshnessWarning(mtimeMs: number): string {
  const days = Math.max(0, Math.floor((Date.now() - mtimeMs) / 86_400_000));
  return days <= 1 ? "" : `This memory is ${days} days old. Verify it against the current state before relying on it.`;
}

export async function selectRelevantMemories(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  signal?: AbortSignal,
): Promise<RelevantMemory[]> {
  const headers = scanMemoryHeaders();
  if (headers.length === 0) return [];

  // 过滤已经在本会话中展示过的记忆
  const candidates = headers.filter((h) => !alreadySurfaced.has(h.filePath));
  if (candidates.length === 0) return [];

  const manifest = formatMemoryManifest(candidates);

  try {
    const text = await sideQuery(
      SELECT_MEMORIES_PROMPT,
      `Query: ${query}\n\nAvailable memories:\n${manifest}`,
      signal,
    );

    // 从响应中提取 JSON（模型可能用 markdown 代码块包裹）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    const selectedFilenames: string[] = parsed.selected_memories || [];

    // 文件名映射回 header，读取完整内容
    const filenameSet = new Set(selectedFilenames);
    const selected = candidates.filter((h) => filenameSet.has(h.filename));

    return selected.slice(0, 5).map((h) => {
      let content = readFileSync(h.filePath, "utf-8");
      // 单文件截断（4KB）
      if (Buffer.byteLength(content) > MAX_MEMORY_BYTES_PER_FILE) {
        content = content.slice(0, MAX_MEMORY_BYTES_PER_FILE) +
          "\n\n[... truncated, memory file too large ...]";
      }
      const freshness = memoryFreshnessWarning(h.mtimeMs);
      const headerText = freshness
        ? `${freshness}\n\nMemory: ${h.filePath}:`
        : `Memory (saved ${memoryAge(h.mtimeMs)}): ${h.filePath}:`;

      return { path: h.filePath, content, mtimeMs: h.mtimeMs, header: headerText };
    });
  } catch (err: any) {
    // 静默失败——记忆召回永远不应阻塞主循环
    if (signal?.aborted) return [];
    console.error(`[memory] semantic recall failed: ${err.message}`);
    return [];
  }
}

export function startMemoryPrefetch(
  query: string,
  sideQuery: SideQueryFn,
  alreadySurfaced: Set<string>,
  sessionMemoryBytes: number,
  signal?: AbortSignal,
): MemoryPrefetch | null {
  // 门控 1: 中文至少两个字，或空格分词的语言至少两个词。
  const cjkChars = query.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? [];
  if (cjkChars.length < 2 && !/\s/.test(query.trim())) return null;

  // 门控 2: 会话预算已满
  if (sessionMemoryBytes >= MAX_SESSION_MEMORY_BYTES) return null;

  // 门控 3: 没有记忆文件
  const dir = getMemoryDir();
  const hasMemories = readdirSync(dir).some(
    (f) => f.endsWith(".md") && f !== "MEMORY.md"
  );
  if (!hasMemories) return null;

  const handle: MemoryPrefetch = {
    promise: selectRelevantMemories(query, sideQuery, alreadySurfaced, signal),
    settled: false,
    consumed: false,
  };
  handle.promise.then(() => { handle.settled = true; }).catch(() => { handle.settled = true; });
  return handle;
}

export function formatMemoriesForInjection(memories: RelevantMemory[]): string {
  return memories.map(m => `<system-reminder>\n${m.header}\n\n${m.content}\n</system-reminder>`).join("\n\n");
}