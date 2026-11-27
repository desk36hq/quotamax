// QuotaMax's Orca panel. Orca draws it with its own components (no React, no DOM): state
// lives in atoms, and everything else comes from the worker (orca/worker.ts) over
// plugin.request / plugin.on, typed by orca/protocol.ts.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  Code,
  Collapsible,
  EmptyState,
  Heading,
  IconButton,
  Input,
  KeyValue,
  Link,
  List,
  ListItem,
  plugin,
  Progress,
  RadioGroup,
  read,
  Row,
  set,
  settings,
  Skeleton,
  Spinner,
  Stack,
  Switch,
  Tab,
  Table,
  Tabs,
  Text,
  type PanelContext,
  type TableRow,
} from "orca";
import type {
  BurnMode,
  CostEstimateSummary,
  CostWindow,
  ModelRecommendation,
  PoolStatus,
  QuotaAdvisorSnapshot,
  SyncAaResult,
  TaskTier,
  WindowStats,
} from "../shared/types";
import type { ApplyResult } from "./applyTypes";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const TIERS: { value: TaskTier; label: string }[] = [
  { value: "quick", label: "Quick" },
  { value: "standard", label: "Standard" },
  { value: "hard", label: "Hard" },
  { value: "frontier", label: "Frontier" },
];

const WINDOWS: { value: CostWindow; label: string }[] = [
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const MODE: Record<BurnMode, { label: string; tone: Tone }> = {
  HAMMER: { label: "HAMMER", tone: "accent" },
  PUSH: { label: "PUSH", tone: "success" },
  BALANCED: { label: "BALANCED", tone: "neutral" },
  CONSERVE: { label: "CONSERVE", tone: "warning" },
  THROTTLED_5H: { label: "5H CAP", tone: "danger" },
  EXHAUSTED: { label: "EXHAUSTED", tone: "danger" },
  UNTRACKED: { label: "UNTRACKED", tone: "neutral" },
};

const snapshot = atom<QuotaAdvisorSnapshot | null>(null);
const loadError = atom<string | null>(null);
const refreshing = atom(false);
const tab = atom("tab", "recommend", { persist: "plugin" });
const tier = atom<string>("tier", "standard", { persist: "plugin" });
const selected = atom<string | null>(null);
const apply = atom<ApplyResult | null>(null);
const applying = atom(false);
const costWindow = atom<string>("costWindow", "7d", { persist: "plugin" });
const costs = atom<CostEstimateSummary | null>(null);
const costsLoading = atom(false);
const costsError = atom<string | null>(null);
const keyDraft = atom("");
const keyNote = atom<string | null>(null);
const recalibrate = atom(true);
const syncing = atom(false);
const syncResult = atom<SyncAaResult | null>(null);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const recKey = (r: ModelRecommendation) => `${r.pool}|${r.provider}|${r.modelId}`;
const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

function hours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 36) return `${h.toFixed(1)}h`;
  return `${Math.floor(h / 24)}d ${Math.round(h % 24)}h`;
}

async function refresh(): Promise<void> {
  set(refreshing, true);
  try {
    set(snapshot, await plugin.request("quotamax.snapshot", { refresh: true }));
    set(loadError, null);
  } catch (err) {
    set(loadError, errorText(err));
  } finally {
    set(refreshing, false);
  }
}

async function loadCosts(window: string, force = false): Promise<void> {
  set(costsLoading, true);
  set(costsError, null);
  try {
    set(costs, await plugin.request("quotamax.costs", { window: window as CostWindow, refresh: force }, { timeoutMs: 120_000 }));
  } catch (err) {
    set(costsError, errorText(err));
  } finally {
    set(costsLoading, false);
  }
}

async function previewApply(rec: ModelRecommendation): Promise<void> {
  set(applying, true);
  try {
    set(apply, await plugin.request("quotamax.apply", {
      provider: rec.provider,
      modelId: rec.modelId,
      label: rec.label,
      thinking: rec.recommendedThinking,
      confirm: false,
    }));
  } catch (err) {
    set(apply, { status: "failed", message: errorText(err), commands: [] });
  } finally {
    set(applying, false);
  }
}

async function confirmApply(rec: ModelRecommendation, terminalId: string): Promise<void> {
  set(applying, true);
  try {
    set(apply, await plugin.request("quotamax.apply", {
      provider: rec.provider,
      modelId: rec.modelId,
      label: rec.label,
      thinking: rec.recommendedThinking,
      confirm: true,
      terminalId,
    }));
  } catch (err) {
    set(apply, { status: "failed", message: errorText(err), commands: [] });
  } finally {
    set(applying, false);
  }
}

