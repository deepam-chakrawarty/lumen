import { Hono } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { createMailer } from "../billing/mailer"
import { createPaymentProvider } from "../billing/providers"
import {
	cancelUserSubscription,
	enforceGraceDowngrades,
	startCheckout,
} from "../billing/lifecycle"
import { listPublicPlans } from "../billing/plans"
import {
	renderAccountPage,
	renderPlansPage,
	renderSignupPage,
	renderVerifyOk,
} from "../billing/pages"
import {
	resolveSessionUser,
	rotatePlanKey,
	signupWithEmail,
	verifyEmailAndIssueKey,
} from "../billing/signup"
import { getQuotaSnapshot } from "../metering/quotas"
import { log } from "../logger"

const SESSION_COOKIE = "lumen_session"

export function billingRoutes(config: AppConfig, db: AsyncDb) {
	const app = new Hono()
	const mailer = createMailer(config)
	const provider = createPaymentProvider(config)

	app.get("/", (c) => c.redirect("/billing/plans"))

	app.get("/plans", (c) => {
		const html = renderPlansPage(listPublicPlans(config.plans))
		return c.html(html)
	})

	app.get("/signup", (c) => c.html(renderSignupPage()))

	app.post("/signup", async (c) => {
		const body = await c.req.parseBody()
		const email = String(body.email || "").trim()
		const displayName = String(body.name || "").trim() || undefined
		const phone = String(body.phone || "").trim() || undefined
		try {
			const result = await signupWithEmail({ db, config, mailer, email, displayName, phone })
			const ok =
				config.mailer === "console" && result.devVerificationToken
					? `Verification link console pe print hua. Dev token: ${result.devVerificationToken}`
					: "Check your email for the verification link. Jaldi verify kar lo."
			return c.html(renderSignupPage({ ok }))
		} catch (err) {
			return c.html(renderSignupPage({ error: err instanceof Error ? err.message : "Signup failed" }), 400)
		}
	})

	app.get("/verify", async (c) => {
		const token = c.req.query("token")
		if (!token) return c.html(renderSignupPage({ error: "Missing token" }), 400)
		try {
			const result = await verifyEmailAndIssueKey({ db, config, token })
			setCookie(c, SESSION_COOKIE, result.sessionToken, {
				httpOnly: true,
				sameSite: "Lax",
				path: "/",
				maxAge: 30 * 24 * 60 * 60,
			})
			return c.html(
				renderVerifyOk({ planId: result.planId, planKey: result.planKey, edu: result.edu }),
			)
		} catch (err) {
			return c.html(
				renderSignupPage({ error: err instanceof Error ? err.message : "Verification failed" }),
				400,
			)
		}
	})

	app.get("/account", async (c) => {
		const user = await resolveSessionUser({
			db,
			config,
			sessionToken: getCookie(c, SESSION_COOKIE),
		})
		if (!user) return c.redirect("/billing/signup")

		await enforceGraceDowngrades({ db, config, userId: user.id })
		const refreshed = (await db.findUserById(user.id)) || user
		const planId = refreshed.plan_id || config.plans.defaultPlan
		const plan = config.plans.plans[planId]
		const quota = await getQuotaSnapshot(db, config, refreshed.id, planId)
		const sub = await db.findActiveSubscriptionForUser(refreshed.id)
		const keys = await db.listPlanKeysForUser(refreshed.id, false)
		const invoices = await db.listInvoicesForUser(refreshed.id, 20)

		const upgraded = c.req.query("upgraded")
		const html = renderAccountPage({
			email: refreshed.email || "",
			planId,
			planName: plan?.name || planId,
			subscriptionStatus: sub?.status,
			graceUntil: sub?.grace_until,
			usedTokens: quota.usedTokens,
			limitTokens: quota.limitTokens,
			keys: keys.map((k) => ({ prefix: k.key_prefix, label: k.label, created_at: k.created_at })),
			invoices,
			plans: listPublicPlans(config.plans),
			paymentProvider: provider.id,
			message: upgraded ? "Checkout complete — webhook activate karega plan ko." : undefined,
		})
		return c.html(html)
	})

	app.post("/upgrade", async (c) => {
		const user = await resolveSessionUser({
			db,
			config,
			sessionToken: getCookie(c, SESSION_COOKIE),
		})
		if (!user?.email) return c.redirect("/billing/signup")

		const body = await c.req.parseBody()
		const planId = String(body.plan || "")
		try {
			const checkout = await startCheckout({
				db,
				config,
				provider,
				userId: user.id,
				planId,
				email: user.email,
				name: user.display_name || undefined,
				phone: user.phone || undefined,
			})
			return c.redirect(checkout.checkoutUrl)
		} catch (err) {
			log.error("upgrade failed", { error: err instanceof Error ? err.message : String(err) })
			const plan = config.plans.plans[user.plan_id || config.plans.defaultPlan]
			const quota = await getQuotaSnapshot(
				db,
				config,
				user.id,
				user.plan_id || config.plans.defaultPlan,
			)
			return c.html(
				renderAccountPage({
					email: user.email,
					planId: user.plan_id || config.plans.defaultPlan,
					planName: plan?.name || "Free",
					usedTokens: quota.usedTokens,
					limitTokens: quota.limitTokens,
					keys: [],
					invoices: [],
					plans: listPublicPlans(config.plans),
					paymentProvider: provider.id,
					message: err instanceof Error ? err.message : "Upgrade failed",
				}),
				400,
			)
		}
	})

	app.post("/cancel", async (c) => {
		const user = await resolveSessionUser({
			db,
			config,
			sessionToken: getCookie(c, SESSION_COOKIE),
		})
		if (!user) return c.redirect("/billing/signup")
		await cancelUserSubscription({ db, config, provider, userId: user.id })
		return c.redirect("/billing/account")
	})

	app.post("/rotate-key", async (c) => {
		const user = await resolveSessionUser({
			db,
			config,
			sessionToken: getCookie(c, SESSION_COOKIE),
		})
		if (!user) return c.redirect("/billing/signup")
		const rotated = await rotatePlanKey({ db, config, userId: user.id })
		const planId = rotated.planId
		const plan = config.plans.plans[planId]
		const quota = await getQuotaSnapshot(db, config, user.id, planId)
		const keys = await db.listPlanKeysForUser(user.id, false)
		const invoices = await db.listInvoicesForUser(user.id, 20)
		const sub = await db.findActiveSubscriptionForUser(user.id)
		return c.html(
			renderAccountPage({
				email: user.email || "",
				planId,
				planName: plan?.name || planId,
				subscriptionStatus: sub?.status,
				graceUntil: sub?.grace_until,
				usedTokens: quota.usedTokens,
				limitTokens: quota.limitTokens,
				keys: keys.map((k) => ({ prefix: k.key_prefix, label: k.label, created_at: k.created_at })),
				invoices,
				plans: listPublicPlans(config.plans),
				paymentProvider: provider.id,
				issuedPlanKey: rotated.planKey,
				message: "Purana key revoke ho gaya. Naya key neeche hai.",
			}),
		)
	})

	app.get("/logout", async (c) => {
		deleteCookie(c, SESSION_COOKIE, { path: "/" })
		return c.redirect("/billing/signup")
	})

	// Mock checkout page — completes activation via local webhook-shaped apply in test/mock mode
	app.get("/mock-checkout", async (c) => {
		if (provider.id !== "mock" && !config.paymentTestMode) {
			return c.text("Mock checkout disabled", 404)
		}
		const sub = c.req.query("sub")
		const plan = c.req.query("plan")
		if (!sub || !plan) return c.text("Missing sub/plan", 400)
		return c.html(
			layoutSimple(
				"Mock checkout",
				`<h1>Mock UPI checkout</h1>
         <p class="muted">Test mode — simulate payment success.</p>
         <form method="post" action="/billing/mock-checkout">
           <input type="hidden" name="sub" value="${sub}" />
           <input type="hidden" name="plan" value="${plan}" />
           <button type="submit">Pay with UPI (mock)</button>
         </form>`,
			),
		)
	})

	app.post("/mock-checkout", async (c) => {
		const { applyBillingEvent } = await import("../billing/lifecycle")
		const body = await c.req.parseBody()
		const sub = String(body.sub || "")
		const plan = String(body.plan || "")
		await applyBillingEvent({
			db,
			config,
			event: {
				provider: "mock",
				eventId: `mock-checkout:${sub}:${Date.now()}`,
				type: "subscription.activated",
				providerSubscriptionId: sub,
				providerPaymentId: `pay_mock_${Date.now()}`,
				localPlanId: plan,
				currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
				rawType: "subscription.activated",
				payload: { mock: true, sub, plan },
			},
		})
		return c.redirect("/billing/account?upgraded=1")
	})

	return app
}

function layoutSimple(title: string, body: string): string {
	return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title}</title>
  <style>body{font-family:system-ui;max-width:520px;margin:2rem auto;padding:0 1rem}button{background:#0f766e;color:white;border:0;padding:.6rem 1rem;border-radius:8px}</style>
  </head><body>${body}</body></html>`
}
