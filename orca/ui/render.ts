// Pure rendering for the Orca panel: state in, HTML out (no DOM, so it tests in Node). The
// structure mirrors the Paseo panel (client/panel.tsx) section by section. Every value that
// comes from data is escaped with `esc`. Buttons carry `data-action` (and `data-value`)
// for main.ts's click handler, and a stable `id` so focus survives a re-render.
import type {
  CostEstimateSummary,
  CostWindow,
  ModelRecommendation,
  PoolCostBreakdown,
  PoolStatus,
  QuotaAdvisorSnapshot,
  SyncAaResult,
  TaskTier,
} from "../../shared/types";
import type { ApplyResult } from "../applyTypes";
import { esc, formatCompactTokens, formatDuration, formatRelativeAge, formatUsd, MODE_ORDER, modeLabel } from "./format";
import { icons, spinner } from "./icons";

export const TASK_TIERS: readonly { id: TaskTier; label: string }[] = [
  { id: "quick", label: "Quick" },
  { id: "standard", label: "Standard" },
  { id: "hard", label: "Hard" },
  { id: "frontier", label: "Frontier" },
];

export const COST_WINDOWS: readonly { id: CostWindow; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
];

export const AA_KEY_URL = "https://artificialanalysis.ai/insights";

export interface ViewState {
  snapshot: QuotaAdvisorSnapshot | null;
  fetchError: string | null;
  refreshing: boolean;
  tier: TaskTier;
  showAllModels: boolean;
  /** The Apply banner and the recommendation it is about. */
  apply: { key: string; result: ApplyResult } | null;
  applying: boolean;
  appliedKey: string | null;
  costWindow: CostWindow;
  costs: CostEstimateSummary | null;
  costsLoading: boolean;
  costsError: string | null;
  showCostModels: boolean;
  showUntrackedReasons: boolean;
  settingsOpen: boolean;
  keyDraft: string;
  revealKey: boolean;
  keyNotice: { ok: boolean; text: string } | null;
  savingKey: boolean;
  recalibrate: boolean;
  syncing: boolean;
  syncNotice: SyncAaResult | null;
  /** A snapshot was pushed recently (Paseo's "live" subscription dot). */
  live: boolean;
}

export function initialState(): ViewState {
  return {
    snapshot: null,
    fetchError: null,
    refreshing: false,
    tier: "standard",
    showAllModels: false,
    apply: null,
    applying: false,
    appliedKey: null,
    costWindow: "7d",
    costs: null,
    costsLoading: false,
    costsError: null,
    showCostModels: false,
    showUntrackedReasons: false,
    settingsOpen: false,
    keyDraft: "",
    revealKey: false,
    keyNotice: null,
    savingKey: false,
    recalibrate: true,
    syncing: false,
    syncNotice: null,
    live: false,
  };
}

export const recKey = (r: ModelRecommendation) => `${r.provider}/${r.modelId}`;

/** Ids for buttons, so main.ts can put focus back after a re-render. */
const bid = (action: string, value?: string | number) =>
  `qm-${action}${value === undefined ? "" : `-${String(value).replace(/[^\w-]/g, "_")}`}`;

function button(
  cls: string,
  action: string,
  inner: string,
  opts: { value?: string | number; label?: string; disabled?: boolean; pressed?: boolean; extra?: string } = {}
): string {
  const attrs = [
    `id="${bid(action, opts.value)}"`,
    `class="${cls}"`,
    `type="button"`,
    `data-action="${action}"`,
    opts.value !== undefined ? `data-value="${esc(opts.value)}"` : "",
    opts.label ? `aria-label="${esc(opts.label)}"` : "",
    opts.pressed !== undefined ? `aria-pressed="${opts.pressed}"` : "",
    opts.disabled ? "disabled" : "",
    opts.extra ?? "",
  ].filter(Boolean);
  return `<button ${attrs.join(" ")}>${inner}</button>`;
}