async function saveKey(key: string): Promise<void> {
  try {
    const { hasKey } = await plugin.request("quotamax.aaKey", { key });
    set(keyDraft, "");
    set(keyNote, hasKey ? "Key saved in Orca's encrypted secrets." : "Key removed.");
    set(snapshot, await plugin.request("quotamax.snapshot", {}));
  } catch (err) {
    set(keyNote, `Couldn't save the key: ${errorText(err)}`);
  }
}

async function syncNow(): Promise<void> {
  set(syncing, true);
  try {
    set(syncResult, await plugin.request("quotamax.syncAa", { recalibrate: read(recalibrate) }, { timeoutMs: 60_000 }));
    set(snapshot, await plugin.request("quotamax.snapshot", {}));
  } catch (err) {
    set(syncResult, { ok: false, matched: 0, total: 0, updatedAt: "", message: errorText(err) });
  } finally {
    set(syncing, false);
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on("quotamax.snapshot", (s) => set(snapshot, s)));
  plugin
    .request("quotamax.snapshot", {})
    .then((s) => {
      set(snapshot, s);
      set(loadError, null);
    })
    .catch((err) => set(loadError, errorText(err)));
  settings
    .get("recalibrateOnSync")
    .then((v) => set(recalibrate, v !== false))
    .catch(() => {});
  if (read(tab) === "costs") void loadCosts(read(costWindow));
}

// ── Recommend ───────────────────────────────────────────────────────────────

function ApplyFeedback({ rec }: { rec: ModelRecommendation }) {
  const result = read(apply);
  const busy = read(applying);
  if (!result) return null;
  const tone: Tone =
    result.status === "sent" || result.status === "ready"
      ? "success"
      : result.status === "failed"
        ? "danger"
        : result.status === "busy"
          ? "warning"
          : "neutral";
  return (
    <Callout tone={tone} title={result.status === "ready" ? "Confirm" : undefined}>
      <Stack gap="sm">
        <Text>{result.message}</Text>
        {result.commands.length > 0 ? <Code block>{result.commands.join("\n")}</Code> : null}
        {result.status === "ready" && result.terminalId ? (
          <Row gap="xs">
            <Button tone="accent" icon="play" disabled={busy} onPress={() => confirmApply(rec, result.terminalId!)}>
              Send
            </Button>
            <Button variant="ghost" disabled={busy} onPress={() => set(apply, null)}>
              Cancel
            </Button>
          </Row>
        ) : null}
      </Stack>
    </Callout>
  );
}

function RecommendTab({ s }: { s: QuotaAdvisorSnapshot }) {
  const t = (read(tier) as TaskTier) in s.recommendations ? (read(tier) as TaskTier) : "standard";
  const recs = s.recommendations[t].slice(0, 10);
  const chosen = recs.find((r) => recKey(r) === read(selected)) ?? recs[0];
  const rows: TableRow[] = recs.map((r) => ({
    key: recKey(r),
    cells: {
      model: r.label,
      pool: r.poolLabel,
      mode: MODE[r.poolMode].label,
      thinking: r.recommendedThinking ?? "—",
      score: Number(r.totalScore.toFixed(1)),
    },
  }));
  return (
    <Stack gap="md">
      <RadioGroup
        label="Task"
        orientation="horizontal"
        value={t}
        options={TIERS}
        onChange={(v) => {
          set(tier, v);
          set(selected, null);
          set(apply, null);
        }}
      />
      {recs.length === 0 ? (
        <EmptyState
          icon="gauge"
          title="No subscription quota yet"
          description="Sign in to a provider in Orca (Settings → Accounts). QuotaMax ranks models only for subscriptions Orca reports usage for."
        />
      ) : (
        <Stack gap="md">
          <Table
            label="Recommended models"
            columns={[
              { key: "model", label: "Model", width: "auto", minWidth: "md" },
              { key: "pool", label: "Pool", hideBelow: "sm" },
              { key: "mode", label: "Mode", hideBelow: "md" },
              { key: "thinking", label: "Thinking", hideBelow: "md" },
              { key: "score", label: "Score", align: "end", width: "xs" },
            ]}
            rows={rows}
            selectionMode="single"
            selected={chosen ? [recKey(chosen)] : []}
            maxHeight="md"
            onSelectionChange={({ keys }) => {
              set(selected, keys[0] ?? null);
              set(apply, null);
            }}
          />
          {chosen ? (
            <Card title={chosen.label} description={`${chosen.poolLabel} · ${MODE[chosen.poolMode].label}`}>
              <Stack gap="sm">
                <Text muted>{chosen.notes}</Text>
                <KeyValue
                  items={[
                    { label: "Model id", value: chosen.paseoTarget, code: true },
                    { label: "Thinking", value: chosen.recommendedThinking ?? "—" },
                    { label: "Intelligence · Coding", value: `${chosen.intelligence} · ${chosen.coding}` },
                    { label: "Efficiency · Quota cost", value: `${chosen.efficiency} · ${chosen.quotaCost}×` },
                  ]}
                />
                <Row gap="xs">
                  <Button icon="play" disabled={read(applying)} onPress={() => previewApply(chosen)}>
                    Apply to agent
                  </Button>
                </Row>
                <ApplyFeedback rec={chosen} />
              </Stack>
            </Card>
          ) : null}
        </Stack>
      )}
    </Stack>
  );
}

