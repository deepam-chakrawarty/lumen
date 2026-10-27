import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { newId } from "../auth/keys"
import type { SubscriptionRow } from "../db/schema"
import { log } from "../logger"
import { breakdownGst } from "./gst"
import {
	downgradePlanId,
	getPaidPlanOrThrow,
	graceUntilIso,
	isGraceExpired,
	toPublicPlan,
} from "./plans"
import type { PaymentProvider } from "./providers"
import type { NormalizedBillingEvent } from "./providers/types"

export async function startCheckout(opts: {
	db: AsyncDb
	config: AppConfig
	provider: PaymentProvider
	userId: string
	planId: string
	email: string
	name?: string
	phone?: string
}): Promise<{ subscriptionId: string; checkoutUrl: string; provider: string }> {
	const plan = getPaidPlanOrThrow(opts.config, opts.planId)
	const publicPlan = toPublicPlan(opts.planId, plan, opts.config.plans.billing)

	const providerPlan = await opts.provider.ensurePlan({
		localPlanId: opts.planId,
		name: plan.name,
		description: plan.description,
		amountPaise: publicPlan.chargePaise,
		currency: plan.currency || "INR",
		interval: opts.config.plans.billing.interval,
	})

	const localSubscriptionId = newId("sub")
	const now = new Date().toISOString()
	await opts.db.upsertSubscription({
		id: localSubscriptionId,
		user_id: opts.userId,
		plan_id: opts.planId,
		provider: opts.provider.id,
		provider_subscription_id: null,
		provider_plan_id: providerPlan.providerPlanId,
		status: "created",
		current_period_end: null,
		grace_until: null,
		cancel_at_period_end: 0,
		cancelled_at: null,
		created_at: now,
		updated_at: now,
	})

	const checkout = await opts.provider.createSubscriptionCheckout({
		localSubscriptionId,
		localPlanId: opts.planId,
		providerPlanId: providerPlan.providerPlanId,
		customer: {
			userId: opts.userId,
			email: opts.email,
			name: opts.name,
			phone: opts.phone,
		},
		totalCount: opts.config.plans.billing.subscriptionTotalCount,
		amountPaise: publicPlan.chargePaise,
		currency: plan.currency || "INR",
		returnUrl: `${opts.config.publicBaseUrl}/billing/account?upgraded=1`,
		enableUpi: true,
	})

	await opts.db.upsertSubscription({
		id: localSubscriptionId,
		user_id: opts.userId,
		plan_id: opts.planId,
		provider: opts.provider.id,
		provider_subscription_id: checkout.providerSubscriptionId,
		provider_plan_id: checkout.providerPlanId,
		status: "created",
		current_period_end: null,
		grace_until: null,
		cancel_at_period_end: 0,
		cancelled_at: null,
		created_at: now,
		updated_at: new Date().toISOString(),
	})

	return {
		subscriptionId: localSubscriptionId,
		checkoutUrl: checkout.checkoutUrl,
		provider: opts.provider.id,
	}
}

export async function cancelUserSubscription(opts: {
	db: AsyncDb
	config: AppConfig
	provider: PaymentProvider
	userId: string
}): Promise<SubscriptionRow | null> {
	const sub = await opts.db.findActiveSubscriptionForUser(opts.userId)
	if (!sub || !sub.provider_subscription_id) return sub

	await opts.provider.cancelSubscription({
		providerSubscriptionId: sub.provider_subscription_id,
		cancelAtCycleEnd: true,
	})

	const now = new Date().toISOString()
	const updated: SubscriptionRow = {
		...sub,
		cancel_at_period_end: 1,
		status: sub.status === "active" ? "active" : "cancelled",
		cancelled_at: now,
		updated_at: now,
	}
	await opts.db.upsertSubscription(updated)
	return updated
}

