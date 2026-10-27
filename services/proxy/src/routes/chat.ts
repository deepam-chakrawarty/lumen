import { Hono } from "hono"
import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { newId } from "../auth/keys"
import { ErrorCodes, jsonError } from "../errors"
import { log } from "../logger"
import { enforceQuotaOrError, requirePlanKey } from "../middleware/auth"
import { estimateCompletionTokens, estimateTokensFromMessages } from "../metering/tokenizer"
import { assertModelAllowed } from "../metering/quotas"
import { ModelNotFoundError, resolveRoutePlan } from "../routing/router"
import {
	callWithFallback,
	extractUsage,
	rewriteResponseModel,
} from "../upstream/client"

export function chatRoutes(config: AppConfig, db: AsyncDb) {
	const app = new Hono()
	app.use("*", requirePlanKey(config, db))

	app.post("/chat/completions", async (c) => {
		let body: Record<string, unknown>
		try {
			body = (await c.req.json()) as Record<string, unknown>
		} catch {
			return jsonError(c, 400, "Invalid JSON body", {
				type: "invalid_request_error",
				code: ErrorCodes.invalidRequest,
			})
		}

		const requestedModel = typeof body.model === "string" ? body.model : ""
		if (!requestedModel) {
			return jsonError(c, 400, "Missing model", {
				type: "invalid_request_error",
				code: ErrorCodes.invalidRequest,
				param: "model",
			})
		}

		let plan
		try {
			plan = resolveRoutePlan(config.models, requestedModel, {
				messages: body.messages,
				tools: body.tools,
				functions: body.functions,
				tool_choice: body.tool_choice,
			})
		} catch (err) {
			if (err instanceof ModelNotFoundError) {
				return jsonError(c, 404, err.message, {
					type: "invalid_request_error",
					code: "model_not_found",
					param: "model",
				})
			}
			throw err
		}

		const auth = c.get("auth")
		const planDef = config.plans.plans[auth.planId]
		if (!assertModelAllowed(planDef, plan.tier)) {
			return jsonError(c, 403, `Model tier '${plan.tier}' is not allowed on plan '${auth.planId}'`, {
				type: "invalid_request_error",
				code: ErrorCodes.modelNotAllowed,
				param: "model",
			})
		}

		const promptEstimate = estimateTokensFromMessages(body.messages)
		const quota = await enforceQuotaOrError(c, config, db, promptEstimate)
		if (quota.error) return quota.error

		const stream = Boolean(body.stream)
		const requestId = newId("req")

		// Pass through tool/function-calling and other OpenAI chat fields.
		const forwardBody: Record<string, unknown> = { ...body }
		delete forwardBody.model

		const { result, attempts } = await callWithFallback(config, plan.routes, forwardBody, {
			stream,
			signal: c.req.raw.signal,
		})

		if (!result.ok) {
			const status =
				result.status === 401 || result.status === 403
					? 502
					: result.status === 429
						? 429
						: result.status >= 400 && result.status < 600
							? result.status
							: 502
			const code = result.status === 429 ? ErrorCodes.rateLimitExceeded : ErrorCodes.upstreamError
			log.error("all upstream routes failed", {
				requestId,
				logicalModel: plan.logicalModel,
				attempts: attempts.map((a) => `${a.provider}/${a.model}`),
				status: result.status,
			})
			await db.insertUsage({
				id: newId("usage"),
				user_id: auth.userId,
				plan_key_id: auth.planKeyId,
				logical_model: plan.logicalModel,
				upstream_provider: result.route.provider,
				upstream_model: result.route.model,
				prompt_tokens: promptEstimate,
				completion_tokens: 0,
				total_tokens: promptEstimate,
				streamed: stream ? 1 : 0,
				status: "error",
			})
			return jsonError(c, status as 400, result.errorMessage, {
				type: result.status === 429 ? "rate_limit_error" : "server_error",
				code,
			})
		}

		log.info("chat completion routed", {
			requestId,
			userId: auth.userId,
			logicalModel: plan.logicalModel,
			requestedModel: plan.requestedModel,
			autoFrom: plan.autoResolvedFrom,
			upstreamProvider: result.route.provider,
			upstreamModel: result.route.model,
			stream,
			attempts: attempts.length,
		})

		if (!stream) {
			const payload = rewriteResponseModel(result.json, plan.logicalModel)
			let usage = extractUsage(payload)
			if (!usage) {
				const completionText = extractAssistantText(payload)
				const completionTokens = estimateCompletionTokens(completionText)
				usage = {
					prompt_tokens: promptEstimate,
					completion_tokens: completionTokens,
					total_tokens: promptEstimate + completionTokens,
				}
				payload.usage = usage
			}
			await db.insertUsage({
				id: newId("usage"),
				user_id: auth.userId,
				plan_key_id: auth.planKeyId,
				logical_model: plan.logicalModel,
				upstream_provider: result.route.provider,
				upstream_model: result.route.model,
				prompt_tokens: usage.prompt_tokens,
				completion_tokens: usage.completion_tokens,
				total_tokens: usage.total_tokens,
				streamed: 0,
				status: "ok",
			})
			return c.json(payload)
		}

		// Streaming SSE passthrough — rewrite model id and capture usage.
		return streamPassthrough(c, db, {
			requestId,
			auth,
			plan,
			route: result.route,
			upstreamBody: result.body,
			promptEstimate,
		})
	})

	return app
}

