import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../../src/config"
import { openDatabase, type AsyncDb } from "../../src/db/client"
import { createApp } from "../../src/server"
import { newId } from "../../src/auth/keys"
import { signMockWebhook } from "../../src/billing/providers/mock"

const tmpDir = mkdtempSync(join(tmpdir(), "lumen-billing-"))
const dbPath = join(tmpDir, "billing.db")

let db: AsyncDb
let app: ReturnType<typeof createApp>
let config: ReturnType<typeof loadConfig>

beforeAll(async () => {
	process.env.DATABASE_URL = `sqlite:${dbPath}`
	process.env.KEY_PEPPER = "billing-pepper"
	process.env.SESSION_SECRET = "billing-session"
	process.env.ADMIN_SECRET = "test-admin"
	process.env.LOG_LEVEL = "error"
	process.env.PAYMENT_PROVIDER = "mock"
	process.env.PAYMENT_TEST_MODE = "true"
	process.env.RAZORPAY_WEBHOOK_SECRET = "mock-webhook-secret"
	process.env.CASHFREE_WEBHOOK_SECRET = "cf-webhook-secret"
	process.env.PUBLIC_BASE_URL = "http://localhost:8787"
	process.env.MAILER = "console"

	config = loadConfig()
	db = await openDatabase(config.databaseUrl)
	app = createApp(config, db)
})

afterAll(() => {
	db.close()
	rmSync(tmpDir, { recursive: true, force: true })
})

async function signupVerify(email: string) {
	const signup = await app.request("/billing/signup", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `email=${encodeURIComponent(email)}&name=Tester`,
	})
	expect(signup.status).toBe(200)
	const html = await signup.text()
	const tokenMatch = html.match(/Dev token: ([A-Za-z0-9_-]+)/)
	expect(tokenMatch?.[1]).toBeTruthy()
	const verify = await app.request(`/billing/verify?token=${tokenMatch![1]}`)
	expect(verify.status).toBe(200)
	const setCookie = verify.headers.get("set-cookie") || ""
	const session = /lumen_session=([^;]+)/.exec(setCookie)?.[1]
	expect(session).toBeTruthy()
	return { session: session!, html: await verify.text() }
}

describe("billing signup + edu", () => {
	test("edu domain gets Edu plan + plan key", async () => {
		const { html } = await signupVerify("student@iitd.ac.in")
		expect(html).toContain("edu")
		expect(html).toContain("lmn_")
		const user = await db.findUserByEmail("student@iitd.ac.in")
		expect(user?.plan_id).toBe("edu")
		expect(user?.email_verified_at).toBeTruthy()
	})

	test("commercial email gets Free plan", async () => {
		const { html } = await signupVerify("dev@example.com")
		expect(html).toContain("free")
		const user = await db.findUserByEmail("dev@example.com")
		expect(user?.plan_id).toBe("free")
	})
})

