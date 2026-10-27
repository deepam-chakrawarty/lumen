# Lumen Proxy

Thin OpenAI-compatible plan-key proxy for the Lumen VS Code extension (Phase 2) with **INR billing** (Phase 3).

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
- **INR billing** — Free / Edu / Pro (₹2,000) / Pro Plus (₹3,000); Razorpay (default) or Cashfree; UPI + UPI Autopay; GST on receipts; `/billing` account pages
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
| GET | `/billing/plans` | none | Plan cards (INR) |
| GET/POST | `/billing/signup` | none | Email signup + verification mail |
| GET | `/billing/verify` | token | Verify email → issue plan key + session |
| GET | `/billing/account` | session cookie | Usage, upgrade, rotate key, cancel |
| POST | `/webhooks/razorpay` | signature | Razorpay subscription webhooks |
| POST | `/webhooks/cashfree` | signature | Cashfree subscription webhooks |
| POST | `/webhooks/mock` | signature | Local/test provider webhooks |

OpenAI-style error JSON on **401 / 403 / 429** (`invalid_api_key`, `model_not_allowed`, `insufficient_quota`, `rate_limit_exceeded`).

## Model routing

Configured in [`config/models.yaml`](./config/models.yaml):

| Logical | Primary upstream | Fallback |
|---|---|---|
| `lumen-fast` | NVIDIA `nvidia/nemotron-3-nano-30b-a3b` | other Nano / Lightning on NIM |
| `lumen-standard` | NVIDIA `nvidia/nemotron-mini-4b-instruct` | Lightning / Nemotron Super |
| `lumen-strong` | DashScope `qwen3-coder-plus` | DeepSeek `deepseek-flash` → `deepseek-v4-pro` |
| `lumen-auto` | heuristic → one of the above | same fallback chain from chosen tier upward |

On upstream **error / timeout / 429**, the proxy retries the next route in the chain (stronger / alternate).

### Upstream verification (docs checked 2026-10-27)

