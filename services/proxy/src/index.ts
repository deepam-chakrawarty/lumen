import { loadConfig } from "./config"
import { openDatabase } from "./db/client"
import { log } from "./logger"
import { createApp } from "./server"

async function main(): Promise<void> {
	const config = loadConfig()
	const db = await openDatabase(config.databaseUrl)
	const app = createApp(config, db)

	log.info("lumen proxy starting", {
		host: config.host,
		port: config.port,
		db: config.databaseUrl.startsWith("postgres") ? "postgres" : "sqlite",
		adminConfigured: Boolean(config.adminSecret),
		idleTimeoutSeconds: config.serverIdleTimeoutSeconds,
	})

	// idleTimeout: Bun default is 10s, which kills SSE chat streams during
	// Nemotron/Qwen pauses. 0 disables; otherwise seconds (Bun max 255).
	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		idleTimeout: config.serverIdleTimeoutSeconds,
		fetch: app.fetch,
	})

	log.info("lumen proxy listening", {
		url: `http://${server.hostname}:${server.port}/v1`,
		health: `http://${server.hostname}:${server.port}/health`,
		idleTimeoutSeconds: config.serverIdleTimeoutSeconds,
	})
}

main().catch((err) => {
	log.error("fatal", { error: err instanceof Error ? err.message : String(err) })
	process.exit(1)
})
