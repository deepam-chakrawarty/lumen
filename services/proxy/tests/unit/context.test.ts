import { describe, expect, test } from "bun:test"
import { loadModelsConfig } from "../../src/config"
import {
	buildSizeBudget,
	filterRoutesByContextSize,
	isContextLengthError,
} from "../../src/routing/context"
import { resolveAutoModel } from "../../src/routing/auto"
import { resolveRoutePlan } from "../../src/routing/router"

const models = loadModelsConfig()

describe("filterRoutesByContextSize", () => {
	test("skips Nemotron Mini when prompt does not fit 4k", () => {
		const budget = buildSizeBudget(3500, 1024, 1024) // 5648 > 4096
		const standard = models.logicalModels["lumen-standard"].routes
		const { routes, skipped } = filterRoutesByContextSize(standard, budget)
		expect(skipped.some((s) => s.route.model === "nvidia/nemotron-mini-4b-instruct")).toBe(true)
		expect(routes.every((r) => r.model !== "nvidia/nemotron-mini-4b-instruct")).toBe(true)
		expect(routes[0]?.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b")
	})

	test("keeps Mini for tiny requests", () => {
		const budget = buildSizeBudget(100, 256, 64)
		const standard = models.logicalModels["lumen-standard"].routes
		const { routes, skipped } = filterRoutesByContextSize(standard, budget)
		expect(skipped).toHaveLength(0)
		expect(routes[0]?.model).toBe("nvidia/nemotron-mini-4b-instruct")
	})

	test("returns empty when nothing fits", () => {
		const budget = buildSizeBudget(2_000_000, 100_000, 1024)
		const all = [
			...models.logicalModels["lumen-fast"].routes,
			...models.logicalModels["lumen-standard"].routes,
			...models.logicalModels["lumen-strong"].routes,
		]
		const { routes, skipped } = filterRoutesByContextSize(all, budget)
		expect(routes).toHaveLength(0)
		expect(skipped.length).toBeGreaterThan(0)
	})
})

describe("isContextLengthError", () => {
	test("detects OpenAI-style context_length_exceeded", () => {
		expect(
			isContextLengthError(
				400,
				JSON.stringify({
					error: { message: "This model's maximum context length is 4096 tokens", code: "context_length_exceeded" },
				}),
			),
		).toBe(true)
	})

	test("detects NVIDIA / generic length phrases on 400/413/422", () => {
		expect(isContextLengthError(400, "maximum context length exceeded")).toBe(true)
		expect(isContextLengthError(413, "input is too long")).toBe(true)
		expect(isContextLengthError(422, JSON.stringify({ error: { message: "too many tokens in the request" } }))).toBe(
			true,
		)
	})

	test("does not treat unrelated 400s as retryable context errors", () => {
		expect(
			isContextLengthError(400, JSON.stringify({ error: { message: "Invalid temperature", code: "invalid_request_error" } })),
		).toBe(false)
		expect(isContextLengthError(401, "context_length_exceeded")).toBe(false)
		expect(isContextLengthError(500, "maximum context length")).toBe(false)
	})
})

describe("size-aware resolveRoutePlan", () => {
	test("oversized auto prompt lands on strong (qwen first)", () => {
		const plan = resolveRoutePlan(
			models,
			"lumen-auto",
			{
				messages: [{ role: "user", content: "x".repeat(1000) }],
				tools: [{ type: "function", function: { name: "read_file" } }],
			},
			{ promptTokens: 140000, maxOutputTokens: 4096 },
		)
		expect(plan.logicalModel).toBe("lumen-strong")
		expect(plan.routes[0]?.model).toBe("qwen3-coder-plus")
		expect(plan.routes[1]?.model).toBe("deepseek-v4-pro")
		expect(plan.skippedForSize.some((s) => s.route.model.includes("nemotron-mini"))).toBe(false)
	})

	test("standard tier skips Mini then keeps Lightning for mid-size prompts", () => {
		const plan = resolveRoutePlan(models, "lumen-standard", { messages: [] }, {
			promptTokens: 5000,
			maxOutputTokens: 1024,
		})
		expect(plan.skippedForSize[0]?.route.model).toBe("nvidia/nemotron-mini-4b-instruct")
		expect(plan.routes[0]?.model).toBe("nvidia/nemotron-3.5-lightning-30b-a3b")
	})

	test("auto strongContextTokens threshold", () => {
		expect(
			resolveAutoModel(models, {
				messages: [{ role: "user", content: "hi" }],
				requiredTokens: 200000,
			}),
		).toBe("lumen-strong")
	})
})