describe("mock provider subscription lifecycle", () => {
	test("upgrade → activate → renew → fail → cancel", async () => {
		const { session } = await signupVerify("payer@example.com")
		const user = await db.findUserByEmail("payer@example.com")
		expect(user).toBeTruthy()

		const upgrade = await app.request("/billing/upgrade", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Cookie: `lumen_session=${session}`,
			},
			body: "plan=pro",
		})
		expect([302, 303]).toContain(upgrade.status)
		const checkoutUrl = upgrade.headers.get("location") || ""
		expect(checkoutUrl).toContain("/billing/mock-checkout")

		const sub = await db.findActiveSubscriptionForUser(user!.id)
		expect(sub?.plan_id).toBe("pro")
		expect(sub?.provider_subscription_id).toBeTruthy()
		const providerSubId = sub!.provider_subscription_id!

		// Activate via mock checkout POST
		const pay = await app.request("/billing/mock-checkout", {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Cookie: `lumen_session=${session}`,
			},
			body: `sub=${encodeURIComponent(providerSubId)}&plan=pro`,
		})
		expect([302, 303]).toContain(pay.status)

		const after = await db.findUserById(user!.id)
		expect(after?.plan_id).toBe("pro")
		const keys = await db.listPlanKeysForUser(user!.id)
		expect(keys[0]?.plan_id).toBe("pro")
		const invoices = await db.listInvoicesForUser(user!.id)
		expect(invoices.length).toBeGreaterThanOrEqual(1)
		expect(invoices[0].gst_paise).toBeGreaterThan(0)

		// Renewal webhook (mock)
		const renewBody = JSON.stringify({
			event: "subscription.renewed",
			event_id: "evt_renew_1",
			subscription_id: providerSubId,
			payment_id: "pay_renew_1",
			plan_id: "pro",
		})
		const renew = await app.request("/webhooks/mock", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-razorpay-signature": signMockWebhook(renewBody),
				"x-razorpay-event-id": "evt_renew_1",
			},
			body: renewBody,
		})
		expect(renew.status).toBe(200)
		expect((await renew.json()).duplicate).toBe(false)

		// Idempotent replay
		const replay = await app.request("/webhooks/mock", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-razorpay-signature": signMockWebhook(renewBody),
				"x-razorpay-event-id": "evt_renew_1",
			},
			body: renewBody,
		})
		expect((await replay.json()).duplicate).toBe(true)

		// Payment failure → past_due + grace
		const failBody = JSON.stringify({
			event: "subscription.payment_failed",
			event_id: "evt_fail_1",
			subscription_id: providerSubId,
			plan_id: "pro",
		})
		const fail = await app.request("/webhooks/mock", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-razorpay-signature": signMockWebhook(failBody),
				"x-razorpay-event-id": "evt_fail_1",
			},
			body: failBody,
		})
		expect(fail.status).toBe(200)
		const pastDue = await db.findSubscriptionByProviderId("mock", providerSubId)
		expect(pastDue?.status).toBe("past_due")
		expect(pastDue?.grace_until).toBeTruthy()

		// Cancel
		const cancelBody = JSON.stringify({
			event: "subscription.cancelled",
			event_id: "evt_cancel_1",
			subscription_id: providerSubId,
			plan_id: "pro",
		})
		const cancel = await app.request("/webhooks/mock", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-razorpay-signature": signMockWebhook(cancelBody),
				"x-razorpay-event-id": "evt_cancel_1",
			},
			body: cancelBody,
		})
		expect(cancel.status).toBe(200)
		const cancelled = await db.findSubscriptionByProviderId("mock", providerSubId)
		expect(cancelled?.status).toBe("cancelled")
	})
})

