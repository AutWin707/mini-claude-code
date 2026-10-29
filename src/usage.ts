export interface TokenUsage {
    input: number | null;
    output: number | null;
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0 });

// null 表示供应商未返回完整用量，不能把它当作 0。
export function readUsage(usage: unknown): TokenUsage {
    const data = usage as Record<string, unknown> | undefined;
    const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    return { input: count(data?.input_tokens), output: count(data?.output_tokens) };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
    const add = (x: number | null, y: number | null) => x === null || y === null ? null : x + y;
    return { input: add(a.input, b.input), output: add(a.output, b.output) };
}

export function formatUsage(usage: TokenUsage): string {
    return `输入 ${usage.input ?? "不可用"} / 输出 ${usage.output ?? "不可用"}`;
}
