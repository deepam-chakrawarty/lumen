#!/usr/bin/env node

/**
 * vscode:prepublish entry. Skips when LUMEN_VSIX_PREBUILT=1 (package-vsix.mjs
 * already ran build:production). Otherwise runs the full package gate.
 */

import { execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")

if (process.env.LUMEN_VSIX_PREBUILT === "1") {
	console.log("vscode:prepublish: skipped (LUMEN_VSIX_PREBUILT=1)")
	process.exit(0)
}

execFileSync("bun", ["run", "package"], { stdio: "inherit", cwd: projectRoot })
