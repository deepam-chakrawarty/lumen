import { describe, expect, test } from "bun:test"
import { estimateTokensFromMessages, estimateTokensFromText } from "../../src/metering/tokenizer"

describe("tokenizer estimate", () => {
	test("estimates latin text", () => {
		const n = estimateTokensFromText("hello world this is a test")
		expect(n).toBeGreaterThan(3)
		expect(n).toBeLessThan(20)
	})

	test("estimates messages including tool_calls overhead", () => {
		const n = estimateTokensFromMessages([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "x", arguments: "{}" } }] },
		])
		expect(n).toBeGreaterThan(5)
	})
})
