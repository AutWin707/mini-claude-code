#!/usr/bin/env node
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { Agent } from "./agent.ts";
import { formatUsage } from "./usage.ts";

try {
    // 源码入口和 dist 入口均读取安装项目的 .env，不改变用户的工作目录。
    // MINI_CLAUDE_ENV_FILE 可指向其他配置文件；已存在的环境变量优先于文件内容。
    const envFile = process.env.MINI_CLAUDE_ENV_FILE?.trim() || fileURLToPath(new URL("../.env", import.meta.url));
    try { loadEnvFile(envFile); }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    const prompt = process.argv.slice(2).join(" ").trim();
    if (prompt === "--help" || prompt === "-h") {
        console.log('用法: npm start -- "你的问题" 或 coding-agent-lab [prompt]');
        console.log("有 prompt 直接聊天；无 prompt 进入 REPL。支持 /chat、/clear、/compact，空输入按 ← 切换会话。");
    } else if (!prompt && (!process.stdin.isTTY || !process.stdout.isTTY)) {
        throw new Error("REPL 需要交互式终端；非交互环境请提供 prompt。");
    } else if (!process.env.ANTHROPIC_API_KEY?.trim()) {
        throw new Error("缺少 ANTHROPIC_API_KEY，请在 .env 或环境变量中配置。");
    } else if (prompt) {
        const agent = new Agent();
        try { await agent.chat(prompt); }
        finally { console.log(`本轮 token: ${formatUsage(agent.snapshot().lastTurnUsage)}`); }
    } else {
        const { startRepl } = await import("./ui.ts");
        await startRepl();
    }
} catch (error) {
    console.error(`请求失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
}
