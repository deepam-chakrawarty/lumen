import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import { loadConfig } from "../../src/config"
import { openDatabase, type AsyncDb } from "../../src/db/client"
import { generatePlanKey, hashPlanKey, newId } from "../../src/auth/keys"
import { createApp } from "../../src/server"
import { resetRateLimits } from "../../src/rate-limit"

const tmpDir = mkdtempSync(join(tmpdir(), "lumen-proxy-ctx-"))
const dbPath = join(tmpDir, "test.db")

let db: AsyncDb
let app: ReturnType<typeof createApp>
let planKey: string
let mockUrl: string
let mockServer: Server
const mockRequests: Array<{ body: any }> = []

function okBody(model: string, content: string) {
	return {
		id: "chatcmpl-ctx",
		object: "chat.completion",
		created: 1,
		model,
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
		usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
	}
}

function startModelAwareMock(): Server {
	return Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.json().catch(() => null)
			mockRequests.push({ body })
			const model = body?.model as string
			if (model === "nvidia/nemotron-mini-4b-instruct") {
				return Response.json(
					{
						error: {
							message: "This model's maximum context length is 4096 tokens",
							type: "invalid_request_error",
							code: "context_length_exceeded",
						},
					},
					{ status: 400 },
				)
			}
			if (model === "qwen3-coder-plus") {
				return Response.json(okBody(model, "from-qwen"))
			}
			if (model === "deepseek-v4-pro") {
				return Response.json(okBody(model, "from-deepseek-pro"))
			}
			if (model === "nvidia/nemotron-3.5-lightning-30b-a3b") {
				return Response.json(okBody(model, "from-lightning"))
			}
			if (model === "nvidia/llama-3.3-nemotron-super-49b-v1.5") {
				return Response.json(okBody(model, "from-super"))
			}
			return Response.json(okBody(model || "unknown", "from-other"))
		},
	})
}

beforeAll(async () => {
	process.env.DATABASE_URL = `sqlite:${dbPath}`
	process.env.KEY_PEPPER = "test-pepper-ctx"
	process.env.ADMIN_SECRET = "test-admin-ctx"
	process.env.LOG_LEVEL = "error"
	process.env.UPSTREAM_TIMEOUT_MS = "2000"

	mockServer = startModelAwareMock()
	mockUrl = `http://127.0.0.1:${mockServer.port}/v1`

	process.env.NVIDIA_API_KEY = "mock-nvidia"
	process.env.DASHSCOPE_API_KEY = "mock-dashscope"
	process.env.DEEPSEEK_API_KEY = "mock-deepseek"
	process.env.NVIDIA_BASE_URL = mockUrl
	process.env.DASHSCOPE_BASE_URL = mockUrl
	process.env.DEEPSEEK_BASE_URL = mockUrl

	const config = loadConfig()
	db = await openDatabase(config.databaseUrl)
	app = createApp(config, db)

	await db.ensureUser({ id: "user_ctx" })
	const gen = generatePlanKey()
	planKey = gen.rawKey
	await db.createPlanKey({
		id: newId("key"),
		userId: "user_ctx",
		planId: "free",
		keyHash: hashPlanKey(planKey, config.keyPepper),
		keyPrefix: gen.prefix,
		label: "ctx",
	})
	resetRateLimits()
})

afterAll(() => {
	db?.close()
	mockServer?.stop(true)
	rmSync(tmpDir, { recursive: true, force: true })
})

async function chat(body: Record<string, unknown>, localApp = app) {
	return localApp.request("/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${planKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	})
}

describe("context-aware routing integration", () => {
	test("oversized prompt skips Nemotron Mini and hits Lightning", async () => {
		const before = mockRequests.length
		const res = await chat({
			model: "lumen-standard",
			messages: [{ role: "user", content: "a".repeat(20_000) }],
			max_tokens: 1024,
			stream: false,
		})
		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.choices[0].message.content).toBe("from-lightning")
		const modelsHit = mockRequests.slice(before).map((r) => r.body?.model)
		expect(modelsHit).not.toContain("nvidia/nemotron-mini-4b-instruct")
		expect(modelsHit[0]).toBe("nvidia/nemotron-3.5-lightning-30b-a3b")
	})

	test("Mini 400 context_length_exceeded rolls over to next fitting route", async () => {
		const before = mockRequests.length
		const res = await chat({
			model: "lumen-standard",
			messages: [{ role: "user", content: "short enough for mini filter" }],
			max_tokens: 256,
			stream: false,
		})
		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.choices[0].message.content).toBe("from-lightning")
		const modelsHit = mockRequests.slice(before).map((r) => r.body?.model)
		expect(modelsHit[0]).toBe("nvidia/nemotron-mini-4b-instruct")
		expect(modelsHit[1]).toBe("nvidia/nemotron-3.5-lightning-30b-a3b")
	})

	test("heavy agent prompt lands on qwen3-coder-plus", async () => {
		const before = mockRequests.length
		const res = await chat({
			model: "lumen-auto",
			messages: [{ role: "user", content: "a".repeat(600_000) }],
			tools: [
				{
					type: "function",
					function: {
						name: "read_file",
						parameters: { type: "object", properties: { path: { type: "string" } } },
					},
				},
			],
			max_tokens: 4096,
			stream: false,
		})
		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.choices[0].message.content).toBe("from-qwen")
		const modelsHit = mockRequests.slice(before).map((r) => r.body?.model)
		expect(modelsHit[0]).toBe("qwen3-coder-plus")
	})

	test("strong tier tries deepseek-v4-pro right after qwen context error", async () => {
		const requests: Array<{ body: any }> = []
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				const body = await req.json().catch(() => null)
				requests.push({ body })
				const model = body?.model as string
				if (model === "qwen3-coder-plus") {
					return Response.json(
						{ error: { message: "maximum context length exceeded", code: "context_length_exceeded" } },
						{ status: 400 },
					)
				}
				if (model === "deepseek-v4-pro") {
					return Response.json(okBody(model, "from-deepseek-pro"))
				}
				return Response.json(okBody(model || "x", "unexpected"), { status: 500 })
			},
		})
		const url = `http://127.0.0.1:${server.port}/v1`
		process.env.NVIDIA_BASE_URL = url
		process.env.DASHSCOPE_BASE_URL = url
		process.env.DEEPSEEK_BASE_URL = url
		const localApp = createApp(loadConfig(), db)

		try {
			const res = await chat(
				{
					model: "lumen-strong",
					messages: [{ role: "user", content: "a".repeat(600_000) }],
					max_tokens: 4096,
				},
				localApp,
			)
			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.choices[0].message.content).toBe("from-deepseek-pro")
			expect(requests.map((r) => r.body?.model)).toEqual(["qwen3-coder-plus", "deepseek-v4-pro"])
		} finally {
			server.stop(true)
			process.env.NVIDIA_BASE_URL = mockUrl
			process.env.DASHSCOPE_BASE_URL = mockUrl
			process.env.DEEPSEEK_BASE_URL = mockUrl
		}
	})

	test("nothing fits returns OpenAI-style 400 context_length_exceeded", async () => {
		const before = mockRequests.length
		const res = await chat({
			model: "lumen-fast",
			messages: [{ role: "user", content: "x".repeat(5_000_000) }],
			max_tokens: 100000,
			stream: false,
		})
		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe("context_length_exceeded")
		expect(json.error.message.toLowerCase()).toContain("context")
		expect(mockRequests.length).toBe(before) // never called upstream
	})
})
