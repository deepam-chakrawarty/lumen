import { existsSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

const RouteSchema = z.object({
	provider: z.string(),
	model: z.string(),
	/** Total context window in tokens (prompt + completion). Required on every route. */
	contextWindow: z.number().int().positive(),
	/** Optional documented max generation tokens for this upstream model. */
	maxOutputTokens: z.number().int().positive().optional(),
})

const ProviderSchema = z.object({
	baseUrlEnv: z.string(),
	apiKeyEnv: z.string(),
	defaultBaseUrl: z.string().url(),
})

const LogicalModelSchema = z.object({
	name: z.string(),
	description: z.string(),
	tier: z.enum(["fast", "standard", "strong", "auto"]),
	routes: z.array(RouteSchema),
})

const ModelsConfigSchema = z.object({
	providers: z.record(ProviderSchema),
	strengthOrder: z.array(z.string()),
	contextSafetyMargin: z.number().int().nonnegative().default(1024),
	defaultMaxOutputTokens: z.number().int().positive().default(8192),
	logicalModels: z.record(LogicalModelSchema),
	auto: z.object({
		smallPromptChars: z.number(),
		largePromptChars: z.number(),
		toolsBumpTo: z.string(),
		strongContextTokens: z.number().int().positive().default(128000),
		strongSignals: z.array(z.string()),
		default: z.string(),
	}),
})

const PlanSchema = z.object({
	name: z.string(),
	description: z.string(),
	monthlyTokenLimit: z.number().int().positive(),
	requestsPerMinute: z.number().int().positive(),
	allowedTiers: z.array(z.enum(["fast", "standard", "strong", "auto"])),
	pricePaise: z.number().int().nonnegative().default(0),
	currency: z.string().default("INR"),
	paid: z.boolean().default(false),
	eduOnly: z.boolean().optional(),
})

const BillingConfigSchema = z.object({
	currency: z.string().default("INR"),
	gstRatePercent: z.number().nonnegative().default(18),
	pricesGstInclusive: z.boolean().default(true),
	gracePeriodDays: z.number().int().nonnegative().default(3),
	interval: z.enum(["monthly", "yearly"]).default("monthly"),
	subscriptionTotalCount: z.number().int().positive().default(120),
	publicBaseUrl: z.string().default("http://localhost:8787"),
	copyLocale: z.string().default("en-IN"),
})

const PlansConfigSchema = z.object({
	plans: z.record(PlanSchema),
	defaultPlan: z.string(),
	billing: BillingConfigSchema.default({}),
	eduEmailAllowlist: z.array(z.string()).default([".edu.in", ".ac.in"]),
})

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>
export type PlansConfig = z.infer<typeof PlansConfigSchema>
export type PlanDefinition = z.infer<typeof PlanSchema>
export type BillingConfig = z.infer<typeof BillingConfigSchema>
export type LogicalModelId = string
export type UpstreamRoute = z.infer<typeof RouteSchema>

export type PaymentProviderId = "razorpay" | "cashfree" | "mock"

const here = dirname(fileURLToPath(import.meta.url))
export const PROXY_ROOT = resolve(here, "..")

function loadDotEnv(): void {
	const envPath = resolve(PROXY_ROOT, ".env")
	if (!existsSync(envPath)) return
	const text = readFileSync(envPath, "utf8")
	for (const line of text.split("\n")) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith("#")) continue
		const eq = trimmed.indexOf("=")
		if (eq <= 0) continue
		const key = trimmed.slice(0, eq).trim()
		let value = trimmed.slice(eq + 1).trim()
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1)
		}
		if (process.env[key] === undefined) {
			process.env[key] = value
		}
	}
}

loadDotEnv()

export type AppConfig = {
	port: number
	host: string
	adminSecret: string
	keyPepper: string
	databaseUrl: string
	modelsConfigPath: string
	plansConfigPath: string
	upstreamTimeoutMs: number
	upstreamConnectTimeoutMs: number
	/**
	 * Bun.serve idleTimeout in seconds (max 255). `0` disables the idle timer so
	 * long-running SSE chat streams are not killed during upstream pauses.
	 */
	serverIdleTimeoutSeconds: number
	models: ModelsConfig
	plans: PlansConfig
	/** Public URL used for checkout return / webhook docs (no trailing slash). */
	publicBaseUrl: string
	paymentProvider: PaymentProviderId
	paymentTestMode: boolean
	mailer: "console" | "smtp"
	smtp: {
		host: string
		port: number
		user: string
		pass: string
		from: string
	}
	razorpay: {
		keyId: string
		keySecret: string
		webhookSecret: string
	}
	cashfree: {
		clientId: string
		clientSecret: string
		webhookSecret: string
		apiVersion: string
		env: "sandbox" | "production"
	}
	sessionSecret: string
}

function readYamlFile(path: string): unknown {
	return parseYaml(readFileSync(path, "utf8"))
}

