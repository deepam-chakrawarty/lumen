import { describe, expect, test } from "bun:test"
import { parseServerIdleTimeoutSeconds } from "../../src/config"

describe("parseServerIdleTimeoutSeconds", () => {
	test("defaults to 0 (disabled)", () => {
		expect(parseServerIdleTimeoutSeconds(undefined)).toBe(0)
	})

	test("accepts 0 and Bun max 255", () => {
		expect(parseServerIdleTimeoutSeconds("0")).toBe(0)
		expect(parseServerIdleTimeoutSeconds("255")).toBe(255)
	})

	test("rejects non-integers and values above 255", () => {
		expect(() => parseServerIdleTimeoutSeconds("1.5")).toThrow(/integer/)
		expect(() => parseServerIdleTimeoutSeconds("-1")).toThrow()
		expect(() => parseServerIdleTimeoutSeconds("256")).toThrow(/255/)
	})
})
