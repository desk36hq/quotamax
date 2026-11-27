# QuotaMax

Live Explorer panel for Paseo that maximizes your AI coding subscriptions — tracking weekly/5-hour reset countdowns, pace multipliers, 15-minute burn-rate ETAs, and **API-equivalent cost estimates** (LiteLLM + OpenRouter fallback across local Claude Code, Codex, Antigravity, and Pi sessions), while recommending the best model + thinking effort for `Quick`, `Standard`, `Hard`, and `Frontier` tasks with 1-click Apply.

It reads quota from Paseo's usage tracker (`paseo usage`) for Claude, Codex, Kimi, MiniMax, Grok and Cursor (one shared X Subscription pool), OpenCode Go, Muse and GitHub Copilot, and from its own Alibaba source. It also registers the `alibaba` account usage source behind `paseo usage` (`server/alibabaUsage.ts`), which reads the `bl` or `qwencloud` CLI.

The same plugin also runs in Orca, where it reads Orca's rate limits instead. In Paseo, the Antigravity and GLM pools stay untracked, because Paseo has no quota source that reports their windows. Copilot is tracked in Paseo only.

Setup: no keys are needed. An optional free Artificial Analysis key (Settings → QuotaMax, or `ARTIFICIAL_ANALYSIS_API_KEY`) refreshes model scores; it is stored in Paseo's plugin settings on the host. The plugin writes its synced catalog and price cache to `~/.paseo/plugin-data/quota-advisor/`, reads session logs on the daemon machine, and fetches public price lists from GitHub (LiteLLM) and OpenRouter, plus Artificial Analysis when a key is set.