export function sortPools(pools: PoolStatus[]): { tracked: PoolStatus[]; untracked: PoolStatus[] } {
  const tracked = pools
    .filter((p) => p.tracked)
    .sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode] || (b.weekly?.pace ?? 0) - (a.weekly?.pace ?? 0));
  return { tracked, untracked: pools.filter((p) => !p.tracked) };
}

// ── Header ────────────────────────────────────────────────────────────────

function renderHeader(s: ViewState, trackedCount: number, nowMs: number): string {
  const updated = s.snapshot?.lastPolledAt ? ` · updated ${formatRelativeAge(s.snapshot.lastPolledAt, nowMs)}` : "";
  return `<header class="qm-header">
  <div class="qm-title-block">
    <div class="qm-title">${icons.gauge(16)}<span>QuotaMax</span></div>
    <div class="qm-subtitle">${trackedCount} active ${trackedCount === 1 ? "pool" : "pools"}${esc(updated)}</div>
  </div>
  <div class="qm-header-actions">
    ${button("qm-btn", "refresh", `${s.refreshing ? spinner() : icons.refresh(13)}<span>Refresh</span>`, { label: "Refresh subscription usage", disabled: s.refreshing })}
    ${button(`qm-icon-btn${s.settingsOpen ? " is-active" : ""}`, "toggle-settings", icons.settings(14), { label: "QuotaMax settings", pressed: s.settingsOpen })}
  </div>
</header>`;
}

// ── Settings (Paseo's Settings → QuotaMax screen, inline) ─────────────────

function renderSettings(s: ViewState): string {
  const hasKey = Boolean(s.snapshot?.hasAaKey);
  const dirty = s.keyDraft.trim().length > 0;
  const notice = s.keyNotice
    ? `<div class="qm-note ${s.keyNotice.ok ? "is-ok" : "is-error"}">${esc(s.keyNotice.text)}</div>`
    : "";
  const sync =
    s.syncNotice && s.settingsOpen
      ? `<div class="qm-note ${s.syncNotice.ok ? "is-ok" : "is-error"}">${esc(s.syncNotice.message)}</div>`
      : "";
  return `<section class="qm-card qm-settings" aria-label="QuotaMax settings">
  <div class="qm-card-head"><h2>Artificial Analysis Benchmarks</h2>${button("qm-link", "toggle-settings", "Done", { value: "done" })}</div>
  <div class="qm-settings-body">
    <div>
      <div class="qm-setting-title">Artificial Analysis API Key</div>
      <div class="qm-setting-desc">Stored in Orca's encrypted plugin secrets on this computer. Used to pull live Intelligence Index, Coding Index, and pricing into your local models.json catalog.</div>
    </div>
    <div class="qm-row">
      <input id="qm-key" class="qm-input" type="${s.revealKey ? "text" : "password"}" value="${esc(s.keyDraft)}" placeholder="${hasKey ? "Key saved. Paste a new key to replace it" : "Paste free API key from artificialanalysis.ai/insights"}" autocomplete="off" spellcheck="false" aria-label="Artificial Analysis API key">
      ${button("qm-btn is-fg", "toggle-reveal", s.revealKey ? "Hide" : "Show")}
    </div>
    <div class="qm-row is-wrap">
      ${button("qm-primary", "save-key", s.savingKey ? "Saving…" : "Save Key", { disabled: !dirty || s.savingKey })}
      ${button("qm-btn is-fg", "sync-aa", `${s.syncing ? spinner() : ""}<span>${s.syncing ? "Syncing…" : "Sync AA Now"}</span>`, { value: "settings", disabled: s.syncing })}
      ${button("qm-link", "open-aa-site", "Get free key ↗")}
      ${hasKey ? button("qm-link is-danger", "remove-key", "Remove key") : ""}
    </div>
    ${notice}${sync}
  </div>
  <div class="qm-setting-row">
    <div>
      <div class="qm-setting-title">Recalibrate IQ &amp; Efficiency scores on sync</div>
      <div class="qm-setting-desc">When on, Sync AA updates each matched model's intelligence, coding, and efficiency scores from AA's live index and blended price.</div>
    </div>
    ${button("qm-switch", "toggle-recalibrate", "", { label: "Recalibrate scores on sync", extra: `role="switch" aria-checked="${s.recalibrate}"` })}
  </div>
</section>`;
}

