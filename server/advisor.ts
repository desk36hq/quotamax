// Host-neutral quota advisor. It must not import zod or the Paseo SDK at runtime:
// Orca loads this file as-is, without a bundler or node_modules.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AddBankedResetInput,
  AdvisorSettingsValues,
  BankedResetEntry,
  BurnMode,
  BurnRateEstimate,
  ModelRecommendation,
  PoolStatus,
  QuotaAdvisorSnapshot,
  SyncAaResult,
  TaskTier,
  WindowStats,
} from "../shared/types";
import { BankedResetManager, computeResetAdvice } from "./bankedResets";
import type { QuotaSource, UsageReportEntry, UsageWindowRaw } from "./quotaSource";

const AA_ENDPOINTS = [
  "https://artificialanalysis.ai/api/v2/data/llms/models",
  "https://artificialanalysis.ai/api/v2/language/models",
];

const POLL_INTERVAL_MS = 90_000;
const HISTORY_RETENTION_MS = 65 * 60_000;
const PRIMARY_BURN_WINDOW_MS = 15 * 60_000;
const FALLBACK_BURN_WINDOW_MS = 30 * 60_000;
const VALID_TASKS: readonly TaskTier[] = ["quick", "standard", "hard", "frontier"];

export interface CatalogPool {
  label: string;
  sourceId: string;
  weeklyWindowId: string;
  shortWindowId: string;
  paseoProvider: string;
  /** Other source ids that report this pool, tried after `sourceId` (e.g. a renamed source). */
  sourceIds?: string[];
  /**
   * More window ids tried after `shortWindowId` / `weeklyWindowId`, in order. An id ending
   * in `*` is a prefix (e.g. `interval_*` for per-model windows); when several windows
   * match, the most-used one wins, since it is the one that binds.
   */
  shortWindowIds?: string[];
  weeklyWindowIds?: string[];
  /** Length assumed for the long window when the source omits it (default 7 days). */
  weeklyWindowSeconds?: number;
  /** Hosts whose quota source can report this pool (informational; shown in the README). */
  hosts?: string[];
}

export interface CatalogModel {
  id: string;
  provider: string;
  pool: string;
  label: string;
  tier: string;
  intelligence: number;
  coding: number;
  efficiency: number;
  quotaCost: number;
  bestFor: string[];
  thinking?: Record<string, string | null>;
  aaMatch?: string[];
  /**
   * A window that limits this model on its own, within its pool (e.g. Claude's separate
   * weekly Fable limit, `weekly_model_fable`). Same id/prefix rules as pool windows.
   */
  modelWindowId?: string;
  aaMetrics?: {
    name: string;
    slug: string | null;
    intelligenceIndex: number | null;
    codingIndex: number | null;
    blendedPricePer1M: number | null;
    medianOutputTps: number | null;
    syncedAt: string;
  };
  notes: string;
}

export interface ModelCatalog {
  updatedAt: string;
  pools: Record<string, CatalogPool>;
  models: CatalogModel[];
  [key: string]: unknown;
}

