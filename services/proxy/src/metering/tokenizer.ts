/**
 * Lightweight tokenizer estimate used when upstream omits usage.
 * Approximates ~4 chars/token for Latin + code; treats CJK denser.
 */

export function estimateTokensFromText(text: string): number {
	if (!text) return 0
	let cjk = 0
	let other = 0
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0
		if (
			(code >= 0x4e00 && code <= 0x9fff) ||
			(code >= 0x3400 && code <= 0x4dbf) ||
			(code >= 0x3040 && code <= 0x30ff) ||
			(code >= 0xac00 && code <= 0xd7af)
		) {
			cjk += 1
		} else {
			other += 1
		}
	}
	return Math.max(1, Math.ceil(cjk / 1.5 + other / 4))
}

export function estimateTokensFromMessages(messages: unknown): number {
	if (!Array.isArray(messages)) return 0
	let total = 0
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue
		const m = msg as Record<string, unknown>
		total += 4 // role / framing overhead
		total += estimateTokensFromContent(m.content)
		if (m.name && typeof m.name === "string") total += estimateTokensFromText(m.name)
		if (m.tool_calls) total += estimateTokensFromText(JSON.stringify(m.tool_calls))
	}
	return total
}

/** Estimate tokens for tools / functions schemas attached to the request. */
export function estimateTokensFromTools(tools: unknown, functions?: unknown): number {
	let total = 0
	if (tools != null) total += estimateTokensFromText(JSON.stringify(tools))
	if (functions != null) total += estimateTokensFromText(JSON.stringify(functions))
	return total
}

/**
 * Prompt-side token estimate for routing: messages + tool/function schemas.
 * Does not include requested max output or safety margin.
 */
export function estimateRequestPromptTokens(input: {
	messages?: unknown
	tools?: unknown
	functions?: unknown
}): number {
	return estimateTokensFromMessages(input.messages) + estimateTokensFromTools(input.tools, input.functions)
}

export function resolveRequestedMaxOutputTokens(
	body: Record<string, unknown>,
	defaultMaxOutputTokens: number,
): number {
	const raw = body.max_tokens ?? body.max_completion_tokens
	const n = typeof raw === "number" ? raw : Number(raw)
	if (Number.isFinite(n) && n > 0) return Math.floor(n)
	return defaultMaxOutputTokens
}

function estimateTokensFromContent(content: unknown): number {
	if (typeof content === "string") return estimateTokensFromText(content)
	if (Array.isArray(content)) {
		let n = 0
		for (const part of content) {
			if (typeof part === "string") n += estimateTokensFromText(part)
			else if (part && typeof part === "object") {
				const p = part as Record<string, unknown>
				if (typeof p.text === "string") n += estimateTokensFromText(p.text)
				else n += estimateTokensFromText(JSON.stringify(part))
			}
		}
		return n
	}
	if (content == null) return 0
	return estimateTokensFromText(JSON.stringify(content))
}

export function estimateCompletionTokens(text: string): number {
	return estimateTokensFromText(text)
}
