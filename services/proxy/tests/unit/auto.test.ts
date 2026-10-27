import { describe, expect, test } from "bun:test"
import { loadModelsConfig } from "../../src/config"
import { resolveAutoModel } from "../../src/routing/auto"

const models = loadModelsConfig()

describe("resolveAutoModel", () => {
	test("defaults to fast for short prompts without tools", () => {
		const pick = resolveAutoModel(models, {
			messages: [{ role: "user", content: "fix typo" }],
		})
		expect(pick).toBe("lumen-fast")
	})

	test("bumps to standard when tools are present", () => {
		const pick = resolveAutoModel(models, {
			messages: [{ role: "user", content: "edit file" }],
			tools: [{ type: "function", function: { name: "write_to_file" } }],
		})
		expect(pick).toBe("lumen-standard")
	})

	test("bumps to strong on architecture/security signals", () => {
		const pick = resolveAutoModel(models, {
			messages: [{ role: "user", content: "Please refactor the architecture for a security vulnerability" }],
		})
		expect(pick).toBe("lumen-strong")
	})

	test("bumps to strong for large prompts", () => {
		const big = "x".repeat(models.auto.largePromptChars + 10)
		const pick = resolveAutoModel(models, {
			messages: [{ role: "user", content: big }],
		})
		expect(pick).toBe("lumen-strong")
	})
})