// ── Catalog validation (replaces the former zod schemas; same acceptance rules) ──

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && !Number.isNaN(v);
const isNullableNum = (v: unknown) => v === null || isNum(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

function validPool(v: unknown): v is CatalogPool {
  return (
    isObj(v) &&
    isStr(v.label) &&
    isStr(v.sourceId) &&
    isStr(v.weeklyWindowId) &&
    isStr(v.shortWindowId) &&
    isStr(v.paseoProvider) &&
    (v.sourceIds === undefined || isStrArray(v.sourceIds)) &&
    (v.shortWindowIds === undefined || isStrArray(v.shortWindowIds)) &&
    (v.weeklyWindowIds === undefined || isStrArray(v.weeklyWindowIds)) &&
    (v.weeklyWindowSeconds === undefined || (isNum(v.weeklyWindowSeconds) && v.weeklyWindowSeconds > 0)) &&
    (v.hosts === undefined || isStrArray(v.hosts))
  );
}

function validModel(v: unknown): v is CatalogModel {
  if (!isObj(v)) return false;
  if (![v.id, v.provider, v.pool, v.label, v.tier, v.notes].every(isStr)) return false;
  if (![v.intelligence, v.coding, v.efficiency, v.quotaCost].every(isNum)) return false;
  if (!isStrArray(v.bestFor)) return false;
  if (v.thinking !== undefined) {
    if (!isObj(v.thinking)) return false;
    if (!Object.values(v.thinking).every((t) => t === null || isStr(t))) return false;
  }
  if (v.aaMatch !== undefined && !isStrArray(v.aaMatch)) return false;
  if (v.modelWindowId !== undefined && !isStr(v.modelWindowId)) return false;
  if (v.aaMetrics !== undefined) {
    const m = v.aaMetrics;
    if (!isObj(m) || !isStr(m.name) || !isStr(m.syncedAt)) return false;
    if (!(m.slug === null || isStr(m.slug))) return false;
    if (![m.intelligenceIndex, m.codingIndex, m.blendedPricePer1M, m.medianOutputTps].every(isNullableNum)) {
      return false;
    }
  }
  return true;
}

/** A validated copy of `raw`, or null when any part of it is malformed. */
export function parseCatalog(raw: unknown): ModelCatalog | null {
  if (!isObj(raw) || !isStr(raw.updatedAt) || !isObj(raw.pools) || !Array.isArray(raw.models)) {
    return null;
  }
  if (!Object.values(raw.pools).every(validPool)) return null;
  if (!raw.models.every(validModel)) return null;
  return structuredClone(raw) as ModelCatalog;
}

/**
 * Model fields that describe how QuotaMax reads a model's quota rather than how good it
 * is. The bundled catalog owns them, so a catalog synced before a field existed (or
 * changed) still gets it; an Artificial Analysis sync never writes them.
 */
function structuralFields(m: CatalogModel): Pick<CatalogModel, "modelWindowId"> {
  return m.modelWindowId !== undefined ? { modelWindowId: m.modelWindowId } : {};
}

/**
 * A catalog synced from Artificial Analysis keeps its model scores (intelligence, coding,
 * efficiency, aaMetrics and the rest), but:
 * - models present in both take their structural fields from the bundled catalog,
 * - pools and models added to the bundled catalog in later releases are added,
 * - the bundled pool settings (how a pool reads its quota windows) replace stale copies.
 */
export function mergeWithBundled(synced: ModelCatalog, bundled: ModelCatalog): ModelCatalog {
  const pools: Record<string, CatalogPool> = { ...synced.pools, ...bundled.pools };
  const key = (m: CatalogModel) => `${m.pool}|${m.provider}|${m.id}`;
  const bundledByKey = new Map(bundled.models.map((m) => [key(m), m]));
  const have = new Set(synced.models.map(key));
  const models = synced.models.map((m) => {
    const b = bundledByKey.get(key(m));
    return b ? { ...m, ...structuralFields(b) } : m;
  });
  return {
    ...synced,
    pools,
    models: [...models, ...bundled.models.filter((m) => !have.has(key(m)))],
  };
}

interface PoolSample {
  ts: number;
  shortUsedPct: number | null;
  weeklyUsedPct: number | null;
  shortResetsAt: string | null;
  weeklyResetsAt: string | null;
}

export interface QuotaAdvisorOptions {
  readSettings: () => Promise<AdvisorSettingsValues>;
  /** Where quota windows come from: Paseo's usage tracker or Orca's rate limits. */
  quotaSource: QuotaSource;
  /** The catalog shipped with the plugin (server/default-models.json). */
  bundledCatalog: unknown;
  /** This host's data folder; the Artificial Analysis sync writes models.json here. */
  dataDir: string;
  /** Catalogs synced under another host, read when this host has none of its own. */
  fallbackCatalogPaths?: string[];
  /** Disable live read-only banked-reset API calls (for deterministic tests). */
  disableBankedResetApi?: boolean;
}

function skillCatalogPath(): string {
  return path.join(os.homedir(), ".agents", "skills", "quota-advisor", "references", "models.json");
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function formatDuration(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return "-";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 36) return `${hours.toFixed(1)}h`;
  let days = Math.floor(hours / 24);
  let remH = Math.round(hours - days * 24);
  if (remH === 24) {
    days += 1;
    remH = 0;
  }
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

function formatEtaMinutes(mins: number): string {
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`;
  const h = mins / 60;
  if (h < 36) return `${h.toFixed(1)}h`;
  const d = Math.floor(h / 24);
  const remH = Math.round(h - d * 24);
  return remH > 0 ? `${d}d ${remH}h` : `${d}d`;
}

function writeFileAtomically(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function tryReadValidatedCatalog(filePath: string): ModelCatalog | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return parseCatalog(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return null;
  }
}

function resolveAaApiKey(settings: AdvisorSettingsValues): string {
  return (settings.aaApiKey || process.env.ARTIFICIAL_ANALYSIS_API_KEY || "").trim();
}

function parseWindow(
  win: UsageWindowRaw | undefined,
  nowMs: number,
  fallbackDurationSec: number
): WindowStats | null {
  if (!win) return null;
  const hasUsed = typeof win.usedPct === "number" && Number.isFinite(win.usedPct);
  const hasRem = typeof win.remainingPct === "number" && Number.isFinite(win.remainingPct);
  if (!hasUsed && !hasRem) return null;
  const usedPct = hasUsed ? win.usedPct! : 100 - win.remainingPct!;
  const remainingPct = hasRem ? win.remainingPct! : 100 - usedPct;
  const durationSec = win.durationSeconds || fallbackDurationSec;
  const windowHours = durationSec / 3600;
  const parsedReset = win.resetsAt ? Date.parse(win.resetsAt) : NaN;
  const resetsAtMs = Number.isFinite(parsedReset) ? parsedReset : null;
  const remainingHours = resetsAtMs != null ? Math.max(0.05, (resetsAtMs - nowMs) / 3_600_000) : null;
  const timeRemainingFrac =
    remainingHours != null ? clamp(remainingHours / windowHours, 0.001, 1.0) : null;
  const quotaRemainingFrac = clamp(remainingPct / 100, 0, 1);
  const pace = timeRemainingFrac != null ? quotaRemainingFrac / timeRemainingFrac : null;
  const requiredPctPerHr = remainingHours != null ? remainingPct / remainingHours : null;
  return {
    id: win.id,
    label: win.label || win.id,
    usedPct: Number(usedPct.toFixed(1)),
    remainingPct: Number(remainingPct.toFixed(1)),
    resetsAt: win.resetsAt || null,
    remainingHours: remainingHours != null ? Number(remainingHours.toFixed(2)) : null,
    windowHours: Number(windowHours.toFixed(1)),
    pace: pace != null ? Number(pace.toFixed(2)) : null,
    requiredPctPerHr: requiredPctPerHr != null ? Number(requiredPctPerHr.toFixed(2)) : null,
  };
}

function computeRatePctPerMin(
  samples: PoolSample[],
  nowMs: number,
  field: "shortUsedPct" | "weeklyUsedPct",
  resetField: "shortResetsAt" | "weeklyResetsAt"
): { rate: number | null; windowMinutes: number; sampleCount: number } {
  if (samples.length < 2) {
    return { rate: null, windowMinutes: 0, sampleCount: samples.length };
  }
  const latest = samples[samples.length - 1];
  const latestVal = latest[field];
  if (latestVal == null) {
    return { rate: null, windowMinutes: 0, sampleCount: samples.length };
  }

  // Only compare against samples from the same reset cycle (no negative jumps)
  const sameCycle = samples.filter((s) => {
    const val = s[field];
    if (val == null) return false;
    if (latest[resetField] && s[resetField] && s[resetField] !== latest[resetField]) return false;
    return val <= latestVal;
  });

  if (sameCycle.length < 2) {
    return { rate: null, windowMinutes: 0, sampleCount: sameCycle.length };
  }

  // Prefer the oldest sample within 15m; fall back to 30m if 15m saw zero delta
  const pickBaseline = (windowMs: number): PoolSample | null => {
    const cutoff = nowMs - windowMs;
    const inWin = sameCycle.filter((s) => s.ts >= cutoff);
    if (inWin.length < 2) return null;
    return inWin[0];
  };

  let base = pickBaseline(PRIMARY_BURN_WINDOW_MS);
  if (base && latestVal - (base[field] ?? latestVal) === 0) {
    const wider = pickBaseline(FALLBACK_BURN_WINDOW_MS);
    if (wider && latestVal - (wider[field] ?? latestVal) > 0) {
      base = wider;
    }
  }
  if (!base) {
    base = sameCycle[0];
  }

  const dtMin = (latest.ts - base.ts) / 60_000;
  if (dtMin < 0.75) {
    return { rate: null, windowMinutes: Number(dtMin.toFixed(1)), sampleCount: sameCycle.length };
  }
  const delta = latestVal - (base[field] ?? latestVal);
  const rate = delta > 0 ? delta / dtMin : 0;
  return {
    rate: Number(rate.toFixed(4)),
    windowMinutes: Number(dtMin.toFixed(1)),
    sampleCount: sameCycle.length,
  };
}

function estimateBurn(
  samples: PoolSample[],
  nowMs: number,
  shortWin: WindowStats | null,
  weeklyWin: WindowStats | null
): BurnRateEstimate {
  const shortCalc = computeRatePctPerMin(samples, nowMs, "shortUsedPct", "shortResetsAt");
  const weeklyCalc = computeRatePctPerMin(samples, nowMs, "weeklyUsedPct", "weeklyResetsAt");

  const windowMinutes = Math.max(shortCalc.windowMinutes, weeklyCalc.windowMinutes);
  const sampleCount = Math.max(shortCalc.sampleCount, weeklyCalc.sampleCount);

  let bestEtaMins: number | null = null;
  let bestWindow: "5h" | "weekly" | null = null;

  if (shortWin && shortCalc.rate != null && shortCalc.rate > 0 && shortWin.remainingPct > 0) {
    const etaMins = shortWin.remainingPct / shortCalc.rate;
    const resetMins = shortWin.remainingHours != null ? shortWin.remainingHours * 60 : Infinity;
    if (etaMins < resetMins) {
      bestEtaMins = etaMins;
      bestWindow = "5h";
    }
  }

  if (weeklyWin && weeklyCalc.rate != null && weeklyCalc.rate > 0 && weeklyWin.remainingPct > 0) {
    const etaMins = weeklyWin.remainingPct / weeklyCalc.rate;
    const resetMins = weeklyWin.remainingHours != null ? weeklyWin.remainingHours * 60 : Infinity;
    if (etaMins < resetMins && (bestEtaMins == null || etaMins < bestEtaMins)) {
      bestEtaMins = etaMins;
      bestWindow = "weekly";
    }
  }

  if (bestEtaMins != null && bestWindow != null) {
    const prefix = bestWindow === "5h" ? "5h limit" : "Weekly limit";
    return {
      sampleCount,
      windowMinutes,
      shortRatePctPerMin: shortCalc.rate,
      weeklyRatePctPerMin: weeklyCalc.rate,
      etaLabel: `${prefix} in ${formatEtaMinutes(bestEtaMins)}`,
      etaSeverity: bestEtaMins <= 60 ? "danger" : "warning",
      etaMinutes: Math.round(bestEtaMins),
      etaWindow: bestWindow,
    };
  }

  return {
    sampleCount,
    windowMinutes,
    shortRatePctPerMin: shortCalc.rate,
    weeklyRatePctPerMin: weeklyCalc.rate,
    etaLabel: "Idle",
    etaSeverity: "idle",
    etaMinutes: null,
    etaWindow: null,
  };
}

/** Ids are exact, or a prefix when they end in `*`. */
function matchesWindowId(id: string, pattern: string): boolean {
  return pattern.endsWith("*") ? id.startsWith(pattern.slice(0, -1)) : id === pattern;
}

function usedOf(w: UsageWindowRaw): number {
  if (typeof w.usedPct === "number" && Number.isFinite(w.usedPct)) return w.usedPct;
  if (typeof w.remainingPct === "number" && Number.isFinite(w.remainingPct)) return 100 - w.remainingPct;
  return -1;
}

/** The first pattern that matches wins; among its matches, the most-used window binds. */
function pickWindow(windows: UsageWindowRaw[], patterns: string[]): UsageWindowRaw | undefined {
  for (const pattern of patterns) {
    const hits = windows.filter((w) => matchesWindowId(w.id, pattern));
    if (hits.length) return hits.reduce((a, b) => (usedOf(b) > usedOf(a) ? b : a));
  }
  return undefined;
}

/** The pool's report: the first available one among its source ids, else the first found. */
function findPoolEntry(reports: UsageReportEntry[], cfg: CatalogPool): UsageReportEntry | undefined {
  const ids = [cfg.sourceId, ...(cfg.sourceIds ?? [])];
  const matches = ids.flatMap((id) => reports.filter((r) => r.sourceId === id));
  return (
    matches.find((r) => r.defaultEnabled !== false && r.report?.status === "available") ?? matches[0]
  );
}

interface ModelLimit {
  penalty: number;
  note: string;
}

/** A model-specific limit counts only once it is low: nearly gone, or in caution range. */
function modelLimitFrom(stats: WindowStats, model: CatalogModel): ModelLimit | null {
  if (stats.remainingPct <= 5) {
    return { penalty: -60, note: `${stats.label} limit nearly used up (${stats.remainingPct}% left)` };
  }
  if (stats.remainingPct <= 15) {
    return {
      penalty: -10 * model.quotaCost,
      note: `${stats.label} limit low (${stats.remainingPct}% left)`,
    };
  }
  return null;
}

function scoreModelForTask(
  model: CatalogModel,
  poolState: PoolStatus,
  task: TaskTier,
  modelLimit?: ModelLimit
): ModelRecommendation {
  const iq = 0.45 * model.intelligence + 0.55 * model.coding;
  const eff = model.efficiency;
  const mode = poolState.mode;

  let wIq = 0.5;
  let wEff = 0.5;
  let penalty = 0;
  let hammerUpgradeBonus = 0;

  if (task === "frontier") {
    if (mode === "HAMMER" || mode === "PUSH") {
      wIq = 0.95;
      wEff = 0.05;
      if (mode === "HAMMER") hammerUpgradeBonus = Math.min(4, model.quotaCost * 1.5);
    } else {
      wIq = 0.85;
      wEff = 0.15;
    }
    if (iq < 92) penalty -= 25;
  } else if (task === "hard") {
    if (mode === "HAMMER" || mode === "PUSH") {
      wIq = 0.88;
      wEff = 0.12;
      if (mode === "HAMMER") hammerUpgradeBonus = Math.min(3, model.quotaCost * 1.0);
    } else if (mode === "CONSERVE") {
      wIq = 0.65;
      wEff = 0.35;
    } else {
      wIq = 0.72;
      wEff = 0.28;
    }
    if (iq < 85) penalty -= 18;
  } else if (task === "standard") {
    if (mode === "HAMMER") {
      wIq = 0.85;
      wEff = 0.15;
      hammerUpgradeBonus = Math.min(2.5, model.quotaCost * 0.8);
    } else if (mode === "PUSH") {
      wIq = 0.65;
      wEff = 0.35;
    } else if (mode === "CONSERVE") {
      wIq = 0.38;
      wEff = 0.62;
    } else {
      wIq = 0.5;
      wEff = 0.5;
    }
    if (iq < 78) penalty -= 12;
  } else if (task === "quick") {
    if (mode === "HAMMER") {
      wIq = 0.55;
      wEff = 0.45;
    } else if (mode === "PUSH") {
      wIq = 0.3;
      wEff = 0.7;
    } else {
      wIq = 0.2;
      wEff = 0.8;
    }
  }

  if (poolState.shortCaution) {
    penalty -= 10 * model.quotaCost;
  }
  if (modelLimit) {
    penalty += modelLimit.penalty;
  }

  const fitScore = wIq * iq + wEff * eff + penalty + hammerUpgradeBonus;
  const totalScore = fitScore + poolState.urgencyBonus;

  let thinkingKey =
    mode === "HAMMER"
      ? "hammer"
      : mode === "PUSH"
        ? "push"
        : mode === "CONSERVE"
          ? "conserve"
          : "balanced";
  if (task === "quick" && (thinkingKey === "hammer" || thinkingKey === "push")) {
    thinkingKey = "balanced";
  }
  const recommendedThinking = model.thinking ? (model.thinking[thinkingKey] ?? null) : null;

  return {
    provider: model.provider,
    modelId: model.id,
    paseoTarget: `${model.provider}/${model.id}`,
    label: model.label,
    pool: model.pool,
    poolLabel: poolState.label,
    poolMode: mode,
    tier: model.tier,
    intelligence: model.intelligence,
    coding: model.coding,
    efficiency: model.efficiency,
    quotaCost: model.quotaCost,
    recommendedThinking,
    fitScore: Number(fitScore.toFixed(1)),
    urgencyBonus: poolState.urgencyBonus,
    totalScore: Number(totalScore.toFixed(1)),
    notes: modelLimit ? `${modelLimit.note}. ${model.notes}` : model.notes,
  };
}

export class QuotaAdvisorService {
  private readonly history = new Map<string, PoolSample[]>();
  private readonly listeners = new Set<(snapshot: QuotaAdvisorSnapshot) => void>();
  private readonly readSettings: () => Promise<AdvisorSettingsValues>;
  private readonly quotaSource: QuotaSource;
  private readonly bundled: ModelCatalog;
  private readonly dataCatalogPath: string;
  private readonly fallbackCatalogPaths: string[];
  private readonly bankedResets: BankedResetManager;
  private latest: QuotaAdvisorSnapshot | null = null;
  private inflight: Promise<QuotaAdvisorSnapshot> | null = null;
  private syncInflight: Promise<SyncAaResult> | null = null;
  private pollSeq = 0;
  private abortController = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: QuotaAdvisorOptions) {
    this.readSettings = options.readSettings;
    this.quotaSource = options.quotaSource;
    const bundled = parseCatalog(options.bundledCatalog);
    if (!bundled) throw new Error("The bundled model catalog (default-models.json) is invalid");
    this.bundled = bundled;
    this.dataCatalogPath = path.join(options.dataDir, "models.json");
    this.fallbackCatalogPaths = options.fallbackCatalogPaths ?? [];
    this.bankedResets = new BankedResetManager({
      dataDir: options.dataDir,
      disableApiFetch: options.disableBankedResetApi,
    });
  }

  async addBankedReset(input: AddBankedResetInput): Promise<QuotaAdvisorSnapshot> {
    this.bankedResets.addManual(input);
    return this.poll(false);
  }

  async consumeBankedReset(id: string, amount = 1): Promise<QuotaAdvisorSnapshot> {
    this.bankedResets.consumeManual(id, amount);
    return this.poll(false);
  }

  async deleteBankedReset(id: string): Promise<QuotaAdvisorSnapshot> {
    this.bankedResets.deleteManual(id);
    return this.poll(false);
  }

  /** Burn-rate samples, so a host whose worker restarts can keep its 15-minute history. */
  exportHistory(): Record<string, PoolSample[]> {
    return Object.fromEntries(this.history);
  }

  importHistory(saved: unknown): void {
    if (!isObj(saved)) return;
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    for (const [pool, samples] of Object.entries(saved)) {
      if (!Array.isArray(samples)) continue;
      const kept = samples.filter(
        (s): s is PoolSample => isObj(s) && isNum(s.ts) && s.ts >= cutoff
      );
      if (kept.length) this.history.set(pool, kept);
    }
  }

  private loadCatalog(): ModelCatalog {
    for (const p of [skillCatalogPath(), this.dataCatalogPath, ...this.fallbackCatalogPaths]) {
      const synced = tryReadValidatedCatalog(p);
      if (synced) return mergeWithBundled(synced, this.bundled);
    }
    return structuredClone(this.bundled);
  }

  private catalogWritePath(): string {
    const skill = skillCatalogPath();
    if (fs.existsSync(skill)) return skill;
    fs.mkdirSync(path.dirname(this.dataCatalogPath), { recursive: true });
    return this.dataCatalogPath;
  }

  start(): void {
    if (this.timer) return;
    this.abortController = new AbortController();
    void this.poll(false).catch(() => {});
    this.timer = setInterval(() => {
      void this.poll(false).catch(() => {});
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abortController.abort();
    this.listeners.clear();
  }

  subscribe(listener: (snapshot: QuotaAdvisorSnapshot) => void): () => void {
    this.listeners.add(listener);
    if (this.latest) {
      listener(this.latest);
    } else {
      void this.poll(false).catch(() => {});
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  async getSnapshot(refresh = false): Promise<QuotaAdvisorSnapshot> {
    if (!refresh && this.latest && Date.now() - Date.parse(this.latest.lastPolledAt) < 20_000) {
      return this.latest;
    }
    return this.poll(refresh);
  }

  async notifySettingsChanged(): Promise<void> {
    await this.poll(false).catch(() => {});
  }

  async syncArtificialAnalysis(recalibrateOverride?: boolean): Promise<SyncAaResult> {
    if (this.syncInflight) return this.syncInflight;
    const run = this.runSyncArtificialAnalysis(recalibrateOverride).finally(() => {
      if (this.syncInflight === run) this.syncInflight = null;
    });
    this.syncInflight = run;
    return run;
  }

  private async runSyncArtificialAnalysis(recalibrateOverride?: boolean): Promise<SyncAaResult> {
    const settings = await this.readSettings();
    const apiKey = resolveAaApiKey(settings);
    const recalibrate = recalibrateOverride ?? settings.recalibrateOnSync;
    const catalog = this.loadCatalog();

    if (!apiKey) {
      return {
        ok: false,
        missingKey: true,
        matched: 0,
        total: catalog.models.length,
        updatedAt: catalog.updatedAt,
        message: "No Artificial Analysis API key saved. Add a free key in Settings.",
      };
    }

    type AaRow = {
      id?: string;
      slug?: string;
      name?: string;
      evaluations?: {
        artificial_analysis_intelligence_index?: number | null;
        artificial_analysis_coding_index?: number | null;
      };
      pricing?: {
        price_1m_blended_3_to_1?: number | null;
      };
      median_output_tokens_per_second?: number | null;
    };

    let rows: AaRow[] = [];
    let lastStatus = 0;
    let lastErrorMessage = "";
    for (const url of AA_ENDPOINTS) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch(url, {
          headers: { "x-api-key": apiKey, Accept: "application/json" },
          signal: controller.signal,
        });
        lastStatus = res.status;
        if (res.ok) {
          const json = (await res.json()) as AaRow[] | { data?: AaRow[]; models?: AaRow[] };
          const list = Array.isArray(json) ? json : json.data || json.models || [];
          if (list.length > 0) {
            rows = list;
            break;
          }
        }
      } catch (err) {
        lastErrorMessage = err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(timeout);
      }
    }

    if (rows.length === 0) {
      return {
        ok: false,
        matched: 0,
        total: catalog.models.length,
        updatedAt: catalog.updatedAt,
        message:
          lastStatus === 401 || lastStatus === 403
            ? `Artificial Analysis rejected the API key (HTTP ${lastStatus}). Check your key in Settings.`
            : `Failed to fetch Artificial Analysis models (${lastStatus ? `HTTP ${lastStatus}` : lastErrorMessage || "network error"}).`,
      };
    }

    const maxIntel = Math.max(
      1,
      ...rows.map((r) => Number(r.evaluations?.artificial_analysis_intelligence_index || 0))
    );
    const today = new Date().toISOString().slice(0, 10);
    let matched = 0;

    for (const m of catalog.models) {
      const needles = (m.aaMatch || [m.id, m.label]).map((s) => s.toLowerCase());
      // Prefer exact slug/id/name match first, then tightest substring match
      const exactHit = rows.find((row) => {
        const fields = [row.slug, row.id, row.name]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .map((v) => v.toLowerCase());
        return needles.some((n) => fields.includes(n));
      });
      const hit =
        exactHit ??
        rows
          .filter((row) => {
            const hay = `${row.slug || ""} ${row.name || ""} ${row.id || ""}`.toLowerCase();
            return needles.some((n) => hay.includes(n));
          })
          .sort(
            (a, b) =>
              `${a.slug || ""}${a.name || ""}`.length - `${b.slug || ""}${b.name || ""}`.length
          )[0];
      if (!hit) continue;
      matched++;
      const intelIdx = hit.evaluations?.artificial_analysis_intelligence_index ?? null;
      const codingIdx = hit.evaluations?.artificial_analysis_coding_index ?? null;
      const blendedPrice = hit.pricing?.price_1m_blended_3_to_1 ?? null;
      const speedTps = hit.median_output_tokens_per_second ?? null;

      m.aaMetrics = {
        name: hit.name || m.label,
        slug: hit.slug || null,
        intelligenceIndex: intelIdx,
        codingIndex: codingIdx,
        blendedPricePer1M: blendedPrice,
        medianOutputTps: speedTps,
        syncedAt: today,
      };

      if (recalibrate && typeof intelIdx === "number" && intelIdx > 0) {
        m.intelligence = Math.round(Math.min(100, (intelIdx / maxIntel) * 100));
        if (typeof codingIdx === "number" && codingIdx > 0) {
          m.coding = Math.round(Math.min(100, (codingIdx / maxIntel) * 100));
        }
        if (typeof blendedPrice === "number" && blendedPrice > 0) {
          const valueRatio = intelIdx / Math.log2(blendedPrice + 1.5);
          m.efficiency = Math.max(25, Math.min(99, Math.round(valueRatio * 2.1)));
        }
      }
    }

    catalog.updatedAt = today;
    writeFileAtomically(this.catalogWritePath(), JSON.stringify(catalog, null, 2) + "\n");
    await this.poll(false);

    return {
      ok: true,
      matched,
      total: catalog.models.length,
      updatedAt: today,
      message: `Synced ${matched}/${catalog.models.length} models from Artificial Analysis${recalibrate ? " (scores recalibrated)" : ""}.`,
    };
  }

  private async poll(refresh: boolean): Promise<QuotaAdvisorSnapshot> {
    if (this.inflight && !refresh) return this.inflight;
    const run = this.computeSnapshot(refresh).finally(() => {
      if (this.inflight === run) this.inflight = null;
    });
    this.inflight = run;
    return run;
  }

  private recordSample(poolKey: string, nowMs: number, shortWin: WindowStats | null, weeklyWin: WindowStats | null): PoolSample[] {
    const arr = this.history.get(poolKey) ?? [];
    arr.push({
      ts: nowMs,
      shortUsedPct: shortWin ? shortWin.usedPct : null,
      weeklyUsedPct: weeklyWin ? weeklyWin.usedPct : null,
      shortResetsAt: shortWin?.resetsAt ?? null,
      weeklyResetsAt: weeklyWin?.resetsAt ?? null,
    });
    const cutoff = nowMs - HISTORY_RETENTION_MS;
    const pruned = arr.filter((s) => s.ts >= cutoff);
    this.history.set(poolKey, pruned);
    return pruned;
  }

  private async computeSnapshot(refresh: boolean): Promise<QuotaAdvisorSnapshot> {
    const seq = ++this.pollSeq;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    try {
      const catalog = this.loadCatalog();
      const [reports, bankedByPool]: [UsageReportEntry[], Map<string, BankedResetEntry[]>] =
        await Promise.all([
          this.quotaSource.fetch(refresh, this.abortController.signal),
          this.bankedResets.getByPool(refresh, nowMs),
        ]);

      const rawWindowsByPool = new Map<string, UsageWindowRaw[]>();
      const pools: PoolStatus[] = Object.entries(catalog.pools).map(([poolKey, cfg]) => {
        const poolBanked = bankedByPool.get(poolKey) ?? [];
        const entry = findPoolEntry(reports, cfg);
        if (!entry || entry.defaultEnabled === false || entry.report?.status !== "available") {
          const { advice } = computeResetAdvice(poolBanked, null, null);
          return {
            pool: poolKey,
            label: cfg.label,
            planLabel: null,
            paseoProvider: cfg.paseoProvider,
            tracked: false,
            mode: "UNTRACKED",
            urgencyBonus: -999,
            shortCaution: false,
            reason: entry
              ? `Status: ${entry.report?.status || "disabled"}${entry.report?.message ? ` — ${entry.report.message}` : ""}`
              : `Not reported by ${this.quotaSource.name}`,
            weekly: null,
            short: null,
            burn: {
              sampleCount: 0,
              windowMinutes: 0,
              shortRatePctPerMin: null,
              weeklyRatePctPerMin: null,
              etaLabel: "Idle",
              etaSeverity: "idle",
              etaMinutes: null,
              etaWindow: null,
            },
            bankedResets: poolBanked,
            resetAdvice: advice,
          };
        }

        const windows = entry.report.windows || [];
        rawWindowsByPool.set(poolKey, windows);
        const weekly = parseWindow(
          pickWindow(windows, [cfg.weeklyWindowId, ...(cfg.weeklyWindowIds ?? [])]),
          nowMs,
          cfg.weeklyWindowSeconds ?? 604_800
        );
        const short = parseWindow(
          pickWindow(windows, [cfg.shortWindowId, ...(cfg.shortWindowIds ?? [])]),
          nowMs,
          18_000
        );

        const samples = this.recordSample(poolKey, nowMs, short, weekly);
        const burn = estimateBurn(samples, nowMs, short, weekly);

        if (!weekly && !short) {
          const { advice } = computeResetAdvice(poolBanked, null, null);
          return {
            pool: poolKey,
            label: cfg.label,
            planLabel: entry.report.planLabel || null,
            paseoProvider: cfg.paseoProvider,
            tracked: false,
            mode: "UNTRACKED",
            urgencyBonus: -999,
            shortCaution: false,
            reason: "No quota windows reported",
            weekly: null,
            short: null,
            burn,
            bankedResets: poolBanked,
            resetAdvice: advice,
          };
        }

        const primary = weekly || short!;
        const pace = primary.pace ?? 1.0;
        const remPct = primary.remainingPct;
        const remHrs = primary.remainingHours ?? primary.windowHours;

        let mode: BurnMode = "BALANCED";
        let urgencyBonus = 0;
        let shortCaution = false;
        let shortActiveBonus = 0;
        let reason = "";

        if (short && short.remainingPct <= 5) {
          mode = "THROTTLED_5H";
          urgencyBonus = -60;
          reason = `5h window nearly exhausted (${short.remainingPct}% left; resets in ${formatDuration(short.remainingHours)})`;
        } else if (remPct <= 5) {
          mode = "EXHAUSTED";
          urgencyBonus = -60;
          reason = `Weekly quota nearly exhausted (${remPct}% left; resets in ${formatDuration(remHrs)})`;
        } else if (remPct >= 15 && (pace >= 2.0 || (remHrs <= 12 && remPct >= 25))) {
          mode = "HAMMER";
          urgencyBonus = 24 + Math.min(18, Math.log2(Math.max(1, pace)) * 5);
          reason = `${remPct}% left with ${formatDuration(remHrs)} to reset (${pace.toFixed(1)}x ratio — use it or lose it)`;
        } else if (remPct >= 15 && pace >= 1.25) {
          mode = "PUSH";
          urgencyBonus = 10 + Math.min(14, (pace - 1.0) * 14);
          reason = `${remPct}% left with ${formatDuration(remHrs)} to reset (${pace.toFixed(2)}x ratio — surplus headroom)`;
        } else if (pace >= 0.85) {
          mode = "BALANCED";
          urgencyBonus = (pace - 1.0) * 10;
          reason = `On pace (${remPct}% left, resets in ${formatDuration(remHrs)}, ${pace.toFixed(2)}x)`;
        } else {
          mode = "CONSERVE";
          urgencyBonus = -10 - Math.min(14, (0.85 - pace) * 20);
          reason = `Burning ahead of pace (${primary.usedPct}% used with ${formatDuration(remHrs)} left, ${pace.toFixed(2)}x)`;
        }

        if (short && short.remainingPct > 5 && short.remainingPct <= 15) {
          shortCaution = true;
          reason += `; 5h caution (${short.remainingPct}% left)`;
        } else if (
          short &&
          short.usedPct > 0 &&
          short.remainingPct >= 40 &&
          short.remainingHours != null &&
          short.remainingHours <= 2
        ) {
          shortActiveBonus = 4;
          reason += `; active 5h block resets in ${formatDuration(short.remainingHours)}`;
        }

        const fableWin =
          poolKey === "claude"
            ? parseWindow(
                pickWindow(windows, ["weekly_model_fable"]),
                nowMs,
                cfg.weeklyWindowSeconds ?? 604_800
              )
            : null;
        const {
          advice: resetAdvice,
          forceHammer,
          urgencyBoost,
        } = computeResetAdvice(poolBanked, weekly, short, fableWin);

        if (forceHammer && mode !== "THROTTLED_5H" && mode !== "EXHAUSTED") {
          mode = "HAMMER";
          urgencyBonus = Math.max(urgencyBonus, urgencyBoost);
          if (resetAdvice) {
            reason = `${resetAdvice.headline} (${reason})`;
          }
        }

        return {
          pool: poolKey,
          label: cfg.label,
          planLabel: entry.report.planLabel || null,
          paseoProvider: cfg.paseoProvider,
          tracked: true,
          mode,
          urgencyBonus: Number((urgencyBonus + shortActiveBonus).toFixed(2)),
          shortCaution,
          reason,
          weekly,
          short,
          burn,
          bankedResets: poolBanked,
          resetAdvice,
        };
      });

      const poolMap = new Map(pools.map((p) => [p.pool, p]));
      const eligibleModels = catalog.models.filter((m) => poolMap.get(m.pool)?.tracked);

      // Models with a limit of their own inside the pool (e.g. Claude's weekly Fable limit).
      const modelLimits = new Map<CatalogModel, ModelLimit>();
      for (const m of eligibleModels) {
        if (!m.modelWindowId) continue;
        const cfg = catalog.pools[m.pool];
        const stats = parseWindow(
          pickWindow(rawWindowsByPool.get(m.pool) ?? [], [m.modelWindowId]),
          nowMs,
          cfg?.weeklyWindowSeconds ?? 604_800
        );
        const limit = stats ? modelLimitFrom(stats, m) : null;
        if (limit) modelLimits.set(m, limit);
      }

      const recommendations = {} as Record<TaskTier, ModelRecommendation[]>;
      for (const t of VALID_TASKS) {
        recommendations[t] = eligibleModels
          .map((m) => scoreModelForTask(m, poolMap.get(m.pool)!, t, modelLimits.get(m)))
          .sort((a, b) => b.totalScore - a.totalScore);
      }

      const settings = await this.readSettings();
      const hasAaKey = Boolean(resolveAaApiKey(settings));

      const snapshot: QuotaAdvisorSnapshot = {
        generatedAt: nowIso,
        lastPolledAt: nowIso,
        pollIntervalMs: POLL_INTERVAL_MS,
        catalogUpdatedAt: catalog.updatedAt,
        hasAaKey,
        error: null,
        pools,
        recommendations,
      };
      if (seq >= this.pollSeq) {
        this.latest = snapshot;
        for (const listener of this.listeners) {
          listener(snapshot);
        }
      }
      return snapshot;
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const msg =
        rawMsg.split(/\r?\n/)[0]?.slice(0, 200) || `Failed to read ${this.quotaSource.displayName}`;
      const fallback: QuotaAdvisorSnapshot = this.latest
        ? { ...this.latest, lastPolledAt: nowIso, error: msg }
        : {
            generatedAt: nowIso,
            lastPolledAt: nowIso,
            pollIntervalMs: POLL_INTERVAL_MS,
            catalogUpdatedAt: "-",
            hasAaKey: false,
            error: msg,
            pools: [],
            recommendations: { quick: [], standard: [], hard: [], frontier: [] },
          };
      if (seq >= this.pollSeq) {
        this.latest = fallback;
        for (const listener of this.listeners) {
          listener(fallback);
        }
      }
      return fallback;
    }
  }
}
