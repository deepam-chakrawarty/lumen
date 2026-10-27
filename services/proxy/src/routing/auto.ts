import type { ModelsConfig } from "../config"
import { estimateTokensFromMessages } from "../metering/tokenizer"

export type AutoInput = {
	messages?: unknown
	tools?: unknown
	functions?: unknown
	tool_choice?: unknown
}

/**
 * Transparent lumen-auto heuristic:
 * 1. tools/functions → at least toolsBumpTo (standard)
 * 2. strong task signal keywords → lumen-strong
 * 3. large prompt → lumen-strong; medium → lumen-standard; small → default (fast)
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
	const tokenEstimate = estimateTokensFromMessages(input.messages)

	const strongHit = auto.strongSignals.some((sig) => lower.includes(sig.toLowerCase()))

	let pick = auto.default
	if (charCount >= auto.largePromptChars || tokenEstimate >= Math.ceil(auto.largePromptChars / 4)) {
		pick = "lumen-strong"
	} else if (
		charCount >= auto.smallPromptChars ||
		tokenEstimate >= Math.ceil(auto.smallPromptChars / 4) ||
		hasTools
	) {
		pick = hasTools ? auto.toolsBumpTo : "lumen-standard"
	}

	if (strongHit) {
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
