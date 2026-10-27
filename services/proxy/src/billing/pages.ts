import type { PublicPlan } from "./plans"
import { formatInr, invoiceGstLines, type GstBreakdown } from "./gst"

export type AccountView = {
	email: string
	planId: string
	planName: string
	subscriptionStatus?: string | null
	graceUntil?: string | null
	usedTokens: number
	limitTokens: number
	keys: Array<{ prefix: string; label: string | null; created_at: string }>
	invoices: Array<{
		id: string
		plan_id: string
		gross_paise: number
		net_paise: number
		gst_paise: number
		gst_rate_percent: number
		created_at: string
		status: string
	}>
	plans: PublicPlan[]
	paymentProvider: string
	message?: string
	issuedPlanKey?: string
}

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
}

function layout(title: string, body: string): string {
	return `<!doctype html>
<html lang="en-IN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} · Lumen</title>
  <style>
    :root {
      --bg: #f6f1e8;
      --ink: #1c1917;
      --muted: #57534e;
      --accent: #0f766e;
      --accent-ink: #ecfdf5;
      --card: #fffdf8;
      --line: #e7e0d5;
      --warn: #b45309;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Noto Sans", system-ui, sans-serif;
      background:
        radial-gradient(1200px 600px at 10% -10%, #d9f3ef 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #fde68a55 0%, transparent 50%),
        var(--bg);
      color: var(--ink);
      line-height: 1.5;
    }
    header {
      padding: 1.25rem 1.25rem 0;
      max-width: 720px;
      margin: 0 auto;
    }
    header a.brand {
      font-weight: 800;
      letter-spacing: -0.03em;
      font-size: 1.5rem;
      color: var(--ink);
      text-decoration: none;
    }
    header p { color: var(--muted); margin: 0.25rem 0 0; }
    main {
      max-width: 720px;
      margin: 0 auto;
      padding: 1.25rem;
    }
    h1 { font-size: 1.6rem; letter-spacing: -0.02em; margin: 0 0 0.5rem; }
    h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
    .muted { color: var(--muted); }
    .flash {
      background: #ecfdf5;
      border: 1px solid #99f6e4;
      color: #115e59;
      padding: 0.75rem 1rem;
      border-radius: 10px;
      margin: 1rem 0;
    }
    .plan {
      border: 1px solid var(--line);
      background: var(--card);
      border-radius: 14px;
      padding: 1rem;
      margin: 0.75rem 0;
      display: grid;
      gap: 0.35rem;
    }
    .plan.current { border-color: var(--accent); box-shadow: 0 0 0 2px #99f6e4; }
    .price { font-size: 1.25rem; font-weight: 700; color: var(--accent); }
    .row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
    button, .btn {
      appearance: none;
      border: 0;
      background: var(--accent);
      color: var(--accent-ink);
      font-weight: 600;
      padding: 0.55rem 0.9rem;
      border-radius: 10px;
      cursor: pointer;
      text-decoration: none;
      display: inline-block;
    }
    button.secondary, .btn.secondary {
      background: transparent;
      color: var(--accent);
      border: 1px solid var(--accent);
    }
    input {
      width: 100%;
      padding: 0.65rem 0.75rem;
      border-radius: 10px;
      border: 1px solid var(--line);
      font: inherit;
      background: white;
    }
    label { display: block; font-size: 0.9rem; margin: 0.75rem 0 0.25rem; color: var(--muted); }
    form.stack { display: grid; gap: 0.25rem; max-width: 420px; }
    .meter {
      height: 10px;
      background: var(--line);
      border-radius: 999px;
      overflow: hidden;
      margin: 0.4rem 0 0.2rem;
    }
    .meter > span {
      display: block;
      height: 100%;
      background: linear-gradient(90deg, #0f766e, #14b8a6);
    }
    code, .mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.85rem;
      word-break: break-all;
    }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { text-align: left; padding: 0.45rem 0.25rem; border-bottom: 1px solid var(--line); }
    footer { max-width: 720px; margin: 0 auto; padding: 1rem 1.25rem 2rem; color: var(--muted); font-size: 0.85rem; }
    @media (max-width: 520px) {
      h1 { font-size: 1.35rem; }
      .plan { padding: 0.85rem; }
    }
  </style>
</head>
<body>
  <header>
    <a class="brand" href="/billing">Lumen</a>
    <p>Billing &amp; account — seedha, simple, INR mein.</p>
  </header>
  <main>${body}</main>
  <footer>Prices in INR. UPI supported. GST shown on receipts. Test mode friendly.</footer>
</body>
</html>`
}