// ── Recommended Models ────────────────────────────────────────────────────

function renderApplyBanner(s: ViewState): string {
  if (!s.apply) return "";
  const r = s.apply.result;
  const tone = r.status === "sent" ? "is-ok" : r.status === "ready" ? "is-info" : r.status === "failed" ? "is-error" : "is-warn";
  const cmds = r.commands.length ? `<div class="qm-cmd">${esc(r.commands.join("\n"))}</div>` : "";
  const actions =
    r.status === "ready" && r.terminalId
      ? `<div class="qm-banner-actions">${button("qm-apply is-top", "apply-send", s.applying ? "Sending…" : "Send", { disabled: s.applying })}${button("qm-apply", "apply-cancel", "Cancel", { disabled: s.applying })}</div>`
      : "";
  return `<div class="qm-banner ${tone}" role="status"><div>${esc(r.message)}</div>${cmds}${actions}</div>`;
}

function renderRec(rec: ModelRecommendation, idx: number, pool: PoolStatus | undefined, s: ViewState): string {
  const isTop = idx === 0;
  const justApplied = s.appliedKey === recKey(rec);
  const thinking = rec.recommendedThinking ? `<span class="qm-chip">${esc(rec.recommendedThinking)}</span>` : "";
  const applyCls = `qm-apply${isTop ? " is-top" : ""}${justApplied ? " is-applied" : ""}`;
  return `<div class="qm-rec${isTop ? " is-top" : ""}">
  <div class="qm-rec-main">
    <div class="qm-rec-title"><span class="qm-rec-name">${idx + 1}. ${esc(rec.label)}</span>${thinking}</div>
    <div class="qm-rec-meta"><span class="qm-mono">${esc(rec.provider)}</span><span>· IQ ${esc(rec.intelligence)} · Eff ${esc(rec.efficiency)}</span><span class="qm-mode-text mode-${esc(rec.poolMode)}">· ${esc(modeLabel(rec.poolMode, pool?.weekly?.pace ?? null))}</span></div>
  </div>
  <div class="qm-rec-side">
    <span class="qm-score${isTop ? " is-top" : ""}">${rec.totalScore.toFixed(1)}</span>
    ${button(applyCls, "apply", justApplied ? "Applied" : "Apply", { value: idx, label: `Apply ${rec.label}`, disabled: s.applying })}
  </div>
</div>`;
}

function renderRecommendations(s: ViewState, snap: QuotaAdvisorSnapshot, poolByKey: Map<string, PoolStatus>): string {
  const recs = snap.recommendations[s.tier] ?? [];
  const visible = s.showAllModels ? recs : recs.slice(0, 3);
  const top = recs[0];
  const topPool = top ? poolByKey.get(top.pool) : undefined;
  const seg = TASK_TIERS.map((t) =>
    button(t.id === s.tier ? "is-active" : "", "tier", esc(t.label), { value: t.id, pressed: t.id === s.tier })
  ).join("");
  const why =
    top && topPool
      ? `<div class="qm-why"><strong>Why #1: </strong>${esc(topPool.reason)}. ${esc(top.notes)}</div>`
      : "";
  const more =
    recs.length > 3
      ? button("qm-link", "toggle-all-models", s.showAllModels ? "Show top 3" : `Show all ${recs.length} ranked models`)
      : "";
  const list = visible.length
    ? `<div class="qm-recs">${visible.map((r, i) => renderRec(r, i, poolByKey.get(r.pool), s)).join("")}</div>`
    : `<div class="qm-muted-text">No tracked subscription yet. Sign in to a provider in Orca (Settings → Accounts) and QuotaMax ranks its models here.</div>`;
  return `<section class="qm-card" aria-label="Recommended models">
  <div class="qm-card-head"><h2>Recommended Models</h2><div class="qm-seg" role="group" aria-label="Task">${seg}</div></div>
  ${renderApplyBanner(s)}
  ${list}
  ${why}
  ${more}
</section>`;
}

