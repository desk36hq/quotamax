import type { PluginServerContext } from "@getpaseo/plugin/server";
import os from "node:os";
import path from "node:path";
import { QuotaAdvisorService } from "./server/advisor";
import bundledCatalog from "./server/default-models.json";
import { createPaseoQuotaSource } from "./server/paseoQuotaSource";
import {
  alibabaInputSchema,
  discoverAlibaba,
  fetchAlibabaUsage,
} from "./server/alibabaUsage";
import { CostEstimatorService } from "./server/costEstimator";
import {
  addBankedResetRpc,
  consumeBankedResetRpc,
  deleteBankedResetRpc,
  getCostsRpc,
  getSnapshotRpc,
  snapshotSubscription,
  syncAaRpc,
} from "./shared/contract";
import { advisorSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(advisorSettings);

  // Feeds Paseo's standard usage tracker (`paseo usage`), which the advisor below
  // consumes; the source id matches the `alibaba` pool in the catalog.
  server.registerUsageSource({
    id: "alibaba",
    label: "Alibaba Cloud",
    providers: ["pi"],
    input: alibabaInputSchema,
    discover: (scope) => (scope.kind === "global" ? discoverAlibaba() : Promise.resolve([])),
    fetch: fetchAlibabaUsage,
  });

  const readSettings = async () => {
    const state = await settingsHandle.read();
    if (state.status === "ready") {
      return state.values;
    }
    return { aaApiKey: "", recalibrateOnSync: true };
  };

  // Paseo keeps its synced catalog and price cache where QuotaMax always has.
  const dataDir = path.join(os.homedir(), ".paseo", "plugin-data", "quota-advisor");

  const service = new QuotaAdvisorService({
    readSettings,
    quotaSource: createPaseoQuotaSource(),
    bundledCatalog,
    dataDir,
  });
  service.start();

  const costEstimator = new CostEstimatorService({
    ratesCachePath: path.join(dataDir, "litellm-rates-cache.json"),
  });

  const stopSettingsSub = settingsHandle.subscribe(() => {
    void service.notifySettingsChanged();
  });

  server.handle(getSnapshotRpc, async (input) => {
    return service.getSnapshot(Boolean(input.refresh));
  });

  server.handle(getCostsRpc, async (input) => {
    return costEstimator.getSummary(input.window ?? "7d", Boolean(input.refresh));
  });

  server.handle(syncAaRpc, async (input) => {
    return service.syncArtificialAnalysis(input.recalibrate);
  });

  server.handle(addBankedResetRpc, async (input) => {
    return service.addBankedReset(input);
  });

  server.handle(consumeBankedResetRpc, async (input) => {
    return service.consumeBankedReset(input.id, input.amount);
  });

  server.handle(deleteBankedResetRpc, async (input) => {
    return service.deleteBankedReset(input.id);
  });

  server.handle(snapshotSubscription, (_input, ctx) => {
    if (ctx.signal.aborted) return;
    const unsubscribe = service.subscribe((snapshot) => {
      if (!ctx.signal.aborted) {
        void ctx.push(snapshot).catch(() => {});
      }
    });
    ctx.signal.addEventListener(
      "abort",
      () => {
        unsubscribe();
      },
      { once: true }
    );
  });

  return () => {
    void stopSettingsSub();
    service.stop();
  };
}
