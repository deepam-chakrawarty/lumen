import { existsSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

const RouteSchema = z.object({
	provider: z.string(),
	model: z.string(),
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
	logicalModels: z.record(LogicalModelSchema),
	auto: z.object({
		smallPromptChars: z.number(),
		largePromptChars: z.number(),
		toolsBumpTo: z.string(),
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
})

const PlansConfigSchema = z.object({
	plans: z.record(PlanSchema),
	defaultPlan: z.string(),
})

export type ModelsConfig = z.infer<typeof ModelsConfigSchema>
export type PlansConfig = z.infer<typeof PlansConfigSchema>
export type PlanDefinition = z.infer<typeof PlanSchema>
export type LogicalModelId = string
export type UpstreamRoute = z.infer<typeof RouteSchema>

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
	models: ModelsConfig
	plans: PlansConfig
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

export function loadConfig(): AppConfig {
	const models = loadModelsConfig()
	const plans = loadPlansConfig()
	const adminSecret = process.env.ADMIN_SECRET || ""
	const keyPepper = process.env.KEY_PEPPER || "lumen-dev-pepper"

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
		models,
		plans,
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
