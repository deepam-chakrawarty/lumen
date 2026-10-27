/**
 * Cashfree Subscriptions adapter.
 *
 * Verified against live docs (2026-10-27):
 * - API version header: x-api-version: 2026-01-01 (latest v6)
 * - Sandbox: https://sandbox.cashfree.com/pg
 * - Production: https://api.cashfree.com/pg
 * - Create Plan: POST /pg/plans
 * - Create Subscription: POST /pg/subscriptions (returns auth/checkout URL)
 * - Payment Links: POST /pg/links (one-time; subscriptions use Create Subscription)
 * - Webhook: Base64(HMAC-SHA256(timestamp + rawBody, secret)) vs x-webhook-signature
 * - UPI Autopay: supported payment method on subscriptions
 * - Official Node SDK: `cashfree-pg` ^5.1.0 — we call REST directly for Bun + testability
 *
 * Docs:
 * https://www.cashfree.com/docs/api-reference/payments/latest/subscription/overview
 * https://www.cashfree.com/docs/api-reference/payments/latest/subscription/create-a-plan
 * https://www.cashfree.com/docs/api-reference/payments/latest/subscription/create-subscription
 * https://www.cashfree.com/docs/payments/subscription/webhook-signature
 */

import type { AppConfig } from "../../config"
import { log } from "../../logger"
import { verifyCashfreeWebhookSignature } from "./signatures"
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

export class CashfreeProvider implements PaymentProvider {
	readonly id = "cashfree" as const
	private planCache = new Map<string, string>()

	constructor(private config: AppConfig) {}

	private baseUrl(): string {
		return this.config.cashfree.env === "production"
			? "https://api.cashfree.com/pg"
			: "https://sandbox.cashfree.com/pg"
	}

	private headers(): Record<string, string> {
		const { clientId, clientSecret, apiVersion } = this.config.cashfree
		if (!clientId || !clientSecret) {
			throw new Error("CASHFREE_CLIENT_ID and CASHFREE_CLIENT_SECRET are required")
		}
		return {
			"Content-Type": "application/json",
			"x-client-id": clientId,
			"x-client-secret": clientSecret,
			"x-api-version": apiVersion || "2026-01-01",
		}
	}

	private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
		const res = await fetch(`${this.baseUrl()}${path}`, {
			method,
			headers: this.headers(),
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
			log.error("cashfree api error", { status: res.status, path, error: json })
			throw new Error(`Cashfree API ${method} ${path} failed: ${res.status}`)
		}
		return json as T
	}

	async ensurePlan(input: CreateProviderPlanInput): Promise<ProviderPlan> {
		const cached = this.planCache.get(input.localPlanId)
		if (cached) {
			return { providerPlanId: cached, localPlanId: input.localPlanId, amountPaise: input.amountPaise }
		}

		// Cashfree plan amounts are in currency major units (rupees), not paise.
		const amountRupees = Number((input.amountPaise / 100).toFixed(2))
		const planId = `lumen_${input.localPlanId}`.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40)