| Provider | Base URL | Model IDs | Source |
|---|---|---|---|
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | `nvidia/nemotron-3-nano-30b-a3b`, `nvidia/nvidia-nemotron-nano-9b-v2`, `nvidia/nemotron-mini-4b-instruct`, `nvidia/nemotron-3.5-lightning-30b-a3b`, `nvidia/llama-3.3-nemotron-super-49b-v1.5` | [docs.api.nvidia.com/nim/reference/llm-apis](https://docs.api.nvidia.com/nim/reference/llm-apis), [build.nvidia.com](https://build.nvidia.com), [nemotron-mini docs](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-mini-4b-instruct-infer) |
| DashScope / Model Studio | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-coder-plus` | [Alibaba OpenAI-compatible chat](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope); workspace `*.maas.aliyuncs.com` hosts also supported via `DASHSCOPE_BASE_URL` |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash`, `deepseek-v4-pro` | [api-docs.deepseek.com](https://api-docs.deepseek.com/) (legacy `deepseek-chat` retired mid-2026) |

Env keys used: `NVIDIA_API_KEY`, `DASHSCOPE_API_KEY`, `DEEPSEEK_API_KEY` (never logged or returned).

## Plans & quotas

See [`config/plans.yaml`](./config/plans.yaml). Amounts are stored in **paise** (₹1 = 100 paise). GST rate, inclusive/exclusive list prices, grace period, and Edu domain allowlist are all configurable there.

| Plan | Price (INR / mo) | Monthly tokens | RPM |
|---|---|---|---|
| `free` | ₹0 | 2_000_000 | 30 |
| `edu` | ₹0 (verified `.edu.in` / `.ac.in`) | 5_000_000 | 60 |
| `pro` | ₹2,000 | 30_000_000 | 120 |
| `pro_plus` | ₹3,000 | 75_000_000 | 180 |

Default prices are **GST-inclusive** at 18% (invoice lines still break out taxable value + GST). Set `billing.pricesGstInclusive: false` to charge GST on top.

## Billing (Phase 3)

### Signup & keys

1. Open `http://localhost:8787/billing/signup`
2. Enter email → verification link (console mailer prints it in dev; `MAILER=smtp` for SMTP)
3. Verified `.edu.in` / `.ac.in` (configurable allowlist) → automatic **Edu** plan; otherwise **Free**
4. A plan key (`lmn_…`) is issued once; rotate from `/billing/account`
5. Admin CLI / `/admin/*` still work for manual key management

### Payment providers

Choose with `PAYMENT_PROVIDER=razorpay|cashfree|mock` (default **razorpay**). `PAYMENT_TEST_MODE=true` by default; without Razorpay keys, checkout falls back to the **mock** provider so local UI works.

Both adapters implement a common interface (`src/billing/providers/`): ensure plan → create subscription checkout link (UPI-enabled) → cancel → verify webhook → normalize events.

#### Razorpay (default) — docs verified 2026-10-27

| Item | Value |
|---|---|
| API | `https://api.razorpay.com/v1` — [Create Plan](https://razorpay.com/docs/api/payments/subscriptions/create-plan), [Create Subscription / Link](https://razorpay.com/docs/api/payments/subscriptions/create-subscription-link) |
| Webhooks | HMAC-SHA256 hex of **raw body** vs `X-Razorpay-Signature`; idempotency via `X-Razorpay-Event-Id` — [validate & test](https://razorpay.com/docs/webhooks/validate-test) |
| UPI | Subscriptions support **UPI Autopay** (plus cards / emandate) — [Subscriptions overview](https://razorpay.com/docs/payments/subscriptions) |
| Official SDK | npm `razorpay` (Node). This service calls REST directly (Bun-friendly); SDK is optional. |
| Webhook URL | `https://<host>/webhooks/razorpay` |

**Test account setup**

1. Sign up at [razorpay.com](https://razorpay.com/) → Dashboard → **Test Mode**
2. Settings → API Keys → generate **Key Id / Key Secret** → set `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`
3. Account & Settings → Webhooks → add URL + secret → set `RAZORPAY_WEBHOOK_SECRET`
4. Subscribe to at least: `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `payment.failed`
5. Enable Flash Checkout if using hosted subscription checkout ([integration guide](https://razorpay.com/docs/payments/subscriptions/integration-guide))

#### Cashfree — docs verified 2026-10-27

| Item | Value |
|---|---|
| API version | **`2026-01-01`** (header `x-api-version`) — [Subscriptions overview](https://www.cashfree.com/docs/api-reference/payments/latest/subscription/overview) |
| Base URL | Sandbox `https://sandbox.cashfree.com/pg` · Production `https://api.cashfree.com/pg` |
| Plans / subs | [Create Plan](https://www.cashfree.com/docs/api-reference/payments/latest/subscription/create-a-plan) · [Create Subscription](https://www.cashfree.com/docs/api-reference/payments/latest/subscription/create-subscription) (auth link; UPI in `payment_methods`) |
| Payment links | [Create Payment Link](https://www.cashfree.com/docs/api-reference/payments/latest/overview) for one-time; recurring uses Subscriptions |
| Webhooks | Base64(HMAC-SHA256(`timestamp + rawBody`, secret)) vs `x-webhook-signature` + `x-webhook-timestamp` — [signature docs](https://www.cashfree.com/docs/payments/subscription/webhook-signature) |
| UPI Autopay | Supported on subscriptions; controlled notify/execute flow available on API `2026-01-01` |
| Official SDK | npm `cashfree-pg` **^5.1.0**. This service calls REST directly; SDK is optional. |
| Webhook URL | `https://<host>/webhooks/cashfree` |

**Test account setup**

1. Sign up at Cashfree → switch dashboard to **Test**
2. Developers → API Keys → copy test `client_id` / `client_secret` → `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`
3. Configure webhook URL + secret → `CASHFREE_WEBHOOK_SECRET`; set `CASHFREE_ENV=sandbox`, `PAYMENT_PROVIDER=cashfree`

### Local webhooks (tunnel)

Providers must reach your laptop. Use a tunnel, then point the dashboard webhook at it:

```bash
# example with cloudflared or ngrok
cloudflared tunnel --url http://localhost:8787
# Webhook: https://<tunnel>/webhooks/razorpay  (or /webhooks/cashfree)
```

Keep `PAYMENT_TEST_MODE=true` and use **test/sandbox** keys only.

### Going live (from official docs only)

**Razorpay** ([set up account](https://razorpay.com/docs/payments/set-up), [FAQs](https://razorpay.com/docs/payments/faqs)):

- Create a Razorpay account and complete **KYC** (CKYC fast-path or Video KYC / document upload).
- Business type drives documents (PAN, bank account, UBO declaration for companies/LLPs/partnerships/trusts as applicable).
- Switch API keys and webhook endpoints from Test → Live; set `PAYMENT_TEST_MODE=false`.
- UPI Autopay / recurring products may need additional activation on the Dashboard.

**Cashfree** ([onboarding FAQs](https://www.cashfree.com/docs/help/onboarding-related/onboarding-faqs), [account activation](https://www.cashfree.com/docs/help/account/account-activation), [quickstart](https://www.cashfree.com/docs/payments/quickstart-guide)):

- Business must be **registered in India** (or sign up as Individual until registered).
- Submit business PAN, owner PAN/KYC, entity registration proof, bank details, beneficial-owner declaration, signed agreement.
- Live website/app with Terms, Privacy, Contact, About (and pricing/refund pages as applicable).
- GSTIN optional. Production keys require activation; sandbox does not need KYC.
- Set `CASHFREE_ENV=production`, live credentials, `PAYMENT_TEST_MODE=false`.

You need a suitable **Indian business entity** (proprietorship / partnership / LLP / Pvt Ltd, etc.) and a settlement bank account to receive INR payouts — exact documents depend on entity type per the provider docs above.

### Lifecycle

Webhook events are **signature-verified** and **idempotent** (`webhook_events` unique on provider + event id). Mapped actions:

| Event | Effect |
|---|---|
| activated / renewed / payment captured | Plan → paid plan; invoice with GST lines; clear grace |
| payment failed / halted | `past_due` + grace window (`billing.gracePeriodDays`, default 3) |
| cancelled | Mark cancelled; after grace → **Free** |
| expired | Immediate downgrade to **Free** |

## Database

- Default: `DATABASE_URL=sqlite:./data/lumen.db` (auto-migrated)
- Postgres-ready: `DATABASE_URL=postgres://user:pass@host:5432/lumen` (requires optional `postgres` package at runtime)

Schema lives in `src/db/schema.ts` with versioned migrations for both drivers (v2 adds billing tables: verifications, sessions, subscriptions, webhook_events, invoices).

## Tests

```bash
cd services/proxy
bun install
bun test
```

- Unit: plan config, Edu detection, GST math, webhook signatures (Razorpay + Cashfree)
- Integration: mock upstream chat proxy + billing signup/Edu + mock/Razorpay/Cashfree recorded webhook payloads (activation, renewal, failure, cancellation/expiry)

No real payment-provider keys required for `bun test`.

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

**Core:** `PORT`, `HOST`, `LOG_LEVEL`, `LOG_PROMPTS`, `PUBLIC_BASE_URL`, `ADMIN_SECRET`, `KEY_PEPPER`, `SESSION_SECRET`, `DATABASE_URL`, `NVIDIA_API_KEY`, `DASHSCOPE_API_KEY`, `DEEPSEEK_API_KEY`, `NVIDIA_BASE_URL`, `DASHSCOPE_BASE_URL`, `DEEPSEEK_BASE_URL`, `UPSTREAM_TIMEOUT_MS`, `UPSTREAM_CONNECT_TIMEOUT_MS`, `MODELS_CONFIG`, `PLANS_CONFIG`

**Billing:** `PAYMENT_PROVIDER`, `PAYMENT_TEST_MODE`, `MAILER`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `CASHFREE_CLIENT_ID`, `CASHFREE_CLIENT_SECRET`, `CASHFREE_WEBHOOK_SECRET`, `CASHFREE_ENV`, `CASHFREE_API_VERSION`

## License

Apache License 2.0 — same as the Lumen / Cline project.