// ── Pools ───────────────────────────────────────────────────────────────────

function WindowRow({ w, name }: { w: WindowStats; name: string }) {
  return (
    <Stack gap="xs">
      <Progress label={`${name}: ${Math.round(w.remainingPct)}% left`} value={w.remainingPct} />
      <Text muted size="xs">
        Resets in {hours(w.remainingHours)}
        {w.pace != null ? ` · pace ${w.pace.toFixed(2)}×` : ""}
        {w.requiredPctPerHr != null ? ` · ${w.requiredPctPerHr.toFixed(1)}%/h to use it all` : ""}
      </Text>
    </Stack>
  );
}

function PoolCard({ p }: { p: PoolStatus }) {
  const mode = MODE[p.mode];
  return (
    <Card title={p.planLabel ? `${p.label} (${p.planLabel})` : p.label}>
      <Stack gap="sm">
        <Row gap="xs" wrap>
          <Badge tone={mode.tone}>{mode.label}</Badge>
          {p.burn.etaSeverity !== "idle" ? (
            <Badge tone={p.burn.etaSeverity === "danger" ? "danger" : "warning"}>{p.burn.etaLabel}</Badge>
          ) : null}
        </Row>
        <Text muted size="sm">{p.reason}</Text>
        {p.weekly ? <WindowRow w={p.weekly} name={p.weekly.label} /> : null}
        {p.short ? <WindowRow w={p.short} name={p.short.label} /> : null}
      </Stack>
    </Card>
  );
}

function PoolsTab({ s }: { s: QuotaAdvisorSnapshot }) {
  const tracked = s.pools.filter((p) => p.tracked);
  const untracked = s.pools.filter((p) => !p.tracked);
  return (
    <Stack gap="md">
      {tracked.length === 0 ? (
        <EmptyState icon="gauge" title="No pools tracked" description="Orca isn't reporting quota for any subscription QuotaMax knows yet." />
      ) : (
        tracked.map((p) => <PoolCard p={p} />)
      )}
      {untracked.length > 0 ? (
        <Collapsible title={`Not tracked (${untracked.length})`}>
          <List label="Untracked pools">
            {untracked.map((p) => (
              <ListItem title={p.label} description={p.reason} />
            ))}
          </List>
        </Collapsible>
      ) : null}
    </Stack>
  );
}

// ── Costs ───────────────────────────────────────────────────────────────────

function CostsTab() {
  const c = read(costs);
  const loading = read(costsLoading);
  const err = read(costsError);
  const w = read(costWindow);
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <RadioGroup
          label="Window"
          labelHidden
          orientation="horizontal"
          value={w}
          options={WINDOWS}
          onChange={(v) => {
            set(costWindow, v);
            void loadCosts(v);
          }}
        />
        <IconButton icon="refresh" label="Rescan logs" disabled={loading} onPress={() => loadCosts(w, true)} />
      </Row>
      {err ? <Callout tone="danger" title="Couldn't estimate costs">{err}</Callout> : null}
      {loading && !c ? <Spinner label="Scanning local session logs" /> : null}
      {c ? (
        <Stack gap="md">
          <KeyValue
            label={`API-equivalent value, last ${c.window}`}
            items={[
              { label: "Estimated API value", value: usd(c.totalCostUsd), tone: "accent" },
              { label: "Saved by prompt caching", value: usd(c.cacheSavingsUsd), tone: "success" },
              { label: "Cache hit rate", value: `${c.cacheHitPct.toFixed(1)}%` },
              { label: "Tokens", value: compact(c.totalTokens) },
              { label: "Input · Cache read · Cache write · Output", value: [c.categoryCostUsd.input, c.categoryCostUsd.cacheRead, c.categoryCostUsd.cacheWrite, c.categoryCostUsd.output].map(usd).join(" · ") },
              { label: "Prices", value: `${c.ratesSource} (${c.ratesCount} models)` },
            ]}
          />
          <Table
            label="By pool"
            columns={[
              { key: "pool", label: "Pool", width: "auto" },
              { key: "cost", label: "Value", align: "end" },
              { key: "saved", label: "Cache saved", align: "end", hideBelow: "sm" },
              { key: "hit", label: "Hit %", align: "end", hideBelow: "md" },
            ]}
            rows={c.byPool.map((p) => ({
              key: p.pool,
              cells: { pool: p.label, cost: usd(p.costUsd), saved: usd(p.cacheSavingsUsd), hit: `${p.cacheHitPct.toFixed(0)}%` },
            }))}
            emptyText="No usage in this window"
          />
          <Table
            label="By model"
            columns={[
              { key: "model", label: "Model", width: "auto" },
              { key: "cost", label: "Value", align: "end" },
              { key: "tokens", label: "Tokens", align: "end", hideBelow: "sm" },
            ]}
            rows={c.byModel.slice(0, 15).map((m) => ({
              key: `${m.provider}|${m.model}`,
              cells: { model: m.unpriced ? `${m.model} (unpriced)` : m.model, cost: usd(m.costUsd), tokens: compact(m.totalTokens) },
            }))}
            maxHeight="md"
            emptyText="No usage in this window"
          />
          <Text muted size="xs">
            Estimated from Claude Code, Codex, Antigravity and Pi session logs on this computer (not WSL or SSH hosts).
          </Text>
        </Stack>
      ) : null}
    </Stack>
  );
}

