<p align="center">
  <img src="apps/vscode/assets/icons/icon.png" width="80" alt="Lumen" />
</p>

<h1 align="center">Lumen</h1>

<p align="center">
AI coding assistant for Indian developers — Hinglish-native, proxy-routed models, built for daily use in VS Code.
</p>

<p align="center">
  <a href="./docs/LUMEN_DEV.md"><strong>Dev guide</strong></a>
  ·
  <a href="https://github.com/deepam-chakrawarty/lumen"><strong>GitHub</strong></a>
  ·
  <a href="./NOTICE"><strong>NOTICE</strong></a>
</p>

## About this fork

**Lumen** is a fork of [Cline](https://github.com/cline/cline) under the [Apache License 2.0](./LICENSE). Upstream copyright and attribution are retained; see [NOTICE](./NOTICE).

Phase 1 (this tree) focuses on:

1. **Rebrand** — Lumen display names, icons, commands, and activity bar
2. **Lumen provider** — OpenAI-compatible proxy (`http://localhost:8787/v1` by default) with plan-key auth and routing models `lumen-auto` / `lumen-fast` / `lumen-standard` / `lumen-strong`
3. **Hinglish persona** — system prompts that speak natural Hinglish while keeping tool formats in English
4. **No upstream telemetry** — Cline PostHog / cloud / marketplace hooks disabled

Later phases will add the routing proxy (Nemotron Nano / Mini, Qwen / DeepSeek fallback) and INR billing.

## Quick start (Extension Development Host)

```sh
bun install
bun run build:sdk
cd apps/vscode && bun run build:webview && bun esbuild.mjs
```

Then press **F5** (“Run Extension”) — see [docs/LUMEN_DEV.md](./docs/LUMEN_DEV.md).

## License

Apache License 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
