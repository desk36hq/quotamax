/**
 * Cost estimation service ported from pingdotgg/t3code's UsageService + UsageAggregator.
 *
 * Scans local Claude Code, Codex, Antigravity, and Pi session logs, deduplicates
 * records across resumed/forked transcripts, prices them against LiteLLM's live
 * model rate table (cached 24h on disk), and aggregates API-equivalent costs,
 * cache savings, category splits, and per-pool / per-model breakdowns.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  CostEstimateSummary,
  CostRatesSource,
  CostWindow,
  ModelCostBreakdown,
  PoolCostBreakdown,
} from "../shared/contract";
import {
  cacheSavingsUsd,
  createOverrideRateTable,
  lookupRate,
  parseOpenRouterRateTable,
  parseRateTable,
  priceUsage,
  type RateTable,
  type UsageCategoryCost,
  type UsageModelPriceOverride,
  type UsageTokenTotals,
} from "./usagePricing";
import { LocalUsageScanner, type UsageRecord, type UsageScanRoots } from "./usageScanner";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const OPENROUTER_RATES_URL = "https://openrouter.ai/api/v1/models";
const RATES_TTL_MS = 24 * 60 * 60 * 1000;
const SUMMARY_CACHE_TTL_MS = 60_000;

const WINDOW_MS: Record<CostWindow, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

const POOL_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  "antigravity:gemini": "Antigravity (Gemini)",
  "antigravity:3p": "Antigravity (Claude & GPT)",
  glm: "GLM Coding Plan",
  alibaba: "Alibaba Token Plan",
  pi: "Pi (Other)",
};

/**
 * Fallback rates (USD per 1M tokens) used ONLY when a model is not yet listed
 * in LiteLLM's live table. LiteLLM always wins when present.
 */
const FALLBACK_MODEL_PRICES: Record<string, UsageModelPriceOverride> = {
  "claude-opus-5-5": {
    inputCostPerMillionTokens: 15,
    outputCostPerMillionTokens: 75,
    cacheReadCostPerMillionTokens: 1.5,
    cacheWriteCostPerMillionTokens: 18.75,
  },
  "claude-sonnet-5-5": {
    inputCostPerMillionTokens: 3,
    outputCostPerMillionTokens: 15,
    cacheReadCostPerMillionTokens: 0.3,
    cacheWriteCostPerMillionTokens: 3.75,
  },
  "claude-haiku-5-5": {
    inputCostPerMillionTokens: 0.8,
    outputCostPerMillionTokens: 4,
    cacheReadCostPerMillionTokens: 0.08,
    cacheWriteCostPerMillionTokens: 1.0,
  },
  "claude-fable-5-2": {
    inputCostPerMillionTokens: 20,
    outputCostPerMillionTokens: 100,
    cacheReadCostPerMillionTokens: 2.0,
    cacheWriteCostPerMillionTokens: 25.0,
  },
  "gpt-6.2-astra": {
    inputCostPerMillionTokens: 10,
    outputCostPerMillionTokens: 40,
    cacheReadCostPerMillionTokens: 1.0,
    cacheWriteCostPerMillionTokens: 10,
  },
  "gpt-6.2-sol": {
    inputCostPerMillionTokens: 2.5,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.25,
    cacheWriteCostPerMillionTokens: 2.5,
  },
  "gpt-6.1-terra": {
    inputCostPerMillionTokens: 2.0,
    outputCostPerMillionTokens: 8,
    cacheReadCostPerMillionTokens: 0.2,
    cacheWriteCostPerMillionTokens: 2.0,
  },
  "gemini-4-neon": {
    inputCostPerMillionTokens: 2.5,
    outputCostPerMillionTokens: 15,
    cacheReadCostPerMillionTokens: 0.25,
    cacheWriteCostPerMillionTokens: 2.5,
  },
  "gemini-4-carbon": {
    inputCostPerMillionTokens: 1.25,
    outputCostPerMillionTokens: 10,
    cacheReadCostPerMillionTokens: 0.125,
    cacheWriteCostPerMillionTokens: 1.25,
  },
  "gemini-3.8-flash": {
    inputCostPerMillionTokens: 0.3,
    outputCostPerMillionTokens: 2.5,
    cacheReadCostPerMillionTokens: 0.03,
    cacheWriteCostPerMillionTokens: 0.3,
  },
  "glm-5.4": {
    inputCostPerMillionTokens: 1.0,
    outputCostPerMillionTokens: 3.2,
    cacheReadCostPerMillionTokens: 0.2,
    cacheWriteCostPerMillionTokens: 1.0,
  },
  "glm-5.3": {
    inputCostPerMillionTokens: 0.6,
    outputCostPerMillionTokens: 2.2,
    cacheReadCostPerMillionTokens: 0.12,
    cacheWriteCostPerMillionTokens: 0.6,
  },
  "glm-5.3-flash": {
    inputCostPerMillionTokens: 0.15,
    outputCostPerMillionTokens: 0.6,
    cacheReadCostPerMillionTokens: 0.03,
    cacheWriteCostPerMillionTokens: 0.15,
  },
};

