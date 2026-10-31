import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { executeTool } from "../src/tools.ts";
import { makeAgent, message, mockClient, sseEvents, text, toolUse, useTempDir } from "./helpers.mjs";

const done = () => text("done");

// 第一次请求：逐个发出工具块（最后一个重复发），然后停在 pause，直到测试放行才结束响应。
function pausedStream(t, blocks) {
  const pause = Promise.withResolvers();
  const emitted = Promise.withResolvers();
  t.after(() => pause.resolve());
  const mock = mockClient([async ({ emit }) => {
    for (const block of blocks) emit("contentBlock", block);
    emit("contentBlock", blocks.at(-1)); // 重复通知不能触发第二次执行。
    emitted.resolve();
    await pause.promise;
    return message(blocks);
  }, done()]);
  return { mock, pause, emitted };
}
// 记录 Agent 实际启动了哪些工具。
function trackTools(agent) {
  const started = [];
  const work = [];
  const runTool = agent.runTool.bind(agent);
  agent.runTool = (call, ...args) => {
    started.push(call.name);
    const result = runTool(call, ...args);
    work.push(result);
    return result;
  };
  return { started, work };
}

test("safe tools start before the stream ends and reuse their results", async t => {
  const dir = useTempDir(t);
  const file = join(dir, "sample.txt");
  writeFileSync(file, "needle in file");
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("web-result"));
  const calls = [
    toolUse("r", "read_file", { file_path: file }),
    toolUse("l", "list_files", { pattern: "*.txt", path: dir }),
    toolUse("g", "grep_search", { pattern: "needle", path: dir }),
    toolUse("w", "web_fetch", { url: "https://example.com/" }),
  ];
  const { mock, pause, emitted } = pausedStream(t, calls);
  const agent = makeAgent(mock.client);
  const { started, work } = trackTools(agent);
  const chat = agent.chat("hello");
  await emitted.promise;
  assert.deepEqual(started, calls.map(call => call.name));
  await Promise.all(work);
  assert.equal(mock.calls.length, 1); // 模型响应尚未结束。
  assert.equal(fetchMock.mock.callCount(), 1);
  assert.deepEqual(agent.snapshot().readFiles, []); // 提前读取的状态尚未提交。
  pause.resolve();
  await chat;
  assert.deepEqual(started, calls.map(call => call.name)); // 不会重复执行。
  const results = mock.requests[1].messages.at(-1).content;
  assert.deepEqual(results.map(result => result.tool_use_id), ["r", "l", "g", "w"]);
  assert.match(results[0].content, /needle in file/);
  assert.match(results[1].content, /sample\.txt/);
  assert.equal(results[3].content, "web-result");
  assert.ok(agent.snapshot().readFiles.some(([path]) => path === file));
});

test("an early read preserves the read-before-edit guard", async t => {
  const file = join(useTempDir(t), "editable.txt");
  writeFileSync(file, "before");
  const { mock, pause, emitted } = pausedStream(t, [
    toolUse("read", "read_file", { file_path: file }),
    toolUse("edit", "edit_file", { file_path: file, old_string: "before", new_string: "after" }),
  ]);
  const agent = makeAgent(mock.client);
  const { started } = trackTools(agent);
  const chat = agent.chat("hello");
  await emitted.promise;
  assert.deepEqual(started, ["read_file"]);
  assert.equal(readFileSync(file, "utf8"), "before");
  pause.resolve();
  await chat;
  assert.deepEqual(started, ["read_file", "edit_file"]);
  assert.equal(readFileSync(file, "utf8"), "after");
  assert.equal(mock.requests[1].messages.at(-1).content[1].content, "File edited successfully");
});

