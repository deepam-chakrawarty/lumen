import * as vscode from "vscode"

/** Default OpenAI-compatible proxy base URL for the Lumen provider. */
export const LUMEN_DEFAULT_PROXY_BASE_URL = "http://localhost:8787/v1"

/** Default routing model for new Lumen installs. */
export const LUMEN_DEFAULT_MODEL_ID = "lumen-auto"

/**
 * Reads Lumen-specific VS Code settings (`lumen.*`).
 * These complement (and can seed) the provider Settings UI / providers.json values.
 */
export function getLumenVsCodeSettings(): {
	proxyBaseUrl: string
	planKey: string
	defaultModel: string
} {
	const config = vscode.workspace.getConfiguration("lumen")
	const proxyBaseUrl = (config.get<string>("proxyBaseUrl") || LUMEN_DEFAULT_PROXY_BASE_URL).trim()
	const planKey = (config.get<string>("planKey") || "").trim()
	const defaultModel = (config.get<string>("defaultModel") || LUMEN_DEFAULT_MODEL_ID).trim()
	return {
		proxyBaseUrl: proxyBaseUrl || LUMEN_DEFAULT_PROXY_BASE_URL,
		planKey,
		defaultModel: defaultModel || LUMEN_DEFAULT_MODEL_ID,
	}
}