const FALLBACK_RATE_TABLE = createOverrideRateTable(FALLBACK_MODEL_PRICES);

function defaultRatesCachePath(): string {
  return path.join(
    os.homedir(),
    ".paseo",
    "plugin-data",
    "quota-advisor",
    "litellm-rates-cache.json"
  );
}

export function mapRecordToPool(record: Pick<UsageRecord, "provider" | "model">): string {
  if (record.provider === "claude") return "claude";
  if (record.provider === "codex") return "codex";
  if (record.provider === "antigravity") {
    return record.model.toLowerCase().startsWith("gemini") ? "antigravity:gemini" : "antigravity:3p";
  }
  const lower = record.model.toLowerCase();
  if (lower.startsWith("zai") || lower.includes("/glm-") || lower.startsWith("glm-")) {
    return "glm";
  }
  if (
    lower.startsWith("alibaba") ||
    lower.startsWith("dashscope") ||
    lower.includes("qwen") ||
    lower.includes("deepseek")
  ) {
    return "alibaba";
  }
  return "pi";
}

/**
 * Deduplicate records sharing a billed message key by keeping each token channel's
 * maximum and the larger reported cost (ported from t3code's `mergeUsageCopies`).
 */
export function deduplicateRecords(records: readonly UsageRecord[]): UsageRecord[] {
  const seen = new Map<string, UsageRecord>();
  const unkeyed: UsageRecord[] = [];

  for (const record of records) {
    if (record.dedupeKey === null) {
      unkeyed.push(record);
      continue;
    }
    const prev = seen.get(record.dedupeKey);
    if (!prev) {
      seen.set(record.dedupeKey, record);
      continue;
    }
    const a = prev.totals;
    const b = record.totals;
    const reportedCostUsd =
      prev.reportedCostUsd === null || record.reportedCostUsd === null
        ? (prev.reportedCostUsd ?? record.reportedCostUsd)
        : Math.max(prev.reportedCostUsd, record.reportedCostUsd);
    const cacheCreation1hTokens = Math.max(
      prev.cacheCreation1hTokens ?? 0,
      record.cacheCreation1hTokens ?? 0
    );
    seen.set(record.dedupeKey, {
      ...prev,
      ...(cacheCreation1hTokens > 0 ? { cacheCreation1hTokens } : {}),
      totals: {
        uncachedInputTokens: Math.max(a.uncachedInputTokens, b.uncachedInputTokens),
        cachedInputTokens: Math.max(a.cachedInputTokens, b.cachedInputTokens),
        cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
        outputTokens: Math.max(a.outputTokens, b.outputTokens),
        reasoningTokens: Math.max(a.reasoningTokens, b.reasoningTokens),
      },
      reportedCostUsd,
    });
  }

  return [...seen.values(), ...unkeyed];
}

