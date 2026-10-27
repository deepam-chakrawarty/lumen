import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

const KEY_PREFIX = "lmn_"

/** Generate an opaque plan key. Only the hash is stored. */
export function generatePlanKey(): { rawKey: string; prefix: string } {
	const secret = randomBytes(24).toString("base64url")
	const rawKey = `${KEY_PREFIX}${secret}`
	return { rawKey, prefix: rawKey.slice(0, 12) }
}

export function hashPlanKey(rawKey: string, pepper: string): string {
	return createHash("sha256").update(`${pepper}:${rawKey}`).digest("hex")
}

export function extractBearerToken(authorization: string | undefined | null): string | null {
	if (!authorization) return null
	const match = /^Bearer\s+(.+)$/i.exec(authorization.trim())
	if (!match) return null
	const token = match[1].trim()
	return token.length > 0 ? token : null
}

export function safeEqualHex(a: string, b: string): boolean {
	try {
		const ba = Buffer.from(a, "hex")
		const bb = Buffer.from(b, "hex")
		if (ba.length !== bb.length) return false
		return timingSafeEqual(ba, bb)
	} catch {
		return false
	}
}

export function newId(prefix: string): string {
	return `${prefix}_${randomBytes(12).toString("hex")}`
}