// ── Settings ────────────────────────────────────────────────────────────────

function SettingsTab({ s }: { s: QuotaAdvisorSnapshot }) {
  const draft = read(keyDraft);
  const note = read(keyNote);
  const result = read(syncResult);
  return (
    <Stack gap="md">
      <Text>
        An optional free Artificial Analysis key refreshes the catalog's Intelligence, Coding and efficiency scores.{" "}
        <Link href="https://artificialanalysis.ai/insights">Get a key</Link>
      </Text>
      <Input
        label="Artificial Analysis API key"
        type="password"
        value={draft}
        placeholder={s.hasAaKey ? "Saved. Paste a new key to replace it" : "Paste your key"}
        onChange={(v) => set(keyDraft, v)}
        onSubmit={(v) => saveKey(v)}
      />
      <Row gap="xs">
        <Button disabled={!draft.trim()} onPress={() => saveKey(draft)}>
          Save key
        </Button>
        {s.hasAaKey ? (
          <Button variant="ghost" tone="danger" onPress={() => saveKey("")}>
            Remove key
          </Button>
        ) : null}
      </Row>
      {note ? <Text muted size="sm">{note}</Text> : null}
      <Switch
        label="Recalibrate scores on sync"
        checked={read(recalibrate)}
        onChange={(v) => {
          set(recalibrate, v);
          void settings.set("recalibrateOnSync", v).catch(() => {});
        }}
      />
      <Row gap="xs" align="center">
        <Button icon="refresh" disabled={!s.hasAaKey || read(syncing)} onPress={syncNow}>
          Sync Artificial Analysis now
        </Button>
        {read(syncing) ? <Spinner label="Syncing" labelHidden /> : null}
      </Row>
      {result ? <Callout tone={result.ok ? "success" : "warning"}>{result.message}</Callout> : null}
      <Text muted size="xs">Catalog updated {s.catalogUpdatedAt}. Quota polled every {Math.round(s.pollIntervalMs / 1000)}s from Orca's rate limits.</Text>
    </Stack>
  );
}

// ── Panel ───────────────────────────────────────────────────────────────────

export default function Panel() {
  const s = read(snapshot);
  const err = read(loadError);
  const tracked = s ? s.pools.filter((p) => p.tracked).length : 0;
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>QuotaMax</Heading>
        <Row gap="xs" align="center">
          {s ? <Badge tone={tracked ? "accent" : "neutral"}>{`${tracked} tracked`}</Badge> : null}
          <IconButton icon="refresh" label="Refresh quota" disabled={read(refreshing)} onPress={refresh} />
        </Row>
      </Row>
      {s?.error ? <Callout tone="warning" title="Couldn't read quota">{s.error}</Callout> : null}
      {!s ? (
        err ? (
          <Callout tone="danger" title="QuotaMax isn't responding">{err}</Callout>
        ) : (
          <Skeleton lines={4} label="Reading Orca's rate limits" />
        )
      ) : (
        <Tabs
          label="QuotaMax views"
          value={read(tab)}
          onChange={(v) => {
            set(tab, v);
            if (v === "costs" && !read(costs) && !read(costsLoading)) void loadCosts(read(costWindow));
          }}
        >
          <Tab value="recommend" label="Recommend" icon="lightbulb">
            <RecommendTab s={s} />
          </Tab>
          <Tab value="pools" label="Pools" icon="gauge">
            <PoolsTab s={s} />
          </Tab>
          <Tab value="costs" label="Costs" icon="bar-chart-3">
            <CostsTab />
          </Tab>
          <Tab value="settings" label="Settings" icon="settings">
            <SettingsTab s={s} />
          </Tab>
        </Tabs>
      )}
    </Stack>
  );
}
