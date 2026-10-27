import { describe, expect, test } from "bun:test"
import { loadPlansConfig } from "../../src/config"
import {
	downgradePlanId,
	graceUntilIso,
	isGraceExpired,
	isPaidPlan,
	listPublicPlans,
} from "../../src/billing/plans"
import { loadConfig } from "../../src/config"

describe("plan billing config", () => {
	test("plans.yaml exposes free, edu, pro, pro_plus with INR paise", () => {
		const plans = loadPlansConfig()
		expect(plans.defaultPlan).toBe("free")
		expect(plans.plans.free.pricePaise).toBe(0)
		expect(plans.plans.edu.pricePaise).toBe(0)
		expect(plans.plans.edu.eduOnly).toBe(true)
		expect(plans.plans.pro.pricePaise).toBe(200_000)
		expect(plans.plans.pro_plus.pricePaise).toBe(300_000)
		expect(plans.plans.pro.paid).toBe(true)
		expect(plans.billing.gstRatePercent).toBe(18)
		expect(plans.eduEmailAllowlist).toContain(".edu.in")
		expect(plans.eduEmailAllowlist).toContain(".ac.in")
	})

	test("public plans show INR display prices", () => {
		const plans = loadPlansConfig()
		const publicPlans = listPublicPlans(plans)
		const pro = publicPlans.find((p) => p.id === "pro")
		expect(pro?.displayPrice).toContain("2,000")
		expect(pro?.chargePaise).toBe(200_000)
	})

	test("grace helpers", () => {
		const from = new Date("2026-01-01T00:00:00.000Z")
		const until = graceUntilIso(from, 3)
		expect(until.startsWith("2026-01-04")).toBe(true)
		expect(isGraceExpired(until, new Date("2026-01-03T00:00:00.000Z"))).toBe(false)
		expect(isGraceExpired(until, new Date("2026-01-05T00:00:00.000Z"))).toBe(true)
		expect(downgradePlanId()).toBe("free")
	})

	test("isPaidPlan", () => {
		const config = loadConfig()
		expect(isPaidPlan(config, "pro")).toBe(true)
		expect(isPaidPlan(config, "free")).toBe(false)
	})
})
