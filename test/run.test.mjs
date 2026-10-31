import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { message, mockApiServer, text, toolUse } from "./helpers.mjs";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../src/run.ts", import.meta.url));
const shellEntry = fileURLToPath(new URL("../run.sh", import.meta.url));

// 子进程的 cwd 和 HOME 都是临时目录，并且不读取项目自带的 .env。
function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mini-run-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, HOME: dir, MINI_CLAUDE_ENV_FILE: join(dir, "missing.env"),
    ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", ANTHROPIC_API_URL: "", ANTHROPIC_MODEL: "" };
  return { dir, env };
}

test("runner shows help without credentials or a model request", async t => {
  const { env } = sandbox(t);
  for (const flag of ["--help", "-h"]) {
    const { stdout } = await exec(process.execPath, [entry, flag], { env });
    assert.match(stdout, /用法: npm start/);
    assert.match(stdout, /coding-agent-lab \[prompt\]/);
  }
});

test("runner without a prompt requires a TTY instead of showing help", async t => {
  const { env } = sandbox(t);
  await assert.rejects(exec(process.execPath, [entry], { env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /REPL 需要交互式终端/);
    return true;
  });
});

test("runner reports missing credentials with a nonzero exit", async t => {
  const { env } = sandbox(t);
  await assert.rejects(exec(process.execPath, [entry, "hello"], { env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /缺少 ANTHROPIC_API_KEY/);
    return true;
  });
});

test("run.sh preserves cwd, sends configured model and completes a tool loop", async t => {
  const { dir, env } = sandbox(t);
  writeFileSync(join(dir, "CLAUDE.md"), "runner-project-instruction");
  writeFileSync(join(dir, "fixture.txt"), "tool-result-content");
  const api = await mockApiServer(t, turn => turn === 1
    ? message([toolUse("read-1", "read_file", { file_path: "fixture.txt" })], { usage: { input_tokens: 1, output_tokens: 1 } })
    : message([{ type: "text", text: "first text block" }, { type: "text", text: "second text block" }],
      { usage: { input_tokens: 1, output_tokens: 1 } }));
  const { stdout } = await exec("bash", [shellEntry, "read", "fixture.txt"], { cwd: dir, timeout: 15000,
    env: { ...env, ANTHROPIC_API_KEY: "test-only", ANTHROPIC_BASE_URL: api.url,
      ANTHROPIC_API_URL: "http://127.0.0.1:1", ANTHROPIC_MODEL: "fixture-model" } });
  assert.match(stdout, /first text block/);
  assert.match(stdout, /second text block/);
  assert.match(stdout, /本轮 token: 输入 2 \/ 输出 2/);
  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[0].model, "fixture-model");
  assert.equal(api.requests[0].stream, true);
  assert.ok(api.requests[0].system.includes(`Working directory: ${dir}`)); // 新变量优先于旧的 API_URL。
  assert.match(api.requests[0].messages[0].content, /runner-project-instruction/);
  assert.match(api.requests[0].messages[0].content, /read fixture\.txt$/);
  const result = api.requests[1].messages.at(-1).content[0];
  assert.equal(result.tool_use_id, "read-1");
  assert.match(result.content, /tool-result-content/);
});

test("runner supports the legacy API URL and a model configured in an env file", async t => {
  const { dir, env } = sandbox(t);
  const api = await mockApiServer(t, () => text("legacy works"));
  writeFileSync(join(dir, "custom.env"), "ANTHROPIC_MODEL=fixture-env-model\n");
  const { stdout } = await exec(process.execPath, [entry, "hello"], { cwd: dir, timeout: 15000,
    env: { ...env, ANTHROPIC_API_KEY: "test-only", ANTHROPIC_API_URL: api.url, ANTHROPIC_MODEL: undefined,
      MINI_CLAUDE_ENV_FILE: join(dir, "custom.env") } });
  assert.match(stdout, /legacy works/);
  assert.equal(api.requests[0].model, "fixture-env-model");
});

test("runner rejects missing, empty and whitespace-only models without an API request", async t => {
  const { dir, env } = sandbox(t);
  const api = await mockApiServer(t, () => text("unexpected"));
  for (const model of [undefined, "", "   "]) {
    await assert.rejects(exec(process.execPath, [entry, "hello"], { cwd: dir, timeout: 15000,
      env: { ...env, ANTHROPIC_API_KEY: "test-only", ANTHROPIC_BASE_URL: api.url, ANTHROPIC_MODEL: model } }), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /缺少 ANTHROPIC_MODEL/);
      return true;
    });
  }
  assert.equal(api.requests.length, 0);
});

test("runner reports API failures with a nonzero exit", async t => {
  const { env } = sandbox(t);
  const api = await mockApiServer(t, () => ({ status: 401,
    body: { type: "error", error: { type: "authentication_error", message: "fixture unauthorized" } } }));
  await assert.rejects(exec(process.execPath, [entry, "hello"], { timeout: 15000,
    env: { ...env, ANTHROPIC_API_KEY: "test-only", ANTHROPIC_BASE_URL: api.url, ANTHROPIC_MODEL: "fixture-model" } }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /请求失败:.*401/);
    return true;
  });
});
