#!/usr/bin/env node

/**
 * Build a production Lumen .vsix for sideloading.
 *
 * - Ensures webview + extension host bundles exist (build:production)
 * - Swaps README.marketplace.md into README.md for the package (vsce has no
 *   reliable --readme-path that avoids a case-collision with README.md)
 * - Runs `vsce package --no-dependencies` (esbuild-bundled; bun workspace
 *   symlinks must not be walked)
 *
 * Usage:
 *   bun run package:vsix
 *   node scripts/package-vsix.mjs [--skip-build]
 */

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { restore, swapIn } from "./marketplace-readme.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, "..")
const skipBuild = process.argv.includes("--skip-build")

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
const version = pkg.version
const outName = `lumen-${version}.vsix`
const outPath = path.join(projectRoot, outName)

function run(cmd, args, opts = {}) {
	console.log(`$ ${cmd} ${args.join(" ")}`)
	execFileSync(cmd, args, { stdio: "inherit", cwd: projectRoot, ...opts })
}

function resolveVsce() {
	const require = createRequire(import.meta.url)
	try {
		return require.resolve("@vscode/vsce/vsce")
	} catch {
		const vscePkg = path.dirname(require.resolve("@vscode/vsce/package.json"))
		return path.join(vscePkg, "vsce")
	}
}

if (!skipBuild) {
	run("bun", ["run", "build:production"], {
		env: { ...process.env, CLINE_ENVIRONMENT: process.env.CLINE_ENVIRONMENT || "production" },
	})
}

for (const required of ["dist/extension.js", "webview-ui/build/index.html", "LICENSE", "assets/icons/icon.png"]) {
	const full = path.join(projectRoot, required)
	if (!fs.existsSync(full)) {
		console.error(`Missing required packaging input: ${required}`)
		process.exit(1)
	}
}

if (!fs.existsSync(path.join(projectRoot, "README.marketplace.md"))) {
	console.error("Missing README.marketplace.md")
	process.exit(1)
}

const swapResult = swapIn()
let failed = false
try {
	const vsceBin = resolveVsce()
	run(process.execPath, [vsceBin, "package", "--no-dependencies", "--allow-package-secrets", "sendgrid", "--out", outName], {
		env: {
			...process.env,
			CLINE_ENVIRONMENT: process.env.CLINE_ENVIRONMENT || "production",
			LUMEN_VSIX_PREBUILT: "1",
		},
	})
} catch (err) {
	failed = true
	console.error(err instanceof Error ? err.message : err)
} finally {
	if (!swapResult.skipped) {
		restore()
	}
}

if (failed) {
	process.exit(1)
}

if (!fs.existsSync(outPath)) {
	console.error(`Expected VSIX was not created: ${outPath}`)
	process.exit(1)
}

const sizeMb = (fs.statSync(outPath).size / (1024 * 1024)).toFixed(1)
console.log(`\nPackaged ${outName} (${sizeMb} MB)`)
console.log(outPath)
