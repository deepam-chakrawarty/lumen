/**
 * Razorpay Subscriptions adapter.
 *
 * Verified against live docs (2026-10-27):
 * - Create Plan: POST https://api.razorpay.com/v1/plans
 * - Create Subscription (+ link): POST https://api.razorpay.com/v1/subscriptions
 * - Webhook signature: HMAC-SHA256 hex of raw body with webhook secret (X-Razorpay-Signature)
 * - UPI Autopay: supported on Subscriptions (cards, UPI AutoPay, emandate)
 * - Official Node SDK: `razorpay` (npm) — we call REST directly for Bun + testability
 *
 * Docs:
 * https://razorpay.com/docs/api/payments/subscriptions/create-plan
 * https://razorpay.com/docs/api/payments/subscriptions/create-subscription
 * https://razorpay.com/docs/api/payments/subscriptions/create-subscription-link
 * https://razorpay.com/docs/webhooks/validate-test
 * https://razorpay.com/docs/payments/subscriptions
 */

import type { AppConfig } from "../../config"
import { log } from "../../logger"
import { verifyRazorpayWebhookSignature } from "./signatures"
import type {
	CancelSubscriptionInput,
	CreateProviderPlanInput,
	CreateSubscriptionInput,
	NormalizedBillingEvent,
	NormalizedBillingEventType,
	PaymentProvider,
	ProviderCheckout,
	ProviderPlan,
} from "./types"

const API_BASE = "https://api.razorpay.com/v1"

export class RazorpayProvider implements PaymentProvider {
	readonly id = "razorpay" as const
	private planCache = new Map<string, string>()

	constructor(private config: AppConfig) {}

	private authHeader(): string {
		const { keyId, keySecret } = this.config.razorpay
		if (!keyId || !keySecret) {
			throw new Error("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required")
		}
		return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`
	}

	private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await fetch(`${API_BASE}${path}`, {
			method,
			headers: {
				Authorization: this.authHeader(),
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		const text = await res.text()
		let json: any = null
		try {
			json = text ? JSON.parse(text) : null
		} catch {
			json = { raw: text }
		}
		if (!res.ok) {
			log.error("razorpay api error", { status: res.status, path, error: json?.error || json })
			throw new Error(`Razorpay API ${method} ${path} failed: ${res.status}`)
		}
		return json as T
	}

	async ensurePlan(input: CreateProviderPlanInput): Promise<ProviderPlan> {
		const cached = this.planCache.get(input.localPlanId)
		if (cached) {
			return { providerPlanId: cached, localPlanId: input.localPlanId, amountPaise: input.amountPaise }
		}

		const period = input.interval === "yearly" ? "yearly" : "monthly"
		const created = await this.api<{ id: string }>("POST", "/plans", {
			period,
			interval: 1,
			item: {
				name: input.name,
				amount: input.amountPaise,
				currency: input.currency || "INR",
				description: input.description,
			},
			notes: {
				lumen_plan_id: input.localPlanId,
			},
		})

		this.planCache.set(input.localPlanId, created.id)
		return {
			providerPlanId: created.id,
			localPlanId: input.localPlanId,
			amountPaise: input.amountPaise,
			raw: created,
		}
	}

	async createSubscriptionCheckout(input: CreateSubscriptionInput): Promise<ProviderCheckout> {
		// Subscription + notify_info yields a hosted checkout / short_url (subscription link flow).
		const body: Record<string, unknown> = {
			plan_id: input.providerPlanId,
			total_count: input.totalCount,
			quantity: 1,
			customer_notify: 1,
			notes: {
				lumen_user_id: input.customer.userId,
				lumen_plan_id: input.localPlanId,
				lumen_subscription_id: input.localSubscriptionId,
				...(input.notes || {}),
			},
			notify_info: {
				notify_email: input.customer.email,
				...(input.customer.phone ? { notify_phone: input.customer.phone } : {}),
			},
		}

		const created = await this.api<{
			id: string
			short_url?: string
			plan_id: string
		}>("POST", "/subscriptions", body)

		const checkoutUrl =
			created.short_url ||
			`https://checkout.razorpay.com/v1/checkout.js?subscription_id=${created.id}`

		return {
			providerSubscriptionId: created.id,
			checkoutUrl,
			providerPlanId: created.plan_id || input.providerPlanId,
			raw: created,
		}
	}

	async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
		await this.api("POST", `/subscriptions/${input.providerSubscriptionId}/cancel`, {
			cancel_at_cycle_end: input.cancelAtCycleEnd !== false,
		})
	}

	verifyWebhookSignature(args: {
		rawBody: string
		signature: string | null
		timestamp?: string | null
		headers: Headers
	}): boolean {
		const sig = args.signature || args.headers.get("x-razorpay-signature")
		if (!sig) return false
		return verifyRazorpayWebhookSignature(args.rawBody, sig, this.config.razorpay.webhookSecret)
	}

	parseWebhookEvent(args: {
		rawBody: string
		headers: Headers
		eventIdHeader?: string | null
	}): NormalizedBillingEvent {
		const payload = JSON.parse(args.rawBody) as {
			event?: string
			payload?: any
			contains?: string[]
		}
		const rawType = payload.event || "unknown"
		const eventId =
			args.eventIdHeader ||
			args.headers.get("x-razorpay-event-id") ||
			`${rawType}:${payload.payload?.subscription?.entity?.id || payload.payload?.payment?.entity?.id || "na"}:${payload.payload?.payment?.entity?.id || "0"}`

		const sub = payload.payload?.subscription?.entity
		const payment = payload.payload?.payment?.entity
		const type = mapRazorpayEvent(rawType)

		return {
			provider: "razorpay",
			eventId,
			type,
			providerSubscriptionId: sub?.id,
			providerPaymentId: payment?.id,
			localPlanId: sub?.notes?.lumen_plan_id,
			currentPeriodEnd: sub?.current_end
				? new Date(sub.current_end * 1000).toISOString()
				: undefined,
			rawType,
			payload,
		}
	}
}

function mapRazorpayEvent(rawType: string): NormalizedBillingEventType {
	switch (rawType) {
		case "subscription.activated":
		case "subscription.authenticated":
		case "subscription.charged":
			return rawType === "subscription.charged" ? "subscription.renewed" : "subscription.activated"
		case "subscription.pending":
		case "subscription.halted":
			return "subscription.halted"
		case "subscription.cancelled":
			return "subscription.cancelled"
		case "subscription.completed":
			return "subscription.expired"
		case "subscription.updated":
			return "unknown"
		case "payment.captured":
			return "payment.captured"
		case "payment.failed":
		case "subscription.payment_failed":
			return "subscription.payment_failed"
		default:
			if (rawType.includes("payment_failed") || rawType.includes("failed")) {
				return "subscription.payment_failed"
			}
			if (rawType.includes("cancel")) return "subscription.cancelled"
			if (rawType.includes("charg")) return "subscription.renewed"
			if (rawType.includes("activ")) return "subscription.activated"
			return "unknown"
	}
}
