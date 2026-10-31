export interface TokenUsage {
    input: number | null;
    output: number | null;
    cacheRead?: number;
    cacheWrite?: number;
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0 });

// Anthropic 兼容接口的 input_tokens 不包含缓存命中与写入，需合并为总输入。
export function readUsage(usage: unknown): TokenUsage {
    const data = usage as Record<string, unknown> | undefined;
    const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const input = count(data?.input_tokens);
    const cacheRead = count(data?.cache_read_input_tokens);
    const cacheWrite = count(data?.cache_creation_input_tokens);
    return { input: input === null ? null : input + (cacheRead ?? 0) + (cacheWrite ?? 0),
        output: count(data?.output_tokens),
        ...(cacheRead === null ? {} : { cacheRead }), ...(cacheWrite === null ? {} : { cacheWrite }) };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    const add = (x: number | null, y: number | null) => x === null || y === null ? null : x + y;
    const cacheRead = a.cacheRead === undefined && b.cacheRead === undefined ? undefined : (a.cacheRead ?? 0) + (b.cacheRead ?? 0);
    const cacheWrite = a.cacheWrite === undefined && b.cacheWrite === undefined ? undefined : (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0);
    return { input: add(a.input, b.input), output: add(a.output, b.output),
        ...(cacheRead === undefined ? {} : { cacheRead }), ...(cacheWrite === undefined ? {} : { cacheWrite }) };
}

export function formatUsage(usage: TokenUsage): string {
    const cache = [usage.cacheRead === undefined ? "" : `缓存命中 ${usage.cacheRead}`,
        usage.cacheWrite === undefined ? "" : `缓存写入 ${usage.cacheWrite}`].filter(Boolean).join(" / ");
    return `输入 ${usage.input ?? "不可用"} / 输出 ${usage.output ?? "不可用"}${cache ? `（${cache}）` : ""}`;
}