export function loadModelsConfig(path = process.env.MODELS_CONFIG): ModelsConfig {
	const resolved = resolve(PROXY_ROOT, path || "./config/models.yaml")
	return ModelsConfigSchema.parse(readYamlFile(resolved))
}

export function loadPlansConfig(path = process.env.PLANS_CONFIG): PlansConfig {
	const resolved = resolve(PROXY_ROOT, path || "./config/plans.yaml")
	return PlansConfigSchema.parse(readYamlFile(resolved))
}

function parsePaymentProvider(raw: string | undefined): PaymentProviderId {
	const v = (raw || "razorpay").toLowerCase()
	if (v === "razorpay" || v === "cashfree" || v === "mock") return v
	throw new Error(`Unknown PAYMENT_PROVIDER '${raw}'. Use razorpay | cashfree | mock`)
}

/** Bun.serve idleTimeout is seconds; 0 disables; Bun caps at 255. */
export function parseServerIdleTimeoutSeconds(raw: string | undefined): number {
	const n = Number(raw ?? "0")
	if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
		throw new Error(
			`SERVER_IDLE_TIMEOUT_SECONDS must be an integer >= 0 (got ${JSON.stringify(raw)}); use 0 to disable`,
		)
	}
	if (n > 255) {
		throw new Error("SERVER_IDLE_TIMEOUT_SECONDS max is 255 (Bun limit); use 0 to disable")
	}
	return n
}

export function loadConfig(): AppConfig {
	const models = loadModelsConfig()
	const plans = loadPlansConfig()
	const adminSecret = process.env.ADMIN_SECRET || ""
	const keyPepper = process.env.KEY_PEPPER || "lumen-dev-pepper"
	const publicBaseUrl = (
		process.env.PUBLIC_BASE_URL ||
		plans.billing.publicBaseUrl ||
		"http://localhost:8787"
	).replace(/\/$/, "")

	const cashfreeEnv =
		(process.env.CASHFREE_ENV || "sandbox").toLowerCase() === "production"
			? "production"
			: "sandbox"

	return {
		port: Number(process.env.PORT || 8787),
		host: process.env.HOST || "0.0.0.0",
		adminSecret,
		keyPepper,
		databaseUrl: process.env.DATABASE_URL || "sqlite:./data/lumen.db",
		modelsConfigPath: resolve(PROXY_ROOT, process.env.MODELS_CONFIG || "./config/models.yaml"),
		plansConfigPath: resolve(PROXY_ROOT, process.env.PLANS_CONFIG || "./config/plans.yaml"),
		upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 60_000),
		upstreamConnectTimeoutMs: Number(process.env.UPSTREAM_CONNECT_TIMEOUT_MS || 10_000),
		serverIdleTimeoutSeconds: parseServerIdleTimeoutSeconds(process.env.SERVER_IDLE_TIMEOUT_SECONDS),
		models,
		plans: {
			...plans,
			billing: {
				...plans.billing,
				publicBaseUrl,
			},
		},
		publicBaseUrl,
		paymentProvider: parsePaymentProvider(process.env.PAYMENT_PROVIDER),
		paymentTestMode: (process.env.PAYMENT_TEST_MODE ?? "true").toLowerCase() !== "false",
		mailer: (process.env.MAILER || "console").toLowerCase() === "smtp" ? "smtp" : "console",
		smtp: {
			host: process.env.SMTP_HOST || "",
			port: Number(process.env.SMTP_PORT || 587),
			user: process.env.SMTP_USER || "",
			pass: process.env.SMTP_PASS || "",
			from: process.env.SMTP_FROM || "Lumen <noreply@localhost>",
		},
		razorpay: {
			keyId: process.env.RAZORPAY_KEY_ID || "",
			keySecret: process.env.RAZORPAY_KEY_SECRET || "",
			webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "",
		},
		cashfree: {
			clientId: process.env.CASHFREE_CLIENT_ID || "",
			clientSecret: process.env.CASHFREE_CLIENT_SECRET || "",
			webhookSecret: process.env.CASHFREE_WEBHOOK_SECRET || "",
			apiVersion: process.env.CASHFREE_API_VERSION || "2026-01-01",
			env: cashfreeEnv,
		},
		sessionSecret: process.env.SESSION_SECRET || keyPepper,
	}
}

export function resolveProviderEndpoint(
	models: ModelsConfig,
	providerId: string,
): { baseUrl: string; apiKey: string; apiKeyEnv: string } {
	const provider = models.providers[providerId]
	if (!provider) {
		throw new Error(`Unknown provider: ${providerId}`)
	}
	const baseUrl = (process.env[provider.baseUrlEnv] || provider.defaultBaseUrl).replace(/\/$/, "")
	const apiKey = process.env[provider.apiKeyEnv] || ""
	return { baseUrl, apiKey, apiKeyEnv: provider.apiKeyEnv }
}
