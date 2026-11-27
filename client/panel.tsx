import {
  type PluginComposer,
  type PluginWorkspacePanelProps,
  useComposers,
  useRpc,
  useSubscription,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  type BankedResetEntry,
  type BankedResetKind,
  type BurnMode,
  type CostEstimateSummary,
  type CostWindow,
  type ModelRecommendation,
  type PoolCostBreakdown,
  type PoolStatus,
  type QuotaAdvisorSnapshot,
  type SyncAaResult,
  type TaskTier,
  addBankedResetRpc,
  consumeBankedResetRpc,
  getCostsRpc,
  getSnapshotRpc,
  snapshotSubscription,
  syncAaRpc,
} from "../shared/contract";

type Colors = PluginWorkspacePanelProps["theme"]["colors"];

const RESET_KINDS: readonly { id: BankedResetKind; label: string }[] = [
  { id: "weekly", label: "Weekly" },
  { id: "5h", label: "5h" },
  { id: "full", label: "Full" },
  { id: "fable", label: "Fable" },
];

const RESET_EXPIRY_PRESETS: readonly { id: string; label: string; hours: number | null }[] = [
  { id: "24h", label: "24h", hours: 24 },
  { id: "3d", label: "3d", hours: 72 },
  { id: "7d", label: "7d", hours: 168 },
  { id: "14d", label: "14d", hours: 336 },
  { id: "30d", label: "30d", hours: 720 },
  { id: "none", label: "No expiry", hours: null },
];

const TASK_TIERS: readonly { id: TaskTier; label: string }[] = [
  { id: "quick", label: "Quick" },
  { id: "standard", label: "Standard" },
  { id: "hard", label: "Hard" },
  { id: "frontier", label: "Frontier" },
];

const COST_WINDOWS: readonly { id: CostWindow; label: string }[] = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
];

const MODE_ORDER: Record<BurnMode, number> = {
  HAMMER: 0,
  PUSH: 1,
  BALANCED: 2,
  CONSERVE: 3,
  THROTTLED_5H: 4,
  EXHAUSTED: 5,
  UNTRACKED: 6,
};