export function renderSignupPage(opts?: { error?: string; ok?: string }): string {
	const flash = opts?.error
		? `<div class="flash" style="background:#fff7ed;border-color:#fed7aa;color:#9a3412">${esc(opts.error)}</div>`
		: opts?.ok
			? `<div class="flash">${esc(opts.ok)}</div>`
			: ""
	return layout(
		"Sign up",
		`
    <h1>Account banao</h1>
    <p class="muted">Email se signup. Verification link aayega — Edu domains (.edu.in / .ac.in) auto Free Edu milta hai.</p>
    ${flash}
    <form class="stack" method="post" action="/billing/signup">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" required placeholder="you@college.ac.in" />
      <label for="name">Name (optional)</label>
      <input id="name" name="name" type="text" placeholder="Deepam" />
      <label for="phone">Phone (optional, UPI Autopay)</label>
      <input id="phone" name="phone" type="tel" placeholder="9999999999" />
      <div style="margin-top:0.75rem"><button type="submit">Send verification link</button></div>
    </form>
    <p class="muted" style="margin-top:1rem"><a href="/billing/account">Already verified? Account page</a></p>
  `,
	)
}

export function renderPlansPage(plans: PublicPlan[]): string {
	const cards = plans
		.map(
			(p) => `
      <div class="plan">
        <div class="row"><strong>${esc(p.name)}</strong>${p.eduOnly ? ' <span class="muted">· Edu</span>' : ""}</div>
        <div class="price">${esc(p.displayPrice)}</div>
        <p class="muted">${esc(p.description)}</p>
        <p class="muted">${p.monthlyTokenLimit.toLocaleString("en-IN")} tokens / month · ${p.requestsPerMinute} RPM</p>
      </div>`,
		)
		.join("")
	return layout(
		"Plans",
		`
    <h1>Plans (INR)</h1>
    <p class="muted">Free, Edu, aur paid Pro plans. Upgrade account page se.</p>
    ${cards}
    <p><a class="btn" href="/billing/signup">Get started</a></p>
  `,
	)
}

