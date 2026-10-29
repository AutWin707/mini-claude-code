import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../src/run.ts", import.meta.url));
const shellEntry = fileURLToPath(new URL("../run.sh", import.meta.url));
const cleanEnv = {
  ...process.env,
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_API_URL: "",
  ANTHROPIC_MODEL: "",
};

async function mockAPI(t, reply) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const result = reply(requests.length);
    res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { requests, url: `http://127.0.0.1:${server.address().port}` };
}

function message(content, stop_reason = "end_turn") {
  return {
    id: "msg_test", type: "message", role: "assistant", model: "fixture-model",
    content, stop_reason, stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

test("runner shows help without credentials or a model request", async () => {
  for (const args of [["--help"], ["-h"]]) {
    const { stdout } = await exec(process.execPath, [entry, ...args], { env: cleanEnv });
    assert.match(stdout, /用法: npm start/);
    assert.match(stdout, /coding-agent-lab \[prompt\]/);
  }
});

test("runner without a prompt requires a TTY instead of showing help", async () => {
  await assert.rejects(exec(process.execPath, [entry], { env: cleanEnv }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /REPL 需要交互式终端/);
    return true;
  });
});

test("runner reports missing credentials with a nonzero exit", async () => {
  await assert.rejects(exec(process.execPath, [entry, "hello"], { env: cleanEnv }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /缺少 ANTHROPIC_API_KEY/);
    return true;
  });
});

test("run.sh preserves cwd, sends configured model and completes a tool loop", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mini-claude-run-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "CLAUDE.md"), "runner-project-instruction");
  writeFileSync(join(cwd, "fixture.txt"), "tool-result-content");
  const api = await mockAPI(t, turn => ({ body: turn === 1
    ? message([{ type: "tool_use", id: "read-1", name: "read_file", input: { file_path: "fixture.txt" } }], "tool_use")
    : message([{ type: "text", text: "first text block" }, { type: "text", text: "second text block" }]),
  }));
  const { stdout } = await exec("bash", [shellEntry, "read", "fixture.txt"], {
    cwd, timeout: 15000,
    env: { ...cleanEnv, ANTHROPIC_API_KEY: "test-only", ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_URL: "http://127.0.0.1:1", ANTHROPIC_MODEL: "fixture-model" },
  });
  assert.match(stdout, /first text block/);
  assert.match(stdout, /second text block/);
  assert.match(stdout, /本轮 token: 输入 2 \/ 输出 2/);
  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[0].model, "fixture-model");
  // macOS 的 /var 是 /private/var 的符号链接，process.cwd() 返回真实路径。
  assert.ok(api.requests[0].system.includes(`Working directory: ${realpathSync(cwd)}`));
  assert.match(api.requests[0].messages[0].content, /runner-project-instruction/);
  assert.match(api.requests[0].messages[0].content, /read fixture\.txt$/);
  const result = api.requests[1].messages.at(-1).content[0];
  assert.equal(result.tool_use_id, "read-1");
  assert.match(result.content, /tool-result-content/);
});

test("runner supports the legacy API URL and a model configured in .env", async (t) => {
  const api = await mockAPI(t, () => ({ body: message([{ type: "text", text: "legacy works" }]) }));
  const cwd = mkdtempSync(join(tmpdir(), "mini-claude-env-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, ".env"), "ANTHROPIC_MODEL=fixture-env-model\n");
  const env = { ...cleanEnv, ANTHROPIC_API_KEY: "test-only", ANTHROPIC_API_URL: api.url };
  delete env.ANTHROPIC_MODEL;
  const { stdout } = await exec(process.execPath, ["--env-file=.env", entry, "hello"], {
    cwd, timeout: 15000, env,
  });
  assert.match(stdout, /legacy works/);
  assert.equal(api.requests[0].model, "fixture-env-model");
});

test("runner rejects missing, empty and whitespace-only models without an API request", async (t) => {
  const api = await mockAPI(t, () => ({ body: message([{ type: "text", text: "unexpected" }]) }));
  const cwd = mkdtempSync(join(tmpdir(), "mini-claude-noenv-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const model of [undefined, "", "   "]) {
    const env = { ...cleanEnv, ANTHROPIC_API_KEY: "test-only", ANTHROPIC_BASE_URL: api.url,
      // 隔离项目自带的 .env，否则其中的模型会绕过这次校验。
      MINI_CLAUDE_ENV_FILE: join(cwd, "missing.env") };
    if (model === undefined) delete env.ANTHROPIC_MODEL;
    else env.ANTHROPIC_MODEL = model;
    await assert.rejects(exec(process.execPath, [entry, "hello"], { cwd, env, timeout: 15000 }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /缺少 ANTHROPIC_MODEL/);
      return true;
    });
  }
  assert.equal(api.requests.length, 0);
});

test("runner reports API failures with a nonzero exit", async (t) => {
  const api = await mockAPI(t, () => ({
    status: 401,
    body: { type: "error", error: { type: "authentication_error", message: "fixture unauthorized" } },
  }));
  await assert.rejects(exec(process.execPath, [entry, "hello"], {
    timeout: 15000,
    env: { ...cleanEnv, ANTHROPIC_API_KEY: "test-only", ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_MODEL: "fixture-model" },
  }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /请求失败:.*401/);
    return true;
  });
});
