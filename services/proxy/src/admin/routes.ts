import { Hono } from "hono"
import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { generatePlanKey, hashPlanKey, newId } from "../auth/keys"
import { ErrorCodes, jsonError } from "../errors"
import { requireAdmin } from "../middleware/auth"

export function adminRoutes(config: AppConfig, db: AsyncDb) {
	const app = new Hono()
	app.use("*", requireAdmin(config))

	app.post("/keys", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as {
			userId?: string
			email?: string
			displayName?: string
			plan?: string
			label?: string
		}

		const planId = body.plan || config.plans.defaultPlan
		if (!config.plans.plans[planId]) {
			return jsonError(c, 400, `Unknown plan '${planId}'`, {
				type: "invalid_request_error",
				code: ErrorCodes.invalidRequest,
				param: "plan",
			})
		}

		const userId = body.userId || newId("user")
		await db.ensureUser({
			id: userId,
			email: body.email,
			displayName: body.displayName,
		})

		const { rawKey, prefix } = generatePlanKey()
		const keyId = newId("key")
		const row = await db.createPlanKey({
			id: keyId,
			userId,
			planId,
			keyHash: hashPlanKey(rawKey, config.keyPepper),
			keyPrefix: prefix,
			label: body.label,
		})

		return c.json(
			{
				id: row.id,
				user_id: row.user_id,
				plan_id: row.plan_id,
				key_prefix: row.key_prefix,
				label: row.label,
				created_at: row.created_at,
				// Returned once — store hashed only thereafter
				plan_key: rawKey,
			},
			201,
		)
	})

	app.get("/keys", async (c) => {
		const includeRevoked = c.req.query("include_revoked") === "true"
		const rows = await db.listPlanKeys(includeRevoked)
		return c.json({
			object: "list",
			data: rows.map((r) => ({
				id: r.id,
				user_id: r.user_id,
				email: r.email,
				display_name: r.display_name,
				plan_id: r.plan_id,
				key_prefix: r.key_prefix,
				label: r.label,
				revoked_at: r.revoked_at,
				created_at: r.created_at,
			})),
		})
	})

	app.post("/keys/:id/revoke", async (c) => {
		const id = c.req.param("id")
		const row = await db.revokePlanKey(id)
		if (!row) {
			return jsonError(c, 404, `Key '${id}' not found`, {
				type: "invalid_request_error",
				code: "not_found",
			})
		}
		return c.json({
			id: row.id,
			key_prefix: row.key_prefix,
			revoked_at: row.revoked_at,
			status: "revoked",
		})
	})

	return app
}
