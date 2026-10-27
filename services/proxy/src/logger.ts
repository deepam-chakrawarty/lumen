export type LogLevel = "debug" | "info" | "warn" | "error"

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
}

export type LogFields = Record<string, unknown>

export function setLogLevel(level: LogLevel): void {
	process.env.LOG_LEVEL = level
}

function currentLevel(): LogLevel {
	return (process.env.LOG_LEVEL as LogLevel) || "info"
}

function shouldLog(level: LogLevel): boolean {
	return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel()]
}

function logPromptsEnabled(): boolean {
	return process.env.LOG_PROMPTS === "true"
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
	if (!shouldLog(level)) return
	const entry = {
		ts: new Date().toISOString(),
		level,
		msg: message,
		...sanitize(fields),
	}
	const line = JSON.stringify(entry)
	if (level === "error") {
		console.error(line)
	} else if (level === "warn") {
		console.warn(line)
	} else {
		console.log(line)
	}
}

/** Strip secrets and prompt bodies from structured logs. */
function sanitize(fields?: LogFields): LogFields | undefined {
	if (!fields) return undefined
	const out: LogFields = {}
	for (const [k, v] of Object.entries(fields)) {
		const key = k.toLowerCase()
		if (
			key.includes("apikey") ||
			key.includes("api_key") ||
			key.includes("authorization") ||
			key.includes("secret") ||
			key.includes("plankey") ||
			key.includes("plan_key") ||
			key.includes("bearer")
		) {
			out[k] = "[redacted]"
			continue
		}
		if (!logPromptsEnabled() && (key.includes("prompt") || key === "messages" || key === "content")) {
			out[k] = "[omitted]"
			continue
		}
		out[k] = v
	}
	return out
}

export const log = {
	debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
	info: (message: string, fields?: LogFields) => emit("info", message, fields),
	warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
	error: (message: string, fields?: LogFields) => emit("error", message, fields),
}
