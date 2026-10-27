/** Simple sliding-window per-key rate limiter (in-memory). */

type Bucket = {
	timestamps: number[]
}

const buckets = new Map<string, Bucket>()

export function checkRateLimit(
	key: string,
	limitPerMinute: number,
	now = Date.now(),
): { allowed: boolean; retryAfterSec: number } {
	const windowMs = 60_000
	let bucket = buckets.get(key)
	if (!bucket) {
		bucket = { timestamps: [] }
		buckets.set(key, bucket)
	}
	bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs)
	if (bucket.timestamps.length >= limitPerMinute) {
		const oldest = bucket.timestamps[0] ?? now
		const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000))
		return { allowed: false, retryAfterSec }
	}
	bucket.timestamps.push(now)
	return { allowed: true, retryAfterSec: 0 }
}

/** Test helper */
export function resetRateLimits(): void {
	buckets.clear()
}