// ── Burn Pace & Resets ────────────────────────────────────────────────────

function barRow(label: string, usedPct: number, resetText: string, fill: string): string {
  const clamped = Math.max(0, Math.min(100, usedPct));
  return `<div class="qm-bar-row"><span class="qm-bar-label">${esc(label)}</span><div class="qm-bar"><i style="width:${clamped.toFixed(1)}%;--fill:${fill}"></i></div><span class="qm-bar-text">${usedPct.toFixed(0)}% used · ${esc(resetText)}</span></div>`;
}

function renderPool(pool: PoolStatus, poolCost: PoolCostBreakdown | undefined, costWindow: CostWindow): string {
  const weeklyFill =
    pool.mode === "HAMMER"
      ? "var(--qm-warning)"
      : pool.mode === "CONSERVE" || pool.mode === "EXHAUSTED"
        ? "var(--qm-danger)"
        : pool.mode === "PUSH"
          ? "var(--qm-accent)"
          : "var(--qm-success)";
  const shortFill = pool.short && pool.short.remainingPct <= 15 ? "var(--qm-danger)" : "var(--qm-accent)";
  const rate =
    pool.burn.etaWindow === "5h"
      ? pool.burn.shortRatePctPerMin
      : pool.burn.etaWindow === "weekly"
        ? pool.burn.weeklyRatePctPerMin
        : null;
  const longLabel = pool.weekly && (pool.weekly.id === "monthly" || pool.weekly.windowHours >= 600) ? "Monthly" : "Weekly";
  const burnText = `15m burn${rate != null && rate > 0 ? ` (${rate.toFixed(2)}%/m)` : ""}${
    poolCost && poolCost.costUsd > 0 ? ` · ${costWindow} est. ${formatUsd(poolCost.costUsd)}` : ""
  }`;
  const sev = pool.burn.etaSeverity;
  return `<div class="qm-pool mode-${esc(pool.mode)}">
  <div class="qm-pool-head">
    <div class="qm-pool-name"><strong>${esc(pool.label)}</strong>${pool.planLabel ? `<span>${esc(pool.planLabel)}</span>` : ""}</div>
    <span class="qm-pill">${esc(modeLabel(pool.mode, pool.weekly?.pace ?? null))}</span>
  </div>
  ${pool.weekly ? barRow(longLabel, pool.weekly.usedPct, formatDuration(pool.weekly.remainingHours), weeklyFill) : ""}
  ${pool.short ? barRow("5-hour", pool.short.usedPct, formatDuration(pool.short.remainingHours), shortFill) : ""}
  <div class="qm-burn"><span>${esc(burnText)}</span><span class="qm-eta${sev === "idle" ? "" : ` is-${sev}`}">${sev === "idle" ? "" : icons.flame(11)}${esc(pool.burn.etaLabel)}</span></div>
</div>`;
}

function renderPools(s: ViewState, tracked: PoolStatus[], untracked: PoolStatus[]): string {
  const costByPool = new Map((s.costs?.byPool ?? []).map((p) => [p.pool, p]));
  const untrackedHtml = untracked.length
    ? `<div class="qm-untracked">Untracked: ${untracked
        .map((p) => `<span title="${esc(p.reason)}">${esc(p.label)}</span>`)
        .join(", ")} ${button("qm-link", "toggle-untracked", s.showUntrackedReasons ? "Hide reasons" : "Why?")}</div>${
        s.showUntrackedReasons
          ? `<ul class="qm-reasons">${untracked.map((p) => `<li><b>${esc(p.label)}</b>: ${esc(p.reason)}</li>`).join("")}</ul>`
          : ""
      }`
    : "";
  return `<section class="qm-card" aria-label="Burn pace and resets">
  <div class="qm-card-head"><h2>Burn Pace &amp; Resets</h2><span class="qm-hint">Ratio &gt; 1x = surplus · 15m burn ETA</span></div>
  ${tracked.length ? `<div class="qm-pools">${tracked.map((p) => renderPool(p, costByPool.get(p.pool), s.costWindow)).join("")}</div>` : ""}
  ${untrackedHtml}
</section>`;
}

