import type { AppConfig, PlanDefinition } from "../config"
import type { AsyncDb } from "../db/client"
import { monthStartIso } from "../db/client"

export type QuotaSnapshot = {
	planId: string
	plan: PlanDefinition
	usedTokens: number
	limitTokens: number
	remainingTokens: number
	periodStart: string
}

export async function getQuotaSnapshot(
	db: AsyncDb,
	config: AppConfig,
	userId: string,
	planId: string,
): Promise<QuotaSnapshot> {
	const plan = config.plans.plans[planId]
	if (!plan) {
		throw new Error(`Unknown plan: ${planId}`)
	}
	const periodStart = monthStartIso()
	const usedTokens = await db.sumUsageTokens(userId, periodStart)
	const remainingTokens = Math.max(0, plan.monthlyTokenLimit - usedTokens)
	return {
		planId,
		plan,
		usedTokens,
		limitTokens: plan.monthlyTokenLimit,
		remainingTokens,
		periodStart,
	}
}

export function assertModelAllowed(plan: PlanDefinition, tier: string): boolean {
	return plan.allowedTiers.includes(tier as PlanDefinition["allowedTiers"][number])
}

export function wouldExceedQuota(snapshot: QuotaSnapshot, estimatedPromptTokens: number): boolean {
	// Soft pre-check: block only when already over, or prompt alone exceeds remaining.
	if (snapshot.usedTokens >= snapshot.limitTokens) return true
	if (estimatedPromptTokens > 0 && estimatedPromptTokens > snapshot.remainingTokens) return true
	return false
}
