// 测试共用的假模型、消息构造和临时目录。
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent.ts";

export const emptyRules = () => ({ allow: [], deny: [] });

// 构造模型回复；含 tool_use 时 stop_reason 默认为 tool_use。usage: null 表示服务未返回用量。
export function message(content, { stop_reason, usage = { input_tokens: 10, output_tokens: 2 } } = {}) {
    return { id: "test", type: "message", role: "assistant", model: "test", content,
        stop_reason: stop_reason ?? (content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn"),
        stop_sequence: null, ...(usage === null ? {} : { usage }) };
}
export const text = (value, options) => message([{ type: "text", text: value }], options);
export const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

/**
 * 假模型客户端：stream 和 create 按调用顺序共用一个回复队列，与真实请求顺序一致。
 * 回复可以是 message、Error，或 ({ params, options, emit }) => message 的函数（用于控制流式事件和时序）。
 * 普通 message 在流式调用中会先发出 text 和 contentBlock 事件。
 */
export function mockClient(replies = []) {
    const calls = [];
    const next = (kind, params, options) => {
        calls.push({ kind, params: structuredClone(params), options });
        if (!replies.length) throw new Error(`unexpected ${kind} request`);
        return replies.shift();
    };
    const settle = async (reply, context) => {
        if (reply instanceof Error) throw reply;
        return structuredClone(typeof reply === "function" ? await reply(context) : reply);
    };
    const client = { messages: {
        create(params, options) {
            const reply = next("create", params, options);
            return settle(reply, { params, options });
        },
        stream(params, options) {
            const reply = next("stream", params, options);
            const listeners = {};
            const emit = (event, value) => listeners[event]?.(value);
            return {
                on(event, listener) { listeners[event] = listener; },
                async finalMessage() {
                    if (typeof reply === "function") return settle(reply, { params, options, emit });
                    const response = await settle(reply);
                    for (const block of response.content) {
                        if (block.type === "text") emit("text", block.text);
                        emit("contentBlock", block);
                    }
                    return response;
                },
            };
        },
    } };
    return {
        client, calls,
        get requests() { return calls.map(call => call.params); },
        get streams() { return calls.filter(call => call.kind === "stream").map(call => call.params); },
        get creates() { return calls.filter(call => call.kind === "create"); },
    };
}

// 默认不读取真实配置的 Agent。
export function makeAgent(client, options = {}) {
    return new Agent({ config: { model: "test" }, instructions: "", permissionRules: emptyRules(),
        client, onOutput() {}, ...options });
}

/**
 * 创建临时目录，并把 cwd 和 HOME 指向它，避免读写真实的 ~/.mini-claude 和 ~/.claude。
 * macOS 的 /var 是软链接，返回真实路径以便和 process.cwd() 比较。
 */
export function useTempDir(t) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "mini-test-")));
    const previousCwd = process.cwd();
    const previousHome = process.env.HOME;
    process.chdir(dir);
    process.env.HOME = dir;
    t.after(() => {
        process.chdir(previousCwd);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}

export async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("timed out");
}

// 把一条完整消息转为 Anthropic SSE 事件序列。
export function sseEvents(response) {
    const events = [{ type: "message_start", message: { ...response, content: [], stop_reason: null,
        usage: { input_tokens: response.usage?.input_tokens ?? 0, output_tokens: 0 } } }];
    response.content.forEach((block, index) => {
        if (block.type === "text") {
            events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } },
                { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
        } else {
            events.push({ type: "content_block_start", index, content_block: { ...block, input: {} } },
                { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        }
        events.push({ type: "content_block_stop", index });
    });
    events.push({ type: "message_delta", delta: { stop_reason: response.stop_reason, stop_sequence: null },
        usage: { output_tokens: response.usage?.output_tokens ?? 0 } },
    { type: "message_stop" });
    return events;
}

/**
 * 本地假 API 服务：respond(第几次请求, 请求体) 返回 message，或 { status, body } 表示错误响应。
 * 流式请求以 SSE 返回。
 */
export async function mockApiServer(t, respond) {
    const requests = [];
    const server = createServer(async (req, res) => {
        let body = "";
        for await (const chunk of req) body += chunk;
        requests.push(JSON.parse(body));
        const result = respond(requests.length, requests.at(-1));
        if (result.status) {
            res.writeHead(result.status, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result.body));
            return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const event of sseEvents(result)) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    return { requests, url: `http://127.0.0.1:${server.address().port}` };
}
