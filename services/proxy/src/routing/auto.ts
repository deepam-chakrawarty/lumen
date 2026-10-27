import type { ModelsConfig } from "../config"
import { estimateRequestPromptTokens } from "../metering/tokenizer"

export type AutoInput = {
	messages?: unknown
	tools?: unknown
	functions?: unknown
	tool_choice?: unknown
	/** When set (prompt+tools+maxOut+margin), oversized requests bump to strong. */
	requiredTokens?: number
}

/**
 * Transparent lumen-auto heuristic:
 * 1. requiredTokens > strongContextTokens → lumen-strong (heavy agent → Qwen)
 * 2. tools/functions → at least toolsBumpTo (standard)
 * 3. strong task signal keywords → lumen-strong
 * 4. large prompt → lumen-strong; medium → lumen-standard; small → default (fast)
 */
export function resolveAutoModel(config: ModelsConfig, input: AutoInput): string {
	const auto = config.auto
	const hasTools =
		(Array.isArray(input.tools) && input.tools.length > 0) ||
		(Array.isArray(input.functions) && input.functions.length > 0) ||
		input.tool_choice != null

	const text = flattenMessagesText(input.messages)
	const lower = text.toLowerCase()
	const charCount = text.length
	const tokenEstimate = estimateRequestPromptTokens(input)

	const strongHit = auto.strongSignals.some((sig) => lower.includes(sig.toLowerCase()))
	const oversized =
		typeof input.requiredTokens === "number" &&
		input.requiredTokens > (auto.strongContextTokens ?? 128000)

	let pick = auto.default
	if (oversized) {
		pick = "lumen-strong"
	} else if (charCount >= auto.largePromptChars || tokenEstimate >= Math.ceil(auto.largePromptChars / 4)) {
		pick = "lumen-strong"
	} else if (
		charCount >= auto.smallPromptChars ||
		tokenEstimate >= Math.ceil(auto.smallPromptChars / 4) ||
		hasTools
	) {
		pick = hasTools ? auto.toolsBumpTo : "lumen-standard"
	}

	if (strongHit || oversized) {
		pick = "lumen-strong"
	} else if (hasTools && pick === auto.default) {
		pick = auto.toolsBumpTo
	}

	if (!config.logicalModels[pick] || pick === "lumen-auto") {
		return "lumen-fast"
	}
	return pick
}

function flattenMessagesText(messages: unknown): string {
	if (!Array.isArray(messages)) return ""
	const parts: string[] = []
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue
		const m = msg as Record<string, unknown>
		if (typeof m.content === "string") parts.push(m.content)
		else if (Array.isArray(m.content)) {
			for (const p of m.content) {
				if (typeof p === "string") parts.push(p)
				else if (p && typeof p === "object" && typeof (p as any).text === "string") {
					parts.push((p as any).text)
				}
			}
		}
	}
	return parts.join("\n")
}