// ── API-Equivalent Cost ───────────────────────────────────────────────────

function renderCosts(s: ViewState): string {
  const c = s.costs;
  const seg = COST_WINDOWS.map((w) =>
    button(w.id === s.costWindow ? "is-active" : "", "cost-window", esc(w.label), { value: w.id, pressed: w.id === s.costWindow })
  ).join("");
  let body = "";
  if (s.costsError) body += `<div class="qm-error-text">Could not scan local usage: ${esc(s.costsError)}</div>`;
  if (c) {
    const cat = c.categoryCostUsd;
    const catTotal = cat.input + cat.cacheRead + cat.cacheWrite + cat.output;
    const pct = (part: number) => (catTotal > 0 ? Math.max(0, (part / catTotal) * 100) : 0);
    const kpi = (label: string, value: string, sub: string, valueCls = "", subCls = "") =>
      `<div class="qm-kpi"><span class="qm-kpi-label">${label}</span><span class="qm-kpi-value ${valueCls}">${esc(value)}</span><span class="qm-kpi-sub ${subCls}">${esc(sub)}</span></div>`;
    body += `<div class="qm-kpis">
  ${c.speedPremiumUsd > 0.01 ? kpi("Est. Value", formatUsd(c.totalCostUsd), `+${formatUsd(c.speedPremiumUsd)} fast`, "", "is-warning") : kpi("Est. Value", formatUsd(c.totalCostUsd), `${c.records.toLocaleString("en-US")} turns`)}
  ${kpi("Cache Saved", formatUsd(c.cacheSavingsUsd), `${c.cacheHitPct.toFixed(0)}% cache hit`, "is-success")}
  ${kpi("Tokens", formatCompactTokens(c.totalTokens), `${formatCompactTokens(c.totals.outputTokens)} out`)}
</div>`;
    if (catTotal > 0) {
      body += `<div class="qm-split">
  <div class="qm-split-bar"><i class="bg-accent" style="width:${pct(cat.input).toFixed(2)}%"></i><i class="bg-success" style="width:${pct(cat.cacheRead).toFixed(2)}%"></i><i class="bg-warning" style="width:${pct(cat.cacheWrite).toFixed(2)}%"></i><i class="bg-purple" style="width:${pct(cat.output).toFixed(2)}%"></i></div>
  <div class="qm-legend"><span>In ${formatUsd(cat.input)}</span><span class="c-success">Cache Rd ${formatUsd(cat.cacheRead)}</span><span class="c-warning">Cache Wr ${formatUsd(cat.cacheWrite)}</span><span class="c-purple">Out ${formatUsd(cat.output)}</span></div>
</div>`;
    }
    body += c.byPool.length
      ? `<div class="qm-cost-pools">${c.byPool
          .map((p) => {
            const share = c.totalCostUsd > 0 ? Math.min(100, (p.costUsd / c.totalCostUsd) * 100) : 0;
            return `<div class="qm-cost-pool"><div class="qm-cost-row"><strong>${esc(p.label)}</strong><span class="qm-mono">${formatCompactTokens(p.totalTokens)} · ${p.cacheHitPct.toFixed(0)}% hit</span><span class="qm-amount">${formatUsd(p.costUsd)}</span></div><div class="qm-share"><i style="width:${share.toFixed(1)}%"></i></div></div>`;
          })
          .join("")}</div>`
      : `<div class="qm-muted-text">No local session usage recorded in the last ${esc(s.costWindow)}.</div>`;
    if (c.byModel.length) {
      body += button("qm-link", "toggle-cost-models", s.showCostModels ? "Hide model breakdown" : `Show top ${c.byModel.length} models`);
      if (s.showCostModels) {
        body += `<div class="qm-cost-models">${c.byModel
          .map(
            (m) =>
              `<div class="qm-cost-model"><div class="qm-cost-model-main"><strong title="${esc(m.model)}">${esc(m.model)}</strong><span>${esc(m.provider)} · ${formatCompactTokens(m.totalTokens)} · ${m.records} turns</span></div><span class="qm-amount${m.unpriced ? " is-unpriced" : ""}">${m.unpriced ? "unpriced" : formatUsd(m.costUsd)}</span></div>`
          )
          .join("")}</div>`;
      }
    }
    const source = c.ratesSource === "openrouter" ? "OpenRouter" : c.ratesSource === "fallback" ? "built-in fallback" : "LiteLLM";
    body += `<div class="qm-footnote">API-equivalent rates via ${source} (${c.ratesCount.toLocaleString("en-US")} models) — reflects equivalent API value, not subscription spend.${
      c.unpricedRecords > 0 ? ` ${c.unpricedRecords} unpriced turns.` : ""
    } Reads Claude Code, Codex, Antigravity and Pi logs on this computer.</div>`;
  } else if (!s.costsLoading && !s.costsError) {
    body += `<div class="qm-muted-text">Scanning local agent transcripts…</div>`;
  }
  return `<section class="qm-card" aria-label="API-equivalent cost">
  <div class="qm-card-head"><h2>API-Equivalent Cost${s.costsLoading ? spinner() : ""}</h2><div class="qm-seg is-small" role="group" aria-label="Cost window">${seg}</div></div>
  ${body}
</section>`;
}

