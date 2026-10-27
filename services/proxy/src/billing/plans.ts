import type { AppConfig, PlanDefinition, PlansConfig } from "../config"
import { breakdownGst, formatInr, type GstBreakdown } from "./gst"

export type PublicPlan = {
	id: string
	name: string
	description: string
	monthlyTokenLimit: number
	requestsPerMinute: number
	allowedTiers: string[]
	paid: boolean
	eduOnly: boolean
	pricePaise: number
	/** Gross amount charged (paise), after GST mode applied. */
	chargePaise: number
	displayPrice: string
	gst: GstBreakdown
}

export function listPublicPlans(plans: PlansConfig): PublicPlan[] {
	const billing = plans.billing
	return Object.entries(plans.plans).map(([id, plan]) => toPublicPlan(id, plan, billing))
}

export function toPublicPlan(
	id: string,
	plan: PlanDefinition,
	billing: PlansConfig["billing"],
): PublicPlan {
	const gst = breakdownGst({
		pricePaise: plan.pricePaise,
		gstRatePercent: billing.gstRatePercent,
		pricesGstInclusive: billing.pricesGstInclusive,
	})
	return {
		id,
		name: plan.name,
		description: plan.description,
		monthlyTokenLimit: plan.monthlyTokenLimit,
		requestsPerMinute: plan.requestsPerMinute,
		allowedTiers: [...plan.allowedTiers],
		paid: plan.paid,
		eduOnly: Boolean(plan.eduOnly),
		pricePaise: plan.pricePaise,
		chargePaise: gst.grossPaise,
		displayPrice: plan.paid ? `${formatInr(gst.grossPaise)}/mo` : "Free",
		gst,
	}
}

export function getPaidPlanOrThrow(config: AppConfig, planId: string): PlanDefinition & { id: string } {
	const plan = config.plans.plans[planId]
	if (!plan) throw new Error(`Unknown plan '${planId}'`)
	if (!plan.paid) throw new Error(`Plan '${planId}' is not a paid plan`)
	return { ...plan, id: planId }
}

export function isPaidPlan(config: AppConfig, planId: string): boolean {
	return Boolean(config.plans.plans[planId]?.paid)
}

export function resolveEffectivePlanId(userPlanId: string | null | undefined, defaultPlan: string): string {
	return userPlanId || defaultPlan
}

/** After grace expires on failure/cancel/expiry → Free. */
export function downgradePlanId(defaultPlan = "free"): string {
	return defaultPlan
}

export function graceUntilIso(from: Date, gracePeriodDays: number): string {
	const d = new Date(from.getTime())
	d.setUTCDate(d.getUTCDate() + gracePeriodDays)
	return d.toISOString()
}

export function isGraceExpired(graceUntil: string | null | undefined, now = new Date()): boolean {
	if (!graceUntil) return true
	return new Date(graceUntil).getTime() <= now.getTime()
}
