import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { renderMarkdown } from "../src/markdown.ts";
import { entriesFromMessages, renderTranscript, toolDetail } from "../src/transcript.ts";

const plain = (value: string) => stripVTControlCharacters(value);

test("renderMarkdown keeps emphasis text and drops the markers", () => {
  const out = plain(renderMarkdown("See **bold** and `code`.\n\n- item", 40));
  assert.match(out, /bold/);
  assert.match(out, /code/);
  assert.match(out, /item/);
  assert.doesNotMatch(out, /\*\*bold\*\*/);
  assert.doesNotMatch(out, /`code`/);
});

test("renderMarkdown strips terminal controls from the source", () => {
  const out = renderMarkdown("hello\u001b[31mred\u0007", 40);
  // BEL 会结束 ESC 序列，整段控制序列连同夹在里面的文本一起丢掉。
  assert.equal(plain(out), "hello");
  assert.equal(out.includes("\u001b"), false);
  assert.equal(out.includes("\u0007"), false);
  assert.match(plain(renderMarkdown("hello\u001b[31mred", 40)), /hellored/);
});

test("transcript uses prompt and tool markers instead of role labels", () => {
  const lines = renderTranscript([
    { type: "user", text: "hello" },
    { type: "assistant", text: "**hi**" },
    { type: "tool", name: "read_file", detail: "src/ui.ts" },
    { type: "result", text: "export const x = 1", error: false },
    { type: "note", text: "上下文已压缩，原始记录仍保留。" },
  ], 40);
  const text = plain(lines.join("\n"));
  assert.match(text, /❯ hello/);
  assert.match(text, /hi/);
  assert.match(text, /● Read {2}src\/ui\.ts/);
  assert.match(text, /⎿ export const x = 1/);
  assert.doesNotMatch(text, /You:|Assistant:|\*\*hi\*\*/);
  assert.equal(toolDetail({ file_path: "src/ui.ts", extra: true }), "src/ui.ts");
});

test("thinking is rendered in gray italics without Markdown reset sequences", () => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = "1";
  try {
    const lines = renderTranscript([{ type: "thinking", text: "**Plan**\n\nThinking *carefully* about this." }], 40);
    assert.match(plain(lines.join("\n")), /Plan\n\nThinking carefully about this\./);
    for (const line of lines.filter(line => plain(line))) {
      assert.match(line, /^\u001b\[90m\u001b\[3m/);
      assert.doesNotMatch(line, /\u001b\[0m/);
    }
  } finally {
    if (previous === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = previous;
  }
});

test("restored messages skip role prefixes and keep tool previews", () => {
  const entries = entriesFromMessages([
    { role: "user", content: "<project-instructions>\nsecret\n</project-instructions>\n\n看看目录" },
    { role: "assistant", content: [
      { type: "text", text: "先看一下。" },
      { type: "tool_use", name: "list_files", input: { pattern: "*.ts" } },
    ] },
    { role: "user", content: [{ type: "tool_result", content: "src/ui.ts\nsrc/repl.ts", is_error: false }] },
    { role: "user", content: "<conversation-summary>\nshort summary\n</conversation-summary>\nContinue from this summary." },
  ]);
  assert.deepEqual(entries.map(entry => entry.type), ["user", "assistant", "tool", "result", "note", "assistant"]);
  assert.equal(entries[0].type === "user" ? entries[0].text : "", "看看目录");
  assert.equal(entries[2].type === "tool" ? entries[2].detail : "", "*.ts");
  assert.equal(entries[3].type === "result" ? entries[3].text : "", "src/ui.ts src/repl.ts");
  assert.equal(entries[5].type === "assistant" ? entries[5].text : "", "short summary");
});
