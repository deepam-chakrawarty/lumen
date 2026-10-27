#!/usr/bin/env bun
/**
 * Admin CLI for plan keys.
 *
 * Usage:
 *   bun run admin -- create-key --user deepam --plan free [--email you@example.com] [--label laptop]
 *   bun run admin -- list-keys [--include-revoked]
 *   bun run admin -- revoke-key <keyIdOrPrefix>
 */

import { loadConfig } from "../config"
import { openDatabase } from "../db/client"
import { generatePlanKey, hashPlanKey, newId } from "../auth/keys"

function usage(): never {
	console.log(`Lumen proxy admin CLI

Commands:
  create-key --user <id> --plan <free|edu|pro> [--email <email>] [--name <display>] [--label <label>]
  list-keys [--include-revoked]
  revoke-key <keyIdOrPrefix>
`)
	process.exit(1)
}

function flag(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name)
	if (idx < 0) return undefined
	return args[idx + 1]
}

function has(args: string[], name: string): boolean {
	return args.includes(name)
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2)
	const cmd = argv[0]
	if (!cmd || cmd === "-h" || cmd === "--help") usage()

	const config = loadConfig()
	const db = await openDatabase(config.databaseUrl)

	try {
		if (cmd === "create-key") {
			const user = flag(argv, "--user")
			const plan = flag(argv, "--plan") || config.plans.defaultPlan
			const email = flag(argv, "--email")
			const displayName = flag(argv, "--name")
			const label = flag(argv, "--label")
			if (!user) {
				console.error("--user is required")
				process.exit(1)
			}
			if (!config.plans.plans[plan]) {
				console.error(`Unknown plan '${plan}'. Valid: ${Object.keys(config.plans.plans).join(", ")}`)
				process.exit(1)
			}
			await db.ensureUser({ id: user, email, displayName })
			const { rawKey, prefix } = generatePlanKey()
			const row = await db.createPlanKey({
				id: newId("key"),
				userId: user,
				planId: plan,
				keyHash: hashPlanKey(rawKey, config.keyPepper),
				keyPrefix: prefix,
				label,
			})
			console.log(
				JSON.stringify(
					{
						id: row.id,
						user_id: row.user_id,
						plan_id: row.plan_id,
						key_prefix: row.key_prefix,
						plan_key: rawKey,
						note: "Store plan_key now — only the hash is kept in the database.",
					},
					null,
					2,
				),
			)
			return
		}

		if (cmd === "list-keys") {
			const rows = await db.listPlanKeys(has(argv, "--include-revoked"))
			console.log(
				JSON.stringify(
					rows.map((r) => ({
						id: r.id,
						user_id: r.user_id,
						email: r.email,
						plan_id: r.plan_id,
						key_prefix: r.key_prefix,
						label: r.label,
						revoked_at: r.revoked_at,
						created_at: r.created_at,
					})),
					null,
					2,
				),
			)
			return
		}

		if (cmd === "revoke-key") {
			const id = argv[1]
			if (!id) {
				console.error("revoke-key requires <keyIdOrPrefix>")
				process.exit(1)
			}
			const row = await db.revokePlanKey(id)
			if (!row) {
				console.error("Key not found")
				process.exit(1)
			}
			console.log(JSON.stringify({ id: row.id, key_prefix: row.key_prefix, revoked_at: row.revoked_at }, null, 2))
			return
		}

		usage()
	} finally {
		db.close()
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
