import { Hono } from "hono"
import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { requirePlanKey } from "../middleware/auth"
import { listPublicModels } from "../routing/router"

export function modelsRoutes(config: AppConfig, db: AsyncDb) {
	const app = new Hono()
	app.use("*", requirePlanKey(config, db))

	app.get("/models", (c) => {
		return c.json({
			object: "list",
			data: listPublicModels(config.models),
		})
	})

	app.get("/models/:id", (c) => {
		const id = c.req.param("id")
		const models = listPublicModels(config.models)
		const found = models.find((m) => m.id === id)
		if (!found) {
			return c.json(
				{
					error: {
						message: `The model '${id}' does not exist`,
						type: "invalid_request_error",
						param: "model",
						code: "model_not_found",
					},
				},
				404,
			)
		}
		return c.json(found)
	})

	return app
}
