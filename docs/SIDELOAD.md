# Lumen — Sideload install (`.vsix`)

For first users (and daily driver Deepam). English + light Hinglish. Keep the original **Cline** extension disabled if it’s installed — dono ek saath mat chalao, conflict hoga.

## Install

**CLI**

```sh
code --install-extension lumen-0.1.0.vsix
```

Cursor / VSCodium: same idea — use that editor’s CLI, or **Extensions → ⋯ → Install from VSIX…** and pick `lumen-0.1.0.vsix`.

Reload the window if asked. Activity Bar pe Lumen lamp icon dikhna chahiye.

## First-run settings

`settings.json` (or Settings UI → search “Lumen”):

```json
{
  "lumen.proxyBaseUrl": "https://your-proxy.example/v1",
  "lumen.planKey": "your-plan-key",
  "lumen.defaultModel": "lumen-auto"
}
```

Model picker: `lumen-auto` / `lumen-fast` / `lumen-standard` / `lumen-strong`. Plan key Settings UI mein bhi set kar sakte ho — secrets commit mat karna.

## Update

Install the newer `.vsix` the same way (`--install-extension` overwrites). Reload window.

## Uninstall

```sh
code --uninstall-extension deepam-chakrawarty.lumen
```

Or Extensions panel → Lumen → Uninstall.

## Conflict with Cline

If `saoudrizwan.claude-dev` / Cline Nightly is installed, **Disable** it for this profile. Lumen is a fork — dono active = duplicate sidebars / command clashes.

## Builds

GitHub Actions workflow `lumen-vsix` builds the `.vsix` on `v*` tags and on manual dispatch, uploads an artifact, and attaches it to the GitHub Release for that tag. See `docs/LUMEN_DEV.md` for local `bun run package:vsix`.
