#!/usr/bin/env node

/**
 * Install/activation smoke test for a packaged Lumen .vsix.
 *
 * 1. Locates (or builds) lumen-<version>.vsix
 * 2. Extracts it and statically asserts package.json contributions
 * 3. Launches a headless VS Code via @vscode/test-electron with the
 *    extracted extension as extensionDevelopmentPath and runs
 *    scripts/smoke-vsix/run.cjs (activate + command registration)
 *
 * Usage:
 *   bun run smoke:vsix
 *   node scripts/smoke-vsix.mjs [path/to/lumen-0.1.0.vsix]
 */

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.join(__dirname, "..")
const require = createRequire(import.meta.url)

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
const version = pkg.version
const defaultVsix = path.join(projectRoot, `lumen-${version}.vsix`)
const vsixPath = path.resolve(process.argv[2] || defaultVsix)

function ensureVsix() {
	if (fs.existsSync(vsixPath)) return
	console.log(`VSIX not found at ${vsixPath}; building via package:vsix…`)
	execFileSync("bun", ["run", "package:vsix"], { stdio: "inherit", cwd: projectRoot })
	assert.ok(fs.existsSync(vsixPath), `Expected ${vsixPath} after package:vsix`)
}

function unzipVsix(vsix, dest) {
	fs.rmSync(dest, { recursive: true, force: true })
	fs.mkdirSync(dest, { recursive: true })
	execFileSync("unzip", ["-q", vsix, "-d", dest], { stdio: "inherit" })
	const extensionDir = path.join(dest, "extension")
	assert.ok(fs.existsSync(path.join(extensionDir, "package.json")), "VSIX missing extension/package.json")
	return extensionDir
}

function staticChecks(extensionDir) {
	const packaged = JSON.parse(fs.readFileSync(path.join(extensionDir, "package.json"), "utf8"))
	assert.equal(packaged.name, "lumen")
	assert.equal(packaged.publisher, "deepam-chakrawarty")
	assert.equal(packaged.version, version)
	assert.equal(packaged.engines?.vscode, pkg.engines.vscode)

	const props = packaged.contributes?.configuration?.properties || {}
	for (const key of ["lumen.proxyBaseUrl", "lumen.planKey", "lumen.defaultModel"]) {
		assert.ok(props[key], `packaged package.json missing ${key}`)
	}

	const views = packaged.contributes?.views?.["lumen-ActivityBar"] || []
	assert.ok(
		views.some((v) => v.id === "lumen.SidebarProvider"),
		"missing lumen.SidebarProvider view",
	)

	assert.ok(fs.existsSync(path.join(extensionDir, "dist", "extension.js")), "missing dist/extension.js")
	assert.ok(fs.existsSync(path.join(extensionDir, "webview-ui", "build", "index.html")), "missing webview build")
	assert.ok(fs.existsSync(path.join(extensionDir, "assets", "icons", "icon.png")), "missing icon")
	assert.ok(
		fs.existsSync(path.join(extensionDir, "LICENSE")) || fs.existsSync(path.join(extensionDir, "LICENSE.txt")),
		"missing LICENSE",
	)

	const sizeMb = (fs.statSync(vsixPath).size / (1024 * 1024)).toFixed(1)
	console.log(`static ok: ${packaged.publisher}.${packaged.name}@${packaged.version} (${sizeMb} MB)`)
	console.log(`engines.vscode = ${packaged.engines.vscode}`)
	return packaged
}

async function runElectronSmoke(extensionDir) {
	const { downloadAndUnzipVSCode, runTests } = require("@vscode/test-electron")

	const version = process.env.VSCODE_TEST_VERSION || "stable"
	console.log(`Downloading VS Code (${version})…`)
	const vscodeExecutablePath = await downloadAndUnzipVSCode(version)
	console.log(`VS Code at ${vscodeExecutablePath}`)

	const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-smoke-ws-"))
	fs.writeFileSync(path.join(workspaceDir, "README.md"), "# Lumen smoke workspace\n")

	const userDataDir = path.join(
		os.tmpdir(),
		`lumen-smoke-ud-${createHash("sha256").update(extensionDir).digest("hex").slice(0, 8)}`,
	)
	fs.rmSync(userDataDir, { recursive: true, force: true })
	fs.mkdirSync(userDataDir, { recursive: true })

	const extensionTestsPath = path.join(__dirname, "smoke-vsix", "run.cjs")

	const launchArgs = [
		workspaceDir,
		`--user-data-dir=${userDataDir}`,
		"--disable-extensions",
		"--disable-workspace-trust",
		"--no-sandbox",
		"--disable-gpu",
	]

	console.log("Launching Extension Host smoke…")
	await runTests({
		vscodeExecutablePath,
		extensionDevelopmentPath: extensionDir,
		extensionTestsPath,
		launchArgs,
		extensionTestsEnv: {
			...process.env,
			DISPLAY: process.env.DISPLAY || ":1",
		},
	})
}

async function main() {
	ensureVsix()
	assert.ok(fs.existsSync(vsixPath), `VSIX not found: ${vsixPath}`)

	const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lumen-vsix-"))
	try {
		const extensionDir = unzipVsix(vsixPath, extractRoot)
		const packaged = staticChecks(extensionDir)

		// Cursor / VSCodium note (engines field only — no install attempted here)
		const engine = packaged.engines.vscode
		console.log(
			`engines note: engines.vscode=${engine} — compatible with VS Code, and with Cursor/VSCodium builds that declare the same VS Code engine range.`,
		)

		await runElectronSmoke(extensionDir)
		console.log("\nsmoke:vsix passed")
	} finally {
		fs.rmSync(extractRoot, { recursive: true, force: true })
	}
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
