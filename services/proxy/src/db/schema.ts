/** SQL schema — shared between SQLite and Postgres (migration-ready). */

export const SCHEMA_VERSION = 1

/** SQLite DDL (default). */
export const SQLITE_MIGRATIONS: string[] = [
	`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		email TEXT,
		display_name TEXT,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS plan_keys (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		plan_id TEXT NOT NULL,
		key_hash TEXT NOT NULL UNIQUE,
		key_prefix TEXT NOT NULL,
		label TEXT,
		revoked_at TEXT,
		created_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_plan_keys_hash ON plan_keys(key_hash)`,
	`CREATE INDEX IF NOT EXISTS idx_plan_keys_user ON plan_keys(user_id)`,
	`CREATE TABLE IF NOT EXISTS usage_events (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		plan_key_id TEXT NOT NULL,
		logical_model TEXT NOT NULL,
		upstream_provider TEXT,
		upstream_model TEXT,
		prompt_tokens INTEGER NOT NULL DEFAULT 0,
		completion_tokens INTEGER NOT NULL DEFAULT 0,
		total_tokens INTEGER NOT NULL DEFAULT 0,
		streamed INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id),
		FOREIGN KEY (plan_key_id) REFERENCES plan_keys(id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_events(user_id, created_at)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_key_created ON usage_events(plan_key_id, created_at)`,
]

/** Postgres DDL — same tables with minor type differences. */
export const POSTGRES_MIGRATIONS: string[] = [
	`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`,
	`CREATE TABLE IF NOT EXISTS users (
		id TEXT PRIMARY KEY,
		email TEXT,
		display_name TEXT,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`,
	`CREATE TABLE IF NOT EXISTS plan_keys (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id),
		plan_id TEXT NOT NULL,
		key_hash TEXT NOT NULL UNIQUE,
		key_prefix TEXT NOT NULL,
		label TEXT,
		revoked_at TIMESTAMPTZ,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_plan_keys_hash ON plan_keys(key_hash)`,
	`CREATE INDEX IF NOT EXISTS idx_plan_keys_user ON plan_keys(user_id)`,
	`CREATE TABLE IF NOT EXISTS usage_events (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id),
		plan_key_id TEXT NOT NULL REFERENCES plan_keys(id),
		logical_model TEXT NOT NULL,
		upstream_provider TEXT,
		upstream_model TEXT,
		prompt_tokens INTEGER NOT NULL DEFAULT 0,
		completion_tokens INTEGER NOT NULL DEFAULT 0,
		total_tokens INTEGER NOT NULL DEFAULT 0,
		streamed INTEGER NOT NULL DEFAULT 0,
		status TEXT NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_events(user_id, created_at)`,
	`CREATE INDEX IF NOT EXISTS idx_usage_key_created ON usage_events(plan_key_id, created_at)`,
]

export type UserRow = {
	id: string
	email: string | null
	display_name: string | null
	created_at: string
}

export type PlanKeyRow = {
	id: string
	user_id: string
	plan_id: string
	key_hash: string
	key_prefix: string
	label: string | null
	revoked_at: string | null
	created_at: string
}

export type UsageEventRow = {
	id: string
	user_id: string
	plan_key_id: string
	logical_model: string
	upstream_provider: string | null
	upstream_model: string | null
	prompt_tokens: number
	completion_tokens: number
	total_tokens: number
	streamed: number
	status: string
	created_at: string
}
