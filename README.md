<div align="center">

# QuotaMax

**Maximize your AI coding subscriptions before they reset.**

Live quota pacing, intelligent model + thinking recommendations with Apply, and API-equivalent cost estimates across **Claude**, **Codex**, **Antigravity**, **GLM**, **Alibaba**, **Kimi**, **MiniMax**, **Grok + Cursor**, **OpenCode Go**, **Muse** and **Copilot** — built for [Paseo](https://paseo.sh) and [Orca](https://www.onorca.dev).

[![License: MIT](https://img.shields.io/badge/License-MIT-34d399.svg?style=flat-square)](LICENSE)
[![Paseo](https://img.shields.io/badge/Paseo-%3E%3D0.17.3-3b82f6.svg?style=flat-square)](https://paseo.sh)
[![Orca](https://img.shields.io/badge/Orca-%3E%3D1.4.248-8b5cf6.svg?style=flat-square)](https://www.onorca.dev)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.13-22c55e.svg?style=flat-square)](https://nodejs.org)

</div>

<br/>

![QuotaMax Dashboard](assets/hero-dashboard.svg)

<sub>The Paseo panel. The Orca panel has the same layout and styling, follows Orca's light/dark theme, and adds a status bar item.</sub>

---

## Why QuotaMax?

Flat-rate AI coding plans reset on rolling 5-hour, weekly, or monthly cycles. Unused quota disappears at reset — while burning too fast on the wrong pool hits a 5-hour wall mid-sprint.

**QuotaMax** treats expiring quota as a decaying asset:
- **Surplus expiring soon (`HAMMER`)?** Automatically upgrades recommendations to flagship models and `high` / `xhigh` thinking so nothing goes to waste.
- **Burning ahead of schedule (`CONSERVE`)?** Shifts toward high intelligence-per-quota workhorses and lower thinking effort to stretch until reset.
- **Want to see your real ROI?** Scans local session logs and calculates **API-equivalent value** and **prompt-cache savings** across `24h`, `7d`, and `30d` windows.

![QuotaMax Pacing Modes](assets/burn-modes.svg)

---

## Features

Rows marked **Paseo only**, **Orca only** or **Differs** behave differently by host. See [Paseo vs Orca](#paseo-vs-orca) for details.

| Feature | What it does |
|---|---|
| **Model & Thinking Recommendations** | Ranks models across active pools for `Quick`, `Standard`, `Hard`, and `Frontier` tasks. Models with a limit of their own (Claude Fable's separate weekly limit) are demoted as that limit runs out. |
| **Apply** — *Differs* | **Paseo:** 1-click Apply sets model, provider and thinking on the focused composer. **Orca:** Apply previews, then on **Send** types `/model …` (and `/effort …` where supported) into an *idle* matching agent in the focused workspace; for agents that can't switch model by command it shows the launch command instead. |
| **Burn Pace & Reset Urgency** | Tracks weekly/monthly & 5-hour windows, pace multipliers (`HAMMER` · `PUSH` · `BALANCED` · `CONSERVE` · `5H CAP`), and 15-minute burn-rate ETAs. |
| **API-Equivalent Cost Estimates** | Scans local **Claude Code**, **Codex**, **Antigravity** (SQLite), and **Pi** sessions; prices tokens via LiteLLM's public catalog (24h local cache) with automatic **OpenRouter** fallback and built-in rates. Same on both hosts, except that Orca reads logs only from their default folders (see Environment variables below). |
| **Cache Savings & Breakdowns** | Shows total estimated API value, cache-hit %, USD saved by prompt caching, category split (Input / Cache Read / Cache Write / Output), and per-pool / per-model tables. |
| **Optional Artificial Analysis Sync** | Add a free key to refresh live Intelligence Index, Coding Index, and efficiency scores. *Differs:* where the key is stored (see below). |
| **Alibaba Cloud Usage Source** — *Differs* | **Paseo:** registers the `alibaba` source behind `paseo usage`. **Orca:** QuotaMax reads the `bl` / `qwencloud` CLIs itself; Alibaba appears in QuotaMax only, not in Orca's own usage views. |
| **Status bar item** — *Orca only* | Shows the pool to use now (e.g. `Claude · Hammer`); hover for every tracked pool; click to refresh. |
| **Mobile screen & sidebar item** — *Paseo only* | One-tap access from Paseo's sidebar drawer on phones. |

---

## Paseo vs Orca

QuotaMax runs the same advisor, catalog and cost estimator on both hosts. These things differ:

| | Paseo | Orca |
|---|---|---|
| **Where quota comes from** | Paseo's usage tracker (`paseo usage --json`) | Orca's rate limits (`orca account list --json`) |
| **Where you sign in to providers** | Paseo's provider settings | Orca → Settings → Accounts (and each agent's own login) |
| **Opening QuotaMax** | Explorer panel, sidebar gauge, Command Center → `Open QuotaMax` | Right sidebar → gauge icon (**QuotaMax** panel); status bar item; palette → `QuotaMax: Refresh quota` |
| **Apply** | 1 click, on the focused composer | Preview → **Send**; types into an idle agent's terminal (see [Apply in Orca](#apply-in-orca)) |
| **Settings** | A separate screen: Settings → QuotaMax | An inline card in the panel: the gear button next to Refresh |
| **Artificial Analysis key** | Settings → QuotaMax; stored in Paseo plugin settings on the host | Panel → gear button; stored in Orca's encrypted plugin secrets |
| **"Recalibrate on sync" toggle** | Settings → QuotaMax | Panel → gear button, or Orca Settings → Plugins → QuotaMax |
| **Data folder** (synced catalog, price cache) | `~/.paseo/plugin-data/quota-advisor/` | `~/.quotamax/` (uses a catalog synced under Paseo until you sync in Orca) |
| **Burn-rate history** | In memory; starts over when the plugin restarts | Kept in plugin storage; survives a restart |
| **Environment variables** (`ARTIFICIAL_ANALYSIS_API_KEY`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `ANTIGRAVITY_DATA_DIR`) | Read from the daemon's environment | **Not seen.** Orca starts plugins with a minimal environment, so enter the key in the panel; session logs are read from their default folders |
| **Why a pool is untracked** | `Status: …` from Paseo | Orca's own reason, e.g. `Codex not signed in` |
| **Requirements** | Paseo `>=0.17.3`; plugins enabled on the daemon | Orca `>=1.4.248` (status bar: desktop app); approve the plugin's access on install |

### Which pools each host can track

| Pool | Paseo | Orca | Notes |
|---|:---:|:---:|---|
| Claude (incl. Fable weekly limit) | ✅ | ✅ | |
| Codex | ✅ | ✅ | |
| Antigravity (Gemini) · Antigravity (Claude & GPT) | ❌ | ✅ | **Orca only.** Paseo 0.18 has no Antigravity quota source. |
| GLM Coding Plan | ❌ | ✅ | **Orca only.** Paseo's Z.ai source reports no quota windows; Orca reads it as ZCode. |
| Alibaba Token Plan | ✅ | ✅ | Needs the `bl` or `qwencloud` CLI logged in, on both hosts. |
| Kimi Code | ✅ | ✅ | |
| MiniMax M Plan | ✅ | ✅ | |
| X Subscription (Grok + Cursor) | ✅ | ✅ | Grok and Cursor share one weekly pool; either source tracks it. |
| OpenCode Go | ✅ | ✅ | |
| Muse Code | ✅ | ✅ | |
| GitHub Copilot | ✅ | ❌ | **Paseo only.** Orca doesn't report Copilot usage. |

A pool shows as untracked until you sign in to that provider on the host. Scores for Kimi, MiniMax, X Subscription, OpenCode Go, Muse and Copilot models are estimates; an Artificial Analysis sync replaces them with live values.

### Apply in Orca

Orca agents are CLIs in terminals, so there is no composer to set. Instead, **Apply** finds a matching agent in the focused workspace and shows exactly what it will type; **Send** types it:

| Agent | What Apply does |
|---|---|
| Claude Code | `/model <id>` and `/effort <level>` |
| Codex | `/model <id> --reasoning=<level>` |
| Copilot CLI, Pi, Grok Build | `/model <id>` (Grok also `/effort`; Copilot and Pi set effort in their own UI) |
| Kimi, OpenCode, Cursor agent, Muse Code, Antigravity | Nothing is typed — their `/model` opens a picker (or is unconfirmed), so QuotaMax shows the launch command, e.g. `kimi --model k3.1-pro` |

It only types into an agent that is **waiting or done** — never one that is working or asking for permission — and re-checks just before sending. Anything half-typed in that agent's prompt would be submitted with the command, so clear it first.

---

## Quick Install

### Paseo

```bash
paseo plugin add https://github.com/desk36hq/quotamax.git
```

Then open **QuotaMax** from the Paseo Explorer panel, the sidebar gauge icon, or Command Center (`Open QuotaMax`).

> **Requirements:** Paseo `>=0.17.3`. Node `>=22.13` is recommended for Antigravity SQLite cost scanning (Claude Code, Codex, and Pi work on older Node versions too).

### Orca

```bash
orca plugin install desk36hq/quotamax
```

QuotaMax runs code, so the first run stops with `approval_required` and lists what it asks for: its own storage, settings and encrypted secrets, reading agent status (`agent:read`) and typing into terminals (`terminal:send`, used only by Apply). Re-run the command it prints, with `--approve <fingerprint>`, once you're happy with that. Then open the **QuotaMax** panel from the gauge icon in Orca's right sidebar.

> **Requirements:** Orca `>=1.4.248`. On Linux the Orca CLI is `orca-ide` (a bare `orca` is usually the GNOME screen reader). Orca runs the plugin on its own built-in Node.

---

## For AI Agents

> **Machine-readable install & verification instructions for coding agents installing QuotaMax for a user.** Use the block for the user's host. Never pass an Orca `--approve` fingerprint the user hasn't agreed to.

### On Paseo

```bash
# 1. Verify prerequisites (Paseo >= 0.17.3; Node >= 22.13 for Antigravity SQLite scanning)
paseo --version && node -v

# 2. Install plugin directly from GitHub
paseo plugin add https://github.com/desk36hq/quotamax.git

# 3. Verify plugin status is "running" with empty ERROR column
paseo plugin ls quotamax
```

- **Update / Reload / Diagnostics:**
  ```bash
  paseo plugin update quotamax   # pull latest commit
  paseo plugin reload quotamax   # restart plugin process
  paseo plugin logs quotamax     # inspect stdout/stderr if status != running
  ```
- **Uninstall:** `paseo plugin remove quotamax`

### On Orca

```bash
# 1. Verify prerequisites (Orca >= 1.4.248; use `orca-ide` instead of `orca` on Linux)
orca --version && orca status --json

# 2. Install from GitHub — exits 3 with approval_required; show the user error.data (the grants)
orca plugin install desk36hq/quotamax --json

# 3. Only after the user agrees, re-run with the fingerprint Orca printed
orca plugin install desk36hq/quotamax --approve <fingerprint> --json

# 4. Verify it is installed and enabled, then show the panel
orca plugin list --json
orca plugin open desk36hq.quotamax --panel quotamax
```

- **Update / Restart / Diagnostics:**
  ```bash
  orca plugin update desk36hq.quotamax   # new access needs a new --approve
  orca plugin restart desk36hq.quotamax  # restart the worker
  orca plugin logs desk36hq.quotamax     # worker and panel log lines
  ```
- **Uninstall:** `orca plugin uninstall desk36hq.quotamax`

**Post-install notes for agents (both hosts):**
- **No API keys required** to start. Quota pacing reads the host's usage data (`paseo usage --json` on Paseo, `orca account list --json` on Orca); cost estimates read local session logs (`~/.claude/projects`, `~/.codex/sessions`, `~/.gemini/antigravity-cli/conversations`, `~/.pi/agent/sessions`).
- **No external runtime dependencies** (e.g. LiteLLM is *not* installed — only its public GitHub pricing JSON is fetched once per 24h, with automatic fallback to `https://openrouter.ai/api/v1/models` and built-in rates).
- **Optional Artificial Analysis sync:** the user can add a free key from `https://artificialanalysis.ai/insights` — Paseo: **Settings → QuotaMax** (or `ARTIFICIAL_ANALYSIS_API_KEY` in the daemon's environment); Orca: **QuotaMax panel → gear button** only, because Orca plugins don't see the shell's environment variables.

---

## Development

```bash
git clone https://github.com/desk36hq/quotamax.git
cd quotamax
npm install
npm run typecheck        # Paseo plugin + shared code
npm test                 # self-checks: Alibaba CLIs, cost engine, advisor
npm run typecheck:orca   # Orca plugin (needs the Orca CLI for its typings)
npm run test:orca        # Orca plugin tests + plugin check (needs the Orca CLI)
```

Live development: `paseo plugin install "$(pwd)"` then `paseo plugin reload quotamax`; or `orca plugin dev watch . --check` for Orca.

### Layout

| Path | Used by | What it is |
|---|---|---|
| `server/advisor.ts`, `costEstimator.ts`, `usageScanner.ts`, `usagePricing.ts`, `alibabaCore.ts`, `exec.ts`, `quotaSource.ts`, `default-models.json` | Both | Host-neutral core. No zod or Paseo SDK at runtime, so Orca can load it without a bundler. |
| `shared/types.ts` | Both | Plain data types. |
| `index.server.ts`, `index.client.tsx`, `client/`, `shared/contract.ts`, `shared/settings.ts`, `server/paseoQuotaSource.ts`, `server/alibabaUsage.ts`, `paseo-plugin.json` | Paseo | Paseo entry points, RPCs, UI and the Alibaba usage source. |
| `orca-plugin.json`, `orca/` | Orca | Orca manifest, worker, quota adapter, Apply, panel and tests. |

## License

[MIT](LICENSE) — Cost estimation engine and transcript scanners adapted from [T3 Code](https://github.com/pingdotgg/t3code) (MIT).

---

<div align="center">
Built by <a href="https://desk36.com"><strong>Desk36</strong></a>
</div>
