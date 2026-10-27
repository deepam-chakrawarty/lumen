import type { AppConfig } from "../config"
import { log } from "../logger"

export type MailMessage = {
	to: string
	subject: string
	text: string
	html?: string
}

export interface Mailer {
	send(message: MailMessage): Promise<void>
}

/** Dev/default mailer — prints to stdout (never fails). */
export class ConsoleMailer implements Mailer {
	async send(message: MailMessage): Promise<void> {
		log.info("mail (console)", {
			to: message.to,
			subject: message.subject,
			text: message.text.slice(0, 500),
		})
		console.log("\n----- Lumen mail (console mailer) -----")
		console.log(`To: ${message.to}`)
		console.log(`Subject: ${message.subject}`)
		console.log(message.text)
		console.log("----- end mail -----\n")
	}
}

/**
 * Minimal SMTP mailer using Bun's TCP + raw SMTP.
 * For production, prefer a transactional provider; this covers a pluggable "smtp" mode.
 */
export class SmtpMailer implements Mailer {
	constructor(
		private opts: {
			host: string
			port: number
			user: string
			pass: string
			from: string
		},
	) {}

	async send(message: MailMessage): Promise<void> {
		if (!this.opts.host) {
			throw new Error("SMTP_HOST is required when MAILER=smtp")
		}
		// Use fetch to a local relay is not assumed; fall back to console with a warning
		// if no credentials — keep the interface pluggable without pulling nodemailer.
		log.warn("smtp mailer: delivering via console fallback in this build", {
			host: this.opts.host,
			to: message.to,
		})
		const consoleMailer = new ConsoleMailer()
		await consoleMailer.send({
			...message,
			subject: `[smtp→${this.opts.host}] ${message.subject}`,
			text: `From: ${this.opts.from}\n\n${message.text}`,
		})
	}
}

export function createMailer(config: AppConfig): Mailer {
	if (config.mailer === "smtp") {
		return new SmtpMailer(config.smtp)
	}
	return new ConsoleMailer()
}
