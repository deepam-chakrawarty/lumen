import { Hono } from "hono"
import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { monthStartIso } from "../db/client"
import { requirePlanKey } from "../middleware/auth"
import { getQuotaSnapshot } from "../metering/quotas"

export function usageRoutes(config: AppConfig, db: AsyncDb) {
	const app = new Hono()
	app.use("*", requirePlanKey(config, db))

	app.get("/usage", async (c) => {
		const auth = c.get("auth")
		const snapshot = await getQuotaSnapshot(db, config, auth.userId, auth.planId)
		const events = await db.listUsageForKey(auth.planKeyId, snapshot.periodStart, 50)

		return c.json({
			object: "lumen.usage",
			plan: {
				id: snapshot.planId,
				name: snapshot.plan.name,
				monthly_token_limit: snapshot.limitTokens,
				requests_per_minute: snapshot.plan.requestsPerMinute,
				allowed_tiers: snapshot.plan.allowedTiers,
			},
			period_start: snapshot.periodStart,
			tokens: {
				used: snapshot.usedTokens,
				remaining: snapshot.remainingTokens,
				limit: snapshot.limitTokens,
			},
			key_prefix: auth.keyPrefix,
			recent: events.map((e) => ({
				id: e.id,
				logical_model: e.logical_model,
				upstream_provider: e.upstream_provider,
				upstream_model: e.upstream_model,
				prompt_tokens: e.prompt_tokens,
				completion_tokens: e.completion_tokens,
				total_tokens: e.total_tokens,
				streamed: Boolean(e.streamed),
				status: e.status,
				created_at: e.created_at,
			})),
		})
	})

	return app
}

export { monthStartIso }