// ── Footer ────────────────────────────────────────────────────────────────

function renderFooter(s: ViewState, snap: QuotaAdvisorSnapshot): string {
  const notice =
    s.syncNotice && !s.settingsOpen
      ? `<div class="qm-banner ${s.syncNotice.ok ? "is-ok" : "is-error"}">${esc(s.syncNotice.message)}</div>`
      : "";
  const label = s.syncing ? "Syncing…" : snap.hasAaKey ? "Sync AA" : "Set AA Key";
  const icon = s.syncing ? spinner() : snap.hasAaKey ? icons.refresh(11) : icons.keyRound(11);
  return `${notice}<footer class="qm-footer">
  <div class="qm-footer-status"><span class="qm-dot${s.live ? " is-live" : ""}" title="${s.live ? "Live updates from the QuotaMax worker" : "Waiting for the next update"}"></span><span>AA baseline (${esc(snap.catalogUpdatedAt)})</span></div>
  ${button("qm-link", "sync-aa", `${icon}<span>${label}</span>`, { value: "footer", label: snap.hasAaKey ? "Sync Artificial Analysis scores" : "Configure Artificial Analysis API key", disabled: s.syncing })}
</footer>`;
}

// ── Panel ─────────────────────────────────────────────────────────────────

export function renderPanel(s: ViewState, nowMs: number): string {
  const snap = s.snapshot;
  const { tracked, untracked } = sortPools(snap?.pools ?? []);
  const poolByKey = new Map((snap?.pools ?? []).map((p) => [p.pool, p]));
  const parts = [renderHeader(s, tracked.length, nowMs)];
  if (s.settingsOpen) parts.push(renderSettings(s));
  if (s.fetchError) parts.push(`<div class="qm-banner is-error" role="alert">Could not refresh usage: ${esc(s.fetchError)}</div>`);
  if (!snap && !s.fetchError) {
    parts.push(`<div class="qm-loading">${spinner("is-large")}<span>Reading Orca's subscription quotas…</span></div>`);
  }
  if (snap) {
    parts.push(renderRecommendations(s, snap, poolByKey));
    parts.push(renderPools(s, tracked, untracked));
    parts.push(renderCosts(s));
    parts.push(renderFooter(s, snap));
  }
  return parts.join("\n");
}
