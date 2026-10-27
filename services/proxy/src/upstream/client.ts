import type { AppConfig, ModelsConfig, UpstreamRoute } from "../config"
import { resolveProviderEndpoint } from "../config"
import { log } from "../logger"
import { isContextLengthError } from "../routing/context"

export type ChatCompletionBody = Record<string, unknown>

export type UpstreamSuccess = {
	ok: true
	route: UpstreamRoute
	status: number
	headers: Headers
	body: ReadableStream<Uint8Array> | null
	json?: unknown
}

export type UpstreamFailure = {
	ok: false
	route: UpstreamRoute
	status: number
	retryable: boolean
	errorMessage: string
	bodyText?: string
}

export type UpstreamResult = UpstreamSuccess | UpstreamFailure

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

export function isRetryableStatus(status: number): boolean {
	return RETRYABLE_STATUS.has(status)
}

export async function callUpstreamChat(
	config: AppConfig,
	route: UpstreamRoute,
	body: ChatCompletionBody,
	opts: { stream: boolean; signal?: AbortSignal } = { stream: false },
): Promise<UpstreamResult> {
	const { baseUrl, apiKey, apiKeyEnv } = resolveProviderEndpoint(config.models, route.provider)
	if (!apiKey) {
		return {
			ok: false,
			route,
			status: 503,
			retryable: true,
			errorMessage: `Upstream provider '${route.provider}' is not configured (missing ${apiKeyEnv})`,
		}
	}

	const url = `${baseUrl}/chat/completions`
	const payload = { ...body, model: route.model }
	if (opts.stream) {
		payload.stream = true
		const so =
			payload.stream_options && typeof payload.stream_options === "object"
				? { ...(payload.stream_options as object) }
				: {}
		payload.stream_options = { ...so, include_usage: true }
	}

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort("upstream_timeout"), config.upstreamTimeoutMs)
	const onAbort = () => controller.abort("client_abort")
	opts.signal?.addEventListener("abort", onAbort)

	try {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				Accept: opts.stream ? "text/event-stream" : "application/json",
			},
			body: JSON.stringify(payload),
			signal: controller.signal,
		})

		if (!res.ok) {
			const bodyText = await res.text().catch(() => "")
			const contextOverflow = isContextLengthError(res.status, bodyText)
			const retryable = isRetryableStatus(res.status) || contextOverflow
			log.warn("upstream error", {
				provider: route.provider,
				model: route.model,
				status: res.status,
				retryable,
				contextOverflow,
			})
			return {
				ok: false,
				route,
				status: res.status,
				retryable,
				errorMessage: summarizeUpstreamError(res.status, bodyText),
				bodyText,
			}
		}

		if (opts.stream) {
			return {
				ok: true,
				route,
				status: res.status,
				headers: res.headers,
				body: res.body,
			}
		}

		const json = await res.json()
		return {
			ok: true,
			route,
			status: res.status,
			headers: res.headers,
			body: null,
			json,
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		const timedOut = message.includes("upstream_timeout") || message.includes("abort")
		log.warn("upstream transport failure", {
			provider: route.provider,
			model: route.model,
			error: timedOut ? "timeout_or_abort" : "network_error",
		})
		return {
			ok: false,
			route,
			status: 504,
			retryable: true,
			errorMessage: timedOut ? "Upstream request timed out" : `Upstream network error: ${message}`,
		}
	} finally {
		clearTimeout(timeout)
		opts.signal?.removeEventListener("abort", onAbort)
	}
}

function summarizeUpstreamError(status: number, bodyText: string): string {
	try {
		const parsed = JSON.parse(bodyText) as { error?: { message?: string } }
		if (parsed?.error?.message) return parsed.error.message
	} catch {
		// ignore
	}
	if (bodyText && bodyText.length < 200) return bodyText
	return `Upstream returned HTTP ${status}`
}

/**
 * Try routes in order; on retryable failure, move to next stronger/alternate.
 */
export async function callWithFallback(
	config: AppConfig,
	routes: UpstreamRoute[],
	body: ChatCompletionBody,
	opts: { stream: boolean; signal?: AbortSignal },
): Promise<{ result: UpstreamResult; attempts: UpstreamRoute[] }> {
	const attempts: UpstreamRoute[] = []
	let last: UpstreamResult | null = null

	for (const route of routes) {
		attempts.push(route)
		const result = await callUpstreamChat(config, route, body, opts)
		last = result
		if (result.ok) {
			return { result, attempts }
		}
		if (!result.retryable) {
			return { result, attempts }
		}
		log.info("fallback to next route", {
			failedProvider: route.provider,
			failedModel: route.model,
			status: result.status,
			contextOverflow: isContextLengthError(result.status, result.bodyText),
		})
	}

	return {
		result:
			last ??
			({
				ok: false,
				route: routes[0] ?? { provider: "none", model: "none" },
				status: 503,
				retryable: false,
				errorMessage: "No upstream routes configured",
			} satisfies UpstreamFailure),
		attempts,
	}
}

/** Rewrite upstream response model field to the logical Lumen model id. */
export function rewriteResponseModel(payload: any, logicalModel: string): any {
	if (!payload || typeof payload !== "object") return payload
	return { ...payload, model: logicalModel }
}

export function extractUsage(payload: any): {
	prompt_tokens: number
	completion_tokens: number
	total_tokens: number
} | null {
	const u = payload?.usage
	if (!u || typeof u !== "object") return null
	const prompt = Number(u.prompt_tokens) || 0
	const completion = Number(u.completion_tokens) || 0
	const total = Number(u.total_tokens) || prompt + completion
	return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
}

export function providerConfigured(models: ModelsConfig, providerId: string): boolean {
	try {
		const { apiKey } = resolveProviderEndpoint(models, providerId)
		return Boolean(apiKey)
	} catch {
		return false
	}
}
