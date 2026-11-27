# Orca support: what changed on the `Orca` branch

QuotaMax now runs as an **Orca** plugin as well as a **Paseo** plugin, from one repository. The quota advisor, model catalog and cost estimator are shared. Each host gets a thin adapter for where quota comes from and how the UI is drawn.

The Paseo plugin's behaviour is unchanged except for the items listed under [Changes Paseo users will notice](#changes-paseo-users-will-notice). Those are bug fixes and the six new pools.

## At a glance

- **New Orca plugin** (`orca-plugin.json` + `orca/`):
  - a worker that reads Orca's rate limits
  - a right-sidebar panel with Recommend / Pools / Costs / Settings tabs
  - a status bar item
  - a two-step Apply that types `/model …` into an idle agent
  - 17 tests
- **Shared core refactor:** the advisor, Alibaba reader and command runner no longer import zod or the Paseo SDK at runtime. Orca loads TypeScript as-is, without a bundler or `node_modules`. Paseo wiring moved into small Paseo-only files.
- **Six new subscription pools** for both hosts: Kimi Code, MiniMax M Plan, X Subscription (Grok + Cursor), OpenCode Go, Muse Code and GitHub Copilot (Copilot is Paseo only).
- **Smarter window matching:** pools can now match windows by prefix or through alternative source ids, which Kimi, MiniMax, Cursor and Copilot need.
- **Claude Fable's separate weekly limit** is now honoured: Fable is demoted with a note when that limit runs low.
- **Docs:** the README covers both hosts, with a full [Paseo vs Orca](README.md#paseo-vs-orca) table. OVERVIEW.md is updated.

## Changes Paseo users will notice

| Change | Before | After |
|---|---|---|
| **New pools** | 6 pools | 12 pools. Kimi, MiniMax, X Subscription, OpenCode Go, Muse and Copilot appear as *untracked* until you sign in to them in Paseo. |
| **Windows: Alibaba discovery bug** (fix) | Paseo runs CLIs through `cmd.exe`, so a missing `bl`/`qwencloud` never failed with `ENOENT`. Alibaba was always "discovered", and fetching showed a raw cmd error. | The CLI is looked up on `PATH` first, so a missing CLI is detected on every OS and locale. |
| **Claude Fable weekly limit** | Ignored | Fable is demoted, with a note such as *"Weekly · Fable limit nearly used up (3% left)"*, when ≤15% is left (caution) or ≤5% (effectively exhausted). |
| **Previously synced catalogs** | A catalog synced with Artificial Analysis replaced the bundled catalog entirely, so new pools and models never appeared. | It is merged: your synced scores are kept, and missing pools and models from the bundled catalog are added. The bundled *pool* settings (how windows are read) take precedence. |
| **GLM pool** | Expects a `glm` source | Also accepts Paseo's `zai` source. Paseo 0.18's Z.ai source currently reports no windows, so GLM still shows untracked in Paseo. |

## Orca-specific behaviour worth knowing

- **Environment variables don't reach the plugin.** Orca starts plugins with a minimal environment, so variables set in your shell don't reach QuotaMax in Orca. That covers `ARTIFICIAL_ANALYSIS_API_KEY` and custom log folders like `CLAUDE_CONFIG_DIR`. Enter the key in the panel's Settings tab; session logs are read from their default folders. The README flags this.
- **A brief loading state on first open.** The first panel open after Orca (or the plugin) starts shows a loading skeleton for a few seconds while the first `orca account list` call runs.

## Things I found but did not change

- **Paseo 0.18 can't track the Antigravity or GLM pools.** Paseo 0.18.0 has no Antigravity quota source, and its Z.ai source reports no windows. Those pools have shown as untracked on Paseo 0.18 since before this branch. Orca tracks both.
- **Open-weight model scores in the catalog sit about 8–10 points above** where their Artificial Analysis v5 scores would put them, compared with the Claude/OpenAI/Gemini rows. Affected rows: GLM, Qwen 4 Max, DeepSeek V4.1 Flash. New-pool scores use the AA-consistent scale and are marked as estimates. An AA sync with *Recalibrate* normalises everything.

## File-by-file

**Shared core (both hosts)**
- `shared/types.ts` *(new)*: all data types, moved out of `contract.ts`. No zod.
- `shared/contract.ts`: now only the Paseo RPC definitions. It re-exports the types unchanged, so `client/` imports still work.
- `server/advisor.ts`: zod schemas replaced by an equivalent hand-written validator. Paseo's `execCommand` call is replaced by an injected `QuotaSource`. The bundled catalog and data folder are passed in. Also adds:
  - prefix and alias window matching
  - per-model windows (`modelWindowId`)
  - catalog merging
  - burn-history export and import
  - source messages in untracked reasons
- `server/quotaSource.ts` *(new)*: the report shape the advisor reads (Paseo's `paseo usage` format).
- `server/exec.ts` *(new)*: `findOnPath`, plus a Node `execFile` runner with Windows `.cmd` support, for Orca.
- `server/alibabaCore.ts` *(new)*: the Alibaba CLI reader and parser moved here from `alibabaUsage.ts`, zod-free with the same acceptance rules, plus the Windows missing-CLI fix.
- `server/default-models.json`: 6 new pools and 18 new models, host metadata, `sourceIds` (aliases) for GLM, fallback windows for Antigravity, and `modelWindowId` on Claude Fable. Existing entries are otherwise unchanged; the diff is additions only.
- `server/costEstimator.ts`: imports types from `shared/types.ts`. No logic change.

**Paseo only**
- `index.server.ts`: wires the advisor to `createPaseoQuotaSource()` and keeps the same data folder (`~/.paseo/plugin-data/quota-advisor/`).
- `server/paseoQuotaSource.ts` *(new)*: the `paseo usage --json` call, moved out of the advisor unchanged.
- `server/alibabaUsage.ts`: now a thin Paseo wrapper over `alibabaCore.ts`, with the same exports and usage-source behaviour.

**Orca only** (all new)
- `orca-plugin.json`: manifest. `trusted-worker`; capabilities `storage:own`, `secrets:own`, `settings:own`, `agent:read`, `terminal:send`; requires Orca `>=1.4.248`.
- `orca/orcaQuotaSource.ts`: runs `orca account list --json` and maps its `rateLimits` onto the catalog's source and window ids. It splits Antigravity buckets into the Gemini and Claude & GPT pools, reads Alibaba via `alibabaCore`, and finds the Orca CLI without touching Linux's GNOME `orca` screen reader.
  - It also gives every CLI it runs the standard profile folders back. Orca starts plugin workers with a trimmed environment; on Windows there is no `APPDATA`, `LOCALAPPDATA` or `HOME`. Without them the Orca CLI fails with `runtime_unavailable`. The live test caught this.
- `orca/worker.ts`: runs the advisor and cost estimator, answers panel requests, keeps burn history in plugin storage, updates the status bar, stores the Artificial Analysis key in Orca's encrypted secrets, and registers the refresh command.
- `orca/apply.ts`, `orca/applyTypes.ts`: Apply. It previews first, then on **Send** types into an *idle* matching agent, re-checking just before typing. Claude Code, Codex, Copilot, Pi and Grok are typed into. Kimi, OpenCode, Cursor, Muse and Antigravity get a launch command instead, because their `/model` is a picker or is unconfirmed. Model ids are restricted to safe characters.
- `orca/panel.tsx`, `orca/protocol.ts`: the panel UI in Orca components, and the typed panel ↔ worker contract.
- `orca/*.test.ts(x)`, `orca/panel.check.ts`, `orca/tsconfig.json`: tests, render-check scenarios and Orca type checking.

**Tooling and docs**
- `test/alibabaUsage.selfcheck.mts`: now also runs on Windows, using `.cmd` stubs instead of a symlink and shebang scripts.
- `test/advisor.selfcheck.mts` *(new)*: window patterns, aliases, the Fable limit, source messages and catalog merging. Needs no host.
- `package.json`: `npm test` also runs the advisor self-check. Adds `typecheck:orca` and `test:orca`.
- `package-lock.json`: the lockfile caught up with the earlier rename to `quotamax` (name, license, engines). No dependency changes.
- `tsconfig.json`: excludes `orca/` and `.orca/` (Orca has its own config).
- `README.md`, `OVERVIEW.md`: both hosts documented; host-only and host-specific behaviour is flagged throughout.

## How this was verified

- **Regression against the original code:** the original `main` code was run on recorded quota data through a script with a fixed clock and an isolated home folder. The data covered all six original pools in every pacing mode, four polls for burn-rate ETAs, plus a real `paseo usage --json` capture.
  - After the refactor, the output was **byte-for-byte identical**.
  - With the new catalog and features: **0 differences** in existing pools and recommendations. The only additions are the six new pools, shown as untracked.
- **Paseo 0.18.0, live:** the plugin installed from this folder reaches `running` and logs `Plugin ready`. `paseo usage --json` no longer lists a bogus Alibaba entry on Windows.
- **Self-checks:** `npm run typecheck` passes. `npm test` passes: Alibaba A–N, which now passes on Windows (case K failed before the fix), plus cost engine and advisor A–H.
- **Orca 1.4.279:**
  - `npm run typecheck:orca` passes.
  - `orca plugin test .` passes 17/17.
  - `orca plugin check .` renders three scenarios with the real worker and no issues.
  - `orca plugin validate .` passes with no warnings.
- **Orca 1.4.279, live:** loaded as an approved development plugin.
  - The worker reads the live rate limits. Claude is tracked; untracked pools show Orca's own reasons, e.g. *"Codex not signed in"*.
  - The cost estimate works: 7 days, LiteLLM prices, cache in `~/.quotamax/`.
  - The status bar shows *"Claude · Balanced"*.
  - The panel's Recommend tab renders with live data.
  - The first live run found the trimmed-environment problem above. It is fixed and covered by a test.

**Not verified here:**
- Screenshots of the Pools, Costs and Settings tabs inside the app. Orca only allows those captures while its window is hidden. Their render checks pass.
- Apply typing into a real agent. It is covered by unit tests; step 3 of *Trying the Orca side* below tries it live.
- Environment on macOS and Linux: whether Orca's worker environment there is also trimmed. The fix covers `HOME` either way.
- Antigravity/ZCode/Kimi/MiniMax/Grok/Cursor/Muse/OpenCode Go quota on either host, because there were no logins for them. The mapping follows their published shapes.
- Copilot's window id on Paseo now that Copilot bills in AI Credits.
- Older Paseo versions (0.17.x).

## Test plan for your Paseo install (about 10 minutes)

**Setup**
1. Check out the branch and install: `git checkout Orca && npm install`
2. Run `npm run typecheck && npm test`. **Expect** three lines: `ALL CHECKS PASSED (A–N)`, `ALL USAGE COST CHECKS PASSED`, `ALL ADVISOR CHECKS PASSED (A–H)`.
3. Note what QuotaMax shows **before** switching. On `main` (`git checkout main` then `paseo plugin reload quotamax`), record each pool's mode and % left on the Pools section, and the top 3 Standard and Frontier recommendations. Then run `git checkout Orca`.

**Load the branch**

4. If QuotaMax is installed from this folder, run `paseo plugin reload quotamax`. Otherwise run `paseo plugin install "$(pwd)"`. Paseo must be on `>=0.17.3` with plugins enabled.
5. Run `paseo plugin ls quotamax` and `paseo plugin logs quotamax`. **Expect** `running`, an empty ERROR column, and `Plugin ready`.

**Check behaviour**

6. Open QuotaMax from Explorer, the sidebar gauge or Command Center (`Open QuotaMax`). **Expect:**
   - the same modes, % left and top recommendations as step 3, allowing for usage since then
   - six new pools in the untracked list: Kimi Code, MiniMax M Plan, X Subscription (Grok + Cursor), OpenCode Go, Muse Code and GitHub Copilot, unless you're signed in to them, in which case they're tracked
7. Focus an agent composer, pick a recommendation and press **Apply**. **Expect** the composer's provider, model and thinking to switch, exactly as before.
8. Open the cost section and switch between 24h, 7d and 30d. **Expect** totals and per-pool/per-model tables, as before.
9. Optional, if you have an Artificial Analysis key: go to Settings → QuotaMax and run **Sync**. **Expect** *"Synced N/38 models…"*, and that `~/.paseo/plugin-data/quota-advisor/models.json` now contains the new pools.
10. Optional, on Windows without `bl`/`qwencloud`: run `paseo usage --json`. **Expect** no `alibaba` entry. Before this branch, there was one with an error.

**Roll back** at any time with `git checkout main && paseo plugin reload quotamax`.

## Trying the Orca side (optional)

1. Run `orca plugin dev load "$(pwd)" --json`. It stops with `approval_required` and lists the access the plugin asks for. If you agree, re-run the printed command with `--approve <fingerprint>`.
2. Open the gauge icon in Orca's right sidebar (or run `orca plugin open local.quotamax --panel quotamax`). The status bar shows the pool to use now.
3. Apply: start Claude Code in a workspace and let it go idle. Pick a Claude recommendation, then **Apply to agent** → **Send**. **Expect** `/model …` and `/effort …` to be typed into that agent.
4. Unload with `orca plugin dev unload "$(pwd)"`.
5. To publish for `orca plugin install desk36hq/quotamax`: set `version` in `orca-plugin.json`, tag `v<version>`, and add the `orca-plugin` GitHub topic.
