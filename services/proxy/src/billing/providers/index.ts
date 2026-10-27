import type { AppConfig } from "../../config"
import { CashfreeProvider } from "./cashfree"
import { MockPaymentProvider } from "./mock"
import { RazorpayProvider } from "./razorpay"
import type { PaymentProvider } from "./types"

export type { PaymentProvider } from "./types"
export { verifyRazorpayWebhookSignature, verifyCashfreeWebhookSignature } from "./signatures"
export { signMockWebhook } from "./mock"

export function createPaymentProvider(config: AppConfig): PaymentProvider {
	switch (config.paymentProvider) {
		case "cashfree":
			return new CashfreeProvider(config)
		case "mock":
			return new MockPaymentProvider(config)
		case "razorpay":
		default:
			// Test mode without keys → mock so local billing pages still work.
			if (
				config.paymentTestMode &&
				(!config.razorpay.keyId || !config.razorpay.keySecret)
			) {
				return new MockPaymentProvider(config)
			}
			return new RazorpayProvider(config)
	}
}