export async function applyBillingEvent(opts: {
	db: AsyncDb
	config: AppConfig
	event: NormalizedBillingEvent
}): Promise<{ applied: boolean; duplicate?: boolean }> {
	const inserted = await opts.db.tryInsertWebhookEvent({
		id: newId("wh"),
		provider: opts.event.provider,
		event_id: opts.event.eventId,
		event_type: opts.event.rawType,
		payload_json: JSON.stringify(opts.event.payload),
		processed_at: new Date().toISOString(),
	})
	if (!inserted) {
		return { applied: false, duplicate: true }
	}

	const sub = opts.event.providerSubscriptionId
		? await opts.db.findSubscriptionByProviderId(
				opts.event.provider,
				opts.event.providerSubscriptionId,
			)
		: null

	if (!sub) {
		log.warn("billing event without local subscription", {
			provider: opts.event.provider,
			type: opts.event.type,
			providerSubscriptionId: opts.event.providerSubscriptionId,
		})
		return { applied: true }
	}

	const now = new Date()
	const nowIso = now.toISOString()
	const billing = opts.config.plans.billing
	const planId = opts.event.localPlanId || sub.plan_id

	switch (opts.event.type) {
		case "subscription.activated":
		case "subscription.renewed":
		case "payment.captured": {
			const periodEnd =
				opts.event.currentPeriodEnd ||
				new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
			await opts.db.upsertSubscription({
				...sub,
				plan_id: planId,
				status: "active",
				current_period_end: periodEnd,
				grace_until: null,
				cancel_at_period_end: 0,
				updated_at: nowIso,
			})
			await applyPlanToUser(opts.db, sub.user_id, planId)

			const planDef = opts.config.plans.plans[planId]
			if (planDef?.paid) {
				const gst = breakdownGst({
					pricePaise: planDef.pricePaise,
					gstRatePercent: billing.gstRatePercent,
					pricesGstInclusive: billing.pricesGstInclusive,
				})
				await opts.db.insertInvoice({
					id: newId("inv"),
					user_id: sub.user_id,
					subscription_id: sub.id,
					plan_id: planId,
					provider: opts.event.provider,
					provider_payment_id: opts.event.providerPaymentId || null,
					currency: "INR",
					gross_paise: gst.grossPaise,
					net_paise: gst.netPaise,
					gst_paise: gst.gstPaise,
					gst_rate_percent: gst.gstRatePercent,
					prices_gst_inclusive: gst.pricesGstInclusive ? 1 : 0,
					status: "paid",
					created_at: nowIso,
				})
			}
			break
		}
		case "subscription.payment_failed":
		case "subscription.halted": {
			const grace = graceUntilIso(now, billing.gracePeriodDays)
			await opts.db.upsertSubscription({
				...sub,
				status: "past_due",
				grace_until: grace,
				updated_at: nowIso,
			})
			break
		}
		case "subscription.cancelled": {
			const grace = graceUntilIso(now, billing.gracePeriodDays)
			await opts.db.upsertSubscription({
				...sub,
				status: "cancelled",
				cancel_at_period_end: 1,
				cancelled_at: nowIso,
				grace_until: grace,
				updated_at: nowIso,
			})
			if (isGraceExpired(grace, now)) {
				await downgradeUser(opts.db, opts.config, sub.user_id)
			}
			break
		}
		case "subscription.expired": {
			await opts.db.upsertSubscription({
				...sub,
				status: "expired",
				cancelled_at: nowIso,
				grace_until: null,
				updated_at: nowIso,
			})
			await downgradeUser(opts.db, opts.config, sub.user_id)
			break
		}
		default:
			log.info("ignored billing event", { type: opts.event.type, rawType: opts.event.rawType })
	}

	return { applied: true }
}

/** Sweep past_due / cancelled subscriptions whose grace window ended. */
export async function enforceGraceDowngrades(opts: {
	db: AsyncDb
	config: AppConfig
	userId: string
}): Promise<boolean> {
	const subs = await opts.db.listSubscriptionsForUser(opts.userId)
	const now = new Date()
	for (const sub of subs) {
		if (sub.status !== "past_due" && sub.status !== "cancelled") continue
		if (!isGraceExpired(sub.grace_until, now)) continue
		await opts.db.upsertSubscription({
			...sub,
			status: sub.status === "cancelled" ? "cancelled" : "expired",
			updated_at: now.toISOString(),
		})
		await downgradeUser(opts.db, opts.config, opts.userId)
		return true
	}
	return false
}

async function applyPlanToUser(db: AsyncDb, userId: string, planId: string): Promise<void> {
	await db.setUserPlan(userId, planId)
	await db.updatePlanKeysPlan(userId, planId)
}

async function downgradeUser(db: AsyncDb, config: AppConfig, userId: string): Promise<void> {
	const free = downgradePlanId(config.plans.defaultPlan)
	await applyPlanToUser(db, userId, free)
}
