import { Hono } from "hono"
import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { applyBillingEvent } from "../billing/lifecycle"
import { createPaymentProvider } from "../billing/providers"
import { CashfreeProvider } from "../billing/providers/cashfree"
import { RazorpayProvider } from "../billing/providers/razorpay"
import { MockPaymentProvider } from "../billing/providers/mock"
import type { PaymentProvider } from "../billing/providers/types"
import { log } from "../logger"

async function handleProviderWebhook(
	c: any,
	db: AsyncDb,
	config: AppConfig,
	provider: PaymentProvider,
	opts?: { signatureHeader?: string; timestampHeader?: string; eventIdHeader?: string },
) {
	const rawBody = await c.req.text()
	const signature =
		(opts?.signatureHeader ? c.req.header(opts.signatureHeader) : null) ||
		c.req.header("x-razorpay-signature") ||
		c.req.header("x-webhook-signature") ||
		null
	const timestamp =
		(opts?.timestampHeader ? c.req.header(opts.timestampHeader) : null) ||
		c.req.header("x-webhook-timestamp") ||
		null

	const ok = provider.verifyWebhookSignature({
		rawBody,
		signature,
		timestamp,
		headers: c.req.raw.headers,
	})
	if (!ok) {
		log.warn("webhook signature failed", { provider: provider.id })
		return c.text("invalid signature", 400)
	}

	const event = provider.parseWebhookEvent({
		rawBody,
		headers: c.req.raw.headers,
		eventIdHeader: opts?.eventIdHeader ? c.req.header(opts.eventIdHeader) : c.req.header("x-razorpay-event-id"),
	})
	const result = await applyBillingEvent({ db, config, event })
	return c.json({ ok: true, duplicate: Boolean(result.duplicate) })
}

export function webhookRoutes(config: AppConfig, db: AsyncDb) {
	const app = new Hono()

	app.post("/razorpay", (c) =>
		handleProviderWebhook(c, db, config, new RazorpayProvider(config), {
			signatureHeader: "x-razorpay-signature",
			eventIdHeader: "x-razorpay-event-id",
		}),
	)

	app.post("/cashfree", (c) =>
		handleProviderWebhook(c, db, config, new CashfreeProvider(config), {
			signatureHeader: "x-webhook-signature",
			timestampHeader: "x-webhook-timestamp",
		}),
	)

	app.post("/mock", (c) =>
		handleProviderWebhook(c, db, config, new MockPaymentProvider(config), {
			signatureHeader: "x-razorpay-signature",
			eventIdHeader: "x-razorpay-event-id",
		}),
	)

	app.post("/payments", (c) => {
		const active = createPaymentProvider(config)
		if (active.id === "cashfree") {
			return handleProviderWebhook(c, db, config, new CashfreeProvider(config), {
				signatureHeader: "x-webhook-signature",
				timestampHeader: "x-webhook-timestamp",
			})
		}
		if (active.id === "mock") {
			return handleProviderWebhook(c, db, config, new MockPaymentProvider(config), {
				signatureHeader: "x-razorpay-signature",
				eventIdHeader: "x-razorpay-event-id",
			})
		}
		return handleProviderWebhook(c, db, config, new RazorpayProvider(config), {
			signatureHeader: "x-razorpay-signature",
			eventIdHeader: "x-razorpay-event-id",
		})
	})

	return app
}
