/**
 * GST helpers — amounts in paise (₹1 = 100 paise).
 * Configurable rate (default 18%) and inclusive vs exclusive list prices.
 */

export type GstBreakdown = {
	/** Amount the customer pays (always GST-inclusive total). */
	grossPaise: number
	/** Taxable value before GST. */
	netPaise: number
	/** GST component. */
	gstPaise: number
	gstRatePercent: number
	pricesGstInclusive: boolean
}

/** Split a configured plan price into net + GST given inclusive/exclusive mode. */
export function breakdownGst(input: {
	pricePaise: number
	gstRatePercent: number
	pricesGstInclusive: boolean
}): GstBreakdown {
	const rate = input.gstRatePercent
	const price = Math.max(0, Math.round(input.pricePaise))

	if (rate <= 0 || price === 0) {
		return {
			grossPaise: price,
			netPaise: price,
			gstPaise: 0,
			gstRatePercent: rate,
			pricesGstInclusive: input.pricesGstInclusive,
		}
	}

	if (input.pricesGstInclusive) {
		// gross = price; net = gross / (1 + r/100); gst = gross - net
		const netPaise = Math.round(price / (1 + rate / 100))
		const gstPaise = price - netPaise
		return {
			grossPaise: price,
			netPaise,
			gstPaise,
			gstRatePercent: rate,
			pricesGstInclusive: true,
		}
	}

	const gstPaise = Math.round((price * rate) / 100)
	return {
		grossPaise: price + gstPaise,
		netPaise: price,
		gstPaise,
		gstRatePercent: rate,
		pricesGstInclusive: false,
	}
}

/** Format paise as Indian Rupee string, e.g. 200000 → "₹2,000.00". */
export function formatInr(paise: number): string {
	const rupees = paise / 100
	return new Intl.NumberFormat("en-IN", {
		style: "currency",
		currency: "INR",
		minimumFractionDigits: 2,
	}).format(rupees)
}

/** Display line for invoices / receipts. */
export function invoiceGstLines(breakdown: GstBreakdown): {
	taxableValue: string
	gstLabel: string
	gstAmount: string
	total: string
} {
	return {
		taxableValue: formatInr(breakdown.netPaise),
		gstLabel: `GST (${breakdown.gstRatePercent}%)`,
		gstAmount: formatInr(breakdown.gstPaise),
		total: formatInr(breakdown.grossPaise),
	}
}
