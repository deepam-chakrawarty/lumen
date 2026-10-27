import { createHash, randomBytes } from "node:crypto"
import type { AppConfig } from "../config"
import type { AsyncDb } from "../db/client"
import { generatePlanKey, hashPlanKey, newId } from "../auth/keys"
import { planAfterEmailVerification, normalizeEmail } from "./edu"
import type { Mailer } from "./mailer"

function hashToken(token: string, pepper: string): string {
	return createHash("sha256").update(`${pepper}:verify:${token}`).digest("hex")
}

export function hashSessionToken(token: string, pepper: string): string {
	return createHash("sha256").update(`${pepper}:session:${token}`).digest("hex")
}

export type SignupResult = {
	userId: string
	email: string
	verificationSent: boolean
	/** Present only in test/dev when console mailer — never for production responses by default. */
	devVerificationToken?: string
}

export async function signupWithEmail(opts: {
	db: AsyncDb
	config: AppConfig
	mailer: Mailer
	email: string
	displayName?: string
	phone?: string
}): Promise<SignupResult> {
	const email = normalizeEmail(opts.email)
	if (!email.includes("@") || email.length < 5) {
		throw new Error("Valid email required")
	}

	let user = await opts.db.findUserByEmail(email)
	if (!user) {
		const userId = newId("user")
		user = await opts.db.ensureUser({
			id: userId,
			email,
			displayName: opts.displayName,
			phone: opts.phone,
			planId: opts.config.plans.defaultPlan,
		})
	} else if (opts.displayName || opts.phone) {
		user = await opts.db.ensureUser({
			id: user.id,
			email,
			displayName: opts.displayName,
			phone: opts.phone,
		})
	}

	const rawToken = randomBytes(24).toString("base64url")
	const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
	await opts.db.createEmailVerification({
		id: newId("verif"),
		user_id: user.id,
		email,
		token_hash: hashToken(rawToken, opts.config.sessionSecret),
		expires_at: expires,
		consumed_at: null,
		created_at: new Date().toISOString(),
	})

	const verifyUrl = `${opts.config.publicBaseUrl}/billing/verify?token=${encodeURIComponent(rawToken)}`
	await opts.mailer.send({
		to: email,
		subject: "Lumen — verify your email / email verify karo",
		text: [
			"Namaste!",
			"",
			"Verify your email to activate your Lumen account:",
			verifyUrl,
			"",
			"Link 24 hours ke liye valid hai.",
			"",
			"— Lumen",
		].join("\n"),
	})

	return {
		userId: user.id,
		email,
		verificationSent: true,
		devVerificationToken: opts.config.mailer === "console" ? rawToken : undefined,
	}
}

export type VerifyResult = {
	userId: string
	email: string
	planId: string
	sessionToken: string
	planKey: string
	keyPrefix: string
	edu: boolean
}

export async function verifyEmailAndIssueKey(opts: {
	db: AsyncDb
	config: AppConfig
	token: string
}): Promise<VerifyResult> {
	const row = await opts.db.findEmailVerificationByTokenHash(
		hashToken(opts.token, opts.config.sessionSecret),
	)
	if (!row) throw new Error("Invalid or expired verification token")
	if (row.consumed_at) throw new Error("Verification token already used")
	if (new Date(row.expires_at).getTime() < Date.now()) {
		throw new Error("Verification token expired")
	}

	const planId = planAfterEmailVerification(row.email, opts.config.plans.eduEmailAllowlist)
	const now = new Date().toISOString()
	await opts.db.consumeEmailVerification(row.id, now)
	await opts.db.setUserEmailVerified(row.user_id, now, planId)

	const { rawKey, prefix } = generatePlanKey()
	await opts.db.createPlanKey({
		id: newId("key"),
		userId: row.user_id,
		planId,
		keyHash: hashPlanKey(rawKey, opts.config.keyPepper),
		keyPrefix: prefix,
		label: "default",
	})

	const sessionToken = randomBytes(24).toString("base64url")
	const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
	await opts.db.createSession({
		id: newId("sess"),
		user_id: row.user_id,
		token_hash: hashSessionToken(sessionToken, opts.config.sessionSecret),
		expires_at: sessionExpires,
		created_at: now,
	})

	return {
		userId: row.user_id,
		email: row.email,
		planId,
		sessionToken,
		planKey: rawKey,
		keyPrefix: prefix,
		edu: planId === "edu",
	}
}

export async function rotatePlanKey(opts: {
	db: AsyncDb
	config: AppConfig
	userId: string
	label?: string
}): Promise<{ planKey: string; keyPrefix: string; planId: string }> {
	const user = await opts.db.findUserById(opts.userId)
	if (!user) throw new Error("User not found")
	const planId = user.plan_id || opts.config.plans.defaultPlan

	const existing = await opts.db.listPlanKeysForUser(opts.userId, false)
	for (const key of existing) {
		await opts.db.revokePlanKey(key.id)
	}

	const { rawKey, prefix } = generatePlanKey()
	await opts.db.createPlanKey({
		id: newId("key"),
		userId: opts.userId,
		planId,
		keyHash: hashPlanKey(rawKey, opts.config.keyPepper),
		keyPrefix: prefix,
		label: opts.label || "rotated",
	})

	return { planKey: rawKey, keyPrefix: prefix, planId }
}

export async function resolveSessionUser(opts: {
	db: AsyncDb
	config: AppConfig
	sessionToken: string | undefined | null
}) {
	if (!opts.sessionToken) return null
	const row = await opts.db.findSessionByTokenHash(
		hashSessionToken(opts.sessionToken, opts.config.sessionSecret),
	)
	if (!row) return null
	if (new Date(row.expires_at).getTime() < Date.now()) return null
	return opts.db.findUserById(row.user_id)
}
