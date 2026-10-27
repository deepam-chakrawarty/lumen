import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { PROXY_ROOT } from "../config"
import { log } from "../logger"
import {
	POSTGRES_MIGRATIONS,
	SCHEMA_VERSION,
	SQLITE_MIGRATIONS,
	type PlanKeyRow,
	type UsageEventRow,
	type UserRow,
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

	ensureUser(input: { id: string; email?: string; displayName?: string }): UserRow
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
	private db: Database

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

	close(): void {
		this.db.close()
	}

	ensureUser(input: { id: string; email?: string; displayName?: string }): UserRow {
		const existing = this.db.query("SELECT * FROM users WHERE id = ?").get(input.id) as UserRow | null
		if (existing) return existing
		const createdAt = nowIso()
		this.db.run("INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)", [
			input.id,
			input.email ?? null,
			input.displayName ?? null,
			createdAt,
		])
		return {
			id: input.id,
			email: input.email ?? null,
			display_name: input.displayName ?? null,
			created_at: createdAt,
		}
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

	listPlanKeys(includeRevoked = false): Array<PlanKeyRow & { email: string | null; display_name: string | null }> {
		const sql = includeRevoked
			? `SELECT pk.*, u.email, u.display_name FROM plan_keys pk JOIN users u ON u.id = pk.user_id ORDER BY pk.created_at DESC`
			: `SELECT pk.*, u.email, u.display_name FROM plan_keys pk JOIN users u ON u.id = pk.user_id WHERE pk.revoked_at IS NULL ORDER BY pk.created_at DESC`
		return this.db.query(sql).all() as Array<PlanKeyRow & { email: string | null; display_name: string | null }>
	}

	revokePlanKey(idOrPrefix: string): PlanKeyRow | null {
		const row = this.db
			.query(
				`SELECT * FROM plan_keys WHERE id = ? OR key_prefix = ? ORDER BY created_at DESC LIMIT 1`,
			)
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
		// sync wrapper — callers should await migrateAsync for postgres
		throw new Error("Use migrateAsync() for postgres")
	}

	async migrateAsync(): Promise<void> {
		if (!this.sql) await this.init()
		for (const statement of POSTGRES_MIGRATIONS) {
			await this.sql.unsafe(statement)
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

	ensureUser(input: { id: string; email?: string; displayName?: string }): UserRow {
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

	// --- async API used when driver=postgres ---

	async ensureUserAsync(input: { id: string; email?: string; displayName?: string }): Promise<UserRow> {
		const existing = await this.sql`SELECT * FROM users WHERE id = ${input.id}`
		if (existing[0]) return mapUser(existing[0])
		const rows = await this.sql`
			INSERT INTO users (id, email, display_name, created_at)
			VALUES (${input.id}, ${input.email ?? null}, ${input.displayName ?? null}, NOW())
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
}

function mapUser(r: any): UserRow {
	return {
		id: r.id,
		email: r.email ?? null,
		display_name: r.display_name ?? null,
		created_at: toIso(r.created_at),
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

function toIso(v: unknown): string {
	if (v instanceof Date) return v.toISOString()
	return String(v)
}

export type AsyncDb = {
	driver: DbDriver
	ensureUser(input: { id: string; email?: string; displayName?: string }): Promise<UserRow>
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
