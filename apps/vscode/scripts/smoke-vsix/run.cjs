/**
 * Extension-host smoke checks against a packaged Lumen VSIX (extracted).
 * Loaded by @vscode/test-electron via extensionTestsPath.
 *
 * @typedef {import('vscode')} vscode
 */

const assert = require("node:assert/strict")
const vscode = require("vscode")

const EXTENSION_ID = "deepam-chakrawarty.lumen"

/**
 * @param {number} ms
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

async function run() {
	const ext = vscode.extensions.getExtension(EXTENSION_ID)
	assert.ok(ext, `Extension ${EXTENSION_ID} should be discoverable`)

	const pkg = ext.packageJSON
	assert.equal(pkg.name, "lumen")
	assert.equal(pkg.publisher, "deepam-chakrawarty")
	assert.ok(pkg.version, "package version should be set")

	// Contributed settings
	const props = pkg.contributes?.configuration?.properties || {}
	for (const key of ["lumen.proxyBaseUrl", "lumen.planKey", "lumen.defaultModel"]) {
		assert.ok(props[key], `Missing configuration property ${key}`)
	}

	// Sidebar view
	const views = pkg.contributes?.views?.["lumen-ActivityBar"] || pkg.contributes?.views?.["lumen-sidebar"] || []
	const allViews = Object.values(pkg.contributes?.views || {}).flat()
	assert.ok(
		allViews.some((v) => v.id === "lumen.SidebarProvider"),
		"lumen.SidebarProvider view should be contributed",
	)

	const containers = pkg.contributes?.viewsContainers?.activitybar || []
	assert.ok(
		containers.some((c) => c.id?.includes("lumen") || c.title?.toLowerCase?.().includes("lumen")),
		"Lumen activity bar container should be contributed",
	)

	// Commands
	const commands = (pkg.contributes?.commands || []).map((c) => c.command)
	for (const cmd of ["lumen.plusButtonClicked", "lumen.settingsButtonClicked", "lumen.focusChatInput"]) {
		assert.ok(commands.includes(cmd), `Missing command ${cmd}`)
	}

	// Activate
	await ext.activate()
	assert.ok(ext.isActive, "Extension should activate")

	// Give the sidebar provider a moment to register
	await sleep(500)

	const allCmds = await vscode.commands.getCommands(true)
	assert.ok(allCmds.includes("lumen.plusButtonClicked"), "lumen.plusButtonClicked should be registered at runtime")
	assert.ok(allCmds.includes("lumen.settingsButtonClicked"), "lumen.settingsButtonClicked should be registered at runtime")

	console.log("smoke-vsix: ok — extension activated, views/commands/settings present")
}

module.exports = { run }
