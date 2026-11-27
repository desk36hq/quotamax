import { execCommand } from "@getpaseo/plugin/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import bundledCatalog from "./default-models.json";
import type {
  BurnMode,
  BurnRateEstimate,
  ModelRecommendation,
  PoolStatus,
  QuotaAdvisorSnapshot,
  SyncAaResult,
  TaskTier,
  WindowStats,
} from "../shared/contract";
import type { advisorSettings } from "../shared/settings";

const AA_ENDPOINTS = [
  "https://artificialanalysis.ai/api/v2/data/llms/models",
  "https://artificialanalysis.ai/api/v2/language/models",
];

type AdvisorSettingsValues = z.infer<typeof advisorSettings.schema>;

const POLL_INTERVAL_MS = 90_000;
const HISTORY_RETENTION_MS = 65 * 60_000;
const PRIMARY_BURN_WINDOW_MS = 15 * 60_000;
const FALLBACK_BURN_WINDOW_MS = 30 * 60_000;
const VALID_TASKS: readonly TaskTier[] = ["quick", "standard", "hard", "frontier"];

const CatalogPoolSchema = z.object({
  label: z.string(),
  sourceId: z.string(),
  weeklyWindowId: z.string(),
  shortWindowId: z.string(),
  paseoProvider: z.string(),
});

const CatalogModelSchema = z.object({
  id: z.string(),
  provider: z.string(),
  pool: z.string(),
  label: z.string(),
  tier: z.string(),
  intelligence: z.number(),
  coding: z.number(),
  efficiency: z.number(),
  quotaCost: z.number(),
  bestFor: z.array(z.string()),
  thinking: z.record(z.string(), z.string().nullable()).optional(),
  aaMatch: z.array(z.string()).optional(),
  aaMetrics: z
    .object({
      name: z.string(),
      slug: z.string().nullable(),
      intelligenceIndex: z.number().nullable(),
      codingIndex: z.number().nullable(),
      blendedPricePer1M: z.number().nullable(),
      medianOutputTps: z.number().nullable(),
      syncedAt: z.string(),
    })
    .optional(),
  notes: z.string(),
});

const ModelCatalogSchema = z
  .object({
    updatedAt: z.string(),
    pools: z.record(z.string(), CatalogPoolSchema),
    models: z.array(CatalogModelSchema),
  })
  .passthrough();

type CatalogModel = z.infer<typeof CatalogModelSchema>;
type ModelCatalog = z.infer<typeof ModelCatalogSchema>;

interface UsageWindowRaw {
  id: string;
  label?: string;
  usedPct?: number;
  remainingPct?: number;
  resetsAt?: string;
  durationSeconds?: number;
}

interface UsageReportEntry {
  sourceId: string;
  defaultEnabled?: boolean;
  report?: {
    status?: string;
    planLabel?: string;
    windows?: UsageWindowRaw[];
  };
}

interface PoolSample {
  ts: number;
  shortUsedPct: number | null;
  weeklyUsedPct: number | null;
  shortResetsAt: string | null;
  weeklyResetsAt: string | null;
}

const SKILL_CATALOG_PATH = path.join(
  os.homedir(),
  ".agents",
  "skills",
  "quota-advisor",
  "references",
  "models.json"
);

const PLUGIN_DATA_CATALOG_PATH = path.join(
  os.homedir(),
  ".paseo",
  "plugin-data",
  "quota-advisor",
  "models.json"
);

function resolveCatalogWritePath(): string {
  if (fs.existsSync(SKILL_CATALOG_PATH)) return SKILL_CATALOG_PATH;
  fs.mkdirSync(path.dirname(PLUGIN_DATA_CATALOG_PATH), { recursive: true });
  return PLUGIN_DATA_CATALOG_PATH;
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
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = ModelCatalogSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function loadCatalog(): ModelCatalog {
  return (
    tryReadValidatedCatalog(SKILL_CATALOG_PATH) ??
    tryReadValidatedCatalog(PLUGIN_DATA_CATALOG_PATH) ??
    (structuredClone(bundledCatalog) as unknown as ModelCatalog)
  );
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

function scoreModelForTask(
  model: CatalogModel,
  poolState: PoolStatus,
  task: TaskTier
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
    notes: model.notes,
  };
}

export class QuotaAdvisorService {
  private readonly history = new Map<string, PoolSample[]>();
  private readonly listeners = new Set<(snapshot: QuotaAdvisorSnapshot) => void>();
  private readonly readSettings: () => Promise<AdvisorSettingsValues>;
  private latest: QuotaAdvisorSnapshot | null = null;
  private inflight: Promise<QuotaAdvisorSnapshot> | null = null;
  private syncInflight: Promise<SyncAaResult> | null = null;
  private pollSeq = 0;
  private abortController = new AbortController();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readSettings: () => Promise<AdvisorSettingsValues>) {
    this.readSettings = readSettings;
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
    const catalog = loadCatalog();

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
    writeFileAtomically(resolveCatalogWritePath(), JSON.stringify(catalog, null, 2) + "\n");
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
      const catalog = loadCatalog();
      const cmdArgs = ["usage", "--json"];
      if (refresh) cmdArgs.push("--refresh");
      const { stdout } = await execCommand("paseo", cmdArgs, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 20_000,
        signal: this.abortController.signal,
      });
      const reports = JSON.parse(stdout) as UsageReportEntry[];

      const pools: PoolStatus[] = Object.entries(catalog.pools).map(([poolKey, cfg]) => {
        const entry = reports.find((r) => r.sourceId === cfg.sourceId);
        if (!entry || entry.defaultEnabled === false || entry.report?.status !== "available") {
          return {
            pool: poolKey,
            label: cfg.label,
            planLabel: null,
            paseoProvider: cfg.paseoProvider,
            tracked: false,
            mode: "UNTRACKED",
            urgencyBonus: -999,
            shortCaution: false,
            reason: entry ? `Status: ${entry.report?.status || "disabled"}` : "Not reported by paseo usage",
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
          };
        }

        const windows = entry.report.windows || [];
        const weekly = parseWindow(
          windows.find((w) => w.id === cfg.weeklyWindowId),
          nowMs,
          604_800
        );
        const short = parseWindow(
          windows.find((w) => w.id === cfg.shortWindowId),
          nowMs,
          18_000
        );

        const samples = this.recordSample(poolKey, nowMs, short, weekly);
        const burn = estimateBurn(samples, nowMs, short, weekly);

        if (!weekly && !short) {
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
        };
      });

      const poolMap = new Map(pools.map((p) => [p.pool, p]));
      const eligibleModels = catalog.models.filter((m) => poolMap.get(m.pool)?.tracked);

      const recommendations = {} as Record<TaskTier, ModelRecommendation[]>;
      for (const t of VALID_TASKS) {
        recommendations[t] = eligibleModels
          .map((m) => scoreModelForTask(m, poolMap.get(m.pool)!, t))
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
      const msg = rawMsg.split(/\r?\n/)[0]?.slice(0, 200) || "Failed to read Paseo usage";
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
