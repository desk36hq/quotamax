// Paseo RPC contracts. The data types themselves live in ./types.ts (no zod, no Paseo
// SDK) so the Orca plugin can share them; they are re-exported here unchanged.
import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import {
  BURN_MODES,
  COST_WINDOWS,
  TASK_TIERS,
  type CostEstimateSummary,
  type QuotaAdvisorSnapshot,
  type SyncAaResult,
} from "./types";

export type {
  AddBankedResetInput,
  BankedResetEntry,
  BankedResetKind,
  BankedResetSource,
  BurnMode,
  BurnRateEstimate,
  CostCategorySplit,
  CostEstimateSummary,
  CostRatesSource,
  CostTokenTotals,
  CostWindow,
  ModelCostBreakdown,
  ModelRecommendation,
  PoolCostBreakdown,
  PoolStatus,
  QuotaAdvisorSnapshot,
  ResetAdvice,
  SyncAaResult,
  TaskTier,
  WindowStats,
} from "./types";

export const TaskTierSchema = z.enum(TASK_TIERS);
export const BurnModeSchema = z.enum(BURN_MODES);
export const CostWindowSchema = z.enum(COST_WINDOWS);

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

export const BankedResetKindSchema = z.enum(["5h", "weekly", "full", "fable"]);

export const addBankedResetRpc = defineRpc({
  name: "quota-advisor.add-banked-reset",
  input: z.object({
    pool: z.string().min(1),
    kind: BankedResetKindSchema,
    count: z.number().int().min(1).max(99).optional(),
    expiresAt: z.string().nullable().optional(),
    note: z.string().max(160).optional(),
  }),
  output: z.custom<QuotaAdvisorSnapshot>(),
});

export const consumeBankedResetRpc = defineRpc({
  name: "quota-advisor.consume-banked-reset",
  input: z.object({
    id: z.string().min(1),
    amount: z.number().int().min(1).max(99).optional(),
  }),
  output: z.custom<QuotaAdvisorSnapshot>(),
});

export const deleteBankedResetRpc = defineRpc({
  name: "quota-advisor.delete-banked-reset",
  input: z.object({
    id: z.string().min(1),
  }),
  output: z.custom<QuotaAdvisorSnapshot>(),
});

export const snapshotSubscription = defineSubscription({
  name: "quota-advisor.stream",
  input: z.object({}),
  event: z.custom<QuotaAdvisorSnapshot>(),
});
