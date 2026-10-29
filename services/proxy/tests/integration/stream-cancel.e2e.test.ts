import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generatePlanKey, hashPlanKey, newId } from "../../src/auth/keys"
import { loadConfig } from "../../src/config"
import { openDatabase, type AsyncDb } from "../../src/db/client"
import { createApp } from "../../src/server"
import { startMockUpstream, toolCallSseEvents } from "../helpers/mock-upstream"

/**
 * Client abort mid-SSE must not throw "Controller is already closed" and must
 * record usage exactly once.
 */
describe("stream cancel mid-passthrough", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "lumen-proxy-cancel-"))
	const dbPath = join(tmpDir, "test.db")

	let db: AsyncDb
	let app: ReturnType<typeof createApp>
	let config: ReturnType<typeof loadConfig>
	let planKey: string
	let mock: Awaited<ReturnType<typeof startMockUpstream>>
	let planKeyId: string

	beforeAll(async () => {
		process.env.DATABASE_URL = `sqlite:${dbPath}`
		process.env.KEY_PEPPER = "test-pepper-cancel"
		process.env.ADMIN_SECRET = "test-admin"
		process.env.LOG_LEVEL = "error"
		process.env.UPSTREAM_TIMEOUT_MS = "10000"
		process.env.SERVER_IDLE_TIMEOUT_SECONDS = "0"

		mock = await startMockUpstream({
			responses: [
				{
					type: "sse",
					chunkDelayMs: 80,
					events: toolCallSseEvents("nvidia/nemotron-3.5-lightning-30b-a3b"),
				},
			],
		})

		process.env.NVIDIA_API_KEY = "mock-nvidia"
		process.env.DASHSCOPE_API_KEY = "mock-dashscope"
		process.env.DEEPSEEK_API_KEY = "mock-deepseek"
		process.env.NVIDIA_BASE_URL = mock.url
		process.env.DASHSCOPE_BASE_URL = mock.url
		process.env.DEEPSEEK_BASE_URL = mock.url

		config = loadConfig()
		db = await openDatabase(config.databaseUrl)
		app = createApp(config, db)

		await db.ensureUser({ id: "user_cancel", email: "cancel@example.com", displayName: "Cancel" })
		const gen = generatePlanKey()
		planKey = gen.rawKey
		planKeyId = newId("key")
		await db.createPlanKey({
			id: planKeyId,
			userId: "user_cancel",
			planId: "free",
			keyHash: hashPlanKey(planKey, config.keyPepper),
			keyPrefix: gen.prefix,
			label: "cancel-test",
		})
	})

	afterAll(() => {
		mock.close()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	test("client cancel mid-stream does not throw Controller is already closed and records usage once", async () => {
		const before = await db.listUsageForKey(planKeyId, "1970-01-01T00:00:00.000Z", 50)
		const beforeCount = before.length

		const abort = new AbortController()
		const res = await app.request("/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${planKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: "lumen-fast",
				messages: [{ role: "user", content: "stream then cancel" }],
				stream: true,
			}),
			signal: abort.signal,
		})

		expect(res.status).toBe(200)
		expect(res.body).toBeTruthy()

		const reader = res.body!.getReader()
		const first = await reader.read()
		expect(first.done).toBe(false)
		expect(first.value).toBeTruthy()

		// Abort the client request and cancel the response body (mirrors UND_ERR_SOCKET).
		abort.abort()
		await reader.cancel("test_client_cancel")

		// Give passthrough finally a moment to persist usage.
		await Bun.sleep(250)

		const after = await db.listUsageForKey(planKeyId, "1970-01-01T00:00:00.000Z", 50)
		expect(after.length - beforeCount).toBe(1)
		expect(after[0]?.streamed).toBe(1)
		expect(after[0]?.status).toBe("ok")
		expect(after[0]?.logical_model).toBe("lumen-fast")
	})
})
