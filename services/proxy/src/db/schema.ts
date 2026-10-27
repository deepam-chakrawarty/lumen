/** SQL schema — shared between SQLite and Postgres (migration-ready). */

export const SCHEMA_VERSION = 2

/** SQLite DDL (default). Phase 1 tables + Phase 3 billing. */
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
	// Phase 3 billing
	`CREATE TABLE IF NOT EXISTS email_verifications (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		email TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		expires_at TEXT NOT NULL,
		consumed_at TEXT,
		created_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_email_verif_token ON email_verifications(token_hash)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		expires_at TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)`,
	`CREATE TABLE IF NOT EXISTS subscriptions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		plan_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		provider_subscription_id TEXT,
		provider_plan_id TEXT,
		status TEXT NOT NULL,
		current_period_end TEXT,
		grace_until TEXT,
		cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
		cancelled_at TEXT,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_subs_provider ON subscriptions(provider, provider_subscription_id)`,
	`CREATE TABLE IF NOT EXISTS webhook_events (
		id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		event_id TEXT NOT NULL,
		event_type TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		processed_at TEXT NOT NULL,
		UNIQUE(provider, event_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_webhook_provider_event ON webhook_events(provider, event_id)`,
	`CREATE TABLE IF NOT EXISTS invoices (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		subscription_id TEXT,
		plan_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		provider_payment_id TEXT,
		currency TEXT NOT NULL DEFAULT 'INR',
		gross_paise INTEGER NOT NULL,
		net_paise INTEGER NOT NULL,
		gst_paise INTEGER NOT NULL,
		gst_rate_percent REAL NOT NULL,
		prices_gst_inclusive INTEGER NOT NULL,
		status TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (user_id) REFERENCES users(id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id)`,
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
	`CREATE TABLE IF NOT EXISTS email_verifications (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id),
		email TEXT NOT NULL,
		token_hash TEXT NOT NULL UNIQUE,
		expires_at TIMESTAMPTZ NOT NULL,
		consumed_at TIMESTAMPTZ,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_email_verif_token ON email_verifications(token_hash)`,
	`CREATE TABLE IF NOT EXISTS sessions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id),
		token_hash TEXT NOT NULL UNIQUE,
		expires_at TIMESTAMPTZ NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash)`,
	`CREATE TABLE IF NOT EXISTS subscriptions (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id),
		plan_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		provider_subscription_id TEXT,
		provider_plan_id TEXT,
		status TEXT NOT NULL,
		current_period_end TIMESTAMPTZ,
		grace_until TIMESTAMPTZ,
		cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
		cancelled_at TIMESTAMPTZ,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)`,
	`CREATE INDEX IF NOT EXISTS idx_subs_provider ON subscriptions(provider, provider_subscription_id)`,
	`CREATE TABLE IF NOT EXISTS webhook_events (
		id TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		event_id TEXT NOT NULL,
		event_type TEXT NOT NULL,
		payload_json TEXT NOT NULL,
		processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
		UNIQUE(provider, event_id)
	)`,
	`CREATE INDEX IF NOT EXISTS idx_webhook_provider_event ON webhook_events(provider, event_id)`,
	`CREATE TABLE IF NOT EXISTS invoices (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL REFERENCES users(id),
		subscription_id TEXT,
		plan_id TEXT NOT NULL,
		provider TEXT NOT NULL,
		provider_payment_id TEXT,
		currency TEXT NOT NULL DEFAULT 'INR',
		gross_paise INTEGER NOT NULL,
		net_paise INTEGER NOT NULL,
		gst_paise INTEGER NOT NULL,
		gst_rate_percent DOUBLE PRECISION NOT NULL,
		prices_gst_inclusive INTEGER NOT NULL,
		status TEXT NOT NULL,
		created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id)`,
]

/** Columns added to users in schema v2 (ALTER — applied separately). */
export const USER_BILLING_COLUMNS: Array<{ name: string; sqlite: string; postgres: string }> = [
	{ name: "email_verified_at", sqlite: "TEXT", postgres: "TIMESTAMPTZ" },
	{ name: "plan_id", sqlite: "TEXT", postgres: "TEXT" },
	{ name: "phone", sqlite: "TEXT", postgres: "TEXT" },
]

export type UserRow = {
	id: string
	email: string | null
	display_name: string | null
	created_at: string
	email_verified_at?: string | null
	plan_id?: string | null
	phone?: string | null
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

export type EmailVerificationRow = {
	id: string
	user_id: string
	email: string
	token_hash: string
	expires_at: string
	consumed_at: string | null
	created_at: string
}

export type SessionRow = {
	id: string
	user_id: string
	token_hash: string
	expires_at: string
	created_at: string
}

export type SubscriptionStatus =
	| "created"
	| "authenticated"
	| "active"
	| "past_due"
	| "cancelled"
	| "expired"
	| "halted"

export type SubscriptionRow = {
	id: string
	user_id: string
	plan_id: string
	provider: string
	provider_subscription_id: string | null
	provider_plan_id: string | null
	status: SubscriptionStatus | string
	current_period_end: string | null
	grace_until: string | null
	cancel_at_period_end: number
	cancelled_at: string | null
	created_at: string
	updated_at: string
}

export type WebhookEventRow = {
	id: string
	provider: string
	event_id: string
	event_type: string
	payload_json: string
	processed_at: string
}

export type InvoiceRow = {
	id: string
	user_id: string
	subscription_id: string | null
	plan_id: string
	provider: string
	provider_payment_id: string | null
	currency: string
	gross_paise: number
	net_paise: number
	gst_paise: number
	gst_rate_percent: number
	prices_gst_inclusive: number
	status: string
	created_at: string
}
