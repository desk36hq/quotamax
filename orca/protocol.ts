// The Orca panel <-> worker contract, declared once: orca/panel.tsx and orca/worker.ts
// both read it. Data types are the host-neutral ones in shared/types.ts.
import type {
  CostEstimateSummary,
  CostWindow,
  QuotaAdvisorSnapshot,
  SyncAaResult,
} from "../shared/types";
import type { ApplyRequest, ApplyResult } from "./applyTypes";

declare module "orca" {
  interface PluginRequests {
    /** The latest snapshot; `refresh` re-reads Orca's rate limits now. */
    "quotamax.snapshot": { input: { refresh?: boolean }; output: QuotaAdvisorSnapshot };
    /** API-equivalent cost estimate from local session logs. */
    "quotamax.costs": { input: { window?: CostWindow; refresh?: boolean }; output: CostEstimateSummary };
    /** Pulls Artificial Analysis scores into the local catalog. */
    "quotamax.syncAa": { input: { recalibrate?: boolean }; output: SyncAaResult };
    /** Saves (or, when empty, removes) the Artificial Analysis key in Orca's encrypted secrets. */
    "quotamax.aaKey": { input: { key: string }; output: { hasKey: boolean } };
    /** Preview (confirm: false) or send (confirm: true) the model command to an idle agent. */
    "quotamax.apply": { input: ApplyRequest; output: ApplyResult };
  }
  interface PluginPanelEvents {
    /** Posted to every open panel after each poll. */
    "quotamax.snapshot": QuotaAdvisorSnapshot;
  }
}
