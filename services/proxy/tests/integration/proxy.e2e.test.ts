import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../src/config"
import { openDatabase, type AsyncDb } from "../../src/db/client"
import { generatePlanKey, hashPlanKey, newId } from "../../src/auth/keys"
import { createApp } from "../../src/server"
import { resetRateLimits } from "../../src/rate-limit"
import { startMockUpstream, toolCallSseEvents } from "../helpers/mock-upstream"

const tmpDir = mkdtempSync(join(tmpdir(), "lumen-proxy-"))
const dbPath = join(tmpDir, "test.db")

let db: AsyncDb
let app: ReturnType<typeof createApp>
let config: ReturnType<typeof loadConfig>
let planKey: string
let limitedKey: string
let mock: Awaited<ReturnType<typeof startMockUpstream>>

beforeAll(async () => {
	process.env.DATABASE_URL = `sqlite:${dbPath}`
	process.env.KEY_PEPPER = "test-pepper"
	process.env.ADMIN_SECRET = "test-admin"
	process.env.LOG_LEVEL = "error"
	process.env.UPSTREAM_TIMEOUT_MS = "2000"

	mock = await startMockUpstream({
		responses: [
			// 1) non-stream happy path
			{
				type: "json",
				body: {
					id: "c1",
					object: "chat.completion",
					created: 1,
					model: "nvidia/nemotron-3.5-lightning-30b-a3b",
					choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
				},
			},
			// 2) streaming tool calls
			{
				type: "sse",
				events: toolCallSseEvents("nvidia/nemotron-3.5-lightning-30b-a3b"),
			},
			// 3) fallback: first upstream 429, second ok
			{ type: "error", status: 429, body: { error: { message: "rate limited" } } },
			{
				type: "json",
				body: {
					id: "c2",
					object: "chat.completion",
					created: 1,
					model: "nvidia/nvidia-nemotron-nano-9b-v2",
					choices: [{ index: 0, message: { role: "assistant", content: "fallback ok" }, finish_reason: "stop" }],
					usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
				},
			},
		],
	})

	// Point all providers at the mock for integration tests
	process.env.NVIDIA_API_KEY = "mock-nvidia"
	process.env.DASHSCOPE_API_KEY = "mock-dashscope"
	process.env.DEEPSEEK_API_KEY = "mock-deepseek"
	process.env.NVIDIA_BASE_URL = mock.url
	process.env.DASHSCOPE_BASE_URL = mock.url
	process.env.DEEPSEEK_BASE_URL = mock.url

	config = loadConfig()
	db = await openDatabase(config.databaseUrl)
	app = createApp(config, db)

	await db.ensureUser({ id: "user_test", email: "test@example.com", displayName: "Tester" })
	const gen = generatePlanKey()
	planKey = gen.rawKey
	await db.createPlanKey({
		id: newId("key"),
		userId: "user_test",
		planId: "free",
		keyHash: hashPlanKey(planKey, config.keyPepper),
		keyPrefix: gen.prefix,
		label: "test",
	})

	// Tiny-quota plan used only for the quota-exceeded case
	config.plans.plans.micro = {
		name: "Micro",
		description: "test-only tiny quota",
		monthlyTokenLimit: 20,
		requestsPerMinute: 1000,
		allowedTiers: ["fast", "standard", "strong", "auto"],
		pricePaise: 0,
		currency: "INR",
		paid: false,
	}

	const gen2 = generatePlanKey()
	limitedKey = gen2.rawKey
	await db.ensureUser({ id: "user_limited" })
	const limitedKeyId = newId("key")
	await db.createPlanKey({
		id: limitedKeyId,
		userId: "user_limited",
		planId: "micro",
		keyHash: hashPlanKey(limitedKey, config.keyPepper),
		keyPrefix: gen2.prefix,
		label: "limited",
	})
	// Pre-consume quota
	await db.insertUsage({
		id: newId("usage"),
		user_id: "user_limited",
		plan_key_id: limitedKeyId,
		logical_model: "lumen-fast",
		upstream_provider: "nvidia",
		upstream_model: "x",
		prompt_tokens: 20,
		completion_tokens: 0,
		total_tokens: 20,
		streamed: 0,
		status: "ok",
	})

	resetRateLimits()
})

afterAll(() => {
	db?.close()
	mock?.close()
	rmSync(tmpDir, { recursive: true, force: true })
})

async function api(
	path: string,
	init: RequestInit & { key?: string } = {},
): Promise<Response> {
	const headers = new Headers(init.headers)
	if (init.key !== null) {
		headers.set("Authorization", `Bearer ${init.key ?? planKey}`)
	}
	if (init.body && !headers.has("Content-Type")) {
		headers.set("Content-Type", "application/json")
	}
	return app.request(path, { ...init, headers })
}

function readJson<T>(res: Response): Promise<T> {
	return res.json() as Promise<T>
}

