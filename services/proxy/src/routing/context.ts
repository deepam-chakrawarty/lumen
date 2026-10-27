import type { ModelsConfig, UpstreamRoute } from "../config"

export type SizeBudget = {
	promptTokens: number
	maxOutputTokens: number
	safetyMargin: number
	/** prompt + maxOutput + margin */
	requiredTokens: number
}

export function buildSizeBudget(
	promptTokens: number,
	maxOutputTokens: number,
	safetyMargin: number,
): SizeBudget {
	const requiredTokens = promptTokens + maxOutputTokens + safetyMargin
	return { promptTokens, maxOutputTokens, safetyMargin, requiredTokens }
}

export function routeFitsContext(route: UpstreamRoute, requiredTokens: number): boolean {
	return route.contextWindow >= requiredTokens
}

export type FilteredRoutes = {
	routes: UpstreamRoute[]
	skipped: Array<{ route: UpstreamRoute; reason: string; contextWindow: number }>
}

/** Drop routes whose contextWindow cannot hold the estimated request. */
export function filterRoutesByContextSize(
	routes: UpstreamRoute[],
	budget: SizeBudget,
): FilteredRoutes {
	const kept: UpstreamRoute[] = []
	const skipped: FilteredRoutes["skipped"] = []
	for (const route of routes) {
		if (routeFitsContext(route, budget.requiredTokens)) {
			kept.push(route)
		} else {
			skipped.push({
				route,
				contextWindow: route.contextWindow,
				reason: `contextWindow ${route.contextWindow} < required ${budget.requiredTokens} (prompt=${budget.promptTokens} + maxOut=${budget.maxOutputTokens} + margin=${budget.safetyMargin})`,
			})
		}
	}
	return { routes: kept, skipped }
}

/**
 * Detect upstream context / length overflow errors.
 * Status 400/413/422 are retryable only when the body indicates a length problem;
 * other 400s remain non-retryable.
 */
export function isContextLengthError(status: number, bodyText?: string): boolean {
	if (status !== 400 && status !== 413 && status !== 422) return false
	const raw = bodyText || ""
	const lower = raw.toLowerCase()

	let code = ""
	let message = lower
	try {
		const parsed = JSON.parse(raw) as {
			error?: { code?: string; type?: string; message?: string }
			code?: string
			message?: string
		}
		code = String(parsed?.error?.code || parsed?.code || "").toLowerCase()
		message = String(parsed?.error?.message || parsed?.message || raw).toLowerCase()
		const type = String(parsed?.error?.type || "").toLowerCase()
		if (type.includes("context_length")) return true
	} catch {
		// plain-text body
	}

	if (code === "context_length_exceeded" || code.includes("context_length")) return true

	const needles = [
		"context_length_exceeded",
		"maximum context length",
		"max context length",
		"context length exceeded",
		"context window",
		"too many tokens",
		"input is too long",
		"input too long",
		"prompt is too long",
		"prompt too long",
		"token limit",
		"tokens exceed",
		"exceeds the model",
		"exceed the limit",
		"longer than the model's context",
		"this model's maximum context",
		"range of input length",
	]
	return needles.some((n) => message.includes(n) || lower.includes(n))
}

export function maxContextWindow(config: ModelsConfig): number {
	let max = 0
	for (const logical of Object.values(config.logicalModels)) {
		for (const route of logical.routes) {
			if (route.contextWindow > max) max = route.contextWindow
		}
	}
	return max
}
