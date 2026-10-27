import type { ModelsConfig, UpstreamRoute } from "../config"
import { resolveAutoModel, type AutoInput } from "./auto"

export type ResolvedRoutePlan = {
	requestedModel: string
	logicalModel: string
	tier: string
	routes: UpstreamRoute[]
	autoResolvedFrom?: string
}

/**
 * Build ordered upstream routes for a logical model, including cross-tier
 * fallback to the next stronger logical model when routes are exhausted.
 */
export function resolveRoutePlan(
	config: ModelsConfig,
	requestedModel: string,
	autoInput: AutoInput,
): ResolvedRoutePlan {
	let logicalModel = requestedModel
	let autoResolvedFrom: string | undefined

	if (logicalModel === "lumen-auto") {
		logicalModel = resolveAutoModel(config, autoInput)
		autoResolvedFrom = "lumen-auto"
	}

	const def = config.logicalModels[logicalModel]
	if (!def) {
		throw new ModelNotFoundError(requestedModel)
	}

	const routes = collectFallbackRoutes(config, logicalModel)

	return {
		requestedModel,
		logicalModel,
		tier: def.tier,
		routes,
		autoResolvedFrom,
	}
}

function collectFallbackRoutes(config: ModelsConfig, startLogical: string): UpstreamRoute[] {
	const order = config.strengthOrder
	const startIdx = order.indexOf(startLogical)
	const sequence =
		startIdx >= 0 ? order.slice(startIdx) : [startLogical, ...order.filter((id) => id !== startLogical)]

	const seen = new Set<string>()
	const routes: UpstreamRoute[] = []
	for (const logicalId of sequence) {
		const model = config.logicalModels[logicalId]
		if (!model) continue
		for (const route of model.routes) {
			const key = `${route.provider}::${route.model}`
			if (seen.has(key)) continue
			seen.add(key)
			routes.push(route)
		}
	}
	return routes
}

export class ModelNotFoundError extends Error {
	constructor(public readonly model: string) {
		super(`The model '${model}' does not exist`)
		this.name = "ModelNotFoundError"
	}
}

export function listPublicModels(config: ModelsConfig): Array<{
	id: string
	object: "model"
	created: number
	owned_by: string
}> {
	const created = 1_700_000_000
	return Object.keys(config.logicalModels).map((id) => ({
		id,
		object: "model" as const,
		created,
		owned_by: "lumen",
	}))
}
