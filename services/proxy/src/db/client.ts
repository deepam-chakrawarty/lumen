import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { PROXY_ROOT } from "../config"
import { log } from "../logger"
import {
	POSTGRES_MIGRATIONS,
	SCHEMA_VERSION,
	SQLITE_MIGRATIONS,
	USER_BILLING_COLUMNS,
	type EmailVerificationRow,
	type InvoiceRow,
	type PlanKeyRow,
	type SessionRow,
	type SubscriptionRow,
	type UsageEventRow,
	type UserRow,
	type WebhookEventRow,
} from "./schema"

export type DbDriver = "sqlite" | "postgres"

export type AuthContext = {
	userId: string
	planKeyId: string
	planId: string
	keyPrefix: string
}

export interface DatabaseClient {
	readonly driver: DbDriver
	migrate(): void
	close(): void

	ensureUser(input: { id: string; email?: string; displayName?: string; planId?: string; phone?: string }): UserRow
	createPlanKey(input: {
		id: string
		userId: string
		planId: string
		keyHash: string
		keyPrefix: string
		label?: string
	}): PlanKeyRow
	listPlanKeys(includeRevoked?: boolean): Array<PlanKeyRow & { email: string | null; display_name: string | null }>
	revokePlanKey(idOrPrefix: string): PlanKeyRow | null
	findPlanKeyByHash(keyHash: string): PlanKeyRow | null

	insertUsage(event: Omit<UsageEventRow, "created_at"> & { created_at?: string }): void
	sumUsageTokens(userId: string, sinceIso: string): number
	listUsageForKey(planKeyId: string, sinceIso: string, limit?: number): UsageEventRow[]
}

function nowIso(): string {
	return new Date().toISOString()
}

function monthStartIso(d = new Date()): string {
	return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString()
}

export { monthStartIso }

class SqliteClient implements DatabaseClient {
	readonly driver = "sqlite" as const
	db: Database

	constructor(filePath: string) {
		mkdirSync(dirname(filePath), { recursive: true })
		this.db = new Database(filePath, { create: true })
		this.db.exec("PRAGMA foreign_keys = ON")
		this.db.exec("PRAGMA journal_mode = WAL")
	}

