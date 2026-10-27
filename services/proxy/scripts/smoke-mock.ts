/**
 * End-to-end smoke: mock upstream + in-process proxy (no child process).
 * Run: bun ./scripts/smoke-mock.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config"
import { openDatabase } from "../src/db/client"
import { createApp } from "../src/server"
import { startMockUpstream, toolCallSseEvents } from "../tests/helpers/mock-upstream"

const tmp = mkdtempSync(join(tmpdir(), "lumen-smoke-"))
const dbPath = join(tmp, "smoke.db")

const mock = await startMockUpstream({
	responses: [
		{
			type: "json",
			body: {
				id: "smoke",
				object: "chat.completion",
				created: 1,
				model: "mock",
				choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
				usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
			},
		},
		{
			type: "sse",
			events: toolCallSseEvents("nvidia/nemotron-3-nano-30b-a3b"),
		},
	],
})

process.env.DATABASE_URL = `sqlite:${dbPath}`
process.env.ADMIN_SECRET = "smoke-admin"
process.env.KEY_PEPPER = "smoke-pepper"
process.env.LOG_LEVEL = "error"
process.env.NVIDIA_API_KEY = "x"
process.env.DASHSCOPE_API_KEY = "x"
process.env.DEEPSEEK_API_KEY = "x"
process.env.NVIDIA_BASE_URL = mock.url
process.env.DASHSCOPE_BASE_URL = mock.url
process.env.DEEPSEEK_BASE_URL = mock.url

const config = loadConfig()
const db = await openDatabase(config.databaseUrl)
const app = createApp(config, db)

try {
	const health = await app.request("/health")
	if (!health.ok) throw new Error("health failed")

	const created = await app.request("/admin/keys", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-admin-secret": "smoke-admin" },
		body: JSON.stringify({ userId: "deepam", plan: "free", label: "smoke" }),
	})
	const keyBody = await created.json()
	if (!created.ok) throw new Error(`create key failed: ${JSON.stringify(keyBody)}`)
	const planKey = keyBody.plan_key as string

	const chat = await app.request("/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${planKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "lumen-auto",
			messages: [{ role: "user", content: "ping" }],
			stream: false,
		}),
	})
	const chatJson = await chat.json()
	if (!chat.ok) throw new Error(`chat failed: ${JSON.stringify(chatJson)}`)
	if (chatJson.choices?.[0]?.message?.content !== "pong") {
		throw new Error(`unexpected chat body: ${JSON.stringify(chatJson)}`)
	}

	const stream = await app.request("/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${planKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: "lumen-fast",
			messages: [{ role: "user", content: "tools" }],
			tools: [{ type: "function", function: { name: "read_file" } }],
			stream: true,
		}),
	})
	const streamText = await stream.text()
	if (!stream.ok || !streamText.includes("tool_calls")) {
		throw new Error(`stream failed: ${stream.status} ${streamText.slice(0, 300)}`)
	}

	const usage = await app.request("/v1/usage", {
		headers: { Authorization: `Bearer ${planKey}` },
	})
	const usageJson = await usage.json()
	if (!usage.ok || usageJson.tokens.used < 1) {
		throw new Error(`usage failed: ${JSON.stringify(usageJson)}`)
	}

	console.log(
		JSON.stringify(
			{
				ok: true,
				plan_key_prefix: planKey.slice(0, 12),
				chat_model: chatJson.model,
				usage_tokens: usageJson.tokens.used,
				upstream_hits: mock.requests.length,
				upstream_models: mock.requests.map((r) => r.body?.model),
			},
			null,
			2,
		),
	)
} finally {
	db.close()
	mock.close()
	rmSync(tmp, { recursive: true, force: true })
}
