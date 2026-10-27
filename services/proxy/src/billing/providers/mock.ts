/**
 * In-process payment provider for tests and local demos (PAYMENT_PROVIDER=mock).
 * Issues deterministic checkout URLs and verifies webhooks with a shared HMAC secret.
 */

import { createHmac } from "node:crypto"
import type { AppConfig } from "../../config"
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

export class MockPaymentProvider implements PaymentProvider {
	readonly id = "mock" as const
	private plans = new Map<string, ProviderPlan>()
	cancelled = new Set<string>()

	constructor(private config: AppConfig) {}

	async ensurePlan(input: CreateProviderPlanInput): Promise<ProviderPlan> {
		const existing = this.plans.get(input.localPlanId)
		if (existing) return existing
		const plan: ProviderPlan = {
			providerPlanId: `plan_mock_${input.localPlanId}`,
			localPlanId: input.localPlanId,
			amountPaise: input.amountPaise,
		}
		this.plans.set(input.localPlanId, plan)
		return plan
	}

	async createSubscriptionCheckout(input: CreateSubscriptionInput): Promise<ProviderCheckout> {
		const providerSubscriptionId = `sub_mock_${input.localSubscriptionId}`
		return {
			providerSubscriptionId,
			checkoutUrl: `${this.config.publicBaseUrl}/billing/mock-checkout?sub=${providerSubscriptionId}&plan=${input.localPlanId}`,
			providerPlanId: input.providerPlanId,
			raw: { mock: true, enableUpi: input.enableUpi !== false },
		}
	}

	async cancelSubscription(input: CancelSubscriptionInput): Promise<void> {
		this.cancelled.add(input.providerSubscriptionId)
	}

	verifyWebhookSignature(args: {
		rawBody: string
		signature: string | null
		timestamp?: string | null
		headers: Headers
	}): boolean {
		const secret = this.config.razorpay.webhookSecret || "mock-webhook-secret"
		const sig = args.signature || args.headers.get("x-razorpay-signature")
		if (!sig) return false
		return verifyRazorpayWebhookSignature(args.rawBody, sig, secret)
	}

	parseWebhookEvent(args: {
		rawBody: string
		headers: Headers
		eventIdHeader?: string | null
	}): NormalizedBillingEvent {
		const payload = JSON.parse(args.rawBody) as {
			event: string
			event_id?: string
			subscription_id?: string
			payment_id?: string
			plan_id?: string
			current_period_end?: string
		}
		return {
			provider: "mock",
			eventId: args.eventIdHeader || payload.event_id || `mock:${payload.event}:${payload.subscription_id}`,
			type: payload.event as NormalizedBillingEventType,
			providerSubscriptionId: payload.subscription_id,
			providerPaymentId: payload.payment_id,
			localPlanId: payload.plan_id,
			currentPeriodEnd: payload.current_period_end,
			rawType: payload.event,
			payload,
		}
	}
}

export function signMockWebhook(rawBody: string, secret = "mock-webhook-secret"): string {
	return createHmac("sha256", secret).update(rawBody).digest("hex")
}
