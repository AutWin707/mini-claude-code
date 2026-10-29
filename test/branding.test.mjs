import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../src/session.ts";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

test("package name and executable are consistent with the lockfile", () => {
  assert.equal(manifest.name, "coding-agent-lab");
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].name, manifest.name);
  assert.deepEqual(manifest.bin, { "coding-agent-lab": "./dist/run.js" });
  assert.deepEqual(lock.packages[""].bin, { "coding-agent-lab": "dist/run.js" });
});

test("renaming keeps the existing session directory", () => {
  assert.equal(new SessionStore().directory, join(homedir(), ".mini-claude", "sessions"));
});
