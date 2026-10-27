import { Hono } from "hono"
import { cors } from "hono/cors"
import type { AppConfig } from "./config"
import type { AsyncDb } from "./db/client"
import { newId } from "./auth/keys"
import { jsonError, ErrorCodes } from "./errors"
import { log } from "./logger"
import { adminRoutes } from "./admin/routes"
import { billingRoutes } from "./routes/billing"
import { chatRoutes } from "./routes/chat"
import { healthRoutes } from "./routes/health"
import { modelsRoutes } from "./routes/models"
import { usageRoutes } from "./routes/usage"
import { webhookRoutes } from "./routes/webhooks"

export function createApp(config: AppConfig, db: AsyncDb) {
	const app = new Hono()

	app.use("*", cors())
	app.use("*", async (c, next) => {
		const requestId = c.req.header("x-request-id") || newId("req")
		c.set("requestId", requestId)
		c.header("x-request-id", requestId)
		const start = Date.now()
		await next()
		log.info("http", {
			requestId,
			method: c.req.method,
			path: c.req.path,
			status: c.res.status,
			ms: Date.now() - start,
		})
	})

	app.route("/", healthRoutes(config))
	app.route("/v1", modelsRoutes(config, db))
	app.route("/v1", chatRoutes(config, db))
	app.route("/v1", usageRoutes(config, db))
	app.route("/admin", adminRoutes(config, db))
	app.route("/billing", billingRoutes(config, db))
	app.route("/webhooks", webhookRoutes(config, db))

	app.notFound((c) =>
		jsonError(c, 404, `Unknown route ${c.req.method} ${c.req.path}`, {
			type: "invalid_request_error",
			code: "not_found",
		}),
	)

	app.onError((err, c) => {
		log.error("unhandled error", { error: err.message })
		return jsonError(c, 500, "Internal server error", {
			type: "server_error",
			code: ErrorCodes.upstreamError,
		})
	})

	return app
}

export type LumenApp = ReturnType<typeof createApp>
