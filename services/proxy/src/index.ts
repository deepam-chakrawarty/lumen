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
	})

	const server = Bun.serve({
		hostname: config.host,
		port: config.port,
		fetch: app.fetch,
	})

	log.info("lumen proxy listening", {
		url: `http://${server.hostname}:${server.port}/v1`,
		health: `http://${server.hostname}:${server.port}/health`,
	})
}

main().catch((err) => {
	log.error("fatal", { error: err instanceof Error ? err.message : String(err) })
	process.exit(1)
})
