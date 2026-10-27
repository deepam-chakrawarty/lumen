import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import {
	verifyCashfreeWebhookSignature,
	verifyRazorpayWebhookSignature,
} from "../../src/billing/providers/signatures"
import { RazorpayProvider } from "../../src/billing/providers/razorpay"
import { CashfreeProvider } from "../../src/billing/providers/cashfree"
import { loadConfig } from "../../src/config"

describe("webhook signature verification", () => {
	test("razorpay accepts valid HMAC hex", () => {
		const body = JSON.stringify({ event: "subscription.activated" })
		const secret = "whsec_test"
		const sig = createHmac("sha256", secret).update(body).digest("hex")
		expect(verifyRazorpayWebhookSignature(body, sig, secret)).toBe(true)
		expect(verifyRazorpayWebhookSignature(body, "deadbeef", secret)).toBe(false)
		expect(verifyRazorpayWebhookSignature(body + "x", sig, secret)).toBe(false)
	})

	test("cashfree accepts valid Base64 HMAC(timestamp+body)", () => {
		const body = JSON.stringify({ type: "SUBSCRIPTION_STATUS_CHANGED" })
		const secret = "cf_whsec"
		const timestamp = "1710000000"
		const sig = createHmac("sha256", secret).update(timestamp + body).digest("base64")
		expect(verifyCashfreeWebhookSignature(body, sig, timestamp, secret)).toBe(true)
		expect(verifyCashfreeWebhookSignature(body, sig, "0", secret)).toBe(false)
	})

	test("razorpay provider parse + verify", () => {
		process.env.RAZORPAY_WEBHOOK_SECRET = "rzp_wh"
		process.env.RAZORPAY_KEY_ID = "rzp_test_x"
		process.env.RAZORPAY_KEY_SECRET = "secret"
		const config = loadConfig()
		config.razorpay.webhookSecret = "rzp_wh"
		const provider = new RazorpayProvider(config)
		const rawBody = JSON.stringify({
			event: "subscription.activated",
			payload: {
				subscription: {
					entity: {
						id: "sub_123",
						notes: { lumen_plan_id: "pro" },
						current_end: 1_800_000_000,
					},
				},
			},
		})
		const signature = createHmac("sha256", "rzp_wh").update(rawBody).digest("hex")
		const headers = new Headers({
			"x-razorpay-signature": signature,
			"x-razorpay-event-id": "evt_1",
		})
		expect(
			provider.verifyWebhookSignature({ rawBody, signature, headers }),
		).toBe(true)
		const event = provider.parseWebhookEvent({ rawBody, headers, eventIdHeader: "evt_1" })
		expect(event.type).toBe("subscription.activated")
		expect(event.providerSubscriptionId).toBe("sub_123")
		expect(event.localPlanId).toBe("pro")
	})

	test("cashfree provider parse + verify", () => {
		const config = loadConfig()
		config.cashfree.webhookSecret = "cf_secret"
		const provider = new CashfreeProvider(config)
		const rawBody = JSON.stringify({
			type: "SUBSCRIPTION_PAYMENT_SUCCESS",
			data: {
				subscription_id: "sub_cf_1",
				cf_payment_id: "pay_1",
				subscription_tags: { lumen_plan_id: "pro_plus" },
			},
		})
		const timestamp = "1710000001"
		const signature = createHmac("sha256", "cf_secret")
			.update(timestamp + rawBody)
			.digest("base64")
		const headers = new Headers({
			"x-webhook-signature": signature,
			"x-webhook-timestamp": timestamp,
		})
		expect(
			provider.verifyWebhookSignature({ rawBody, signature, timestamp, headers }),
		).toBe(true)
		const event = provider.parseWebhookEvent({ rawBody, headers })
		expect(event.type).toBe("subscription.renewed")
		expect(event.providerSubscriptionId).toBe("sub_cf_1")
		expect(event.localPlanId).toBe("pro_plus")
	})
})