export function renderAccountPage(view: AccountView): string {
	const pct = view.limitTokens > 0 ? Math.min(100, Math.round((view.usedTokens / view.limitTokens) * 100)) : 0
	const flash = view.message ? `<div class="flash">${esc(view.message)}</div>` : ""
	const keyFlash = view.issuedPlanKey
		? `<div class="flash"><strong>Naya plan key</strong> (abhi copy kar lo — phir nahi dikhega):<br/><span class="mono">${esc(view.issuedPlanKey)}</span></div>`
		: ""

	const planCards = view.plans
		.filter((p) => !p.eduOnly || view.planId === "edu")
		.map((p) => {
			const isCurrent = p.id === view.planId
			const upgrade =
				p.paid && !isCurrent
					? `<form method="post" action="/billing/upgrade" style="margin-top:0.5rem">
              <input type="hidden" name="plan" value="${esc(p.id)}" />
              <button type="submit">Upgrade to ${esc(p.name)}</button>
            </form>`
					: isCurrent
						? `<span class="muted">Current plan</span>`
						: ""
			return `<div class="plan ${isCurrent ? "current" : ""}">
        <div class="row"><strong>${esc(p.name)}</strong><span class="price" style="margin-left:auto">${esc(p.displayPrice)}</span></div>
        <p class="muted">${esc(p.description)}</p>
        ${upgrade}
      </div>`
		})
		.join("")

	const invoices = view.invoices.length
		? `<table><thead><tr><th>Date</th><th>Plan</th><th>Taxable</th><th>GST</th><th>Total</th></tr></thead><tbody>${view.invoices
				.map((inv) => {
					const lines = invoiceGstLines({
						grossPaise: inv.gross_paise,
						netPaise: inv.net_paise,
						gstPaise: inv.gst_paise,
						gstRatePercent: inv.gst_rate_percent,
						pricesGstInclusive: true,
					} satisfies GstBreakdown)
					return `<tr>
            <td>${esc(inv.created_at.slice(0, 10))}</td>
            <td>${esc(inv.plan_id)}</td>
            <td>${esc(lines.taxableValue)}</td>
            <td>${esc(lines.gstAmount)} <span class="muted">(${inv.gst_rate_percent}%)</span></td>
            <td>${esc(lines.total)}</td>
          </tr>`
				})
				.join("")}</tbody></table>`
		: `<p class="muted">No invoices yet.</p>`

	const keys = view.keys
		.map(
			(k) =>
				`<li><span class="mono">${esc(k.prefix)}…</span> ${k.label ? esc(k.label) : ""} <span class="muted">${esc(k.created_at.slice(0, 10))}</span></li>`,
		)
		.join("")

	return layout(
		"Account",
		`
    ${flash}${keyFlash}
    <h1>Your account</h1>
    <p><strong>${esc(view.email)}</strong> · plan <strong>${esc(view.planName)}</strong>
      ${view.subscriptionStatus ? ` · sub <span class="muted">${esc(view.subscriptionStatus)}</span>` : ""}
      ${view.graceUntil ? ` · grace till <span class="muted">${esc(view.graceUntil.slice(0, 10))}</span>` : ""}
    </p>
    <p class="muted">Provider: ${esc(view.paymentProvider)}</p>

    <h2>Usage this month</h2>
    <div class="meter"><span style="width:${pct}%"></span></div>
    <p class="muted">${view.usedTokens.toLocaleString("en-IN")} / ${view.limitTokens.toLocaleString("en-IN")} tokens (${pct}%)</p>

    <h2>Plans</h2>
    ${planCards}

    <h2>Plan keys</h2>
    <ul>${keys || "<li class='muted'>No keys</li>"}</ul>
    <form method="post" action="/billing/rotate-key" style="margin-top:0.5rem">
      <button class="secondary" type="submit">Rotate plan key</button>
    </form>

    <h2>Cancel</h2>
    <p class="muted">Cancel anytime — grace period ke baad Free pe downgrade.</p>
    <form method="post" action="/billing/cancel" onsubmit="return confirm('Cancel subscription?')">
      <button class="secondary" type="submit">Cancel subscription</button>
    </form>

    <h2>Receipts (GST breakdown)</h2>
    ${invoices}

    <p style="margin-top:1.5rem"><a href="/billing/logout">Log out</a></p>
  `,
	)
}

export function renderVerifyOk(opts: { planId: string; planKey: string; edu: boolean }): string {
	return layout(
		"Verified",
		`
    <h1>Email verified ✓</h1>
    <p>${opts.edu ? "Edu plan unlock ho gaya — padhai ke liye free boost." : "Account ready. Free plan se shuru karo."}</p>
    <p>Current plan: <strong>${esc(opts.planId)}</strong></p>
    <div class="flash"><strong>Your plan key</strong> (extension settings mein paste karo):<br/><span class="mono">${esc(opts.planKey)}</span></div>
    <p><a class="btn" href="/billing/account">Go to account</a></p>
  `,
	)
}

export { formatInr as formatMoney }