describe("lumen proxy integration", () => {
	test("health is public", async () => {
		const res = await app.request("/health")
		expect(res.status).toBe(200)
		const json = await readJson<{
			status: string
			providers: { nvidia: { configured: boolean } }
		}>(res)
		expect(json.status).toBe("ok")
		expect(json.providers.nvidia.configured).toBe(true)
	})

	test("bad key returns OpenAI-style 401", async () => {
		const res = await api("/v1/models", { key: "lmn_invalid" })
		expect(res.status).toBe(401)
		const json = await readJson<{ error: { code: string; message: string } }>(res)
		expect(json.error.code).toBe("invalid_api_key")
		expect(json.error.message).toContain("plan key")
	})

	test("lists logical models", async () => {
		const res = await api("/v1/models")
		expect(res.status).toBe(200)
		const json = await readJson<{ data: { id: string }[] }>(res)
		const ids = json.data.map((m) => m.id).sort()
		expect(ids).toEqual(["lumen-auto", "lumen-fast", "lumen-standard", "lumen-strong"].sort())
	})

	test("non-streaming chat completions with usage metering", async () => {
		const res = await api("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "lumen-fast",
				messages: [{ role: "user", content: "hi" }],
				stream: false,
			}),
		})
		expect(res.status).toBe(200)
		const json = await readJson<{
			model: string
			choices: { message: { content: string } }[]
			usage: { total_tokens: number }
		}>(res)
		expect(json.model).toBe("lumen-fast")
		expect(json.choices[0].message.content).toBe("ok")
		expect(json.usage.total_tokens).toBe(14)

		const usage = await api("/v1/usage")
		expect(usage.status).toBe(200)
		const u = await readJson<{
			tokens: { used: number }
			recent: { upstream_model: string }[]
		}>(usage)
		expect(u.tokens.used).toBeGreaterThanOrEqual(14)
		expect(u.recent[0].upstream_model).toBeTruthy()
	})

	test("streaming SSE with tool calls and include_usage", async () => {
		const res = await api("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "lumen-fast",
				messages: [{ role: "user", content: "read a file" }],
				tools: [
					{
						type: "function",
						function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } },
					},
				],
				stream: true,
			}),
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type") || "").toContain("text/event-stream")
		const text = await res.text()
		expect(text).toContain("tool_calls")
		expect(text).toContain("read_file")
		expect(text).toContain('"model":"lumen-fast"')
		expect(text).toContain("[DONE]")
		// mock received stream_options.include_usage
		const last = mock.requests.at(-1)
		expect(last?.body?.stream).toBe(true)
		expect(last?.body?.stream_options?.include_usage).toBe(true)
		expect(last?.body?.tools?.[0]?.function?.name).toBe("read_file")
	})

	test("fallback on upstream rate limit", async () => {
		const before = mock.requests.length
		const res = await api("/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "lumen-fast",
				messages: [{ role: "user", content: "fallback please" }],
				stream: false,
			}),
		})
		expect(res.status).toBe(200)
		const json = await readJson<{ choices: { message: { content: string } }[] }>(res)
		expect(json.choices[0].message.content).toBe("fallback ok")
		expect(mock.requests.length - before).toBe(2)
		expect(mock.requests[before]?.body?.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b")
		expect(mock.requests[before + 1]?.body?.model).toBe("nvidia/nvidia-nemotron-nano-9b-v2")
	})

	test("quota exceeded returns OpenAI-style 429", async () => {
		const res = await api("/v1/chat/completions", {
			method: "POST",
			key: limitedKey,
			body: JSON.stringify({
				model: "lumen-fast",
				messages: [{ role: "user", content: "should fail quota" }],
			}),
		})
		expect(res.status).toBe(429)
		const json = await readJson<{ error: { code: string; type: string } }>(res)
		expect(json.error.code).toBe("insufficient_quota")
		expect(json.error.type).toBe("insufficient_quota")
	})

	test("admin create/list/revoke keys", async () => {
		const created = await app.request("/admin/keys", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-admin-secret": "test-admin",
			},
			body: JSON.stringify({ userId: "user_admin", plan: "pro", label: "cli" }),
		})
		expect(created.status).toBe(201)
		const body = await readJson<{ plan_key: string; plan_id: string; id: string }>(created)
		expect(body.plan_key.startsWith("lmn_")).toBe(true)
		expect(body.plan_id).toBe("pro")

		const listed = await app.request("/admin/keys", {
			headers: { "x-admin-secret": "test-admin" },
		})
		expect(listed.status).toBe(200)
		const list = await readJson<{ data: { id: string }[] }>(listed)
		expect(list.data.some((k) => k.id === body.id)).toBe(true)

		const revoked = await app.request(`/admin/keys/${body.id}/revoke`, {
			method: "POST",
			headers: { "x-admin-secret": "test-admin" },
		})
		expect(revoked.status).toBe(200)

		const authed = await api("/v1/models", { key: body.plan_key })
		expect(authed.status).toBe(401)
	})
})
