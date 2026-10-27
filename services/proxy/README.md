# Lumen Proxy

Thin OpenAI-compatible plan-key proxy for the Lumen VS Code extension (Phase 2).

Listens on **port 8787** by default and speaks the same contract as Phase 1:

| Client setting | Value |
|---|---|
| Base URL | `http://localhost:8787/v1` (`lumen.proxyBaseUrl`) |
| Auth | `Authorization: Bearer <plan key>` (`lumen.planKey`) |
| Models | `lumen-auto`, `lumen-fast`, `lumen-standard`, `lumen-strong` |

Apache 2.0. This service is part of the Lumen fork of [Cline](https://github.com/cline/cline); keep upstream attribution (see repo `NOTICE` / `LICENSE`).

## Features

- **Plan-key auth** — opaque `lmn_…` keys; only SHA-256 hashes (with pepper) are stored
- **Routing** — logical models → NVIDIA NIM / DashScope Qwen / DeepSeek with YAML config + fallback
- **`lumen-auto`** — transparent heuristic (prompt size, tools, task keywords)
- **Metering** — prompt/completion tokens per user; SQLite by default (Postgres-ready URL); `GET /v1/usage`
- **Quotas & rate limits** — per-plan monthly token caps + per-key RPM
- **Admin** — CLI and `/admin/*` endpoints (admin secret)
- **Health** — `GET /health`, `GET /healthz`
- **Structured logs** — no prompt bodies / secrets by default

## Quick start (local)

```bash
cd services/proxy
cp .env.example .env
# Set at least ADMIN_SECRET, KEY_PEPPER, and upstream keys you plan to use:
#   NVIDIA_API_KEY=...
#   DASHSCOPE_API_KEY=...
#   DEEPSEEK_API_KEY=...

bun install
bun run start
# → http://127.0.0.1:8787/v1
```

### Create a plan key

```bash
bun run admin -- create-key --user deepam --plan free --email you@example.com --label laptop
```

Copy the returned `plan_key` (shown once). Then list / revoke:

```bash
bun run admin -- list-keys
bun run admin -- revoke-key <keyIdOrPrefix>
```

HTTP admin (same operations) with header `x-admin-secret: $ADMIN_SECRET`:

- `POST /admin/keys`
- `GET /admin/keys`
- `POST /admin/keys/:id/revoke`

### Point the Lumen extension at the proxy

In VS Code / Cursor settings:

```json
{
  "lumen.proxyBaseUrl": "http://localhost:8787/v1",
  "lumen.planKey": "lmn_…",
  "lumen.defaultModel": "lumen-auto"
}
```

Or Settings UI → Provider **Lumen** → Proxy base URL + **Lumen plan key**.

### Smoke test

```bash
curl -s http://127.0.0.1:8787/health | jq
curl -s http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer $PLAN_KEY" | jq
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $PLAN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"lumen-fast","messages":[{"role":"user","content":"ping"}]}' | jq
curl -s http://127.0.0.1:8787/v1/usage \
  -H "Authorization: Bearer $PLAN_KEY" | jq
```

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/health` | none | Provider configured flags (no secrets) |
| GET | `/healthz` | none | Liveness |
| GET | `/v1/models` | plan key | Logical models |
| POST | `/v1/chat/completions` | plan key | Streaming SSE + non-stream; tools/functions passed through |
| GET | `/v1/usage` | plan key | Monthly quota + recent events (includes upstream model) |
| * | `/admin/*` | `x-admin-secret` | Key management |

OpenAI-style error JSON on **401 / 403 / 429 / 400** (`invalid_api_key`, `model_not_allowed`, `insufficient_quota`, `rate_limit_exceeded`, `context_length_exceeded`).

## Model routing

Configured in [`config/models.yaml`](./config/models.yaml):

| Logical | Primary upstream | Fallback |
|---|---|---|
| `lumen-fast` | NVIDIA `nvidia/nemotron-3-nano-30b-a3b` | other Nano / Lightning on NIM |
| `lumen-standard` | NVIDIA `nvidia/nemotron-mini-4b-instruct` | Lightning / Nemotron Super |
| `lumen-strong` | DashScope `qwen3-coder-plus` | DeepSeek `deepseek-v4-pro` → `deepseek-flash` |
| `lumen-auto` | heuristic → one of the above | same fallback chain from chosen tier upward |

### Size-aware routing

Every route declares a required `contextWindow` (tokens) and optional `maxOutputTokens` from provider docs.

For each request the proxy estimates:

`required = promptTokens(messages + tools/functions) + max_tokens(or default 8192) + contextSafetyMargin(1024)`

Then **skips** any route with `contextWindow < required` (logged). Explicit tiers and `lumen-auto` both use this filter. If `lumen-auto`’s required tokens exceed `auto.strongContextTokens` (128k), it bumps straight to **strong** so heavy agent prompts land on `qwen3-coder-plus` first (with `deepseek-v4-pro` as the immediate backup).

If **no** route fits → OpenAI-style **400** `context_length_exceeded` (upstream is never called).

### Fallback

Retries the next route on upstream **error / timeout / 429**, and also on **400 / 413 / 422** when the body indicates a context/length overflow (`context_length_exceeded`, “maximum context length”, “too many tokens”, “input is too long”, …). Other 400s stay non-retryable.

### Context windows (docs checked 2026-10-27)

| Model | contextWindow | maxOutputTokens | Source |
|---|---:|---:|---|
| `nvidia/nemotron-3-nano-30b-a3b` | 128000 | 32768 | [NIM model](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b) (API max input 128K; card/HF up to 1M/262K — **API limit used**); [infer max_tokens](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b-infer) |
| `nvidia/nvidia-nemotron-nano-9b-v2` | 128000 | — | [NIM model](https://docs.api.nvidia.com/nim/reference/nvidia-nvidia-nemotron-nano-9b-v2) (“up to 128K”; build.nvidia.com 131K — **API 128K used**). Infer page does not publish a distinct max_tokens cap. |
| `nvidia/nemotron-3.5-lightning-30b-a3b` | 1000000 | 32768 | [NIM model](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b) (hosted API “up to 1M”; self-hosted NIM default 262144); [infer](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-5-lightning-30b-a3b-infer) |
| `nvidia/nemotron-mini-4b-instruct` | 4096 | 4096 | [NIM model](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-mini-4b-instruct); [infer](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-mini-4b-instruct-infer) |
| `nvidia/llama-3.3-nemotron-super-49b-v1.5` | 131072 | 65536 | [NIM model](https://docs.api.nvidia.com/nim/reference/nvidia-llama-3_3-nemotron-super-49b-v1_5); [infer](https://docs.api.nvidia.com/nim/re/reference/nvidia-llama-3_3-nemotron-super-49b-v1_5-infer) |
| `qwen3-coder-plus` | 1000000 | 65536 | [Model Studio qwen3-coder-plus](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-coder-plus) |
| `deepseek-flash` | 1000000 | 384000 | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) |
| `deepseek-v4-pro` | 1000000 | 384000 | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) |

### Upstream verification (docs checked 2026-10-27)

| Provider | Base URL | Model IDs | Source |
|---|---|---|---|
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `nvidia/nemotron-3-nano-30b-a3b`, `nvidia/nvidia-nemotron-nano-9b-v2`, `nvidia/nemotron-mini-4b-instruct`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `nvidia/llama-3.3-nemotron-super-49b-v1.5` | [docs.api.nvidia.com/nim/reference/llm-apis](https://docs.api.nvidia.com/nim/reference/llm-apis), [build.nvidia.com](https://build.nvidia.com), [nemotron-mini docs](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-mini-4b-instruct-infer) |
| DashScope / Model Studio | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-coder-plus` | [qwen3-coder-plus](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/qwen3-coder-plus); [OpenAI-compatible chat](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope) |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash`, `deepseek-v4-pro` | [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/) |

Env keys used: `NVIDIA_API_KEY`, `DASHSCOPE_API_KEY`, `DEEPSEEK_API_KEY` (never logged or returned).

## Plans & quotas

See [`config/plans.yaml`](./config/plans.yaml). Phase 3 billing can hook into `plan_id` + `monthlyTokenLimit`.

| Plan | Monthly tokens (default) | RPM |
|---|---|---|
| `free` | 2_000_000 | 30 |
| `edu` | 5_000_000 | 60 |
| `pro` | 30_000_000 | 120 |

Free tier allows all logical models so daily coding works before billing lands.

## Database

- Default: `DATABASE_URL=sqlite:./data/lumen.db` (auto-migrated)
- Postgres-ready: `DATABASE_URL=postgres://user:pass@host:5432/lumen` (requires optional `postgres` package at runtime)

Schema lives in `src/db/schema.ts` with versioned migrations for both drivers.

## Tests

```bash
cd services/proxy
bun install
bun test
```

Integration tests spin up an in-process mock upstream covering streaming, tool calls, fallback, quota exceeded, bad keys, size-skip of Mini, context-error rollover, heavy-agent → Qwen/DeepSeek Pro, and nothing-fits `context_length_exceeded` — no real provider keys required.

## Docker

```bash
cd services/proxy
docker build -t lumen-proxy .
docker run --rm -p 8787:8787 --env-file .env \
  -v lumen-proxy-data:/app/data lumen-proxy
```

## Deploy (India)

Good low-latency options for an owner in India:

1. **Fly.io `bom` (Mumbai)** — `fly launch` from this directory, set secrets for `ADMIN_SECRET`, `KEY_PEPPER`, and provider keys, attach a volume for SQLite or use Managed Postgres.
2. **Railway / Render** — choose Mumbai / Singapore region closest to you; set the same env vars; prefer Postgres if you scale beyond one instance.
3. **Oracle Cloud Mumbai (free tier VM)** — run the Docker image behind Caddy/nginx TLS; SQLite on a persistent disk is fine for a single daily user.

For a single power user (Deepam), **one small Fly/Railway instance in Mumbai + SQLite** is enough: keep `lumen-fast` / `lumen-auto` as default for edit latency, and rely on NVIDIA free-tier NIM keys where available.

## Env vars (names only)

See [`.env.example`](./.env.example):

`PORT`, `HOST`, `LOG_LEVEL`, `LOG_PROMPTS`, `ADMIN_SECRET`, `KEY_PEPPER`, `DATABASE_URL`, `NVIDIA_API_KEY`, `DASHSCOPE_API_KEY`, `DEEPSEEK_API_KEY`, `NVIDIA_BASE_URL`, `DASHSCOPE_BASE_URL`, `DEEPSEEK_BASE_URL`, `UPSTREAM_TIMEOUT_MS`, `UPSTREAM_CONNECT_TIMEOUT_MS`, `MODELS_CONFIG`, `PLANS_CONFIG`

## License

Apache License 2.0 — same as the Lumen / Cline project.