describe("razorpay & cashfree recorded webhook payloads", () => {
	test("razorpay activation + cancel with signature", async () => {
		const userId = newId("user")
		await db.ensureUser({ id: userId, email: "rzp@example.com", planId: "free" })
		const localSub = newId("sub")
		const providerSubId = "sub_RZTEST123"
		const now = new Date().toISOString()
		await db.upsertSubscription({
			id: localSub,
			user_id: userId,
			plan_id: "pro",
			provider: "razorpay",
			provider_subscription_id: providerSubId,
			provider_plan_id: "plan_RZ",
			status: "created",
			current_period_end: null,
			grace_until: null,
			cancel_at_period_end: 0,
			cancelled_at: null,
			created_at: now,
			updated_at: now,
		})

		const secret = "rzp_integration_secret"
		config.razorpay.webhookSecret = secret

		const activated = JSON.stringify({
			event: "subscription.activated",
			payload: {
				subscription: {
					entity: {
						id: providerSubId,
						notes: { lumen_plan_id: "pro" },
						current_end: Math.floor(Date.now() / 1000) + 30 * 86400,
					},
				},
				payment: { entity: { id: "pay_RZ1" } },
			},
		})
		const actSig = createHmac("sha256", secret).update(activated).digest("hex")
		const actRes = await app.request("/webhooks/razorpay", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-razorpay-signature": actSig,
				"x-razorpay-event-id": "rzp_evt_act_1",
			},
			body: activated,
		})
		expect(actRes.status).toBe(200)
		expect((await db.findUserById(userId))?.plan_id).toBe("pro")

		const cancelled = JSON.stringify({
			event: "subscription.cancelled",
			payload: {
				subscription: {
					entity: {
						id: providerSubId,
						notes: { lumen_plan_id: "pro" },
					},
				},
			},
		})
		const cancelSig = createHmac("sha256", secret).update(cancelled).digest("hex")
		const cancelRes = await app.request("/webhooks/razorpay", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-razorpay-signature": cancelSig,
				"x-razorpay-event-id": "rzp_evt_cancel_1",
			},
			body: cancelled,
		})
		expect(cancelRes.status).toBe(200)
		expect((await db.findSubscriptionByProviderId("razorpay", providerSubId))?.status).toBe(
			"cancelled",
		)

		// Bad signature rejected
		const bad = await app.request("/webhooks/razorpay", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-razorpay-signature": "00",
				"x-razorpay-event-id": "rzp_evt_bad",
			},
			body: activated,
		})
		expect(bad.status).toBe(400)
	})

	test("cashfree renewal + failure + expiry", async () => {
		const userId = newId("user")
		await db.ensureUser({ id: userId, email: "cf@example.com", planId: "free" })
		const localSub = newId("sub")
		const providerSubId = "sub_CFTEST456"
		const now = new Date().toISOString()
		await db.upsertSubscription({
			id: localSub,
			user_id: userId,
			plan_id: "pro_plus",
			provider: "cashfree",
			provider_subscription_id: providerSubId,
			provider_plan_id: "lumen_pro_plus",
			status: "created",
			current_period_end: null,
			grace_until: null,
			cancel_at_period_end: 0,
			cancelled_at: null,
			created_at: now,
			updated_at: now,
		})

		const secret = "cf-webhook-secret"
		config.cashfree.webhookSecret = secret

		async function postCf(eventId: string, bodyObj: unknown) {
			const rawBody = JSON.stringify(bodyObj)
			const timestamp = String(Math.floor(Date.now() / 1000))
			const signature = createHmac("sha256", secret)
				.update(timestamp + rawBody)
				.digest("base64")
			return app.request("/webhooks/cashfree", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-webhook-signature": signature,
					"x-webhook-timestamp": timestamp,
					"x-webhook-event-id": eventId,
				},
				body: rawBody,
			})
		}

		const act = await postCf("cf_act_1", {
			type: "SUBSCRIPTION_STATUS_CHANGED",
			data: {
				subscription_id: providerSubId,
				subscription_tags: { lumen_plan_id: "pro_plus" },
			},
		})
		expect(act.status).toBe(200)
		expect((await db.findUserById(userId))?.plan_id).toBe("pro_plus")

		const renew = await postCf("cf_renew_1", {
			type: "SUBSCRIPTION_PAYMENT_SUCCESS",
			data: {
				subscription_id: providerSubId,
				cf_payment_id: "pay_cf_1",
				subscription_tags: { lumen_plan_id: "pro_plus" },
			},
		})
		expect(renew.status).toBe(200)
		expect((await db.listInvoicesForUser(userId)).length).toBeGreaterThanOrEqual(1)

		const fail = await postCf("cf_fail_1", {
			type: "SUBSCRIPTION_PAYMENT_FAILED",
			data: { subscription_id: providerSubId },
		})
		expect(fail.status).toBe(200)
		expect((await db.findSubscriptionByProviderId("cashfree", providerSubId))?.status).toBe(
			"past_due",
		)

		const expired = await postCf("cf_exp_1", {
			type: "SUBSCRIPTION_EXPIRED",
			data: { subscription_id: providerSubId },
		})
		expect(expired.status).toBe(200)
		expect((await db.findUserById(userId))?.plan_id).toBe("free")
		expect((await db.findSubscriptionByProviderId("cashfree", providerSubId))?.status).toBe(
			"expired",
		)
	})
})

describe("billing pages", () => {
	test("plans page lists INR prices", async () => {
		const res = await app.request("/billing/plans")
		expect(res.status).toBe(200)
		const html = await res.text()
		expect(html).toContain("Pro")
		expect(html).toContain("2,000")
		expect(html).toContain("3,000")
	})

	test("admin CLI still creates keys", async () => {
		await db.ensureUser({ id: "admin_user", email: "admin@example.com" })
		const { generatePlanKey, hashPlanKey } = await import("../../src/auth/keys")
		const gen = generatePlanKey()
		const row = await db.createPlanKey({
			id: newId("key"),
			userId: "admin_user",
			planId: "pro_plus",
			keyHash: hashPlanKey(gen.rawKey, config.keyPepper),
			keyPrefix: gen.prefix,
			label: "cli",
		})
		expect(row.plan_id).toBe("pro_plus")
		const listed = await db.listPlanKeys(false)
		expect(listed.some((k) => k.id === row.id)).toBe(true)
	})
})