		try {
			const created = await this.api<{ plan_id: string }>("POST", "/plans", {
				plan_id: planId,
				plan_name: input.name.slice(0, 40),
				plan_type: "PERIODIC",
				plan_currency: input.currency || "INR",
				plan_recurring_amount: amountRupees,
				plan_max_amount: amountRupees,
				plan_max_cycles: 120,
				plan_intervals: 1,
				plan_interval_type: input.interval === "yearly" ? "YEAR" : "MONTH",
				plan_note: input.description.slice(0, 100),
			})
			this.planCache.set(input.localPlanId, created.plan_id || planId)
			return {
				providerPlanId: created.plan_id || planId,
				localPlanId: input.localPlanId,
				amountPaise: input.amountPaise,
				raw: created,
			}
		} catch {
			// Plan may already exist in the merchant account — reuse deterministic id.
			this.planCache.set(input.localPlanId, planId)
			return {
				providerPlanId: planId,
				localPlanId: input.localPlanId,
				amountPaise: input.amountPaise,
			}
		}
	}

	async createSubscriptionCheckout(input: CreateSubscriptionInput): Promise<ProviderCheckout> {
		const amountRupees = Number((input.amountPaise / 100).toFixed(2))
		const paymentMethods = input.enableUpi === false ? ["card", "enach"] : ["upi", "card", "enach"]

		const created = await this.api<{
			subscription_id: string
			subscription_session_id?: string
			auth_link?: string
			subscription_payment_id?: string
		}>("POST", "/subscriptions", {
			subscription_id: input.localSubscriptionId.slice(0, 50),
			customer_details: {
				customer_name: input.customer.name || input.customer.email.split("@")[0],
				customer_email: input.customer.email,
				customer_phone: input.customer.phone || "9999999999",
			},
			plan_details: {
				plan_id: input.providerPlanId,
			},
			authorization_details: {
				authorization_amount: amountRupees,
				authorization_amount_refund: false,
				payment_methods: paymentMethods,
			},
			subscription_meta: {
				return_url: input.returnUrl,
				notification_channel: ["EMAIL"],
			},
			subscription_tags: {
				lumen_user_id: input.customer.userId,
				lumen_plan_id: input.localPlanId,
				lumen_subscription_id: input.localSubscriptionId,
			},
		})

		const checkoutUrl =
			created.auth_link ||
			(created.subscription_session_id
				? `${this.baseUrl()}/subscriptions/checkout?session_id=${created.subscription_session_id}`
				: `${this.config.publicBaseUrl}/billing/account?pending=${created.subscription_id}`)

		return {
			providerSubscriptionId: created.subscription_id,
			checkoutUrl,
			providerPlanId: input.providerPlanId,
			raw: created,
		}
	}

	async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
		await this.api("PATCH", `/subscriptions/${input.providerSubscriptionId}`, {
			subscription_id: input.providerSubscriptionId,
			action: "CANCEL",
		})
	}

	verifyWebhookSignature(args: {
		rawBody: string
		signature: string | null
		timestamp?: string | null
		headers: Headers
	}): boolean {
		const sig = args.signature || args.headers.get("x-webhook-signature")
		const ts = args.timestamp || args.headers.get("x-webhook-timestamp")
		if (!sig || !ts) return false
		return verifyCashfreeWebhookSignature(
			args.rawBody,
			sig,
			ts,
			this.config.cashfree.webhookSecret,
		)
	}

	parseWebhookEvent(args: {
		rawBody: string
		headers: Headers
		eventIdHeader?: string | null
	}): NormalizedBillingEvent {
		const payload = JSON.parse(args.rawBody) as {
			type?: string
			event_type?: string
			data?: any
			event_time?: string
		}
		const rawType = payload.type || payload.event_type || "unknown"
		const data = payload.data || {}
		const subId =
			data.subscription_id ||
			data.subscription?.subscription_id ||
			data.subscription_details?.subscription_id
		const paymentId = data.cf_payment_id || data.payment_id || data.subscription_payment_id
		const eventId =
			args.eventIdHeader ||
			args.headers.get("x-webhook-event-id") ||
			`${rawType}:${subId || "na"}:${paymentId || payload.event_time || "0"}`

		return {
			provider: "cashfree",
			eventId,
			type: mapCashfreeEvent(rawType),
			providerSubscriptionId: subId,
			providerPaymentId: paymentId ? String(paymentId) : undefined,
			localPlanId:
				data.subscription_tags?.lumen_plan_id ||
				data.subscription?.subscription_tags?.lumen_plan_id,
			rawType,
			payload,
		}
	}
}

function mapCashfreeEvent(rawType: string): NormalizedBillingEventType {
	const upper = rawType.toUpperCase()
	if (upper.includes("SUBSCRIPTION_STATUS_CHANGED") || upper.includes("SUBSCRIPTION_AUTH_STATUS")) {
		return "subscription.activated"
	}
	if (upper.includes("SUCCESS") && upper.includes("PAYMENT")) return "subscription.renewed"
	if (upper.includes("PAYMENT_FAILED") || upper.includes("FAILED")) return "subscription.payment_failed"
	if (upper.includes("CANCEL")) return "subscription.cancelled"
	if (upper.includes("EXPIRED") || upper.includes("COMPLETED")) return "subscription.expired"
	if (upper.includes("ACTIVE") || upper.includes("ACTIVATED")) return "subscription.activated"
	if (upper.includes("CHARGED") || upper.includes("PAYMENT_SUCCESS")) return "subscription.renewed"
	return "unknown"
}