function extractAssistantText(payload: any): string {
	try {
		const msg = payload?.choices?.[0]?.message
		if (!msg) return ""
		if (typeof msg.content === "string") return msg.content
		if (msg.tool_calls) return JSON.stringify(msg.tool_calls)
		return JSON.stringify(msg)
	} catch {
		return ""
	}
}

async function streamPassthrough(
	c: any,
	db: AsyncDb,
	ctx: {
		requestId: string
		auth: { userId: string; planKeyId: string }
		plan: { logicalModel: string }
		route: { provider: string; model: string }
		upstreamBody: ReadableStream<Uint8Array> | null
		promptEstimate: number
	},
) {
	if (!ctx.upstreamBody) {
		return jsonError(c, 502, "Upstream returned empty stream", {
			type: "server_error",
			code: ErrorCodes.upstreamError,
		})
	}

	const decoder = new TextDecoder()
	const encoder = new TextEncoder()
	let buffer = ""
	let completionText = ""
	let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = ctx.upstreamBody!.getReader()
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					const chunk = decoder.decode(value, { stream: true })
					buffer += chunk

					const lines = buffer.split("\n")
					buffer = lines.pop() ?? ""
					let out = ""
					for (const line of lines) {
						const rewritten = rewriteSseLine(line, ctx.plan.logicalModel, {
							onDelta: (t) => {
								completionText += t
							},
							onUsage: (u) => {
								usage = u
							},
						})
						out += rewritten + "\n"
					}
					if (out) controller.enqueue(encoder.encode(out))
				}
				if (buffer) {
					const rewritten = rewriteSseLine(buffer, ctx.plan.logicalModel, {
						onDelta: (t) => {
							completionText += t
						},
						onUsage: (u) => {
							usage = u
						},
					})
					controller.enqueue(encoder.encode(rewritten))
				}
			} catch (err) {
				log.error("stream passthrough failed", {
					requestId: ctx.requestId,
					error: err instanceof Error ? err.message : String(err),
				})
				controller.error(err)
				return
			} finally {
				const finalUsage =
					usage ??
					({
						prompt_tokens: ctx.promptEstimate,
						completion_tokens: estimateCompletionTokens(completionText),
						total_tokens: ctx.promptEstimate + estimateCompletionTokens(completionText),
					} as const)
				try {
					await db.insertUsage({
						id: newId("usage"),
						user_id: ctx.auth.userId,
						plan_key_id: ctx.auth.planKeyId,
						logical_model: ctx.plan.logicalModel,
						upstream_provider: ctx.route.provider,
						upstream_model: ctx.route.model,
						prompt_tokens: finalUsage.prompt_tokens,
						completion_tokens: finalUsage.completion_tokens,
						total_tokens: finalUsage.total_tokens,
						streamed: 1,
						status: "ok",
					})
				} catch (err) {
					log.error("failed to persist stream usage", {
						requestId: ctx.requestId,
						error: err instanceof Error ? err.message : String(err),
					})
				}
				controller.close()
			}
		},
	})

	return new Response(stream, {
		status: 200,
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Lumen-Upstream-Provider": ctx.route.provider,
			"X-Lumen-Upstream-Model": ctx.route.model,
			"X-Lumen-Logical-Model": ctx.plan.logicalModel,
		},
	})
}

function rewriteSseLine(
	line: string,
	logicalModel: string,
	hooks: {
		onDelta: (text: string) => void
		onUsage: (u: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void
	},
): string {
	if (!line.startsWith("data:")) return line
	const data = line.slice(5).trim()
	if (!data || data === "[DONE]") return line
	try {
		const parsed = JSON.parse(data)
		if (parsed?.model) parsed.model = logicalModel
		const delta = parsed?.choices?.[0]?.delta
		if (delta?.content && typeof delta.content === "string") hooks.onDelta(delta.content)
		if (delta?.tool_calls) hooks.onDelta(JSON.stringify(delta.tool_calls))
		const usage = extractUsage(parsed)
		if (usage) hooks.onUsage(usage)
		return `data: ${JSON.stringify(parsed)}`
	} catch {
		return line
	}
}
