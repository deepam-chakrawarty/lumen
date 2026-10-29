import { describe, expect, test } from "bun:test"
import { loadModelsConfig } from "../../src/config"
import { resolveRoutePlan } from "../../src/routing/router"

const models = loadModelsConfig()
const small = { promptTokens: 100, maxOutputTokens: 256 }

describe("resolveRoutePlan", () => {
	test("lumen-fast starts with Nemotron Lightning", () => {
		const plan = resolveRoutePlan(models, "lumen-fast", { messages: [] }, small)
		expect(plan.logicalModel).toBe("lumen-fast")
		expect(plan.routes[0]?.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b")
		expect(plan.routes[0]?.contextWindow).toBe(1000000)
		expect(plan.routes.length).toBeGreaterThan(1)
	})

	test("lumen-standard starts with Nemotron Mini then stronger fallbacks", () => {
		const plan = resolveRoutePlan(models, "lumen-standard", { messages: [] }, small)
		expect(plan.routes[0]?.model).toBe("nvidia/nemotron-mini-4b-instruct")
		expect(plan.routes.some((r) => r.model.includes("lightning") || r.model.includes("super"))).toBe(true)
	})

	test("lumen-strong prefers Qwen then DeepSeek v4-pro before flash", () => {
		const plan = resolveRoutePlan(models, "lumen-strong", { messages: [] }, small)
		expect(plan.routes[0]?.provider).toBe("dashscope")
		expect(plan.routes[0]?.model).toBe("qwen3-coder-plus")
		expect(plan.routes[1]?.model).toBe("deepseek-v4-pro")
		expect(plan.routes[2]?.model).toBe("deepseek-flash")
	})

	test("lumen-auto resolves and includes fallbacks from chosen tier upward", () => {
		const plan = resolveRoutePlan(
			models,
			"lumen-auto",
			{ messages: [{ role: "user", content: "tiny" }] },
			small,
		)
		expect(plan.autoResolvedFrom).toBe("lumen-auto")
		expect(plan.logicalModel).toBe("lumen-fast")
		expect(plan.routes[0]?.provider).toBe("nvidia")
	})

	test("every configured route has a positive contextWindow", () => {
		for (const logical of Object.values(models.logicalModels)) {
			for (const route of logical.routes) {
				expect(route.contextWindow).toBeGreaterThan(0)
			}
		}
	})
})