	migrate(): void {
		for (const sql of SQLITE_MIGRATIONS) {
			this.db.exec(sql)
		}
		this.ensureUserBillingColumns()
		const row = this.db.query("SELECT version FROM schema_migrations WHERE version = ?").get(SCHEMA_VERSION) as
			| { version: number }
			| null
		if (!row) {
			this.db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
				SCHEMA_VERSION,
				nowIso(),
			])
		}
		log.info("database migrated", { driver: this.driver, version: SCHEMA_VERSION })
	}

	private ensureUserBillingColumns(): void {
		const cols = this.db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>
		const existing = new Set(cols.map((c) => c.name))
		for (const col of USER_BILLING_COLUMNS) {
			if (!existing.has(col.name)) {
				this.db.exec(`ALTER TABLE users ADD COLUMN ${col.name} ${col.sqlite}`)
			}
		}
	}

	close(): void {
		this.db.close()
	}

	ensureUser(input: {
		id: string
		email?: string
		displayName?: string
		planId?: string
		phone?: string
	}): UserRow {
		const existing = this.db.query("SELECT * FROM users WHERE id = ?").get(input.id) as UserRow | null
		if (existing) {
			if (input.email || input.displayName || input.planId || input.phone) {
				this.db.run(
					`UPDATE users SET
						email = COALESCE(?, email),
						display_name = COALESCE(?, display_name),
						plan_id = COALESCE(?, plan_id),
						phone = COALESCE(?, phone)
					 WHERE id = ?`,
					[
						input.email ?? null,
						input.displayName ?? null,
						input.planId ?? null,
						input.phone ?? null,
						input.id,
					],
				)
				return this.db.query("SELECT * FROM users WHERE id = ?").get(input.id) as UserRow
			}
			return existing
		}
		const createdAt = nowIso()
		this.db.run(
			`INSERT INTO users (id, email, display_name, created_at, email_verified_at, plan_id, phone)
			 VALUES (?, ?, ?, ?, NULL, ?, ?)`,
			[
				input.id,
				input.email ?? null,
				input.displayName ?? null,
				createdAt,
				input.planId ?? null,
				input.phone ?? null,
			],
		)
		return {
			id: input.id,
			email: input.email ?? null,
			display_name: input.displayName ?? null,
			created_at: createdAt,
			email_verified_at: null,
			plan_id: input.planId ?? null,
			phone: input.phone ?? null,
		}
	}

	findUserByEmail(email: string): UserRow | null {
		return this.db
			.query("SELECT * FROM users WHERE lower(email) = lower(?) LIMIT 1")
			.get(email) as UserRow | null
	}

	findUserById(id: string): UserRow | null {
		return this.db.query("SELECT * FROM users WHERE id = ?").get(id) as UserRow | null
	}

	setUserEmailVerified(userId: string, verifiedAt: string, planId?: string): void {
		if (planId) {
			this.db.run(
				`UPDATE users SET email_verified_at = ?, plan_id = COALESCE(?, plan_id) WHERE id = ?`,
				[verifiedAt, planId, userId],
			)
		} else {
			this.db.run(`UPDATE users SET email_verified_at = ? WHERE id = ?`, [verifiedAt, userId])
		}
	}

	setUserPlan(userId: string, planId: string): void {
		this.db.run(`UPDATE users SET plan_id = ? WHERE id = ?`, [planId, userId])
	}

	createPlanKey(input: {
		id: string
		userId: string
		planId: string
		keyHash: string
		keyPrefix: string
		label?: string
	}): PlanKeyRow {
		const createdAt = nowIso()
		this.db.run(
			`INSERT INTO plan_keys (id, user_id, plan_id, key_hash, key_prefix, label, revoked_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
			[input.id, input.userId, input.planId, input.keyHash, input.keyPrefix, input.label ?? null, createdAt],
		)
		return {
			id: input.id,
			user_id: input.userId,
			plan_id: input.planId,
			key_hash: input.keyHash,
			key_prefix: input.keyPrefix,
			label: input.label ?? null,
			revoked_at: null,
			created_at: createdAt,
		}
	}

	updatePlanKeysPlan(userId: string, planId: string): void {
		this.db.run(`UPDATE plan_keys SET plan_id = ? WHERE user_id = ? AND revoked_at IS NULL`, [
			planId,
			userId,
		])
	}

	listPlanKeysForUser(userId: string, includeRevoked = false): PlanKeyRow[] {
		const sql = includeRevoked
			? `SELECT * FROM plan_keys WHERE user_id = ? ORDER BY created_at DESC`
			: `SELECT * FROM plan_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`
		return this.db.query(sql).all(userId) as PlanKeyRow[]
	}

	listPlanKeys(includeRevoked = false): Array<PlanKeyRow & { email: string | null; display_name: string | null }> {
		const sql = includeRevoked
			? `SELECT pk.*, u.email, u.display_name FROM plan_keys pk JOIN users u ON u.id = pk.user_id ORDER BY pk.created_at DESC`
			: `SELECT pk.*, u.email, u.display_name FROM plan_keys pk JOIN users u ON u.id = pk.user_id WHERE pk.revoked_at IS NULL ORDER BY pk.created_at DESC`
		return this.db.query(sql).all() as Array<PlanKeyRow & { email: string | null; display_name: string | null }>
	}

	revokePlanKey(idOrPrefix: string): PlanKeyRow | null {
		const row = this.db
			.query(`SELECT * FROM plan_keys WHERE id = ? OR key_prefix = ? ORDER BY created_at DESC LIMIT 1`)
			.get(idOrPrefix, idOrPrefix) as PlanKeyRow | null
		if (!row || row.revoked_at) return row
		const revokedAt = nowIso()
		this.db.run("UPDATE plan_keys SET revoked_at = ? WHERE id = ?", [revokedAt, row.id])
		return { ...row, revoked_at: revokedAt }
	}

	findPlanKeyByHash(keyHash: string): PlanKeyRow | null {
		return this.db
			.query("SELECT * FROM plan_keys WHERE key_hash = ? AND revoked_at IS NULL")
			.get(keyHash) as PlanKeyRow | null
	}

	insertUsage(event: Omit<UsageEventRow, "created_at"> & { created_at?: string }): void {
		this.db.run(
			`INSERT INTO usage_events
			 (id, user_id, plan_key_id, logical_model, upstream_provider, upstream_model,
			  prompt_tokens, completion_tokens, total_tokens, streamed, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				event.id,
				event.user_id,
				event.plan_key_id,
				event.logical_model,
				event.upstream_provider,
				event.upstream_model,
				event.prompt_tokens,
				event.completion_tokens,
				event.total_tokens,
				event.streamed,
				event.status,
				event.created_at ?? nowIso(),
			],
		)
	}

	sumUsageTokens(userId: string, sinceIso: string): number {
		const row = this.db
			.query(
				`SELECT COALESCE(SUM(total_tokens), 0) AS total FROM usage_events
				 WHERE user_id = ? AND created_at >= ? AND status = 'ok'`,
			)
			.get(userId, sinceIso) as { total: number }
		return Number(row.total) || 0
	}

	listUsageForKey(planKeyId: string, sinceIso: string, limit = 100): UsageEventRow[] {
		return this.db
			.query(
				`SELECT * FROM usage_events WHERE plan_key_id = ? AND created_at >= ?
				 ORDER BY created_at DESC LIMIT ?`,
			)
			.all(planKeyId, sinceIso, limit) as UsageEventRow[]
	}

	createEmailVerification(row: EmailVerificationRow): void {
		this.db.run(
			`INSERT INTO email_verifications (id, user_id, email, token_hash, expires_at, consumed_at, created_at)
			 VALUES (?, ?, ?, ?, ?, NULL, ?)`,
			[row.id, row.user_id, row.email, row.token_hash, row.expires_at, row.created_at],
		)
	}

	findEmailVerificationByTokenHash(tokenHash: string): EmailVerificationRow | null {
		return this.db
			.query(`SELECT * FROM email_verifications WHERE token_hash = ?`)
			.get(tokenHash) as EmailVerificationRow | null
	}

	consumeEmailVerification(id: string, consumedAt: string): void {
		this.db.run(`UPDATE email_verifications SET consumed_at = ? WHERE id = ?`, [consumedAt, id])
	}

	createSession(row: SessionRow): void {
		this.db.run(
			`INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
			[row.id, row.user_id, row.token_hash, row.expires_at, row.created_at],
		)
	}

	findSessionByTokenHash(tokenHash: string): SessionRow | null {
		return this.db.query(`SELECT * FROM sessions WHERE token_hash = ?`).get(tokenHash) as SessionRow | null
	}

	deleteSession(id: string): void {
		this.db.run(`DELETE FROM sessions WHERE id = ?`, [id])
	}

	upsertSubscription(row: SubscriptionRow): void {
		const byId = this.db.query(`SELECT id FROM subscriptions WHERE id = ?`).get(row.id) as
			| { id: string }
			| null
		const byProvider =
			!byId && row.provider_subscription_id
				? (this.db
						.query(
							`SELECT id FROM subscriptions WHERE provider = ? AND provider_subscription_id = ? LIMIT 1`,
						)
						.get(row.provider, row.provider_subscription_id) as { id: string } | null)
				: null
		const existing = byId || byProvider
		if (existing) {
			this.db.run(
				`UPDATE subscriptions SET
					plan_id = ?, status = ?, current_period_end = ?, grace_until = ?,
					cancel_at_period_end = ?, cancelled_at = ?, provider_plan_id = ?,
					provider_subscription_id = COALESCE(?, provider_subscription_id), updated_at = ?
				 WHERE id = ?`,
				[
					row.plan_id,
					row.status,
					row.current_period_end,
					row.grace_until,
					row.cancel_at_period_end,
					row.cancelled_at,
					row.provider_plan_id,
					row.provider_subscription_id,
					row.updated_at,
					existing.id,
				],
			)
			return
		}
		this.db.run(
			`INSERT INTO subscriptions
			 (id, user_id, plan_id, provider, provider_subscription_id, provider_plan_id, status,
			  current_period_end, grace_until, cancel_at_period_end, cancelled_at, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				row.id,
				row.user_id,
				row.plan_id,
				row.provider,
				row.provider_subscription_id,
				row.provider_plan_id,
				row.status,
				row.current_period_end,
				row.grace_until,
				row.cancel_at_period_end,
				row.cancelled_at,
				row.created_at,
				row.updated_at,
			],
		)
	}

	findSubscriptionById(id: string): SubscriptionRow | null {
		return this.db.query(`SELECT * FROM subscriptions WHERE id = ?`).get(id) as SubscriptionRow | null
	}

	findSubscriptionByProviderId(provider: string, providerSubscriptionId: string): SubscriptionRow | null {
		return this.db
			.query(
				`SELECT * FROM subscriptions WHERE provider = ? AND provider_subscription_id = ? LIMIT 1`,
			)
			.get(provider, providerSubscriptionId) as SubscriptionRow | null
	}

	findActiveSubscriptionForUser(userId: string): SubscriptionRow | null {
		return this.db
			.query(
				`SELECT * FROM subscriptions WHERE user_id = ?
				 AND status IN ('created','authenticated','active','past_due')
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.get(userId) as SubscriptionRow | null
	}

	listSubscriptionsForUser(userId: string): SubscriptionRow[] {
		return this.db
			.query(`SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC`)
			.all(userId) as SubscriptionRow[]
	}

	tryInsertWebhookEvent(row: WebhookEventRow): boolean {
		try {
			this.db.run(
				`INSERT INTO webhook_events (id, provider, event_id, event_type, payload_json, processed_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[row.id, row.provider, row.event_id, row.event_type, row.payload_json, row.processed_at],
			)
			return true
		} catch {
			return false
		}
	}

	insertInvoice(row: InvoiceRow): void {
		this.db.run(
			`INSERT INTO invoices
			 (id, user_id, subscription_id, plan_id, provider, provider_payment_id, currency,
			  gross_paise, net_paise, gst_paise, gst_rate_percent, prices_gst_inclusive, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				row.id,
				row.user_id,
				row.subscription_id,
				row.plan_id,
				row.provider,
				row.provider_payment_id,
				row.currency,
				row.gross_paise,
				row.net_paise,
				row.gst_paise,
				row.gst_rate_percent,
				row.prices_gst_inclusive,
				row.status,
				row.created_at,
			],
		)
	}

	listInvoicesForUser(userId: string, limit = 20): InvoiceRow[] {
		return this.db
			.query(`SELECT * FROM invoices WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`)
			.all(userId, limit) as InvoiceRow[]
	}
}

class PostgresClient implements DatabaseClient {
	readonly driver = "postgres" as const
	private sql: any

	constructor(private connectionString: string) {}

	async init(): Promise<void> {
		const postgres = (await import("postgres")).default
		this.sql = postgres(this.connectionString, { max: 5 })
	}

	migrate(): void {
		throw new Error("Use migrateAsync() for postgres")
	}

	async migrateAsync(): Promise<void> {
		if (!this.sql) await this.init()
		for (const statement of POSTGRES_MIGRATIONS) {
			await this.sql.unsafe(statement)
		}
		for (const col of USER_BILLING_COLUMNS) {
			await this.sql.unsafe(
				`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${col.name} ${col.postgres}`,
			)
		}
		const rows = await this.sql`SELECT version FROM schema_migrations WHERE version = ${SCHEMA_VERSION}`
		if (rows.length === 0) {
			await this.sql`INSERT INTO schema_migrations (version, applied_at) VALUES (${SCHEMA_VERSION}, NOW())`
		}
		log.info("database migrated", { driver: this.driver, version: SCHEMA_VERSION })
	}

	close(): void {
		void this.sql?.end?.({ timeout: 5 })
	}

	ensureUser(): UserRow {
		throw new Error("Use async postgres helpers via repository wrappers")
	}
	createPlanKey(): PlanKeyRow {
		throw new Error("Use async postgres helpers via repository wrappers")
	}
	listPlanKeys(): Array<PlanKeyRow & { email: string | null; display_name: string | null }> {
		throw new Error("Use async postgres helpers via repository wrappers")
	}
	revokePlanKey(): PlanKeyRow | null {
		throw new Error("Use async postgres helpers via repository wrappers")
	}
	findPlanKeyByHash(): PlanKeyRow | null {
		throw new Error("Use async postgres helpers via repository wrappers")
	}
	insertUsage(): void {
		throw new Error("Use async postgres helpers via repository wrappers")
	}
	sumUsageTokens(): number {
		throw new Error("Use async postgres helpers via repository wrappers")
	}
	listUsageForKey(): UsageEventRow[] {
		throw new Error("Use async postgres helpers via repository wrappers")
	}

	async ensureUserAsync(input: {
		id: string
		email?: string
		displayName?: string
		planId?: string
		phone?: string
	}): Promise<UserRow> {
		const existing = await this.sql`SELECT * FROM users WHERE id = ${input.id}`
		if (existing[0]) {
			if (input.email || input.displayName || input.planId || input.phone) {
				const rows = await this.sql`
					UPDATE users SET
						email = COALESCE(${input.email ?? null}, email),
						display_name = COALESCE(${input.displayName ?? null}, display_name),
						plan_id = COALESCE(${input.planId ?? null}, plan_id),
						phone = COALESCE(${input.phone ?? null}, phone)
					 WHERE id = ${input.id}
					 RETURNING *`
				return mapUser(rows[0])
			}
			return mapUser(existing[0])
		}
		const rows = await this.sql`
			INSERT INTO users (id, email, display_name, created_at, email_verified_at, plan_id, phone)
			VALUES (${input.id}, ${input.email ?? null}, ${input.displayName ?? null}, NOW(), NULL, ${input.planId ?? null}, ${input.phone ?? null})
			RETURNING *`
		return mapUser(rows[0])
	}

	async createPlanKeyAsync(input: {
		id: string
		userId: string
		planId: string
		keyHash: string
		keyPrefix: string
		label?: string
	}): Promise<PlanKeyRow> {
		const rows = await this.sql`
			INSERT INTO plan_keys (id, user_id, plan_id, key_hash, key_prefix, label, revoked_at, created_at)
			VALUES (${input.id}, ${input.userId}, ${input.planId}, ${input.keyHash}, ${input.keyPrefix}, ${input.label ?? null}, NULL, NOW())
			RETURNING *`
		return mapPlanKey(rows[0])
	}

	async listPlanKeysAsync(
		includeRevoked = false,
	): Promise<Array<PlanKeyRow & { email: string | null; display_name: string | null }>> {
		const rows = includeRevoked
			? await this.sql`
				SELECT pk.*, u.email, u.display_name FROM plan_keys pk
				JOIN users u ON u.id = pk.user_id ORDER BY pk.created_at DESC`
			: await this.sql`
				SELECT pk.*, u.email, u.display_name FROM plan_keys pk
				JOIN users u ON u.id = pk.user_id WHERE pk.revoked_at IS NULL
				ORDER BY pk.created_at DESC`
		return rows.map((r: any) => ({ ...mapPlanKey(r), email: r.email, display_name: r.display_name }))
	}

	async revokePlanKeyAsync(idOrPrefix: string): Promise<PlanKeyRow | null> {
		const found = await this.sql`
			SELECT * FROM plan_keys WHERE id = ${idOrPrefix} OR key_prefix = ${idOrPrefix}
			ORDER BY created_at DESC LIMIT 1`
		if (!found[0]) return null
		if (found[0].revoked_at) return mapPlanKey(found[0])
		const rows = await this.sql`
			UPDATE plan_keys SET revoked_at = NOW() WHERE id = ${found[0].id} RETURNING *`
		return mapPlanKey(rows[0])
	}

	async findPlanKeyByHashAsync(keyHash: string): Promise<PlanKeyRow | null> {
		const rows = await this.sql`
			SELECT * FROM plan_keys WHERE key_hash = ${keyHash} AND revoked_at IS NULL`
		return rows[0] ? mapPlanKey(rows[0]) : null
	}

	async insertUsageAsync(event: Omit<UsageEventRow, "created_at"> & { created_at?: string }): Promise<void> {
		await this.sql`
			INSERT INTO usage_events
			 (id, user_id, plan_key_id, logical_model, upstream_provider, upstream_model,
			  prompt_tokens, completion_tokens, total_tokens, streamed, status, created_at)
			VALUES (
				${event.id}, ${event.user_id}, ${event.plan_key_id}, ${event.logical_model},
				${event.upstream_provider}, ${event.upstream_model},
				${event.prompt_tokens}, ${event.completion_tokens}, ${event.total_tokens},
				${event.streamed}, ${event.status}, ${event.created_at ?? nowIso()}
			)`
	}

	async sumUsageTokensAsync(userId: string, sinceIso: string): Promise<number> {
		const rows = await this.sql`
			SELECT COALESCE(SUM(total_tokens), 0)::int AS total FROM usage_events
			WHERE user_id = ${userId} AND created_at >= ${sinceIso} AND status = 'ok'`
		return Number(rows[0]?.total) || 0
	}

	async listUsageForKeyAsync(planKeyId: string, sinceIso: string, limit = 100): Promise<UsageEventRow[]> {
		const rows = await this.sql`
			SELECT * FROM usage_events WHERE plan_key_id = ${planKeyId} AND created_at >= ${sinceIso}
			ORDER BY created_at DESC LIMIT ${limit}`
		return rows.map(mapUsage)
	}

	async findUserByEmailAsync(email: string): Promise<UserRow | null> {
		const rows = await this.sql`SELECT * FROM users WHERE lower(email) = lower(${email}) LIMIT 1`
		return rows[0] ? mapUser(rows[0]) : null
	}

	async findUserByIdAsync(id: string): Promise<UserRow | null> {
		const rows = await this.sql`SELECT * FROM users WHERE id = ${id}`
		return rows[0] ? mapUser(rows[0]) : null
	}

	async setUserEmailVerifiedAsync(userId: string, verifiedAt: string, planId?: string): Promise<void> {
		if (planId) {
			await this.sql`UPDATE users SET email_verified_at = ${verifiedAt}, plan_id = COALESCE(${planId}, plan_id) WHERE id = ${userId}`
		} else {
			await this.sql`UPDATE users SET email_verified_at = ${verifiedAt} WHERE id = ${userId}`
		}
	}

	async setUserPlanAsync(userId: string, planId: string): Promise<void> {
		await this.sql`UPDATE users SET plan_id = ${planId} WHERE id = ${userId}`
	}

	async updatePlanKeysPlanAsync(userId: string, planId: string): Promise<void> {
		await this.sql`UPDATE plan_keys SET plan_id = ${planId} WHERE user_id = ${userId} AND revoked_at IS NULL`
	}

	async listPlanKeysForUserAsync(userId: string, includeRevoked = false): Promise<PlanKeyRow[]> {
		const rows = includeRevoked
			? await this.sql`SELECT * FROM plan_keys WHERE user_id = ${userId} ORDER BY created_at DESC`
			: await this.sql`SELECT * FROM plan_keys WHERE user_id = ${userId} AND revoked_at IS NULL ORDER BY created_at DESC`
		return rows.map(mapPlanKey)
	}

	async createEmailVerificationAsync(row: EmailVerificationRow): Promise<void> {
		await this.sql`
			INSERT INTO email_verifications (id, user_id, email, token_hash, expires_at, consumed_at, created_at)
			VALUES (${row.id}, ${row.user_id}, ${row.email}, ${row.token_hash}, ${row.expires_at}, NULL, ${row.created_at})`
	}

	async findEmailVerificationByTokenHashAsync(tokenHash: string): Promise<EmailVerificationRow | null> {
		const rows = await this.sql`SELECT * FROM email_verifications WHERE token_hash = ${tokenHash}`
		return rows[0] ? mapEmailVerif(rows[0]) : null
	}

	async consumeEmailVerificationAsync(id: string, consumedAt: string): Promise<void> {
		await this.sql`UPDATE email_verifications SET consumed_at = ${consumedAt} WHERE id = ${id}`
	}

	async createSessionAsync(row: SessionRow): Promise<void> {
		await this.sql`
			INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
			VALUES (${row.id}, ${row.user_id}, ${row.token_hash}, ${row.expires_at}, ${row.created_at})`
	}

	async findSessionByTokenHashAsync(tokenHash: string): Promise<SessionRow | null> {
		const rows = await this.sql`SELECT * FROM sessions WHERE token_hash = ${tokenHash}`
		return rows[0] ? mapSession(rows[0]) : null
	}

	async deleteSessionAsync(id: string): Promise<void> {
		await this.sql`DELETE FROM sessions WHERE id = ${id}`
	}

	async upsertSubscriptionAsync(row: SubscriptionRow): Promise<void> {
		const byId = await this.sql`SELECT id FROM subscriptions WHERE id = ${row.id}`
		let targetId: string | null = byId[0]?.id ?? null
		if (!targetId && row.provider_subscription_id) {
			const byProvider = await this.sql`
				SELECT id FROM subscriptions WHERE provider = ${row.provider}
				 AND provider_subscription_id = ${row.provider_subscription_id} LIMIT 1`
			targetId = byProvider[0]?.id ?? null
		}
		if (targetId) {
			await this.sql`
				UPDATE subscriptions SET
					plan_id = ${row.plan_id}, status = ${row.status},
					current_period_end = ${row.current_period_end}, grace_until = ${row.grace_until},
					cancel_at_period_end = ${row.cancel_at_period_end}, cancelled_at = ${row.cancelled_at},
					provider_plan_id = ${row.provider_plan_id},
					provider_subscription_id = COALESCE(${row.provider_subscription_id}, provider_subscription_id),
					updated_at = ${row.updated_at}
				 WHERE id = ${targetId}`
			return
		}
		await this.sql`
			INSERT INTO subscriptions
			 (id, user_id, plan_id, provider, provider_subscription_id, provider_plan_id, status,
			  current_period_end, grace_until, cancel_at_period_end, cancelled_at, created_at, updated_at)
			VALUES (
				${row.id}, ${row.user_id}, ${row.plan_id}, ${row.provider}, ${row.provider_subscription_id},
				${row.provider_plan_id}, ${row.status}, ${row.current_period_end}, ${row.grace_until},
				${row.cancel_at_period_end}, ${row.cancelled_at}, ${row.created_at}, ${row.updated_at}
			)`
	}

	async findSubscriptionByIdAsync(id: string): Promise<SubscriptionRow | null> {
		const rows = await this.sql`SELECT * FROM subscriptions WHERE id = ${id}`
		return rows[0] ? mapSubscription(rows[0]) : null
	}

	async findSubscriptionByProviderIdAsync(
		provider: string,
		providerSubscriptionId: string,
	): Promise<SubscriptionRow | null> {
		const rows = await this.sql`
			SELECT * FROM subscriptions WHERE provider = ${provider}
			 AND provider_subscription_id = ${providerSubscriptionId} LIMIT 1`
		return rows[0] ? mapSubscription(rows[0]) : null
	}

	async findActiveSubscriptionForUserAsync(userId: string): Promise<SubscriptionRow | null> {
		const rows = await this.sql`
			SELECT * FROM subscriptions WHERE user_id = ${userId}
			 AND status IN ('created','authenticated','active','past_due')
			 ORDER BY created_at DESC LIMIT 1`
		return rows[0] ? mapSubscription(rows[0]) : null
	}

	async listSubscriptionsForUserAsync(userId: string): Promise<SubscriptionRow[]> {
		const rows = await this.sql`
			SELECT * FROM subscriptions WHERE user_id = ${userId} ORDER BY created_at DESC`
		return rows.map(mapSubscription)
	}

	async tryInsertWebhookEventAsync(row: WebhookEventRow): Promise<boolean> {
		try {
			await this.sql`
				INSERT INTO webhook_events (id, provider, event_id, event_type, payload_json, processed_at)
				VALUES (${row.id}, ${row.provider}, ${row.event_id}, ${row.event_type}, ${row.payload_json}, ${row.processed_at})`
			return true
		} catch {
			return false
		}
	}

	async insertInvoiceAsync(row: InvoiceRow): Promise<void> {
		await this.sql`
			INSERT INTO invoices
			 (id, user_id, subscription_id, plan_id, provider, provider_payment_id, currency,
			  gross_paise, net_paise, gst_paise, gst_rate_percent, prices_gst_inclusive, status, created_at)
			VALUES (
				${row.id}, ${row.user_id}, ${row.subscription_id}, ${row.plan_id}, ${row.provider},
				${row.provider_payment_id}, ${row.currency}, ${row.gross_paise}, ${row.net_paise},
				${row.gst_paise}, ${row.gst_rate_percent}, ${row.prices_gst_inclusive}, ${row.status}, ${row.created_at}
			)`
	}

	async listInvoicesForUserAsync(userId: string, limit = 20): Promise<InvoiceRow[]> {
		const rows = await this.sql`
			SELECT * FROM invoices WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}`
		return rows.map(mapInvoice)
	}
}

function mapUser(r: any): UserRow {
	return {
		id: r.id,
		email: r.email ?? null,
		display_name: r.display_name ?? null,
		created_at: toIso(r.created_at),
		email_verified_at: r.email_verified_at ? toIso(r.email_verified_at) : null,
		plan_id: r.plan_id ?? null,
		phone: r.phone ?? null,
	}
}

function mapPlanKey(r: any): PlanKeyRow {
	return {
		id: r.id,
		user_id: r.user_id,
		plan_id: r.plan_id,
		key_hash: r.key_hash,
		key_prefix: r.key_prefix,
		label: r.label ?? null,
		revoked_at: r.revoked_at ? toIso(r.revoked_at) : null,
		created_at: toIso(r.created_at),
	}
}

function mapUsage(r: any): UsageEventRow {
	return {
		id: r.id,
		user_id: r.user_id,
		plan_key_id: r.plan_key_id,
		logical_model: r.logical_model,
		upstream_provider: r.upstream_provider ?? null,
		upstream_model: r.upstream_model ?? null,
		prompt_tokens: Number(r.prompt_tokens) || 0,
		completion_tokens: Number(r.completion_tokens) || 0,
		total_tokens: Number(r.total_tokens) || 0,
		streamed: Number(r.streamed) || 0,
		status: r.status,
		created_at: toIso(r.created_at),
	}
}

function mapEmailVerif(r: any): EmailVerificationRow {
	return {
		id: r.id,
		user_id: r.user_id,
		email: r.email,
		token_hash: r.token_hash,
		expires_at: toIso(r.expires_at),
		consumed_at: r.consumed_at ? toIso(r.consumed_at) : null,
		created_at: toIso(r.created_at),
	}
}

function mapSession(r: any): SessionRow {
	return {
		id: r.id,
		user_id: r.user_id,
		token_hash: r.token_hash,
		expires_at: toIso(r.expires_at),
		created_at: toIso(r.created_at),
	}
}

function mapSubscription(r: any): SubscriptionRow {
	return {
		id: r.id,
		user_id: r.user_id,
		plan_id: r.plan_id,
		provider: r.provider,
		provider_subscription_id: r.provider_subscription_id ?? null,
		provider_plan_id: r.provider_plan_id ?? null,
		status: r.status,
		current_period_end: r.current_period_end ? toIso(r.current_period_end) : null,
		grace_until: r.grace_until ? toIso(r.grace_until) : null,
		cancel_at_period_end: Number(r.cancel_at_period_end) || 0,
		cancelled_at: r.cancelled_at ? toIso(r.cancelled_at) : null,
		created_at: toIso(r.created_at),
		updated_at: toIso(r.updated_at),
	}
}

function mapInvoice(r: any): InvoiceRow {
	return {
		id: r.id,
		user_id: r.user_id,
		subscription_id: r.subscription_id ?? null,
		plan_id: r.plan_id,
		provider: r.provider,
		provider_payment_id: r.provider_payment_id ?? null,
		currency: r.currency,
		gross_paise: Number(r.gross_paise) || 0,
		net_paise: Number(r.net_paise) || 0,
		gst_paise: Number(r.gst_paise) || 0,
		gst_rate_percent: Number(r.gst_rate_percent) || 0,
		prices_gst_inclusive: Number(r.prices_gst_inclusive) || 0,
		status: r.status,
		created_at: toIso(r.created_at),
	}
}

function toIso(v: unknown): string {
	if (v instanceof Date) return v.toISOString()
	return String(v)
}

export type AsyncDb = {
	driver: DbDriver
	ensureUser(input: {
		id: string
		email?: string
		displayName?: string
		planId?: string
		phone?: string
	}): Promise<UserRow>
	createPlanKey(input: {
		id: string
		userId: string
		planId: string
		keyHash: string
		keyPrefix: string
		label?: string
	}): Promise<PlanKeyRow>
	listPlanKeys(includeRevoked?: boolean): Promise<Array<PlanKeyRow & { email: string | null; display_name: string | null }>>
	revokePlanKey(idOrPrefix: string): Promise<PlanKeyRow | null>
	findPlanKeyByHash(keyHash: string): Promise<PlanKeyRow | null>
	insertUsage(event: Omit<UsageEventRow, "created_at"> & { created_at?: string }): Promise<void>
	sumUsageTokens(userId: string, sinceIso: string): Promise<number>
	listUsageForKey(planKeyId: string, sinceIso: string, limit?: number): Promise<UsageEventRow[]>
	findUserByEmail(email: string): Promise<UserRow | null>
	findUserById(id: string): Promise<UserRow | null>
	setUserEmailVerified(userId: string, verifiedAt: string, planId?: string): Promise<void>
	setUserPlan(userId: string, planId: string): Promise<void>
	updatePlanKeysPlan(userId: string, planId: string): Promise<void>
	listPlanKeysForUser(userId: string, includeRevoked?: boolean): Promise<PlanKeyRow[]>
	createEmailVerification(row: EmailVerificationRow): Promise<void>
	findEmailVerificationByTokenHash(tokenHash: string): Promise<EmailVerificationRow | null>
	consumeEmailVerification(id: string, consumedAt: string): Promise<void>
	createSession(row: SessionRow): Promise<void>
	findSessionByTokenHash(tokenHash: string): Promise<SessionRow | null>
	deleteSession(id: string): Promise<void>
	upsertSubscription(row: SubscriptionRow): Promise<void>
	findSubscriptionById(id: string): Promise<SubscriptionRow | null>
	findSubscriptionByProviderId(provider: string, providerSubscriptionId: string): Promise<SubscriptionRow | null>
	findActiveSubscriptionForUser(userId: string): Promise<SubscriptionRow | null>
	listSubscriptionsForUser(userId: string): Promise<SubscriptionRow[]>
	tryInsertWebhookEvent(row: WebhookEventRow): Promise<boolean>
	insertInvoice(row: InvoiceRow): Promise<void>
	listInvoicesForUser(userId: string, limit?: number): Promise<InvoiceRow[]>
	close(): void
}

function wrapSqlite(db: SqliteClient): AsyncDb {
	return {
		driver: "sqlite",
		ensureUser: async (i) => db.ensureUser(i),
		createPlanKey: async (i) => db.createPlanKey(i),
		listPlanKeys: async (r) => db.listPlanKeys(r),
		revokePlanKey: async (id) => db.revokePlanKey(id),
		findPlanKeyByHash: async (h) => db.findPlanKeyByHash(h),
		insertUsage: async (e) => db.insertUsage(e),
		sumUsageTokens: async (u, s) => db.sumUsageTokens(u, s),
		listUsageForKey: async (k, s, l) => db.listUsageForKey(k, s, l),
		findUserByEmail: async (e) => db.findUserByEmail(e),
		findUserById: async (id) => db.findUserById(id),
		setUserEmailVerified: async (u, v, p) => db.setUserEmailVerified(u, v, p),
		setUserPlan: async (u, p) => db.setUserPlan(u, p),
		updatePlanKeysPlan: async (u, p) => db.updatePlanKeysPlan(u, p),
		listPlanKeysForUser: async (u, r) => db.listPlanKeysForUser(u, r),
		createEmailVerification: async (row) => db.createEmailVerification(row),
		findEmailVerificationByTokenHash: async (h) => db.findEmailVerificationByTokenHash(h),
		consumeEmailVerification: async (id, at) => db.consumeEmailVerification(id, at),
		createSession: async (row) => db.createSession(row),
		findSessionByTokenHash: async (h) => db.findSessionByTokenHash(h),
		deleteSession: async (id) => db.deleteSession(id),
		upsertSubscription: async (row) => db.upsertSubscription(row),
		findSubscriptionById: async (id) => db.findSubscriptionById(id),
		findSubscriptionByProviderId: async (p, id) => db.findSubscriptionByProviderId(p, id),
		findActiveSubscriptionForUser: async (u) => db.findActiveSubscriptionForUser(u),
		listSubscriptionsForUser: async (u) => db.listSubscriptionsForUser(u),
		tryInsertWebhookEvent: async (row) => db.tryInsertWebhookEvent(row),
		insertInvoice: async (row) => db.insertInvoice(row),
		listInvoicesForUser: async (u, l) => db.listInvoicesForUser(u, l),
		close: () => db.close(),
	}
}

function wrapPostgres(db: PostgresClient): AsyncDb {
	return {
		driver: "postgres",
		ensureUser: (i) => db.ensureUserAsync(i),
		createPlanKey: (i) => db.createPlanKeyAsync(i),
		listPlanKeys: (r) => db.listPlanKeysAsync(r),
		revokePlanKey: (id) => db.revokePlanKeyAsync(id),
		findPlanKeyByHash: (h) => db.findPlanKeyByHashAsync(h),
		insertUsage: (e) => db.insertUsageAsync(e),
		sumUsageTokens: (u, s) => db.sumUsageTokensAsync(u, s),
		listUsageForKey: (k, s, l) => db.listUsageForKeyAsync(k, s, l),
		findUserByEmail: (e) => db.findUserByEmailAsync(e),
		findUserById: (id) => db.findUserByIdAsync(id),
		setUserEmailVerified: (u, v, p) => db.setUserEmailVerifiedAsync(u, v, p),
		setUserPlan: (u, p) => db.setUserPlanAsync(u, p),
		updatePlanKeysPlan: (u, p) => db.updatePlanKeysPlanAsync(u, p),
		listPlanKeysForUser: (u, r) => db.listPlanKeysForUserAsync(u, r),
		createEmailVerification: (row) => db.createEmailVerificationAsync(row),
		findEmailVerificationByTokenHash: (h) => db.findEmailVerificationByTokenHashAsync(h),
		consumeEmailVerification: (id, at) => db.consumeEmailVerificationAsync(id, at),
		createSession: (row) => db.createSessionAsync(row),
		findSessionByTokenHash: (h) => db.findSessionByTokenHashAsync(h),
		deleteSession: (id) => db.deleteSessionAsync(id),
		upsertSubscription: (row) => db.upsertSubscriptionAsync(row),
		findSubscriptionById: (id) => db.findSubscriptionByIdAsync(id),
		findSubscriptionByProviderId: (p, id) => db.findSubscriptionByProviderIdAsync(p, id),
		findActiveSubscriptionForUser: (u) => db.findActiveSubscriptionForUserAsync(u),
		listSubscriptionsForUser: (u) => db.listSubscriptionsForUserAsync(u),
		tryInsertWebhookEvent: (row) => db.tryInsertWebhookEventAsync(row),
		insertInvoice: (row) => db.insertInvoiceAsync(row),
		listInvoicesForUser: (u, l) => db.listInvoicesForUserAsync(u, l),
		close: () => db.close(),
	}
}

export async function openDatabase(databaseUrl: string): Promise<AsyncDb> {
	if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
		const client = new PostgresClient(databaseUrl)
		await client.init()
		await client.migrateAsync()
		return wrapPostgres(client)
	}

	let path = databaseUrl
	if (path.startsWith("sqlite:")) {
		path = path.slice("sqlite:".length)
	}
	const filePath = resolve(PROXY_ROOT, path)
	const client = new SqliteClient(filePath)
	client.migrate()
	return wrapSqlite(client)
}
