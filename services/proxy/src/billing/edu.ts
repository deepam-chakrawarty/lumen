/**
 * Edu plan eligibility — verified emails whose domain ends with an allowlisted suffix.
 * Default allowlist: .edu.in, .ac.in (many Indian colleges use .ac.in).
 */

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase()
}

export function emailDomain(email: string): string | null {
	const normalized = normalizeEmail(email)
	const at = normalized.lastIndexOf("@")
	if (at <= 0 || at === normalized.length - 1) return null
	return normalized.slice(at + 1)
}

/** True when the email's domain ends with any allowlisted suffix (e.g. `.edu.in`). */
export function isEduEmail(email: string, allowlist: string[]): boolean {
	const domain = emailDomain(email)
	if (!domain) return false
	const suffixes = allowlist.map((s) => s.trim().toLowerCase()).filter(Boolean)
	return suffixes.some((suffix) => {
		const needle = suffix.startsWith(".") ? suffix : `.${suffix}`
		return domain === needle.slice(1) || domain.endsWith(needle)
	})
}

/** Pick Free vs Edu after successful email verification. */
export function planAfterEmailVerification(
	email: string,
	allowlist: string[],
	opts?: { eduPlanId?: string; freePlanId?: string },
): string {
	const eduPlan = opts?.eduPlanId ?? "edu"
	const freePlan = opts?.freePlanId ?? "free"
	return isEduEmail(email, allowlist) ? eduPlan : freePlan
}
