import { describe, expect, test } from "bun:test"
import { loadModelsConfig } from "../../src/config"
import { resolveRoutePlan } from "../../src/routing/router"

const models = loadModelsConfig()

describe("resolveRoutePlan", () => {
	test("lumen-fast starts with Nemotron Nano", () => {
		const plan = resolveRoutePlan(models, "lumen-fast", { messages: [] })
		expect(plan.logicalModel).toBe("lumen-fast")
		expect(plan.routes[0]?.model).toBe("nvidia/nemotron-3-nano-30b-a3b")
		expect(plan.routes.length).toBeGreaterThan(1)
	})

	test("lumen-standard starts with Nemotron Mini then stronger fallbacks", () => {
		const plan = resolveRoutePlan(models, "lumen-standard", { messages: [] })
		expect(plan.routes[0]?.model).toBe("nvidia/nemotron-mini-4b-instruct")
		expect(plan.routes.some((r) => r.model.includes("lightning") || r.model.includes("super"))).toBe(true)
	})

	test("lumen-strong prefers Qwen then DeepSeek", () => {
		const plan = resolveRoutePlan(models, "lumen-strong", { messages: [] })
		expect(plan.routes[0]).toEqual({ provider: "dashscope", model: "qwen3-coder-plus" })
		expect(plan.routes.some((r) => r.provider === "deepseek")).toBe(true)
	})

	test("lumen-auto resolves and includes fallbacks from chosen tier upward", () => {
		const plan = resolveRoutePlan(models, "lumen-auto", {
			messages: [{ role: "user", content: "tiny" }],
		})
		expect(plan.autoResolvedFrom).toBe("lumen-auto")
		expect(plan.logicalModel).toBe("lumen-fast")
		expect(plan.routes[0]?.provider).toBe("nvidia")
	})
})