function emptyTotals(): { -readonly [K in keyof UsageTokenTotals]: number } {
  return {
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

function sumTokens(t: UsageTokenTotals): number {
  return t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens;
}

function computeCacheHitPct(t: UsageTokenTotals): number {
  const prompt = t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens;
  if (prompt <= 0) return 0;
  return Number(((t.cachedInputTokens / prompt) * 100).toFixed(1));
}

function roundUsd(v: number): number {
  return Number(v.toFixed(4));
}

export function aggregateCostSummary(
  records: readonly UsageRecord[],
  rates: RateTable,
  window: CostWindow,
  ratesUpdatedAt: string | null,
  nowIso: string = new Date().toISOString(),
  ratesSource: CostRatesSource = "litellm"
): CostEstimateSummary {
  const deduped = deduplicateRecords(records);

  const totals = emptyTotals();
  const category: { -readonly [K in keyof UsageCategoryCost]: number } = {
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  };
  let totalCostUsd = 0;
  let totalCacheSavingsUsd = 0;
  let totalSpeedPremiumUsd = 0;
  let unpricedRecords = 0;
  const unpricedModels = new Set<string>();

  type PoolAcc = {
    pool: string;
    label: string;
    costUsd: number;
    cacheSavingsUsd: number;
    totals: ReturnType<typeof emptyTotals>;
    records: number;
    unpricedRecords: number;
  };
  type ModelAcc = {
    model: string;
    provider: string;
    pool: string;
    costUsd: number;
    cacheSavingsUsd: number;
    totals: ReturnType<typeof emptyTotals>;
    records: number;
    unpriced: boolean;
  };

  const poolMap = new Map<string, PoolAcc>();
  const modelMap = new Map<string, ModelAcc>();

  for (const record of deduped) {
    // Use LiteLLM rate table first; fall back to built-in 2026 rates only when unlisted
    const hasLiveRate =
      (record.rateModel !== undefined && lookupRate(rates, record.rateModel) !== null) ||
      lookupRate(rates, record.model) !== null;
    const effectiveTable = hasLiveRate ? rates : FALLBACK_RATE_TABLE;

    const priced = priceUsage(effectiveTable, record);
    const saved = cacheSavingsUsd(effectiveTable, record);

    totalCostUsd += priced.costUsd;
    totalCacheSavingsUsd += saved;
    totalSpeedPremiumUsd += priced.speedPremiumUsd;

    if (priced.categoryCostUsd) {
      category.input += priced.categoryCostUsd.input;
      category.cacheRead += priced.categoryCostUsd.cacheRead;
      category.cacheWrite += priced.categoryCostUsd.cacheWrite;
      category.output += priced.categoryCostUsd.output;
    }

    if (priced.costSource === "unpriced") {
      unpricedRecords += 1;
      unpricedModels.add(record.model);
    }

    totals.uncachedInputTokens += record.totals.uncachedInputTokens;
    totals.cachedInputTokens += record.totals.cachedInputTokens;
    totals.cacheCreationTokens += record.totals.cacheCreationTokens;
    totals.outputTokens += record.totals.outputTokens;
    totals.reasoningTokens += record.totals.reasoningTokens;

    const pool = mapRecordToPool(record);
    let pAcc = poolMap.get(pool);
    if (!pAcc) {
      pAcc = {
        pool,
        label: POOL_LABELS[pool] ?? pool,
        costUsd: 0,
        cacheSavingsUsd: 0,
        totals: emptyTotals(),
        records: 0,
        unpricedRecords: 0,
      };
      poolMap.set(pool, pAcc);
    }
    pAcc.costUsd += priced.costUsd;
    pAcc.cacheSavingsUsd += saved;
    pAcc.records += 1;
    if (priced.costSource === "unpriced") pAcc.unpricedRecords += 1;
    pAcc.totals.uncachedInputTokens += record.totals.uncachedInputTokens;
    pAcc.totals.cachedInputTokens += record.totals.cachedInputTokens;
    pAcc.totals.cacheCreationTokens += record.totals.cacheCreationTokens;
    pAcc.totals.outputTokens += record.totals.outputTokens;
    pAcc.totals.reasoningTokens += record.totals.reasoningTokens;

    const mKey = `${record.provider}\0${record.model}`;
    let mAcc = modelMap.get(mKey);
    if (!mAcc) {
      mAcc = {
        model: record.model,
        provider: record.provider,
        pool,
        costUsd: 0,
        cacheSavingsUsd: 0,
        totals: emptyTotals(),
        records: 0,
        unpriced: priced.costSource === "unpriced",
      };
      modelMap.set(mKey, mAcc);
    }
    mAcc.costUsd += priced.costUsd;
    mAcc.cacheSavingsUsd += saved;
    mAcc.records += 1;
    if (priced.costSource !== "unpriced") mAcc.unpriced = false;
    mAcc.totals.uncachedInputTokens += record.totals.uncachedInputTokens;
    mAcc.totals.cachedInputTokens += record.totals.cachedInputTokens;
    mAcc.totals.cacheCreationTokens += record.totals.cacheCreationTokens;
    mAcc.totals.outputTokens += record.totals.outputTokens;
    mAcc.totals.reasoningTokens += record.totals.reasoningTokens;
  }

  const byPool: PoolCostBreakdown[] = [...poolMap.values()]
    .map((p) => ({
      pool: p.pool,
      label: p.label,
      costUsd: roundUsd(p.costUsd),
      cacheSavingsUsd: roundUsd(p.cacheSavingsUsd),
      totalTokens: sumTokens(p.totals),
      cacheHitPct: computeCacheHitPct(p.totals),
      records: p.records,
      unpricedRecords: p.unpricedRecords,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);

  const byModel: ModelCostBreakdown[] = [...modelMap.values()]
    .map((m) => ({
      model: m.model,
      provider: m.provider,
      pool: m.pool,
      costUsd: roundUsd(m.costUsd),
      cacheSavingsUsd: roundUsd(m.cacheSavingsUsd),
      totalTokens: sumTokens(m.totals),
      cacheHitPct: computeCacheHitPct(m.totals),
      records: m.records,
      unpriced: m.unpriced,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens)
    .slice(0, 15);

  return {
    window,
    generatedAt: nowIso,
    ratesUpdatedAt,
    ratesSource,
    ratesCount: rates.size,
    totalCostUsd: roundUsd(totalCostUsd),
    cacheSavingsUsd: roundUsd(totalCacheSavingsUsd),
    speedPremiumUsd: roundUsd(totalSpeedPremiumUsd),
    cacheHitPct: computeCacheHitPct(totals),
    totalTokens: sumTokens(totals),
    totals,
    categoryCostUsd: {
      input: roundUsd(category.input),
      cacheRead: roundUsd(category.cacheRead),
      cacheWrite: roundUsd(category.cacheWrite),
      output: roundUsd(category.output),
    },
    records: deduped.length,
    unpricedRecords,
    unpricedModels: [...unpricedModels].sort(),
    byPool,
    byModel,
  };
}

export class CostEstimatorService {
  private readonly scanner: LocalUsageScanner;
  private readonly ratesCachePath: string;
  private rateTable: RateTable | null = null;
  private ratesSource: CostRatesSource = "fallback";
  private ratesFetchedAtMs: number | null = null;
  private ratesInflight: Promise<RateTable> | null = null;
  private readonly summaryCache = new Map<
    CostWindow,
    { cachedAtMs: number; summary: CostEstimateSummary }
  >();

  constructor(options?: { roots?: UsageScanRoots; ratesCachePath?: string }) {
    this.scanner = new LocalUsageScanner(options?.roots);
    this.ratesCachePath = options?.ratesCachePath ?? defaultRatesCachePath();
  }

  async getSummary(window: CostWindow = "7d", refresh = false): Promise<CostEstimateSummary> {
    const nowMs = Date.now();
    const cached = this.summaryCache.get(window);
    if (!refresh && cached && nowMs - cached.cachedAtMs < SUMMARY_CACHE_TTL_MS) {
      return cached.summary;
    }

    const [rates, records] = await Promise.all([
      this.loadRates(refresh),
      this.scanner.scanSince(nowMs - WINDOW_MS[window]),
    ]);

    const summary = aggregateCostSummary(
      records,
      rates,
      window,
      this.ratesFetchedAtMs ? new Date(this.ratesFetchedAtMs).toISOString() : null,
      new Date(nowMs).toISOString(),
      this.ratesSource
    );
    this.summaryCache.set(window, { cachedAtMs: nowMs, summary });
    return summary;
  }

  private async loadRates(forceRefresh: boolean): Promise<RateTable> {
    const nowMs = Date.now();
    if (
      !forceRefresh &&
      this.rateTable &&
      this.ratesFetchedAtMs !== null &&
      nowMs - this.ratesFetchedAtMs < RATES_TTL_MS
    ) {
      return this.rateTable;
    }
    if (this.ratesInflight) return this.ratesInflight;

    this.ratesInflight = this.fetchOrReadRates(forceRefresh).finally(() => {
      this.ratesInflight = null;
    });
    return this.ratesInflight;
  }

  private async fetchJsonWithTimeout(url: string, timeoutMs = 15_000): Promise<unknown | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        return (await res.json()) as unknown;
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return null;
    }
  }

  private async writeRatesCache(
    fetchedAtMs: number,
    source: "litellm" | "openrouter",
    document: unknown
  ): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(this.ratesCachePath), { recursive: true });
      await fsp.writeFile(
        this.ratesCachePath,
        JSON.stringify({ fetchedAtMs, source, document }),
        "utf8"
      );
    } catch {
      // Best-effort cache write
    }
  }

  private async fetchOrReadRates(forceRefresh: boolean): Promise<RateTable> {
    const nowMs = Date.now();
    let staleTable: RateTable | null = this.rateTable;
    let staleFetchedAt: number | null = this.ratesFetchedAtMs;
    let staleSource: CostRatesSource = this.ratesSource;

    // 1. Try disk cache first
    if (!staleTable) {
      try {
        const raw = await fsp.readFile(this.ratesCachePath, "utf8");
        const parsed = JSON.parse(raw) as {
          fetchedAtMs?: number;
          source?: "litellm" | "openrouter";
          document?: unknown;
        };
        if (typeof parsed.fetchedAtMs === "number" && parsed.document) {
          const src: "litellm" | "openrouter" =
            parsed.source === "openrouter" ? "openrouter" : "litellm";
          const table =
            src === "openrouter"
              ? parseOpenRouterRateTable(parsed.document)
              : parseRateTable(parsed.document);
          if (table.size > 0) {
            staleTable = table;
            staleFetchedAt = parsed.fetchedAtMs;
            staleSource = src;
            if (!forceRefresh && nowMs - parsed.fetchedAtMs < RATES_TTL_MS) {
              this.rateTable = table;
              this.ratesSource = src;
              this.ratesFetchedAtMs = parsed.fetchedAtMs;
              return table;
            }
          }
        }
      } catch {
        // Cache miss or unreadable
      }
    }

    // 2. Primary: LiteLLM public pricing catalog
    const litellmDoc = await this.fetchJsonWithTimeout(LITELLM_RATES_URL);
    if (litellmDoc !== null) {
      const table = parseRateTable(litellmDoc);
      if (table.size > 0) {
        this.rateTable = table;
        this.ratesSource = "litellm";
        this.ratesFetchedAtMs = nowMs;
        await this.writeRatesCache(nowMs, "litellm", litellmDoc);
        return table;
      }
    }

    // 3. Fallback: OpenRouter public models API
    const openRouterDoc = await this.fetchJsonWithTimeout(OPENROUTER_RATES_URL);
    if (openRouterDoc !== null) {
      const table = parseOpenRouterRateTable(openRouterDoc);
      if (table.size > 0) {
        this.rateTable = table;
        this.ratesSource = "openrouter";
        this.ratesFetchedAtMs = nowMs;
        await this.writeRatesCache(nowMs, "openrouter", openRouterDoc);
        return table;
      }
    }

    // 4. Stale disk cache, else built-in fallback rates
    if (staleTable) {
      this.rateTable = staleTable;
      this.ratesSource = staleSource;
      this.ratesFetchedAtMs = staleFetchedAt;
      return staleTable;
    }
    this.ratesSource = "fallback";
    return FALLBACK_RATE_TABLE;
  }
}
