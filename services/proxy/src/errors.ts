import type { Context } from "hono"
import type { ContentfulStatusCode } from "hono/utils/http-status"

/** OpenAI-style error envelope. */
export type OpenAIErrorBody = {
	error: {
		message: string
		type: string
		param: string | null
		code: string | null
	}
}

export function openaiError(
	message: string,
	opts: { type?: string; code?: string | null; param?: string | null } = {},
): OpenAIErrorBody {
	return {
		error: {
			message,
			type: opts.type ?? "invalid_request_error",
			param: opts.param ?? null,
			code: opts.code ?? null,
		},
	}
}

export function jsonError(
	c: Context,
	status: ContentfulStatusCode,
	message: string,
	opts: { type?: string; code?: string | null; param?: string | null } = {},
) {
	return c.json(openaiError(message, opts), status)
}

export const ErrorCodes = {
	invalidApiKey: "invalid_api_key",
	insufficientQuota: "insufficient_quota",
	rateLimitExceeded: "rate_limit_exceeded",
	modelNotAllowed: "model_not_allowed",
	upstreamError: "upstream_error",
	invalidRequest: "invalid_request_error",
} as const
