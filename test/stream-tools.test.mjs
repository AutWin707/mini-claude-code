import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { Agent } from "../src/agent.ts";
import { executeTool } from "../src/tools.ts";

const message = (content, stopReason = "tool_use") => ({
  id: "test", type: "message", role: "assistant", model: "test", stop_reason: stopReason,
  content, usage: { input_tokens: 10, output_tokens: 2 },
});
const tool = (id, name, input) => ({ type: "tool_use", id, name, input });
const done = () => message([{ type: "text", text: "done" }], "end_turn");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "mini-stream-tools-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function clientFor(blocks, pause, emitted) {
  const requests = [];
  const client = { messages: { stream(params) {
    requests.push(structuredClone(params));
    const first = requests.length === 1;
    const listeners = {};
    return {
      on(event, listener) { listeners[event] = listener; },
      async finalMessage() {
        if (!first) return done();
        for (const block of blocks) listeners.contentBlock(block);
        listeners.contentBlock(blocks.at(-1)); // 重复通知不能触发第二次执行。
        emitted.resolve();
        await pause.promise;
        return message(blocks);
      },
    };
  } } };
  return { client, requests };
}

test("safe tools start before the stream ends and reuse their results", async t => {
  const dir = fixture(t);
  const file = join(dir, "sample.txt");
  writeFileSync(file, "needle in file");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("web-result"));
  const calls = [
    tool("r", "read_file", { file_path: file }),
    tool("l", "list_files", { pattern: "*.txt", path: dir }),
    tool("g", "grep_search", { pattern: "needle", path: dir }),
    tool("w", "web_fetch", { url: "https://example.com/" }),
  ];
  const pause = Promise.withResolvers();
  const emitted = Promise.withResolvers();
  t.after(() => pause.resolve());
  const { client, requests } = clientFor(calls, pause, emitted);
  const agent = new Agent({ config: { model: "test" }, client, instructions: "", onOutput() {} });
  const started = [];
  const work = [];
  const runTool = agent.runTool.bind(agent);
  agent.runTool = (call, ...args) => {
    started.push(call.name);
    const result = runTool(call, ...args);
    work.push(result);
    return result;
  };
  const chat = agent.chat("hello");
  await emitted.promise;
  assert.deepEqual(started, calls.map(call => call.name));
  await Promise.all(work);
  assert.equal(requests.length, 1); // 模型响应尚未结束。
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(agent.snapshot().readFiles, []); // 提前读取的状态尚未提交。
  pause.resolve();
  await chat;
  assert.deepEqual(started, calls.map(call => call.name));
  const results = requests[1].messages.at(-1).content;
  assert.deepEqual(results.map(result => result.tool_use_id), ["r", "l", "g", "w"]);
  assert.match(results[0].content, /needle in file/);
  assert.match(results[1].content, /sample\.txt/);
  assert.equal(results[3].content, "web-result");
  assert.ok(agent.snapshot().readFiles.some(([path]) => path === file));
});

test("an early read preserves the read-before-edit guard", async t => {
  const file = join(fixture(t), "editable.txt");
  writeFileSync(file, "before");
  const calls = [
    tool("read", "read_file", { file_path: file }),
    tool("edit", "edit_file", { file_path: file, old_string: "before", new_string: "after" }),
  ];
  const pause = Promise.withResolvers();
  const emitted = Promise.withResolvers();
  t.after(() => pause.resolve());
  const { client, requests } = clientFor(calls, pause, emitted);
  const agent = new Agent({ config: { model: "test" }, client, instructions: "", onOutput() {} });
  const started = [];
  const runTool = agent.runTool.bind(agent);
  agent.runTool = (call, ...args) => { started.push(call.name); return runTool(call, ...args); };
  const chat = agent.chat("hello");
  await emitted.promise;
  assert.deepEqual(started, ["read_file"]);
  assert.equal(readFileSync(file, "utf8"), "before");
  pause.resolve();
  await chat;
  assert.deepEqual(started, ["read_file", "edit_file"]);
  assert.equal(readFileSync(file, "utf8"), "after");
  assert.equal(requests[1].messages.at(-1).content[1].content, "File edited successfully");
});

