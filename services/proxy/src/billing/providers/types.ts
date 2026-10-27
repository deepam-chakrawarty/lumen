/**
 * Common payment-provider interface for Razorpay + Cashfree subscriptions.
 * Amounts are always in paise (INR).
 */

export type ProviderId = "razorpay" | "cashfree" | "mock"

export type CreateProviderPlanInput = {
	/** Local plan id, e.g. pro / pro_plus */
	localPlanId: string
	name: string
	description: string
	/** Gross charge amount in paise (what the customer pays). */
	amountPaise: number
	currency?: string
	interval: "monthly" | "yearly"
}

export type ProviderPlan = {
	providerPlanId: string
	localPlanId: string
	amountPaise: number
	raw?: unknown
}

export type CreateSubscriptionInput = {
	localSubscriptionId: string
	localPlanId: string
	providerPlanId: string
	customer: {
		userId: string
		email: string
		name?: string
		phone?: string
	}
	/** Total billing cycles (Razorpay total_count). */
	totalCount: number
	amountPaise: number
	currency?: string
	returnUrl: string
	/** Enable UPI / UPI Autopay where the provider supports it. */
	enableUpi?: boolean
	notes?: Record<string, string>
}

export type ProviderCheckout = {
	providerSubscriptionId: string
	/** Hosted checkout / auth / payment link URL. */
	checkoutUrl: string
	providerPlanId: string
	raw?: unknown
}

export type CancelSubscriptionInput = {
	providerSubscriptionId: string
	cancelAtCycleEnd?: boolean
}

export type NormalizedBillingEventType =
	| "subscription.activated"
	| "subscription.renewed"
	| "subscription.payment_failed"
	| "subscription.cancelled"
	| "subscription.expired"
	| "subscription.halted"
	| "payment.captured"
	| "unknown"

export type NormalizedBillingEvent = {
	provider: ProviderId
	/** Idempotency key (provider event id). */
	eventId: string
	type: NormalizedBillingEventType
	providerSubscriptionId?: string
	providerPaymentId?: string
	localPlanId?: string
	/** Period end if known. */
	currentPeriodEnd?: string
	rawType: string
	payload: unknown
}

export interface PaymentProvider {
	readonly id: ProviderId
	/** Ensure a remote plan exists for this local paid plan; return provider plan id. */
	ensurePlan(input: CreateProviderPlanInput): Promise<ProviderPlan>
	/** Create a subscription + return checkout/auth link (UPI-capable). */
	createSubscriptionCheckout(input: CreateSubscriptionInput): Promise<ProviderCheckout>
	cancelSubscription(input: CancelSubscriptionInput): Promise<void>
	/** Verify webhook signature; throw or return false on failure. */
	verifyWebhookSignature(args: {
		rawBody: string
		signature: string | null
		timestamp?: string | null
		headers: Headers
	}): boolean
	/** Parse provider webhook into a normalized event. */
	parseWebhookEvent(args: {
		rawBody: string
		headers: Headers
		eventIdHeader?: string | null
	}): NormalizedBillingEvent
}
