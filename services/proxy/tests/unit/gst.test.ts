import { describe, expect, test } from "bun:test"
import { breakdownGst, formatInr, invoiceGstLines } from "../../src/billing/gst"

describe("GST math", () => {
	test("inclusive 18% on ₹2,000 (200000 paise)", () => {
		const b = breakdownGst({
			pricePaise: 200_000,
			gstRatePercent: 18,
			pricesGstInclusive: true,
		})
		expect(b.grossPaise).toBe(200_000)
		expect(b.netPaise + b.gstPaise).toBe(b.grossPaise)
		// 200000 / 1.18 ≈ 169491.525 → 169492 net, gst 30508
		expect(b.netPaise).toBe(169_492)
		expect(b.gstPaise).toBe(30_508)
	})

	test("exclusive 18% on ₹2,000 adds GST on top", () => {
		const b = breakdownGst({
			pricePaise: 200_000,
			gstRatePercent: 18,
			pricesGstInclusive: false,
		})
		expect(b.netPaise).toBe(200_000)
		expect(b.gstPaise).toBe(36_000)
		expect(b.grossPaise).toBe(236_000)
	})

	test("zero / free plan", () => {
		const b = breakdownGst({
			pricePaise: 0,
			gstRatePercent: 18,
			pricesGstInclusive: true,
		})
		expect(b.grossPaise).toBe(0)
		expect(b.gstPaise).toBe(0)
	})

	test("formatInr and invoice lines", () => {
		expect(formatInr(200_000)).toContain("2,000")
		const lines = invoiceGstLines(
			breakdownGst({ pricePaise: 300_000, gstRatePercent: 18, pricesGstInclusive: true }),
		)
		expect(lines.gstLabel).toBe("GST (18%)")
		expect(lines.total).toContain("3,000")
	})
})