test("a prior write prevents later reads from starting early", async t => {
  const dir = fixture(t);
  const file = join(dir, "new.txt");
  const calls = [
    tool("write", "write_file", { file_path: file, content: "new content" }),
    tool("read", "read_file", { file_path: file }),
  ];
  const pause = Promise.withResolvers();
  const emitted = Promise.withResolvers();
  t.after(() => pause.resolve());
  const { client, requests } = clientFor(calls, pause, emitted);
  const agent = new Agent({ config: { model: "test" }, client, instructions: "", onOutput() {}, confirmPermission: async () => true });
  const started = [];
  const runTool = agent.runTool.bind(agent);
  agent.runTool = (call, ...args) => { started.push(call.name); return runTool(call, ...args); };
  const chat = agent.chat("hello");
  await emitted.promise;
  assert.deepEqual(started, []);
  assert.equal(existsSync(file), false);
  pause.resolve();
  await chat;
  assert.deepEqual(started, ["write_file", "read_file"]);
  assert.equal(readFileSync(file, "utf8"), "new content");
  assert.match(requests[1].messages.at(-1).content[1].content, /new content/);
});

test("an interrupted stream does not commit an early read", async t => {
  const file = join(fixture(t), "sample.txt");
  writeFileSync(file, "private");
  const readFinished = Promise.withResolvers();
  const client = { messages: { stream(_params, options) {
    const listeners = {};
    return {
      on(event, listener) { listeners[event] = listener; },
      finalMessage() {
        listeners.contentBlock(tool("read", "read_file", { file_path: file }));
        return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    };
  } } };
  const agent = new Agent({ config: { model: "test" }, client, instructions: "", onOutput() {} });
  const runTool = agent.runTool.bind(agent);
  agent.runTool = (call, ...args) => runTool(call, ...args).then(result => { readFinished.resolve(); return result; });
  const controller = new AbortController();
  const chat = agent.chat("hello", controller.signal);
  await readFinished.promise;
  assert.deepEqual(agent.snapshot().readFiles, []);
  controller.abort();
  await assert.rejects(chat, /aborted/);
  assert.deepEqual(agent.snapshot().readFiles, []);
});

test("failed streaming attempts cancel early work before retrying", async t => {
  let cancelled = false;
  t.mock.method(Math, "random", () => 0);
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => {
      cancelled = true;
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  }));
  let attempts = 0;
  const client = { messages: { stream() {
    const first = ++attempts === 1;
    const listeners = {};
    return {
      on(event, listener) { listeners[event] = listener; },
      async finalMessage() {
        if (!first) return done();
        listeners.contentBlock(tool("web", "web_fetch", { url: "https://example.com/" }));
        throw Object.assign(new Error("retry"), { status: 500 });
      },
    };
  } } };
  const agent = new Agent({ config: { model: "test" }, client, instructions: "", onOutput() {} });
  const withRetry = agent.withRetry.bind(agent);
  agent.withRetry = (action, maxRetries, signal) => withRetry(action, maxRetries, signal, 1);
  await agent.chat("hello");
  assert.equal(cancelled, true);
  assert.equal(attempts, 2);
  assert.deepEqual(agent.snapshot().readFiles, []);
});

test("grep_search does not block the event loop", async t => {
  const dir = fixture(t);
  const fakeRg = join(dir, "rg");
  writeFileSync(fakeRg, "#!/bin/sh\n/bin/sleep 0.2\nprintf 'file:1:match\\n'\n");
  chmodSync(fakeRg, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  let finished = false;
  const work = executeTool(tool("grep", "grep_search", { pattern: "match" })).then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.match(await work, /file:1:match/);
});

test("Anthropic SDK starts a completed tool block before message_stop", async t => {
  const file = join(fixture(t), "sdk.txt");
  writeFileSync(file, "SDK content");
  const release = Promise.withResolvers();
  const toolFinished = Promise.withResolvers();
  t.after(() => release.resolve());
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    send({ type: "message_start", message: { ...message([], null), usage: { input_tokens: 1, output_tokens: 0 }, stop_sequence: null } });
    if (requests.length === 1) {
      send({ type: "content_block_start", index: 0, content_block: tool("sdk-read", "read_file", {}) });
      send({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: file }) } });
      send({ type: "content_block_stop", index: 0 });
      await release.promise;
      send({ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
    } else {
      send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } });
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    }
    send({ type: "message_stop" });
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = new Anthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
  const agent = new Agent({ config: { model: "test" }, client, instructions: "", onOutput() {} });
  const runTool = agent.runTool.bind(agent);
  agent.runTool = (call, ...args) => runTool(call, ...args).then(result => { toolFinished.resolve(result); return result; });
  const chat = agent.chat("hello");
  let timeout;
  const timedOut = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("tool did not start during streaming")), 2000); });
  t.after(() => clearTimeout(timeout));
  const result = await Promise.race([toolFinished.promise, timedOut]);
  clearTimeout(timeout);
  assert.match(result, /SDK content/);
  assert.equal(requests.length, 1);
  assert.deepEqual(agent.snapshot().readFiles, []);
  release.resolve();
  await chat;
  assert.match(requests[1].messages.at(-1).content[0].content, /SDK content/);
});
