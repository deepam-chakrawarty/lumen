import { describe, expect, test } from "bun:test"
import { extractBearerToken, generatePlanKey, hashPlanKey, safeEqualHex } from "../../src/auth/keys"

describe("plan keys", () => {
	test("generate opaque lmn_ keys", () => {
		const { rawKey, prefix } = generatePlanKey()
		expect(rawKey.startsWith("lmn_")).toBe(true)
		expect(prefix.startsWith("lmn_")).toBe(true)
		expect(prefix.length).toBe(12)
	})

	test("hash is stable and pepper-sensitive", () => {
		const key = "lmn_testkey"
		const a = hashPlanKey(key, "pepper1")
		const b = hashPlanKey(key, "pepper1")
		const c = hashPlanKey(key, "pepper2")
		expect(a).toBe(b)
		expect(a).not.toBe(c)
		expect(a).toHaveLength(64)
	})

	test("extractBearerToken", () => {
		expect(extractBearerToken("Bearer abc")).toBe("abc")
		expect(extractBearerToken("bearer abc")).toBe("abc")
		expect(extractBearerToken("Basic abc")).toBeNull()
		expect(extractBearerToken(undefined)).toBeNull()
	})

	test("safeEqualHex", () => {
		const h = hashPlanKey("x", "p")
		expect(safeEqualHex(h, h)).toBe(true)
		expect(safeEqualHex(h, "00")).toBe(false)
	})
})
