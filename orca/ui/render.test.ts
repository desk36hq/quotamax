// `orca plugin test .` — the Orca panel's renderer (pure: state in, HTML out).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CostEstimateSummary, ModelRecommendation, PoolStatus, QuotaAdvisorSnapshot } from "../../shared/types";
import { formatDuration, formatUsd, modeLabel } from "./format";
import { initialState, renderPanel, type ViewState } from "./render";

const burn = { sampleCount: 3, windowMinutes: 15, shortRatePctPerMin: 0.4, weeklyRatePctPerMin: 0.02, etaLabel: "5h limit in 42m", etaSeverity: "danger" as const, etaMinutes: 42, etaWindow: "5h" as const };

const claude: PoolStatus = {
  pool: "claude",
  label: "Claude",
  planLabel: "Max",
  paseoProvider: "claude",
  tracked: true,
  mode: "HAMMER",
  urgencyBonus: 30,
  shortCaution: false,
  reason: "80% left with 10.0h to reset",
  weekly: { id: "weekly", label: "Weekly", usedPct: 20, remainingPct: 80, resetsAt: null, remainingHours: 10, windowHours: 168, pace: 13.4, requiredPctPerHr: 8 },
  short: { id: "five_hour", label: "Session", usedPct: 88, remainingPct: 12, resetsAt: null, remainingHours: 0.7, windowHours: 5, pace: 0.6, requiredPctPerHr: 17 },
  burn,
};

const codex: PoolStatus = { ...claude, pool: "codex", label: "Codex", planLabel: null, tracked: false, mode: "UNTRACKED", reason: "Status: unavailable — <b>Codex</b> not signed in", weekly: null, short: null };

const rec = (modelId: string, label: string, score: number): ModelRecommendation => ({
  provider: "claude",
  modelId,
  paseoTarget: `claude/${modelId}`,
  label,
  pool: "claude",
  poolLabel: "Claude",
  poolMode: "HAMMER",
  tier: "frontier",
  intelligence: 97,
  coding: 98,
  efficiency: 52,
  quotaCost: 2.2,
  recommendedThinking: "xhigh",
  fitScore: score - 30,
  urgencyBonus: 30,
  totalScore: score,
  notes: `${label} notes`,
});

const recs = ["a", "b", "c", "d"].map((id, i) => rec(`model-${id}`, `Model ${id.toUpperCase()}`, 120 - i * 5));

const snapshot: QuotaAdvisorSnapshot = {
  generatedAt: "2026-11-27T16:00:00.000Z",
  lastPolledAt: "2026-11-27T16:00:00.000Z",
  pollIntervalMs: 90_000,
  catalogUpdatedAt: "2026-11-27",
  hasAaKey: false,
  error: null,
  pools: [codex, claude],
  recommendations: { quick: recs, standard: recs, hard: recs, frontier: recs },
};

const costs = {
  window: "7d",
  generatedAt: "",
  ratesUpdatedAt: null,
  ratesSource: "litellm",
  ratesCount: 6373,
  totalCostUsd: 142.5,
  cacheSavingsUsd: 1318,
  speedPremiumUsd: 0,
  cacheHitPct: 98,
  totalTokens: 354_400_000,
  totals: { uncachedInputTokens: 1, cachedInputTokens: 1, cacheCreationTokens: 1, outputTokens: 1_600_000, reasoningTokens: 0 },
  categoryCostUsd: { input: 0.01, cacheRead: 69.35, cacheWrite: 42.53, output: 30.56 },
  records: 1256,
  unpricedRecords: 0,
  unpricedModels: [],
  byPool: [{ pool: "claude", label: "Claude", costUsd: 142.5, cacheSavingsUsd: 1318, totalTokens: 354_400_000, cacheHitPct: 98, records: 1256, unpricedRecords: 0 }],
  byModel: [],
} as CostEstimateSummary;

const now = Date.parse("2026-11-27T16:00:15.000Z");
const view = (over: Partial<ViewState> = {}) => renderPanel({ ...initialState(), snapshot, costs, ...over }, now);

test("formats like the Paseo panel", () => {
  assert.equal(modeLabel("HAMMER", 13.43), "HAMMER · 13.4x");
  assert.equal(modeLabel("THROTTLED_5H", 1), "5H CAP");
  assert.equal(formatUsd(142.5), "$142.5");
  assert.equal(formatUsd(1318), "$1,318");
  assert.equal(formatDuration(0.7), "42m");
  assert.equal(formatDuration(142), "5d 22h");
});

test("draws the Paseo layout: header, top-3 models, pools, costs, footer", () => {
  const html = view();
  assert.match(html, /1 active pool · updated 15s ago/);
  assert.match(html, /Recommended Models/);
  assert.equal((html.match(/class="qm-rec[ "]/g) ?? []).length, 3, "top 3 until 'Show all'");
  assert.match(html, /class="qm-rec is-top"[\s\S]*1\. Model A/);
  assert.match(html, /Show all 4 ranked models/);
  assert.match(html, /Why #1: <\/strong>80% left with 10\.0h to reset\. Model A notes/);
  assert.match(html, /qm-pill">HAMMER · 13\.4x</);
  assert.match(html, /5h limit in 42m/);
  assert.match(html, /88% used · 42m/);
  assert.match(html, /Est\. Value[\s\S]*\$142\.5[\s\S]*Cache Saved[\s\S]*\$1,318/);
  assert.match(html, /Set AA Key/);
  assert.equal((view({ showAllModels: true }).match(/class="qm-rec[ "]/g) ?? []).length, 4);
});

test("escapes text that comes from providers and the worker", () => {
  const html = view({ showUntrackedReasons: true });
  assert.ok(!html.includes("— <b>Codex</b> not signed in"), "the reason's markup is not live HTML");
  assert.match(html, /— &lt;b&gt;Codex&lt;\/b&gt; not signed in/);
  assert.match(html, /title="Status: unavailable — &lt;b&gt;Codex&lt;\/b&gt; not signed in"/);
});

test("Apply asks before typing: preview banner with Send and Cancel", () => {
  const html = view({
    apply: { key: "claude/model-a", result: { status: "ready", message: "Send to Main?", commands: ["/model model-a", "/effort xhigh"], terminalId: "t1" } },
  });
  assert.match(html, /qm-banner is-info[\s\S]*Send to Main\?/);
  assert.match(html, /\/model model-a\n\/effort xhigh/);
  assert.match(html, /data-action="apply-send"/);
  assert.match(html, /data-action="apply-cancel"/);
  assert.match(view({ appliedKey: "claude/model-a" }), />Applied</);
});

test("settings card mirrors Paseo's Settings → QuotaMax screen", () => {
  const closed = view();
  assert.ok(!closed.includes("Artificial Analysis Benchmarks"));
  const html = view({ settingsOpen: true, keyDraft: "abc", recalibrate: false });
  assert.match(html, /Artificial Analysis Benchmarks/);
  assert.match(html, /id="qm-key"[^>]*type="password"[^>]*value="abc"/);
  assert.match(html, /data-action="save-key"(?![^>]*disabled)/);
  assert.match(html, /role="switch" aria-checked="false"/);
  assert.match(view({ settingsOpen: true }), /data-action="save-key"[^>]*disabled/);
});

test("loading and error states", () => {
  assert.match(renderPanel(initialState(), now), /Reading Orca's subscription quotas/);
  assert.match(renderPanel({ ...initialState(), fetchError: "orca account list: runtime_unavailable" }, now), /Could not refresh usage: orca account list: runtime_unavailable/);
});