function monoFont(): string {
  return Platform.OS === "ios" ? "Menlo" : "monospace";
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

function formatRelativeAge(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const secs = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function modeColors(mode: BurnMode, colors: Colors): { bg: string; fg: string; border: string } {
  switch (mode) {
    case "HAMMER":
      return {
        bg: "rgba(245, 158, 11, 0.16)",
        fg: colors.statusWarning,
        border: "rgba(245, 158, 11, 0.42)",
      };
    case "PUSH":
      return {
        bg: "rgba(59, 130, 246, 0.15)",
        fg: colors.accent,
        border: "rgba(59, 130, 246, 0.38)",
      };
    case "BALANCED":
      return {
        bg: "rgba(52, 211, 153, 0.14)",
        fg: colors.statusSuccess,
        border: "rgba(52, 211, 153, 0.34)",
      };
    case "CONSERVE":
      return {
        bg: "rgba(248, 113, 113, 0.14)",
        fg: colors.statusDanger,
        border: "rgba(248, 113, 113, 0.35)",
      };
    case "THROTTLED_5H":
    case "EXHAUSTED":
      return {
        bg: "rgba(239, 68, 68, 0.2)",
        fg: colors.statusDanger,
        border: "rgba(239, 68, 68, 0.5)",
      };
    default:
      return {
        bg: colors.surface2,
        fg: colors.foregroundMuted,
        border: colors.border,
      };
  }
}

function modeLabel(mode: BurnMode, pace: number | null): string {
  if (mode === "THROTTLED_5H") return "5H CAP";
  if (mode === "EXHAUSTED") return "EXHAUSTED";
  if (mode === "UNTRACKED") return "UNTRACKED";
  if (pace != null && Number.isFinite(pace)) {
    return `${mode} · ${pace.toFixed(1)}x`;
  }
  return mode;
}

function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) return "<$0.01";
  if (amount < 100) return `$${amount.toFixed(2)}`;
  if (amount < 1000) return `$${amount.toFixed(1)}`;
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

function readInitialTier(state: unknown): TaskTier {
  if (state && typeof state === "object" && "tier" in state) {
    const t = (state as { tier?: unknown }).tier;
    if (t === "quick" || t === "standard" || t === "hard" || t === "frontier") return t;
  }
  return "standard";
}

function readInitialCostWindow(state: unknown): CostWindow {
  if (state && typeof state === "object" && "costWindow" in state) {
    const w = (state as { costWindow?: unknown }).costWindow;
    if (w === "24h" || w === "7d" || w === "30d") return w;
  }
  return "7d";
}

type PanelProps = Pick<PluginWorkspacePanelProps, "theme"> & {
  tab?: PluginWorkspacePanelProps["tab"];
  openSettings(): void;
};

export function QuotaAdvisorPanel({ theme, tab, openSettings }: PanelProps) {
  const colors = theme.colors;
  const fetchSnapshot = useRpc(getSnapshotRpc);
  const fetchCosts = useRpc(getCostsRpc);
  const runSyncAa = useRpc(syncAaRpc);
  const runAddBankedReset = useRpc(addBankedResetRpc);
  const runConsumeBankedReset = useRpc(consumeBankedResetRpc);
  const focusedComposers = useComposers({ focused: true });

  const [snapshot, setSnapshot] = useState<QuotaAdvisorSnapshot | null>(null);
  const [addResetOpen, setAddResetOpen] = useState(false);
  const [resetPool, setResetPool] = useState<string>("");
  const [resetKind, setResetKind] = useState<BankedResetKind>("weekly");
  const [resetCount, setResetCount] = useState<number>(1);
  const [resetExpiry, setResetExpiry] = useState<string>("7d");
  const [savingReset, setSavingReset] = useState(false);
  const [costWindow, setCostWindow] = useState<CostWindow>(() => readInitialCostWindow(tab?.state));
  const [costs, setCosts] = useState<CostEstimateSummary | null>(null);
  const [costsLoading, setCostsLoading] = useState(false);
  const [costsError, setCostsError] = useState<string | null>(null);
  const [showCostModels, setShowCostModels] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingAa, setSyncingAa] = useState(false);
  const [syncNotice, setSyncNotice] = useState<SyncAaResult | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [tier, setTier] = useState<TaskTier>(() => readInitialTier(tab?.state));
  const [showAllModels, setShowAllModels] = useState(false);
  const [appliedKey, setAppliedKey] = useState<string | null>(null);
  const [applyFeedback, setApplyFeedback] = useState<{ kind: "ok" | "warn"; text: string } | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const applyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshingRef = useRef(false);
  const syncingAaRef = useRef(false);
  const costWindowRef = useRef<CostWindow>(costWindow);
  costWindowRef.current = costWindow;
  const latestGeneratedAtRef = useRef<string>("");

  const applySnapshot = useCallback((next: QuotaAdvisorSnapshot) => {
    if (latestGeneratedAtRef.current && next.generatedAt < latestGeneratedAtRef.current) {
      return;
    }
    latestGeneratedAtRef.current = next.generatedAt;
    setSnapshot(next);
    setFetchError(next.error);
  }, []);

  const subState = useSubscription(snapshotSubscription, {}, (next) => {
    applySnapshot(next);
  });

  // Initial fetch in case subscription takes a moment
  useEffect(() => {
    let active = true;
    fetchSnapshot({ refresh: false })
      .then((data) => {
        if (!active) return;
        applySnapshot(data);
      })
      .catch((err) => {
        if (!active) return;
        setFetchError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      active = false;
    };
  }, [applySnapshot, fetchSnapshot]);

  // Clear apply feedback timer on unmount
  useEffect(() => {
    return () => {
      if (applyTimerRef.current) {
        clearTimeout(applyTimerRef.current);
      }
    };
  }, []);

  // Fetch API-equivalent cost estimates whenever window changes
  useEffect(() => {
    let active = true;
    setCostsLoading(true);
    setCostsError(null);
    fetchCosts({ window: costWindow, refresh: false })
      .then((data) => {
        if (!active) return;
        setCosts(data);
      })
      .catch((err) => {
        if (!active) return;
        setCostsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setCostsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [costWindow, fetchCosts]);

  // Tick relative age every 15s
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  const selectTier = useCallback(
    (next: TaskTier) => {
      setTier(next);
      setShowAllModels(false);
      tab?.setState({ tier: next, costWindow });
    },
    [costWindow, tab]
  );

  const selectCostWindow = useCallback(
    (next: CostWindow) => {
      setCostWindow(next);
      tab?.setState({ tier, costWindow: next });
    },
    [tab, tier]
  );

  const handleRefresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    setFetchError(null);
    setCostsError(null);
    const requestedWindow = costWindowRef.current;
    try {
      const [data, costData] = await Promise.all([
        fetchSnapshot({ refresh: true }),
        fetchCosts({ window: requestedWindow, refresh: true }).catch((err) => {
          if (costWindowRef.current === requestedWindow) {
            setCostsError(err instanceof Error ? err.message : String(err));
          }
          return null;
        }),
      ]);
      applySnapshot(data);
      if (costData && costWindowRef.current === requestedWindow) {
        setCosts(costData);
      }
      setNowMs(Date.now());
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [applySnapshot, fetchCosts, fetchSnapshot]);

  const handleSyncAa = useCallback(async () => {
    if (syncingAaRef.current) return;
    if (snapshot && !snapshot.hasAaKey) {
      openSettings();
      return;
    }
    syncingAaRef.current = true;
    setSyncingAa(true);
    setSyncNotice(null);
    try {
      const res = await runSyncAa({});
      if (res.missingKey) {
        openSettings();
      } else {
        setSyncNotice(res);
      }
    } catch (err) {
      setSyncNotice({
        ok: false,
        matched: 0,
        total: 0,
        updatedAt: "-",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      syncingAaRef.current = false;
      setSyncingAa(false);
    }
  }, [openSettings, runSyncAa, snapshot]);

  const handleApply = useCallback(
    async (rec: ModelRecommendation) => {
      const composer: PluginComposer | undefined = focusedComposers[0];
      if (!composer) {
        setApplyFeedback({
          kind: "warn",
          text: `Focus a chat composer first to apply ${rec.paseoTarget}.`,
        });
        return;
      }

      const key = `${rec.provider}/${rec.modelId}`;
      setApplyFeedback(null);
      try {
        const currentProvider = composer.agent.provider;
        if (currentProvider !== rec.provider) {
          if (composer.context === "agent") {
            setApplyFeedback({
              kind: "warn",
              text: `Active chat is locked to ${currentProvider || "its provider"}. Open a new draft to switch to ${rec.paseoTarget}.`,
            });
            return;
          }
          await composer.setProvider(rec.provider);
        }
        await composer.setModel(rec.modelId);
        if (rec.recommendedThinking) {
          await composer.setThinking(rec.recommendedThinking).catch(() => {});
        }
        setAppliedKey(key);
        setApplyFeedback({
          kind: "ok",
          text: `Applied ${rec.label}${rec.recommendedThinking ? ` (${rec.recommendedThinking})` : ""} to composer.`,
        });
        if (applyTimerRef.current) clearTimeout(applyTimerRef.current);
        applyTimerRef.current = setTimeout(() => {
          setAppliedKey((prev) => (prev === key ? null : prev));
        }, 2200);
      } catch (err) {
        setApplyFeedback({
          kind: "warn",
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [focusedComposers]
  );

  const { trackedPools, untrackedPools, poolByKey } = useMemo(() => {
    const all = snapshot?.pools ?? [];
    const tracked = all
      .filter((p) => p.tracked)
      .sort((a, b) => {
        const d = MODE_ORDER[a.mode] - MODE_ORDER[b.mode];
        if (d !== 0) return d;
        return (b.weekly?.pace ?? 0) - (a.weekly?.pace ?? 0);
      });
    const untracked = all.filter((p) => !p.tracked);
    const map = new Map(all.map((p) => [p.pool, p]));
    return { trackedPools: tracked, untrackedPools: untracked, poolByKey: map };
  }, [snapshot]);

  const costByPool = useMemo(() => {
    const map = new Map<string, PoolCostBreakdown>();
    for (const p of costs?.byPool ?? []) {
      map.set(p.pool, p);
    }
    return map;
  }, [costs]);

  const handleAddReset = useCallback(async () => {
    if (savingReset) return;
    const targetPool = resetPool || trackedPools[0]?.pool || untrackedPools[0]?.pool || "";
    if (!targetPool) return;
    const preset = RESET_EXPIRY_PRESETS.find((p) => p.id === resetExpiry);
    const expiresAt =
      preset && preset.hours != null
        ? new Date(Date.now() + preset.hours * 3_600_000).toISOString()
        : null;
    setSavingReset(true);
    try {
      const next = await runAddBankedReset({
        pool: targetPool,
        kind: resetKind,
        count: resetCount,
        expiresAt,
      });
      applySnapshot(next);
      setAddResetOpen(false);
      setResetCount(1);
    } catch (err) {
      setFetchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingReset(false);
    }
  }, [applySnapshot, resetCount, resetExpiry, resetKind, resetPool, runAddBankedReset, savingReset, trackedPools, untrackedPools]);

  const handleConsumeReset = useCallback(
    async (id: string) => {
      try {
        const next = await runConsumeBankedReset({ id, amount: 1 });
        applySnapshot(next);
      } catch (err) {
        setFetchError(err instanceof Error ? err.message : String(err));
      }
    },
    [applySnapshot, runConsumeBankedReset]
  );

  const recs = snapshot?.recommendations?.[tier] ?? [];
  const visibleRecs = showAllModels ? recs : recs.slice(0, 3);
  const topRec = recs[0] ?? null;
  const topPool = topRec ? poolByKey.get(topRec.pool) ?? null : null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.surface0 }}
      contentContainerStyle={{ padding: 14, gap: 14, paddingBottom: 24 }}
    >
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
            <Icon name="Gauge" size={16} color={colors.accent} />
            <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "700" }}>
              QuotaMax
            </Text>
          </View>
          <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
            {trackedPools.length} active {trackedPools.length === 1 ? "pool" : "pools"}
            {snapshot?.lastPolledAt ? ` · updated ${formatRelativeAge(snapshot.lastPolledAt, nowMs)}` : ""}
          </Text>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Pressable
            onPress={handleRefresh}
            accessibilityRole="button"
            accessibilityLabel="Refresh subscription usage"
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 5,
              paddingHorizontal: 9,
              paddingVertical: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: pressed ? colors.surface2 : colors.surface1,
            })}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={colors.foregroundMuted} />
            ) : (
              <Icon name="RefreshCw" size={13} color={colors.foregroundMuted} />
            )}
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5, fontWeight: "600" }}>
              Refresh
            </Text>
          </Pressable>

          <Pressable
            onPress={openSettings}
            accessibilityRole="button"
            accessibilityLabel="QuotaMax settings"
            style={({ pressed }) => ({
              padding: 6,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: pressed ? colors.surface2 : colors.surface1,
            })}
          >
            <Icon name="Settings" size={14} color={colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>

      {/* Error banner */}
      {fetchError ? (
        <View
          style={{
            padding: 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: "rgba(239, 68, 68, 0.4)",
            backgroundColor: "rgba(239, 68, 68, 0.1)",
          }}
        >
          <Text style={{ color: colors.statusDanger, fontSize: 12, lineHeight: 17 }}>
            Could not refresh usage: {fetchError}
          </Text>
        </View>
      ) : null}

      {/* Loading state */}
      {!snapshot && !fetchError ? (
        <View style={{ padding: 28, alignItems: "center", gap: 8 }}>
          <ActivityIndicator color={colors.foregroundMuted} />
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            Reading Paseo subscription quotas…
          </Text>
        </View>
      ) : null}

      {snapshot ? (
        <>
          {/* Card 1: Recommended Models */}
          <View
            style={{
              backgroundColor: colors.surface1,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: colors.border,
              padding: 12,
              gap: 10,
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 8,
              }}
            >
              <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "700" }}>
                Recommended Models
              </Text>

              {/* Segmented Task Switcher */}
              <View
                style={{
                  flexDirection: "row",
                  backgroundColor: colors.surface0,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: colors.border,
                  padding: 2,
                  gap: 2,
                }}
              >
                {TASK_TIERS.map((t) => {
                  const active = t.id === tier;
                  return (
                    <Pressable
                      key={t.id}
                      onPress={() => selectTier(t.id)}
                      style={{
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 6,
                        backgroundColor: active ? colors.surface2 : "transparent",
                      }}
                    >
                      <Text
                        style={{
                          fontSize: 11,
                          fontWeight: active ? "700" : "500",
                          color: active ? colors.foreground : colors.foregroundMuted,
                        }}
                      >
                        {t.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Apply feedback toast-like inline banner */}
            {applyFeedback ? (
              <View
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 7,
                  borderRadius: 8,
                  backgroundColor:
                    applyFeedback.kind === "ok"
                      ? "rgba(52, 211, 153, 0.12)"
                      : "rgba(245, 158, 11, 0.12)",
                  borderWidth: 1,
                  borderColor:
                    applyFeedback.kind === "ok"
                      ? "rgba(52, 211, 153, 0.35)"
                      : "rgba(245, 158, 11, 0.35)",
                }}
              >
                <Text
                  style={{
                    fontSize: 11.5,
                    color: applyFeedback.kind === "ok" ? colors.statusSuccess : colors.statusWarning,
                  }}
                >
                  {applyFeedback.text}
                </Text>
              </View>
            ) : null}

            {/* Ranked model list */}
            <View style={{ gap: 7 }}>
              {visibleRecs.map((rec, idx) => {
                const isTop = idx === 0;
                const pool = poolByKey.get(rec.pool);
                const mc = modeColors(rec.poolMode, colors);
                const key = `${rec.provider}/${rec.modelId}`;
                const justApplied = appliedKey === key;

                return (
                  <View
                    key={key}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      paddingHorizontal: 10,
                      paddingVertical: 9,
                      borderRadius: 9,
                      backgroundColor: isTop ? colors.surface2 : colors.surface0,
                      borderWidth: 1,
                      borderColor: isTop ? colors.accent : colors.border,
                    }}
                  >
                    <View style={{ flex: 1, gap: 3 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                        <Text style={{ color: colors.foreground, fontSize: 13, fontWeight: "700" }}>
                          {idx + 1}. {rec.label}
                        </Text>
                        {rec.recommendedThinking ? (
                          <View
                            style={{
                              paddingHorizontal: 6,
                              paddingVertical: 1.5,
                              borderRadius: 5,
                              backgroundColor: colors.surface1,
                              borderWidth: 1,
                              borderColor: colors.border,
                            }}
                          >
                            <Text style={{ color: colors.foregroundMuted, fontSize: 10, fontWeight: "600" }}>
                              {rec.recommendedThinking}
                            </Text>
                          </View>
                        ) : null}
                      </View>

                      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                        <Text
                          style={{
                            color: colors.foregroundMuted,
                            fontSize: 11,
                            fontFamily: monoFont(),
                          }}
                        >
                          {rec.provider}
                        </Text>
                        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                          · IQ {rec.intelligence} · Eff {rec.efficiency}
                        </Text>
                        <Text style={{ color: mc.fg, fontSize: 11, fontWeight: "700" }}>
                          · {modeLabel(rec.poolMode, pool?.weekly?.pace ?? null)}
                        </Text>
                      </View>
                    </View>

                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <Text
                        style={{
                          color: isTop ? colors.accent : colors.foregroundMuted,
                          fontSize: 12,
                          fontWeight: "700",
                          fontFamily: monoFont(),
                        }}
                      >
                        {rec.totalScore.toFixed(1)}
                      </Text>

                      <Pressable
                        onPress={() => void handleApply(rec)}
                        accessibilityRole="button"
                        accessibilityLabel={`Apply ${rec.label}`}
                        style={({ pressed }) => ({
                          paddingHorizontal: 10,
                          paddingVertical: 5,
                          borderRadius: 7,
                          borderWidth: 1,
                          borderColor: justApplied
                            ? colors.statusSuccess
                            : isTop
                              ? colors.accent
                              : colors.border,
                          backgroundColor: justApplied
                            ? colors.statusSuccess
                            : isTop
                              ? colors.accent
                              : pressed
                                ? colors.surface2
                                : colors.surface1,
                          opacity: pressed ? 0.85 : 1,
                        })}
                      >
                        <Text
                          style={{
                            fontSize: 11.5,
                            fontWeight: "600",
                            color: justApplied || isTop ? colors.accentForeground : colors.foreground,
                          }}
                        >
                          {justApplied ? "Applied" : "Apply"}
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                );
              })}
            </View>

            {/* Top pick rationale */}
            {topRec && topPool ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 11.5, lineHeight: 16 }}>
                <Text style={{ color: colors.foreground, fontWeight: "600" }}>Why #1: </Text>
                {topPool.reason}. {topRec.notes}
              </Text>
            ) : null}

            {/* Show more toggle */}
            {recs.length > 3 ? (
              <Pressable
                onPress={() => setShowAllModels((v) => !v)}
                style={{ alignSelf: "flex-start", paddingVertical: 2 }}
              >
                <Text style={{ color: colors.accent, fontSize: 11.5, fontWeight: "600" }}>
                  {showAllModels ? "Show top 3" : `Show all ${recs.length} ranked models`}
                </Text>
              </Pressable>
            ) : null}
          </View>

          {/* Card 2: Burn Pace & Resets */}
          <View
            style={{
              backgroundColor: colors.surface1,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: colors.border,
              padding: 12,
              gap: 10,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "700" }}>
                  Burn Pace &amp; Resets
                </Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>
                  Ratio &gt; 1x = surplus · 15m burn ETA
                </Text>
              </View>
              <Pressable
                onPress={() => {
                  if (!resetPool) {
                    setResetPool(trackedPools[0]?.pool || untrackedPools[0]?.pool || "");
                  }
                  setAddResetOpen((v) => !v);
                }}
                accessibilityRole="button"
                accessibilityLabel="Log banked reset"
                style={({ pressed }) => ({
                  paddingHorizontal: 8,
                  paddingVertical: 4,
                  borderRadius: 7,
                  borderWidth: 1,
                  borderColor: addResetOpen ? colors.accent : colors.border,
                  backgroundColor: addResetOpen
                    ? "rgba(59, 130, 246, 0.14)"
                    : pressed
                      ? colors.surface2
                      : colors.surface0,
                })}
              >
                <Text
                  style={{
                    color: addResetOpen ? colors.accent : colors.foreground,
                    fontSize: 11,
                    fontWeight: "600",
                  }}
                >
                  {addResetOpen ? "Close" : "+ Reset"}
                </Text>
              </Pressable>
            </View>

            {addResetOpen ? (
              <View
                style={{
                  backgroundColor: colors.surface0,
                  borderRadius: 9,
                  borderWidth: 1,
                  borderColor: colors.border,
                  padding: 10,
                  gap: 8,
                }}
              >
                <Text style={{ color: colors.foreground, fontSize: 11.5, fontWeight: "700" }}>
                  Log banked reset
                </Text>

                {/* Pool chips */}
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
                  {[...trackedPools, ...untrackedPools].slice(0, 8).map((p) => {
                    const active = (resetPool || trackedPools[0]?.pool) === p.pool;
                    return (
                      <Pressable
                        key={p.pool}
                        onPress={() => setResetPool(p.pool)}
                        style={{
                          paddingHorizontal: 7,
                          paddingVertical: 3,
                          borderRadius: 6,
                          borderWidth: 1,
                          borderColor: active ? colors.accent : colors.border,
                          backgroundColor: active ? "rgba(59, 130, 246, 0.14)" : colors.surface1,
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 10.5,
                            fontWeight: active ? "700" : "500",
                            color: active ? colors.accent : colors.foregroundMuted,
                          }}
                        >
                          {p.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>

                {/* Kind + Count row */}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                  <View style={{ flexDirection: "row", gap: 4 }}>
                    {RESET_KINDS.map((k) => {
                      const active = resetKind === k.id;
                      return (
                        <Pressable
                          key={k.id}
                          onPress={() => setResetKind(k.id)}
                          style={{
                            paddingHorizontal: 7,
                            paddingVertical: 3,
                            borderRadius: 6,
                            borderWidth: 1,
                            borderColor: active ? colors.accent : colors.border,
                            backgroundColor: active ? colors.surface2 : "transparent",
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 10.5,
                              fontWeight: active ? "700" : "500",
                              color: active ? colors.foreground : colors.foregroundMuted,
                            }}
                          >
                            {k.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                    <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>Qty:</Text>
                    {[1, 2, 3].map((n) => {
                      const active = resetCount === n;
                      return (
                        <Pressable
                          key={n}
                          onPress={() => setResetCount(n)}
                          style={{
                            paddingHorizontal: 7,
                            paddingVertical: 2.5,
                            borderRadius: 6,
                            borderWidth: 1,
                            borderColor: active ? colors.accent : colors.border,
                            backgroundColor: active ? colors.surface2 : "transparent",
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 10.5,
                              fontWeight: active ? "700" : "500",
                              color: active ? colors.foreground : colors.foregroundMuted,
                            }}
                          >
                            {n}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* Expiry presets + Save */}
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
                  <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, flex: 1 }}>
                    {RESET_EXPIRY_PRESETS.map((ex) => {
                      const active = resetExpiry === ex.id;
                      return (
                        <Pressable
                          key={ex.id}
                          onPress={() => setResetExpiry(ex.id)}
                          style={{
                            paddingHorizontal: 6,
                            paddingVertical: 2.5,
                            borderRadius: 6,
                            borderWidth: 1,
                            borderColor: active ? colors.accent : colors.border,
                            backgroundColor: active ? colors.surface2 : "transparent",
                          }}
                        >
                          <Text
                            style={{
                              fontSize: 10,
                              fontWeight: active ? "700" : "500",
                              color: active ? colors.foreground : colors.foregroundMuted,
                            }}
                          >
                            {ex.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>

                  <Pressable
                    onPress={() => void handleAddReset()}
                    disabled={savingReset}
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 4.5,
                      borderRadius: 7,
                      backgroundColor: colors.accent,
                      opacity: savingReset ? 0.6 : 1,
                    }}
                  >
                    <Text style={{ color: colors.accentForeground, fontSize: 11, fontWeight: "700" }}>
                      {savingReset ? "Saving…" : "Save"}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ) : null}

            <View style={{ gap: 8 }}>
              {trackedPools.map((pool) => (
                <PoolCard
                  key={pool.pool}
                  pool={pool}
                  poolCost={costByPool.get(pool.pool) ?? null}
                  costWindow={costWindow}
                  onConsumeReset={handleConsumeReset}
                  colors={colors}
                />
              ))}
            </View>

            {untrackedPools.length > 0 ? (
              <Text style={{ color: colors.foregroundMuted, fontSize: 11, lineHeight: 15 }}>
                Untracked: {untrackedPools.map((p) => p.label).join(", ")}
              </Text>
            ) : null}
          </View>

          {/* Card 3: API-Equivalent Cost Estimates (ported from T3 Code) */}
          <CostEstimatesCard
            costs={costs}
            costWindow={costWindow}
            loading={costsLoading}
            error={costsError}
            showModels={showCostModels}
            onToggleModels={() => setShowCostModels((v) => !v)}
            onSelectWindow={selectCostWindow}
            colors={colors}
          />

          {/* Sync AA inline notice */}
          {syncNotice ? (
            <View
              style={{
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderRadius: 8,
                backgroundColor: syncNotice.ok
                  ? "rgba(52, 211, 153, 0.12)"
                  : "rgba(239, 68, 68, 0.12)",
                borderWidth: 1,
                borderColor: syncNotice.ok
                  ? "rgba(52, 211, 153, 0.35)"
                  : "rgba(239, 68, 68, 0.35)",
              }}
            >
              <Text
                style={{
                  fontSize: 11.5,
                  color: syncNotice.ok ? colors.statusSuccess : colors.statusDanger,
                }}
              >
                {syncNotice.message}
              </Text>
            </View>
          ) : null}

          {/* Footer */}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              paddingHorizontal: 2,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor:
                    subState.status === "live" ? colors.statusSuccess : colors.statusWarning,
                }}
              />
              <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
                AA baseline ({snapshot.catalogUpdatedAt})
              </Text>
            </View>

            <Pressable
              onPress={() => void handleSyncAa()}
              disabled={syncingAa}
              accessibilityRole="button"
              accessibilityLabel={snapshot.hasAaKey ? "Sync Artificial Analysis scores" : "Configure Artificial Analysis API key"}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 5,
                paddingHorizontal: 8,
                paddingVertical: 4,
                borderRadius: 6,
                backgroundColor: pressed ? colors.surface2 : "transparent",
              })}
            >
              {syncingAa ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Icon
                  name={snapshot.hasAaKey ? "RefreshCw" : "KeyRound"}
                  size={11}
                  color={colors.accent}
                />
              )}
              <Text style={{ color: colors.accent, fontSize: 11.5, fontWeight: "600" }}>
                {syncingAa ? "Syncing…" : snapshot.hasAaKey ? "Sync AA" : "Set AA Key"}
              </Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function PoolCard({
  pool,
  poolCost,
  costWindow,
  onConsumeReset,
  colors,
}: {
  pool: PoolStatus;
  poolCost: PoolCostBreakdown | null;
  costWindow: CostWindow;
  onConsumeReset: (id: string) => void;
  colors: Colors;
}) {
  const mc = modeColors(pool.mode, colors);
  const weeklyBarColor =
    pool.mode === "HAMMER"
      ? colors.statusWarning
      : pool.mode === "CONSERVE" || pool.mode === "EXHAUSTED"
        ? colors.statusDanger
        : pool.mode === "PUSH"
          ? colors.accent
          : colors.statusSuccess;

  const shortBarColor =
    pool.short && pool.short.remainingPct <= 15 ? colors.statusDanger : colors.accent;

  const burnColor =
    pool.burn.etaSeverity === "danger"
      ? colors.statusDanger
      : pool.burn.etaSeverity === "warning"
        ? colors.statusWarning
        : colors.foregroundMuted;

  const activeRate =
    pool.burn.etaWindow === "5h"
      ? pool.burn.shortRatePctPerMin
      : pool.burn.etaWindow === "weekly"
        ? pool.burn.weeklyRatePctPerMin
        : null;

  return (
    <View
      style={{
        backgroundColor: colors.surface0,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: colors.border,
        padding: 10,
        gap: 7,
      }}
    >
      {/* Top Row: Name + Mode Badge */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flex: 1 }}>
          <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "700" }}>
            {pool.label}
          </Text>
          {pool.planLabel ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{pool.planLabel}</Text>
          ) : null}
        </View>

        <View
          style={{
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: mc.bg,
            borderWidth: 1,
            borderColor: mc.border,
          }}
        >
          <Text style={{ color: mc.fg, fontSize: 10, fontWeight: "700" }}>
            {modeLabel(pool.mode, pool.weekly?.pace ?? null)}
          </Text>
        </View>
      </View>

      {/* Weekly Bar */}
      {pool.weekly ? (
        <QuotaBarRow
          label={pool.weekly.id === "monthly" ? pool.weekly.label : "Weekly"}
          usedPct={pool.weekly.usedPct}
          resetText={formatDuration(pool.weekly.remainingHours)}
          fillColor={weeklyBarColor}
          colors={colors}
        />
      ) : null}

      {/* 5-hour Bar */}
      {pool.short ? (
        <QuotaBarRow
          label="5-hour"
          usedPct={pool.short.usedPct}
          resetText={formatDuration(pool.short.remainingHours)}
          fillColor={shortBarColor}
          colors={colors}
        />
      ) : null}

      {/* Banked Resets & Strategic Advice */}
      {pool.bankedResets && pool.bankedResets.length > 0 ? (
        <View
          style={{
            gap: 5,
            paddingTop: 5,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          {pool.resetAdvice && pool.resetAdvice.action !== "hold" ? (
            <View
              style={{
                paddingHorizontal: 8,
                paddingVertical: 5,
                borderRadius: 7,
                backgroundColor:
                  pool.resetAdvice.action === "pop_now"
                    ? "rgba(52, 211, 153, 0.14)"
                    : pool.resetAdvice.severity === "urgent"
                      ? "rgba(239, 68, 68, 0.16)"
                      : "rgba(245, 158, 11, 0.14)",
                borderWidth: 1,
                borderColor:
                  pool.resetAdvice.action === "pop_now"
                    ? "rgba(52, 211, 153, 0.4)"
                    : pool.resetAdvice.severity === "urgent"
                      ? "rgba(239, 68, 68, 0.45)"
                      : "rgba(245, 158, 11, 0.4)",
              }}
            >
              <Text
                style={{
                  fontSize: 11,
                  fontWeight: "700",
                  color:
                    pool.resetAdvice.action === "pop_now"
                      ? colors.statusSuccess
                      : pool.resetAdvice.severity === "urgent"
                        ? colors.statusDanger
                        : colors.statusWarning,
                }}
              >
                ⚡ {pool.resetAdvice.headline}
              </Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: 10, marginTop: 1 }}>
                {pool.resetAdvice.detail}
              </Text>
            </View>
          ) : null}

          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
            {pool.bankedResets.map((r: BankedResetEntry) => {
              const urgent = r.remainingHours != null && r.remainingHours <= 12;
              const soon = r.remainingHours != null && r.remainingHours <= 48;
              const pillColor = urgent
                ? colors.statusDanger
                : soon
                  ? colors.statusWarning
                  : colors.accent;
              return (
                <View
                  key={r.id}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 5,
                    paddingHorizontal: 7,
                    paddingVertical: 2.5,
                    borderRadius: 6,
                    backgroundColor: colors.surface1,
                    borderWidth: 1,
                    borderColor: colors.border,
                  }}
                >
                  <Text style={{ color: pillColor, fontSize: 10.5, fontWeight: "700", fontFamily: monoFont() }}>
                    ⚡ {r.count}× {r.kind}
                    {r.remainingHours != null ? ` · exp ${formatDuration(r.remainingHours)}` : ""}
                  </Text>
                  {r.source === "manual" ? (
                    <Pressable
                      onPress={() => onConsumeReset(r.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Mark ${r.kind} reset used`}
                      style={{
                        paddingHorizontal: 5,
                        paddingVertical: 1,
                        borderRadius: 4,
                        backgroundColor: colors.surface2,
                      }}
                    >
                      <Text style={{ color: colors.foregroundMuted, fontSize: 9.5, fontWeight: "600" }}>
                        Mark used
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      ) : null}

      {/* 15m Burn Rate & Limit ETA */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: 4,
          borderTopWidth: 1,
          borderTopColor: colors.border,
        }}
      >
        <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>
          15m burn
          {activeRate != null && activeRate > 0 ? ` (${activeRate.toFixed(2)}%/m)` : ""}
          {poolCost && poolCost.costUsd > 0
            ? ` · ${costWindow} est. ${formatUsd(poolCost.costUsd)}`
            : ""}
        </Text>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 4,
            paddingHorizontal: pool.burn.etaSeverity === "idle" ? 0 : 7,
            paddingVertical: pool.burn.etaSeverity === "idle" ? 0 : 2,
            borderRadius: 6,
            backgroundColor:
              pool.burn.etaSeverity === "danger"
                ? "rgba(239, 68, 68, 0.16)"
                : pool.burn.etaSeverity === "warning"
                  ? "rgba(245, 158, 11, 0.14)"
                  : "transparent",
          }}
        >
          {pool.burn.etaSeverity !== "idle" ? (
            <Icon name="Flame" size={11} color={burnColor} />
          ) : null}
          <Text
            style={{
              color: burnColor,
              fontSize: 11,
              fontWeight: pool.burn.etaSeverity === "idle" ? "500" : "700",
            }}
          >
            {pool.burn.etaLabel}
          </Text>
        </View>
      </View>
    </View>
  );
}

function QuotaBarRow({
  label,
  usedPct,
  resetText,
  fillColor,
  colors,
}: {
  label: string;
  usedPct: number;
  resetText: string;
  fillColor: string;
  colors: Colors;
}) {
  const clamped = Math.max(0, Math.min(100, usedPct));
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 11, width: 44 }}>{label}</Text>
      <View
        style={{
          flex: 1,
          height: 5,
          borderRadius: 999,
          backgroundColor: colors.surface2,
          overflow: "hidden",
        }}
      >
        <View style={{ width: `${clamped}%`, height: "100%", borderRadius: 999, backgroundColor: fillColor }} />
      </View>
      <Text
        style={{
          color: colors.foregroundMuted,
          fontSize: 11,
          width: 124,
          textAlign: "right",
          fontFamily: monoFont(),
        }}
      >
        {usedPct.toFixed(0)}% used · {resetText}
      </Text>
    </View>
  );
}

function CostEstimatesCard({
  costs,
  costWindow,
  loading,
  error,
  showModels,
  onToggleModels,
  onSelectWindow,
  colors,
}: {
  costs: CostEstimateSummary | null;
  costWindow: CostWindow;
  loading: boolean;
  error: string | null;
  showModels: boolean;
  onToggleModels: () => void;
  onSelectWindow: (next: CostWindow) => void;
  colors: Colors;
}) {
  const catTotal = costs
    ? costs.categoryCostUsd.input +
      costs.categoryCostUsd.cacheRead +
      costs.categoryCostUsd.cacheWrite +
      costs.categoryCostUsd.output
    : 0;
  const pct = (part: number) => (catTotal > 0 ? Math.max(0, (part / catTotal) * 100) : 0);

  return (
    <View
      style={{
        backgroundColor: colors.surface1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.border,
        padding: 12,
        gap: 10,
      }}
    >
      {/* Header + Window Switcher */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text style={{ color: colors.foreground, fontSize: 12.5, fontWeight: "700" }}>
            API-Equivalent Cost
          </Text>
          {loading ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : null}
        </View>

        <View
          style={{
            flexDirection: "row",
            backgroundColor: colors.surface0,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            padding: 2,
            gap: 2,
          }}
        >
          {COST_WINDOWS.map((w) => {
            const active = w.id === costWindow;
            return (
              <Pressable
                key={w.id}
                onPress={() => onSelectWindow(w.id)}
                style={{
                  paddingHorizontal: 8,
                  paddingVertical: 3.5,
                  borderRadius: 6,
                  backgroundColor: active ? colors.surface2 : "transparent",
                }}
              >
                <Text
                  style={{
                    fontSize: 11,
                    fontWeight: active ? "700" : "500",
                    color: active ? colors.foreground : colors.foregroundMuted,
                  }}
                >
                  {w.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {error ? (
        <Text style={{ color: colors.statusDanger, fontSize: 11.5 }}>
          Could not scan local usage: {error}
        </Text>
      ) : null}

      {costs ? (
        <>
          {/* Headline KPI Row */}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <View
              style={{
                flex: 1,
                backgroundColor: colors.surface0,
                borderRadius: 9,
                borderWidth: 1,
                borderColor: colors.border,
                padding: 9,
                gap: 2,
              }}
            >
              <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>Est. Value</Text>
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: 16,
                  fontWeight: "700",
                  fontFamily: monoFont(),
                }}
              >
                {formatUsd(costs.totalCostUsd)}
              </Text>
              {costs.speedPremiumUsd > 0.01 ? (
                <Text style={{ color: colors.statusWarning, fontSize: 10 }}>
                  +{formatUsd(costs.speedPremiumUsd)} fast
                </Text>
              ) : (
                <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>
                  {costs.records.toLocaleString("en-US")} turns
                </Text>
              )}
            </View>

            <View
              style={{
                flex: 1,
                backgroundColor: colors.surface0,
                borderRadius: 9,
                borderWidth: 1,
                borderColor: colors.border,
                padding: 9,
                gap: 2,
              }}
            >
              <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>Cache Saved</Text>
              <Text
                style={{
                  color: colors.statusSuccess,
                  fontSize: 16,
                  fontWeight: "700",
                  fontFamily: monoFont(),
                }}
              >
                {formatUsd(costs.cacheSavingsUsd)}
              </Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>
                {costs.cacheHitPct.toFixed(0)}% cache hit
              </Text>
            </View>

            <View
              style={{
                flex: 1,
                backgroundColor: colors.surface0,
                borderRadius: 9,
                borderWidth: 1,
                borderColor: colors.border,
                padding: 9,
                gap: 2,
              }}
            >
              <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>Tokens</Text>
              <Text
                style={{
                  color: colors.foreground,
                  fontSize: 16,
                  fontWeight: "700",
                  fontFamily: monoFont(),
                }}
              >
                {formatCompactTokens(costs.totalTokens)}
              </Text>
              <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>
                {formatCompactTokens(costs.totals.outputTokens)} out
              </Text>
            </View>
          </View>

          {/* Category Split Bar */}
          {catTotal > 0 ? (
            <View style={{ gap: 5 }}>
              <View
                style={{
                  flexDirection: "row",
                  height: 6,
                  borderRadius: 999,
                  overflow: "hidden",
                  backgroundColor: colors.surface2,
                }}
              >
                <View style={{ width: `${pct(costs.categoryCostUsd.input)}%`, backgroundColor: colors.accent }} />
                <View style={{ width: `${pct(costs.categoryCostUsd.cacheRead)}%`, backgroundColor: colors.statusSuccess }} />
                <View style={{ width: `${pct(costs.categoryCostUsd.cacheWrite)}%`, backgroundColor: colors.statusWarning }} />
                <View style={{ width: `${pct(costs.categoryCostUsd.output)}%`, backgroundColor: "#a855f7" }} />
              </View>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
                <Text style={{ color: colors.foregroundMuted, fontSize: 10.5 }}>
                  In {formatUsd(costs.categoryCostUsd.input)}
                </Text>
                <Text style={{ color: colors.statusSuccess, fontSize: 10.5 }}>
                  Cache Rd {formatUsd(costs.categoryCostUsd.cacheRead)}
                </Text>
                <Text style={{ color: colors.statusWarning, fontSize: 10.5 }}>
                  Cache Wr {formatUsd(costs.categoryCostUsd.cacheWrite)}
                </Text>
                <Text style={{ color: "#a855f7", fontSize: 10.5 }}>
                  Out {formatUsd(costs.categoryCostUsd.output)}
                </Text>
              </View>
            </View>
          ) : null}

          {/* By Pool Breakdown */}
          {costs.byPool.length > 0 ? (
            <View style={{ gap: 5 }}>
              {costs.byPool.map((p) => {
                const share =
                  costs.totalCostUsd > 0 ? Math.min(100, (p.costUsd / costs.totalCostUsd) * 100) : 0;
                return (
                  <View
                    key={p.pool}
                    style={{
                      backgroundColor: colors.surface0,
                      borderRadius: 8,
                      borderWidth: 1,
                      borderColor: colors.border,
                      paddingHorizontal: 9,
                      paddingVertical: 7,
                      gap: 4,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                      }}
                    >
                      <Text style={{ color: colors.foreground, fontSize: 11.5, fontWeight: "600", flex: 1 }}>
                        {p.label}
                      </Text>
                      <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, fontFamily: monoFont() }}>
                        {formatCompactTokens(p.totalTokens)} · {p.cacheHitPct.toFixed(0)}% hit
                      </Text>
                      <Text
                        style={{
                          color: colors.foreground,
                          fontSize: 11.5,
                          fontWeight: "700",
                          fontFamily: monoFont(),
                          minWidth: 56,
                          textAlign: "right",
                        }}
                      >
                        {formatUsd(p.costUsd)}
                      </Text>
                    </View>
                    <View
                      style={{
                        height: 3.5,
                        borderRadius: 999,
                        backgroundColor: colors.surface2,
                        overflow: "hidden",
                      }}
                    >
                      <View
                        style={{
                          width: `${share}%`,
                          height: "100%",
                          borderRadius: 999,
                          backgroundColor: colors.accent,
                        }}
                      />
                    </View>
                  </View>
                );
              })}
            </View>
          ) : (
            <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
              No local session usage recorded in the last {costWindow}.
            </Text>
          )}

          {/* Expandable Top Models */}
          {costs.byModel.length > 0 ? (
            <View style={{ gap: 6 }}>
              <Pressable onPress={onToggleModels} style={{ alignSelf: "flex-start", paddingVertical: 2 }}>
                <Text style={{ color: colors.accent, fontSize: 11.5, fontWeight: "600" }}>
                  {showModels ? "Hide model breakdown" : `Show top ${costs.byModel.length} models`}
                </Text>
              </Pressable>

              {showModels ? (
                <View style={{ gap: 4 }}>
                  {costs.byModel.map((m) => (
                    <View
                      key={`${m.provider}:${m.model}`}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        paddingHorizontal: 8,
                        paddingVertical: 5,
                        borderRadius: 7,
                        backgroundColor: colors.surface0,
                        borderWidth: 1,
                        borderColor: colors.border,
                      }}
                    >
                      <View style={{ flex: 1, gap: 1 }}>
                        <Text
                          numberOfLines={1}
                          style={{ color: colors.foreground, fontSize: 11, fontWeight: "600" }}
                        >
                          {m.model}
                        </Text>
                        <Text style={{ color: colors.foregroundMuted, fontSize: 10 }}>
                          {m.provider} · {formatCompactTokens(m.totalTokens)} · {m.records} turns
                        </Text>
                      </View>
                      <Text
                        style={{
                          color: m.unpriced ? colors.foregroundMuted : colors.foreground,
                          fontSize: 11,
                          fontWeight: "700",
                          fontFamily: monoFont(),
                        }}
                      >
                        {m.unpriced ? "unpriced" : formatUsd(m.costUsd)}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          ) : null}

          <Text style={{ color: colors.foregroundMuted, fontSize: 10.5, lineHeight: 14 }}>
            API-equivalent rates via{" "}
            {costs.ratesSource === "openrouter"
              ? "OpenRouter"
              : costs.ratesSource === "fallback"
                ? "built-in fallback"
                : "LiteLLM"}{" "}
            ({costs.ratesCount.toLocaleString("en-US")} models) — reflects equivalent API value, not subscription spend.
            {costs.unpricedRecords > 0 ? ` ${costs.unpricedRecords} unpriced turns.` : ""}
          </Text>
        </>
      ) : !loading && !error ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: 11.5 }}>
          Scanning local agent transcripts…
        </Text>
      ) : null}
    </View>
  );
}
