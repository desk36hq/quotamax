import type { PluginServerContext } from "@getpaseo/plugin/server";
import { QuotaAdvisorService } from "./server/advisor";
import {
  alibabaInputSchema,
  discoverAlibaba,
  fetchAlibabaUsage,
} from "./server/alibabaUsage";
import { CostEstimatorService } from "./server/costEstimator";
import { getCostsRpc, getSnapshotRpc, snapshotSubscription, syncAaRpc } from "./shared/contract";
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

  const service = new QuotaAdvisorService(readSettings);
  service.start();

  const costEstimator = new CostEstimatorService();

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

  server.handle(snapshotSubscription, (_input, ctx) => {
    const unsubscribe = service.subscribe((snapshot) => {
      if (!ctx.signal.aborted) {
        void ctx.push(snapshot).catch(() => {});
      }
    });
    ctx.signal.addEventListener("abort", () => {
      unsubscribe();
    });
  });

  return () => {
    void stopSettingsSub();
    service.stop();
  };
}
