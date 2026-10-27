import { createMiddleware } from "hono/factory"
import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { extractBearerToken, hashPlanKey } from "../auth/keys"
import { ErrorCodes, jsonError } from "../errors"
import { checkRateLimit } from "../rate-limit"
import { getQuotaSnapshot } from "../metering/quotas"

export function requirePlanKey(config: AppConfig, db: AsyncDb) {
	return createMiddleware(async (c, next) => {
		const token = extractBearerToken(c.req.header("authorization"))
		if (!token) {
			return jsonError(c, 401, "Missing Bearer plan key", {
				type: "invalid_request_error",
				code: ErrorCodes.invalidApiKey,
			})
		}

		const keyHash = hashPlanKey(token, config.keyPepper)
		const row = await db.findPlanKeyByHash(keyHash)
		if (!row) {
			return jsonError(c, 401, "Incorrect plan key provided", {
				type: "invalid_request_error",
				code: ErrorCodes.invalidApiKey,
			})
		}

		const plan = config.plans.plans[row.plan_id]
		if (!plan) {
			return jsonError(c, 403, `Plan '${row.plan_id}' is not configured`, {
				type: "invalid_request_error",
				code: ErrorCodes.invalidRequest,
			})
		}

		const rl = checkRateLimit(row.id, plan.requestsPerMinute)
		if (!rl.allowed) {
			c.header("Retry-After", String(rl.retryAfterSec))
			return jsonError(c, 429, "Rate limit exceeded for this plan key", {
				type: "rate_limit_error",
				code: ErrorCodes.rateLimitExceeded,
			})
		}

		c.set("auth", {
			userId: row.user_id,
			planKeyId: row.id,
			planId: row.plan_id,
			keyPrefix: row.key_prefix,
		})

		await next()
	})
}

export function requireAdmin(config: AppConfig) {
	return createMiddleware(async (c, next) => {
		if (!config.adminSecret) {
			return jsonError(c, 503, "ADMIN_SECRET is not configured", {
				type: "server_error",
				code: "admin_not_configured",
			})
		}
		const header = c.req.header("x-admin-secret") || extractBearerToken(c.req.header("authorization"))
		if (!header || header !== config.adminSecret) {
			return jsonError(c, 401, "Invalid admin secret", {
				type: "invalid_request_error",
				code: ErrorCodes.invalidApiKey,
			})
		}
		await next()
	})
}

export async function enforceQuotaOrError(
	c: any,
	config: AppConfig,
	db: AsyncDb,
	estimatedPromptTokens: number,
) {
	const auth = c.get("auth")
	const snapshot = await getQuotaSnapshot(db, config, auth.userId, auth.planId)
	if (snapshot.usedTokens >= snapshot.limitTokens) {
		return {
			error: jsonError(c, 429, "You exceeded your current plan quota", {
				type: "insufficient_quota",
				code: ErrorCodes.insufficientQuota,
			}),
			snapshot,
		}
	}
	if (estimatedPromptTokens > snapshot.remainingTokens) {
		return {
			error: jsonError(c, 429, "This request would exceed your current plan quota", {
				type: "insufficient_quota",
				code: ErrorCodes.insufficientQuota,
			}),
			snapshot,
		}
	}
	return { error: null, snapshot }
}
