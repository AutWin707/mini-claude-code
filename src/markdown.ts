import { createRequire } from "node:module";
import { stripVTControlCharacters } from "node:util";
import { Marked, type MarkedExtension } from "marked";

// marked-terminal 7 没有自带类型，旧的 @types 包对不上现在的 markedTerminal()。
const { markedTerminal } = createRequire(import.meta.url)("marked-terminal") as {
    markedTerminal: (options?: { width?: number; reflowText?: boolean }) => MarkedExtension;
};

const cache = new Map<string, string>();

// 把 Markdown 渲染成适合终端宽度的带颜色文本，并缓存重复内容。
export function renderMarkdown(source: string, width: number): string {
    const text = stripVTControlCharacters(source).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
    const columns = Math.max(20, width);
    const key = `${columns}\0${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const marked = new Marked();
    marked.use(markedTerminal({ width: columns, reflowText: true }));
    const rendered = String(marked.parse(text, { async: false })).replace(/\n+$/, "");
    cache.set(key, rendered);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return rendered;
}
