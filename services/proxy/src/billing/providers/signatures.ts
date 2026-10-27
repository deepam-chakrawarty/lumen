import { createHmac, timingSafeEqual } from "node:crypto"

export function hmacSha256Hex(secret: string, message: string): string {
	return createHmac("sha256", secret).update(message).digest("hex")
}

export function hmacSha256Base64(secret: string, message: string): string {
	return createHmac("sha256", secret).update(message).digest("base64")
}

export function safeEqualString(a: string, b: string): boolean {
	const ba = Buffer.from(a)
	const bb = Buffer.from(b)
	if (ba.length !== bb.length) return false
	return timingSafeEqual(ba, bb)
}

/**
 * Razorpay webhooks: HMAC-SHA256(rawBody, webhookSecret) as hex,
 * compared to `X-Razorpay-Signature`.
 * Docs: https://razorpay.com/docs/webhooks/validate-test
 */
export function verifyRazorpayWebhookSignature(
	rawBody: string,
	signature: string,
	webhookSecret: string,
): boolean {
	if (!webhookSecret || !signature) return false
	const expected = hmacSha256Hex(webhookSecret, rawBody)
	return safeEqualString(expected, signature)
}

/**
 * Cashfree subscriptions/PG webhooks:
 * Base64(HMAC-SHA256(timestamp + rawBody, secret)) vs `x-webhook-signature`.
 * Docs: https://www.cashfree.com/docs/payments/subscription/webhook-signature
 */
export function verifyCashfreeWebhookSignature(
	rawBody: string,
	signature: string,
	timestamp: string,
	webhookSecret: string,
): boolean {
	if (!webhookSecret || !signature || !timestamp) return false
	const expected = hmacSha256Base64(webhookSecret, `${timestamp}${rawBody}`)
	return safeEqualString(expected, signature)
}