test("a prior write prevents later reads from starting early", async t => {
  const file = join(useTempDir(t), "new.txt");
  const { mock, pause, emitted } = pausedStream(t, [
    toolUse("write", "write_file", { file_path: file, content: "new content" }),
    toolUse("read", "read_file", { file_path: file }),
  ]);
  const agent = makeAgent(mock.client, { confirmPermission: async () => true });
  const { started } = trackTools(agent);
  const chat = agent.chat("hello");
  await emitted.promise;
  assert.deepEqual(started, []);
  assert.equal(existsSync(file), false);
  pause.resolve();
  await chat;
  assert.deepEqual(started, ["write_file", "read_file"]);
  assert.match(mock.requests[1].messages.at(-1).content[1].content, /new content/);
});

test("an interrupted stream does not commit an early read", async t => {
  const file = join(useTempDir(t), "sample.txt");
  writeFileSync(file, "private");
  const readFinished = Promise.withResolvers();
  const mock = mockClient([({ emit, options }) => {
    emit("contentBlock", toolUse("read", "read_file", { file_path: file }));
    return new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  }]);
  const agent = makeAgent(mock.client);
  const runTool = agent.runTool.bind(agent);
  agent.runTool = (...args) => runTool(...args).then(result => { readFinished.resolve(); return result; });
  const controller = new AbortController();
  const chat = agent.chat("hello", controller.signal);
  await readFinished.promise;
  controller.abort();
  await assert.rejects(chat, /aborted/);
  assert.deepEqual(agent.snapshot().readFiles, []);
});

test("failed streaming attempts cancel early work before retrying", async t => {
  useTempDir(t);
  let cancelled = false;
  t.mock.method(Math, "random", () => 0);
  t.mock.method(globalThis, "fetch", (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => {
      cancelled = true;
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  }));
  const mock = mockClient([({ emit }) => {
    emit("contentBlock", toolUse("web", "web_fetch", { url: "https://example.com/" }));
    throw Object.assign(new Error("retry"), { status: 500 });
  }, done()]);
  const agent = makeAgent(mock.client);
  const withRetry = agent.withRetry.bind(agent);
  agent.withRetry = (action, maxRetries, signal) => withRetry(action, maxRetries, signal, 1);
  await agent.chat("hello");
  assert.equal(cancelled, true);
  assert.equal(mock.calls.length, 2);
  assert.deepEqual(agent.snapshot().readFiles, []);
});

test("grep_search does not block the event loop", async t => {
  const dir = useTempDir(t);
  const fakeRg = join(dir, "rg");
  writeFileSync(fakeRg, "#!/bin/sh\n/bin/sleep 0.2\nprintf 'file:1:match\\n'\n");
  chmodSync(fakeRg, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = dir;
  t.after(() => { process.env.PATH = previous; });
  let finished = false;
  const work = executeTool(toolUse("grep", "grep_search", { pattern: "match" })).then(result => { finished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  assert.match(await work, /file:1:match/);
});

test("Anthropic SDK starts a completed tool block before message_stop", async t => {
  const file = join(useTempDir(t), "sdk.txt");
  writeFileSync(file, "SDK content");
  const release = Promise.withResolvers();
  const toolFinished = Promise.withResolvers();
  t.after(() => release.resolve());
  const requests = [];
  // 第一次响应在工具块结束后暂停，message_delta 和 message_stop 要等测试放行。
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const response = requests.length === 1 ? message([toolUse("sdk-read", "read_file", { file_path: file })]) : done();
    for (const event of sseEvents(response)) {
      if (requests.length === 1 && event.type === "message_delta") await release.promise;
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const client = new Anthropic({ apiKey: "test", baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
  const agent = makeAgent(client);
  const runTool = agent.runTool.bind(agent);
  agent.runTool = (...args) => runTool(...args).then(result => { toolFinished.resolve(result); return result; });
  const chat = agent.chat("hello");
  let timeout;
  const timedOut = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("tool did not start during streaming")), 2000); });
  const result = await Promise.race([toolFinished.promise, timedOut]);
  clearTimeout(timeout);
  assert.match(result, /SDK content/);
  assert.equal(requests.length, 1);
  assert.deepEqual(agent.snapshot().readFiles, []);
  release.resolve();
  await chat;
  assert.match(requests[1].messages.at(-1).content[0].content, /SDK content/);
});
