import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

export const TaskTierSchema = z.enum(["quick", "standard", "hard", "frontier"]);
export type TaskTier = z.infer<typeof TaskTierSchema>;

export const BurnModeSchema = z.enum([
  "HAMMER",
  "PUSH",
  "BALANCED",
  "CONSERVE",
  "THROTTLED_5H",
  "EXHAUSTED",
  "UNTRACKED",
]);
export type BurnMode = z.infer<typeof BurnModeSchema>;

export interface WindowStats {
  id: string;
  label: string;
  usedPct: number;
  remainingPct: number;
  resetsAt: string | null;
  remainingHours: number | null;
  windowHours: number;
  pace: number | null;
  requiredPctPerHr: number | null;
}

export interface BurnRateEstimate {
  sampleCount: number;
  windowMinutes: number;
  shortRatePctPerMin: number | null;
  weeklyRatePctPerMin: number | null;
  etaLabel: string;
  etaSeverity: "idle" | "warning" | "danger";
  etaMinutes: number | null;
  etaWindow: "5h" | "weekly" | null;
}

export interface PoolStatus {
  pool: string;
  label: string;
  planLabel: string | null;
  paseoProvider: string;
  tracked: boolean;
  mode: BurnMode;
  urgencyBonus: number;
  shortCaution: boolean;
  reason: string;
  weekly: WindowStats | null;
  short: WindowStats | null;
  burn: BurnRateEstimate;
}

export interface ModelRecommendation {
  provider: string;
  modelId: string;
  paseoTarget: string;
  label: string;
  pool: string;
  poolLabel: string;
  poolMode: BurnMode;
  tier: string;
  intelligence: number;
  coding: number;
  efficiency: number;
  quotaCost: number;
  recommendedThinking: string | null;
  fitScore: number;
  urgencyBonus: number;
  totalScore: number;
  notes: string;
}

export interface QuotaAdvisorSnapshot {
  generatedAt: string;
  lastPolledAt: string;
  pollIntervalMs: number;
  catalogUpdatedAt: string;
  hasAaKey: boolean;
  error: string | null;
  pools: PoolStatus[];
  recommendations: Record<TaskTier, ModelRecommendation[]>;
}

export interface SyncAaResult {
  ok: boolean;
  missingKey?: boolean;
  matched: number;
  total: number;
  updatedAt: string;
  message: string;
}

export const CostWindowSchema = z.enum(["24h", "7d", "30d"]);
export type CostWindow = z.infer<typeof CostWindowSchema>;

export interface CostTokenTotals {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface CostCategorySplit {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface PoolCostBreakdown {
  pool: string;
  label: string;
  costUsd: number;
  cacheSavingsUsd: number;
  totalTokens: number;
  cacheHitPct: number;
  records: number;
  unpricedRecords: number;
}

export interface ModelCostBreakdown {
  model: string;
  provider: string;
  pool: string;
  costUsd: number;
  cacheSavingsUsd: number;
  totalTokens: number;
  cacheHitPct: number;
  records: number;
  unpriced: boolean;
}

export type CostRatesSource = "litellm" | "openrouter" | "fallback";

export interface CostEstimateSummary {
  window: CostWindow;
  generatedAt: string;
  ratesUpdatedAt: string | null;
  ratesSource: CostRatesSource;
  ratesCount: number;
  totalCostUsd: number;
  cacheSavingsUsd: number;
  speedPremiumUsd: number;
  cacheHitPct: number;
  totalTokens: number;
  totals: CostTokenTotals;
  categoryCostUsd: CostCategorySplit;
  records: number;
  unpricedRecords: number;
  unpricedModels: string[];
  byPool: PoolCostBreakdown[];
  byModel: ModelCostBreakdown[];
}

export const getSnapshotRpc = defineRpc({
  name: "quota-advisor.snapshot",
  input: z.object({
    refresh: z.boolean().optional(),
  }),
  output: z.custom<QuotaAdvisorSnapshot>(),
});

export const getCostsRpc = defineRpc({
  name: "quota-advisor.costs",
  input: z.object({
    window: CostWindowSchema.optional(),
    refresh: z.boolean().optional(),
  }),
  output: z.custom<CostEstimateSummary>(),
});

export const syncAaRpc = defineRpc({
  name: "quota-advisor.sync-aa",
  input: z.object({
    recalibrate: z.boolean().optional(),
  }),
  output: z.custom<SyncAaResult>(),
});

export const snapshotSubscription = defineSubscription({
  name: "quota-advisor.stream",
  input: z.object({}),
  event: z.custom<QuotaAdvisorSnapshot>(),
});
