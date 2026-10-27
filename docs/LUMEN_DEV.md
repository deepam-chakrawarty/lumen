# Lumen — Extension Development Host

Lumen is a fork of [Cline](https://github.com/cline/cline) (Apache 2.0). This guide covers Phase 1 local development of the VS Code extension (`apps/vscode`, package `lumen`, publisher `deepam-chakrawarty`).

## Prerequisites

- **Bun 1.4.x** (package manager + scripts) and **Node ≥ 22**
- VS Code / Cursor with Extension Development Host support
- From the repo root: `bun install`

## Build

SDK packages resolve through compiled `dist/`. After changing `@cline/*` sources:

```sh
bun run build:sdk
```

VS Code extension (webview + extension host bundle):

```sh
cd apps/vscode
bun run build:webview   # ~15s
bun esbuild.mjs         # dist/extension.js
# or full production package:
bun run package
```

## Run in Extension Development Host (F5)

1. Open this repo in VS Code / Cursor.
2. Use launch config **Run Extension (production)** (or staging / local / Fresh Install) from `.vscode/launch.json`.
3. Press **F5**. A new Extension Development Host window opens with Lumen loaded from `apps/vscode`.
4. Click the Lumen lamp icon in the Activity Bar.

The launch configs disable both `deepam-chakrawarty.lumen` and upstream `saoudrizwan.claude-dev` / `saoudrizwan.cline-nightly` to avoid conflicts.

## Point at a local Lumen proxy

The default provider is **Lumen** (`lumen`), speaking OpenAI chat-completions at:

| Setting | Default | Where |
|---|---|---|
| Proxy base URL | `http://localhost:8787/v1` | VS Code `lumen.proxyBaseUrl` **or** Settings UI → Provider → Lumen → Proxy base URL |
| Plan key | _(empty)_ | VS Code `lumen.planKey` **or** Settings UI → **Lumen plan key** (Bearer token) |
| Model | `lumen-auto` | `lumen.defaultModel` / model picker: `lumen-auto`, `lumen-fast`, `lumen-standard`, `lumen-strong` |

Example `settings.json`:

```json
{
  "lumen.proxyBaseUrl": "http://localhost:8787/v1",
  "lumen.planKey": "your-local-plan-key",
  "lumen.defaultModel": "lumen-auto"
}
```

Do **not** commit plan keys. Prefer the Settings UI (stored in local provider settings) over checking secrets into git.

Phase 2 will implement the proxy (Nemotron / Qwen / DeepSeek routing). For Phase 1, any OpenAI-compatible `/v1/chat/completions` stub that accepts these model IDs is enough to exercise the extension.

## Tests

```sh
# SDK prompt / provider unit tests
cd sdk && bun -F @cline/shared test
cd sdk && bun -F @cline/llms test

# VS Code extension unit tests (no Extension Host)
cd apps/vscode && bun run test:unit
```

## Package a `.vsix`

```sh
# From repo root (builds SDK first if you changed it)
bun run build:sdk

cd apps/vscode
bun run package:vsix          # → lumen-<version>.vsix (e.g. lumen-0.1.0.vsix)
bun run smoke:vsix            # extract + @vscode/test-electron activate smoke
```

Sideload steps for first users: [`docs/SIDELOAD.md`](./SIDELOAD.md). CI: `.github/workflows/lumen-vsix.yml` (tags `v*` + workflow_dispatch).

Marketplace publisher ID (`deepam-chakrawarty`) is a placeholder until you create a real VS Marketplace publisher — update `publisher` in `apps/vscode/package.json` before publishing.

## Telemetry / upstream hooks (Phase 1)

- PostHog / `data.cline.bot` keys are cleared → NoOp telemetry.
- Built-in `app.cline.bot` / `api.cline.bot` endpoints are redirected to loopback placeholders.
- Upstream MCP/plugin marketplace catalog fetch is disabled.

See `NOTICE` and the PR description for details.
