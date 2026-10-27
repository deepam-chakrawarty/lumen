import { Hono } from "hono"
import type { AppConfig } from "../config"
import { providerConfigured } from "../upstream/client"

export function healthRoutes(config: AppConfig) {
	const app = new Hono()

	app.get("/health", (c) => {
		const providers = Object.fromEntries(
			Object.keys(config.models.providers).map((id) => [
				id,
				{ configured: providerConfigured(config.models, id) },
			]),
		)
		return c.json({
			status: "ok",
			service: "lumen-proxy",
			version: "0.1.0",
			providers,
		})
	})

	app.get("/healthz", (c) => c.text("ok"))

	return app
}
