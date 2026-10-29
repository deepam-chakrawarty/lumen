import { Hono } from "hono"
import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { newId } from "../auth/keys"
import { ErrorCodes, jsonError } from "../errors"
import { log } from "../logger"
import { enforceQuotaOrError, requirePlanKey } from "../middleware/auth"
import {
	estimateCompletionTokens,
	estimateRequestPromptTokens,
	resolveRequestedMaxOutputTokens,
} from "../metering/tokenizer"
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

		const promptEstimate = estimateRequestPromptTokens({
			messages: body.messages,
			tools: body.tools,
			functions: body.functions,
		})
		const maxOutputTokens = resolveRequestedMaxOutputTokens(
			body,
			config.models.defaultMaxOutputTokens ?? 8192,
		)

		let plan
		try {
			plan = resolveRoutePlan(
				config.models,
				requestedModel,
				{
					messages: body.messages,
					tools: body.tools,
					functions: body.functions,
					tool_choice: body.tool_choice,
				},
				{ promptTokens: promptEstimate, maxOutputTokens },
			)
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

		if (plan.skippedForSize.length > 0) {
			log.info("routes skipped for context size", {
				logicalModel: plan.logicalModel,
				requiredTokens: plan.budget.requiredTokens,
				skipped: plan.skippedForSize.map(
					(s) => `${s.route.provider}/${s.route.model}(cw=${s.contextWindow})`,
				),
			})
		}

		if (plan.routes.length === 0) {
			return jsonError(
				c,
				400,
				`This model's maximum context length was exceeded (estimated ${plan.budget.requiredTokens} tokens required; no upstream route fits).`,
				{
					type: "invalid_request_error",
					code: ErrorCodes.contextLengthExceeded,
					param: "messages",
				},
			)
		}

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

const SSE_KEEPALIVE_MS = 15_000

function isClientDisconnect(err: unknown): boolean {
	if (!err) return false
	if (typeof err === "object" && err !== null && "name" in err && (err as { name: string }).name === "AbortError") {
		return true
	}
	const msg = err instanceof Error ? err.message : String(err)
	return (
		msg.includes("Controller is already closed") ||
		msg.includes("Invalid state") ||
		msg.includes("aborted") ||
		msg.includes("AbortError") ||
		msg.includes("cancelled") ||
		msg.includes("The operation was aborted")
	)
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
	let closed = false
	let usageRecorded = false
	// Avoid Bun vs DOM ReadableStreamDefaultReader generic mismatch (readMany).
	let reader: {
		read: () => Promise<{ done: boolean; value?: Uint8Array }>
		cancel: (reason?: unknown) => Promise<void>
	} | null = null
	let keepAliveTimer: ReturnType<typeof setInterval> | null = null

	const clientSignal: AbortSignal | undefined = c.req?.raw?.signal

	const stopKeepAlive = () => {
		if (keepAliveTimer) {
			clearInterval(keepAliveTimer)
			keepAliveTimer = null
		}
	}

	const cancelUpstream = (reason?: unknown) => {
		void reader?.cancel(reason).catch(() => {})
	}

	const recordUsageOnce = async () => {
		if (usageRecorded) return
		usageRecorded = true
		const completionTokens = estimateCompletionTokens(completionText)
		const finalUsage =
			usage ??
			({
				prompt_tokens: ctx.promptEstimate,
				completion_tokens: completionTokens,
				total_tokens: ctx.promptEstimate + completionTokens,
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
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const safeEnqueue = (bytes: Uint8Array) => {
				if (closed) return
				try {
					controller.enqueue(bytes)
				} catch (err) {
					closed = true
					if (!isClientDisconnect(err)) throw err
				}
			}

			const safeClose = () => {
				if (closed) return
				closed = true
				try {
					controller.close()
				} catch {
					// already closed by client disconnect
				}
			}

			reader = ctx.upstreamBody!.getReader()

			const onClientAbort = () => {
				if (closed) return
				closed = true
				log.info("client disconnected during stream", {
					requestId: ctx.requestId,
					reason: "request_aborted",
				})
				stopKeepAlive()
				cancelUpstream("client_abort")
			}
			clientSignal?.addEventListener("abort", onClientAbort)

			keepAliveTimer = setInterval(() => {
				// SSE comment keeps intermediaries / Bun from treating the socket as idle.
				safeEnqueue(encoder.encode(": keep-alive\n\n"))
			}, SSE_KEEPALIVE_MS)

			try {
				while (!closed) {
					const current = reader
					if (!current) break
					const { done, value } = await current.read()
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
					if (out) safeEnqueue(encoder.encode(out))
				}
				if (!closed && buffer) {
					const rewritten = rewriteSseLine(buffer, ctx.plan.logicalModel, {
						onDelta: (t) => {
							completionText += t
						},
						onUsage: (u) => {
							usage = u
						},
					})
					safeEnqueue(encoder.encode(rewritten))
				}
				safeClose()
			} catch (err) {
				if (closed || isClientDisconnect(err)) {
					closed = true
					log.info("client disconnected during stream", {
						requestId: ctx.requestId,
						error: err instanceof Error ? err.message : String(err),
					})
				} else {
					log.error("stream passthrough failed", {
						requestId: ctx.requestId,
						error: err instanceof Error ? err.message : String(err),
					})
					if (!closed) {
						closed = true
						try {
							controller.error(err)
						} catch {
							// ignore
						}
					}
				}
			} finally {
				stopKeepAlive()
				clientSignal?.removeEventListener("abort", onClientAbort)
				cancelUpstream()
				await recordUsageOnce()
			}
		},
		cancel(reason) {
			if (!closed) {
				closed = true
				log.info("client disconnected during stream", {
					requestId: ctx.requestId,
					reason: reason != null ? String(reason) : "cancel",
				})
			}
			stopKeepAlive()
			cancelUpstream(reason)
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
