import type { Server } from "bun"

export type MockBehavior = {
	/** Sequence of outcomes per request index */
	responses?: Array<MockResponse>
	/** Default if sequence exhausted */
	default?: MockResponse
	onRequest?: (req: Request, body: any) => void
}

export type MockResponse =
	| { type: "json"; status?: number; body: unknown; delayMs?: number }
	| {
			type: "sse"
			status?: number
			events: string[]
			delayMs?: number
			/** When set, emit each SSE event as its own chunk after this delay (for cancel/keepalive tests). */
			chunkDelayMs?: number
	  }
	| { type: "error"; status: number; body?: unknown; delayMs?: number }
	| { type: "timeout"; delayMs?: number }

export async function startMockUpstream(behavior: MockBehavior = {}): Promise<{
	url: string
	server: Server
	requests: Array<{ path: string; body: any; headers: Headers }>
	close: () => void
}> {
	const requests: Array<{ path: string; body: any; headers: Headers }> = []
	let idx = 0

	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url)
			let body: any = null
			if (req.method !== "GET") {
				body = await req.json().catch(() => null)
			}
			requests.push({ path: url.pathname, body, headers: req.headers })
			behavior.onRequest?.(req, body)

			const response = behavior.responses?.[idx++] ?? behavior.default ?? {
				type: "json" as const,
				body: {
					id: "chatcmpl-mock",
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: body?.model ?? "mock-model",
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "hello from mock" },
							finish_reason: "stop",
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				},
			}

			if (response.delayMs) {
				await Bun.sleep(response.delayMs)
			}

			if (response.type === "timeout") {
				await Bun.sleep(response.delayMs ?? 60_000)
				return new Response("timeout", { status: 504 })
			}

			if (response.type === "error") {
				return Response.json(response.body ?? { error: { message: "upstream fail" } }, {
					status: response.status,
				})
			}

			if (response.type === "sse") {
				const chunkDelayMs = response.chunkDelayMs ?? 0
				if (chunkDelayMs > 0) {
					const events = response.events
					const stream = new ReadableStream<Uint8Array>({
						async start(controller) {
							const enc = new TextEncoder()
							try {
								for (const event of events) {
									await Bun.sleep(chunkDelayMs)
									controller.enqueue(enc.encode(`${event}\n`))
								}
								controller.close()
							} catch {
								try {
									controller.close()
								} catch {
									// ignore
								}
							}
						},
					})
					return new Response(stream, {
						status: response.status ?? 200,
						headers: { "Content-Type": "text/event-stream" },
					})
				}
				const payload = response.events.join("\n") + (response.events.at(-1) === "data: [DONE]" ? "\n" : "\n\n")
				return new Response(payload, {
					status: response.status ?? 200,
					headers: { "Content-Type": "text/event-stream" },
				})
			}

			return Response.json(response.body, { status: response.status ?? 200 })
		},
	})

	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		server,
		requests,
		close: () => server.stop(true),
	}
}

export function toolCallSseEvents(model: string): string[] {
	return [
		`data: ${JSON.stringify({
			id: "chatcmpl-stream",
			object: "chat.completion.chunk",
			created: 1,
			model,
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "call_1",
								type: "function",
								function: { name: "read_file", arguments: "{\"path\":" },
							},
						],
					},
					finish_reason: null,
				},
			],
		})}`,
		`data: ${JSON.stringify({
			id: "chatcmpl-stream",
			object: "chat.completion.chunk",
			created: 1,
			model,
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [{ index: 0, function: { arguments: "\"a.ts\"}" } }],
					},
					finish_reason: null,
				},
			],
		})}`,
		`data: ${JSON.stringify({
			id: "chatcmpl-stream",
			object: "chat.completion.chunk",
			created: 1,
			model,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
		})}`,
		"data: [DONE]",
	]
}
