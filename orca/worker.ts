// QuotaMax's Orca worker: the same advisor and cost estimator the Paseo plugin runs, fed by
// Orca's rate limits instead of `paseo usage`. Orca starts it with the plugin and keeps it
// running while the status bar item exists, so polling and burn-rate history continue.
import os from "node:os";
import path from "node:path";
import type { JsonValue, OrcaWorkerApi } from "orca/worker";
import bundledCatalog from "../server/default-models.json" with { type: "json" };
import { QuotaAdvisorService } from "../server/advisor";
import { CostEstimatorService } from "../server/costEstimator";
import type { QuotaSource } from "../server/quotaSource";
import type { BurnMode, CostEstimateSummary, CostWindow, QuotaAdvisorSnapshot } from "../shared/types";
import { applyRecommendation } from "./apply";
import { createOrcaQuotaSource } from "./orcaQuotaSource";

export const AA_KEY_SECRET = "aaApiKey";
const HISTORY_KEY = "burnHistory";
const STATUS_ITEM = "quotamax";

export interface WorkerDeps {
  quotaSource: QuotaSource;
  /** Holds the synced models.json and the price cache. */
  dataDir: string;
  fallbackCatalogPaths: string[];
  costs: { getSummary(window: CostWindow, refresh: boolean): Promise<CostEstimateSummary> };
}

export function defaultDeps(): WorkerDeps {
  const home = os.homedir();
  const dataDir = path.join(home, ".quotamax");
  return {
    quotaSource: createOrcaQuotaSource(),
    dataDir,
    // Reuse a catalog already synced under Paseo until one is synced here.
    fallbackCatalogPaths: [path.join(home, ".paseo", "plugin-data", "quota-advisor", "models.json")],
    costs: new CostEstimatorService({ ratesCachePath: path.join(dataDir, "litellm-rates-cache.json") }),
  };
}

const MODE_LABEL: Record<BurnMode, string> = {
  HAMMER: "Hammer",
  PUSH: "Push",
  BALANCED: "Balanced",
  CONSERVE: "Conserve",
  THROTTLED_5H: "5h cap",
  EXHAUSTED: "Exhausted",
  UNTRACKED: "Untracked",
};

const MODE_TONE: Record<BurnMode, "neutral" | "accent" | "success" | "warning" | "danger"> = {
  HAMMER: "accent",
  PUSH: "success",
  BALANCED: "neutral",
  CONSERVE: "warning",
  THROTTLED_5H: "danger",
  EXHAUSTED: "danger",
  UNTRACKED: "neutral",
};

/** Status bar: the pool to use now (top Standard pick) and every tracked pool on hover. */
export function statusBarFor(snapshot: QuotaAdvisorSnapshot): {
  text: string;
  tone: "neutral" | "accent" | "success" | "warning" | "danger";
  tooltip: string;
} {
  const tracked = snapshot.pools.filter((p) => p.tracked);
  if (tracked.length === 0) {
    return {
      text: "QuotaMax",
      tone: snapshot.error ? "warning" : "neutral",
      tooltip: snapshot.error ?? "No subscription quota reported by Orca yet",
    };
  }
  const lines = tracked.map((p) => {
    const w = p.weekly ?? p.short;
    const left = w ? `${Math.round(w.remainingPct)}% left` : "";
    return `${p.label}: ${MODE_LABEL[p.mode]}${left ? ` — ${left}` : ""}`;
  });
  const top = snapshot.recommendations.standard[0];
  const pool = tracked.find((p) => p.pool === top?.pool) ?? tracked[0]!;
  return {
    text: `${pool.label} · ${MODE_LABEL[pool.mode]}`,
    tone: MODE_TONE[pool.mode],
    tooltip: [...(top ? [`Use now: ${top.label}`] : []), ...lines].join("\n"),
  };
}

let stopCurrent: (() => Promise<void>) | null = null;

export function activateWith(orca: OrcaWorkerApi, deps: WorkerDeps): void {
  const service = new QuotaAdvisorService({
    readSettings: async () => ({
      aaApiKey: ((await orca.secrets.get(AA_KEY_SECRET)) ?? "").trim(),
      recalibrateOnSync: (await orca.settings.get("recalibrateOnSync")) !== false,
    }),
    quotaSource: deps.quotaSource,
    bundledCatalog,
    dataDir: deps.dataDir,
    fallbackCatalogPaths: deps.fallbackCatalogPaths,
  });

  let unsubscribe: (() => void) | null = null;
  // Set when the worker stops, so a stop during startup can't be followed by polling.
  let disposed = false;
  // Restore the burn-rate history first, so a restart keeps the 15-minute ETA estimate.
  const ready = orca.storage
    .get(HISTORY_KEY)
    .then((saved) => service.importHistory(saved))
    .catch(() => {})
    .then(() => {
      if (disposed) return;
      unsubscribe = service.subscribe((snapshot) => {
        orca.panels.post("quotamax.snapshot", snapshot);
        void orca.storage.set(HISTORY_KEY, service.exportHistory() as unknown as JsonValue).catch(() => {});
        if (orca.host.has("statusBar.update")) {
          void orca.host
            .call("statusBar.update", { id: STATUS_ITEM, ...statusBarFor(snapshot) })
            .catch(() => {});
        }
      });
      service.start();
    });

  orca.panels.handle("quotamax.snapshot", async ({ refresh }) => {
    await ready;
    return service.getSnapshot(Boolean(refresh));
  });
  orca.panels.handle("quotamax.costs", async ({ window, refresh }) =>
    deps.costs.getSummary(window ?? "7d", Boolean(refresh))
  );
  orca.panels.handle("quotamax.syncAa", async ({ recalibrate }) =>
    service.syncArtificialAnalysis(recalibrate)
  );
  orca.panels.handle("quotamax.aaKey", async ({ key }) => {
    const trimmed = key.trim();
    if (trimmed) await orca.secrets.set(AA_KEY_SECRET, trimmed);
    else await orca.secrets.delete(AA_KEY_SECRET);
    await service.notifySettingsChanged();
    return { hasKey: Boolean(trimmed) };
  });
  orca.panels.handle("quotamax.apply", async (input) => applyRecommendation(orca.host, input));
  orca.panels.handle("quotamax.addBankedReset", async (input) => {
    await ready;
    return service.addBankedReset(input);
  });
  orca.panels.handle("quotamax.consumeBankedReset", async ({ id, amount }) => {
    await ready;
    return service.consumeBankedReset(id, amount);
  });
  orca.panels.handle("quotamax.deleteBankedReset", async ({ id }) => {
    await ready;
    return service.deleteBankedReset(id);
  });

  orca.commands.register("quotamax.refresh", async () => {
    await ready;
    const s = await service.getSnapshot(true);
    const tracked = s.pools.filter((p) => p.tracked).length;
    return s.error ? `QuotaMax: ${s.error}` : `QuotaMax refreshed: ${tracked} of ${s.pools.length} pools tracked.`;
  });

  const settingsSub = orca.settings.onDidChange(() => {
    void service.notifySettingsChanged();
  });

  stopCurrent = async () => {
    disposed = true;
    settingsSub.dispose();
    unsubscribe?.();
    await orca.storage.set(HISTORY_KEY, service.exportHistory() as unknown as JsonValue).catch(() => {});
    service.stop();
  };
}

export default function activate(orca: OrcaWorkerApi): void {
  activateWith(orca, defaultDeps());
}

export async function deactivate(): Promise<void> {
  const stop = stopCurrent;
  stopCurrent = null;
  await stop?.();
}
