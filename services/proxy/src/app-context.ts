import type { AppConfig } from "./config"
import type { AsyncDb } from "./db/client"
import type { AuthContext } from "./db/client"

export type Variables = {
	auth: AuthContext
	requestId: string
}

export type AppEnv = {
	Variables: Variables
	Bindings: {
		config: AppConfig
		db: AsyncDb
	}
}

declare module "hono" {
	interface ContextVariableMap extends Variables {}
}
