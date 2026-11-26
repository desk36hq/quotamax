# Paseo Quota Advisor

A [Paseo](https://paseo.sh) plugin for **token-maxxing** across multiple AI coding subscriptions — combining live subscription quota pacing, model recommendations, and API-equivalent cost estimates.

## Features

- **Model & Thinking Recommendations**: Scores models across your active pools (`Claude`, `Codex`, `Antigravity`, `GLM`, `Alibaba`) for `Quick`, `Standard`, `Hard`, and `Frontier` tasks with **1-click Apply** to the focused composer.
- **Burn Pace & Reset Urgency**: Tracks weekly/monthly and 5-hour quota windows, pace multipliers (`HAMMER`, `PUSH`, `BALANCED`, `CONSERVE`, `5H CAP`), and 15-minute burn-rate ETAs.
- **API-Equivalent Cost Estimates** *(ported from [T3 Code](https://github.com/pingdotgg/t3code))*:
  - Scans local session logs for **Claude Code** (`~/.claude/projects`), **Codex** (`~/.codex/sessions`), **Antigravity** (`~/.gemini/antigravity-cli/conversations/*.db` via Node's built-in `node:sqlite`), and **Pi** (`~/.pi/agent/sessions`).
  - Prices tokens using LiteLLM's public pricing catalog (cached 24h on disk), with automatic fallback to **OpenRouter** (`/api/v1/models`) and built-in fallback rates.
  - Displays `24h` / `7d` / `30d` API-equivalent value, cache savings & hit rate, category splits (input / cache read / cache write / output), and per-pool / per-model breakdowns.
- **Optional Artificial Analysis Sync**: Add a free API key in plugin Settings to refresh live Intelligence Index, Coding Index, and efficiency scores.
- **Alibaba Cloud Usage Source**: Registers the `alibaba` usage source behind `paseo usage` (supports `bl` and `qwencloud` CLIs).

## Install

Requires Paseo `>=0.17.3` and Node `>=22.5` (for `node:sqlite`).

```bash
paseo plugin add https://github.com/adamrbell/paseo-quota-advisor.git
```

## Development

```bash
npm install
npm run typecheck
npm test
```
