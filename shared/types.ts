// Plain data types shared by every host (Paseo and Orca) and both runtimes.
// No runtime imports: Orca loads this file without a bundler, so it must not pull in
// zod or the Paseo SDK. Paseo's RPC contracts live in ./contract.ts and re-export these.

export const TASK_TIERS = ["quick", "standard", "hard", "frontier"] as const;
export type TaskTier = (typeof TASK_TIERS)[number];

export const BURN_MODES = [
  "HAMMER",
  "PUSH",
  "BALANCED",
  "CONSERVE",
  "THROTTLED_5H",
  "EXHAUSTED",
  "UNTRACKED",
] as const;
export type BurnMode = (typeof BURN_MODES)[number];

export const COST_WINDOWS = ["24h", "7d", "30d"] as const;
export type CostWindow = (typeof COST_WINDOWS)[number];

/** The advisor's settings, whichever host stores them. */
export interface AdvisorSettingsValues {
  aaApiKey: string;
  recalibrateOnSync: boolean;
}

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

export type BankedResetKind = "5h" | "weekly" | "full" | "fable";
export type BankedResetSource = "api" | "manual";

export interface BankedResetEntry {
  id: string;
  pool: string;
  kind: BankedResetKind;
  count: number;
  expiresAt: string | null;
  remainingHours: number | null;
  source: BankedResetSource;
  label?: string;
  note?: string;
}

export interface ResetAdvice {
  action: "pop_now" | "burn_before_expiry" | "hold";
  severity: "urgent" | "warning" | "info";
  headline: string;
  detail: string;
}

export interface AddBankedResetInput {
  pool: string;
  kind: BankedResetKind;
  count?: number;
  expiresAt?: string | null;
  note?: string;
}

export interface PoolStatus {
  pool: string;
  label: string;
  planLabel: string | null;
  /** Agent provider id that runs this pool's models (historical name; used by both hosts). */
  paseoProvider: string;
  tracked: boolean;
  mode: BurnMode;
  urgencyBonus: number;
  shortCaution: boolean;
  reason: string;
  weekly: WindowStats | null;
  short: WindowStats | null;
  burn: BurnRateEstimate;
  bankedResets?: BankedResetEntry[];
  resetAdvice?: ResetAdvice | null;
}

export interface ModelRecommendation {
  provider: string;
  modelId: string;
  /** `provider/modelId` (historical name; used by both hosts). */
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
