// QuotaMax's Orca panel: an HTML panel styled like the Paseo panel. This file is the only
// part that touches the DOM and Orca's frame API (`orca`); render.ts draws, styles.ts
// styles. All data comes from the plugin's worker (orca/worker.ts) via orca.plugin.
import type { BankedResetKind, CostWindow, QuotaAdvisorSnapshot, TaskTier } from "../../shared/types";
import {
  AA_KEY_URL,
  COST_WINDOWS,
  RESET_EXPIRY_PRESETS,
  RESET_KINDS,
  TASK_TIERS,
  initialState,
  recKey,
  renderPanel,
  sortPools,
} from "./render";
import { CSS } from "./styles";

const state = initialState();
const UI_TIER = "ui.tier";
const UI_COST_WINDOW = "ui.costWindow";
const LIVE_FOR_MS = 4 * 90_000;

let lastGeneratedAt = "";
let lastPushAt = 0;
let appliedTimer: ReturnType<typeof setTimeout> | null = null;

const style = document.createElement("style");
style.textContent = CSS;
document.head.append(style);
const root = document.createElement("div");
root.id = "qm-root";
document.body.append(root);

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Re-draws everything; focus and the caret in the key field survive. */
function render(): void {
  state.live = Date.now() - lastPushAt < LIVE_FOR_MS;
  const active = document.activeElement as HTMLElement | null;
  const focusId = active && root.contains(active) ? active.id : "";
  const input = active instanceof HTMLInputElement ? active : null;
  const caret = input ? [input.selectionStart, input.selectionEnd] : null;
  root.innerHTML = renderPanel(state, Date.now());
  if (focusId) {
    const next = document.getElementById(focusId);
    if (next instanceof HTMLElement && !next.hasAttribute("disabled")) {
      next.focus({ preventScroll: true });
      if (caret && next instanceof HTMLInputElement && caret[0] != null) {
        next.setSelectionRange(caret[0], caret[1] ?? caret[0]);
      }
    }
  }
}

function applySnapshot(next: QuotaAdvisorSnapshot): void {
  if (lastGeneratedAt && next.generatedAt < lastGeneratedAt) return;
  lastGeneratedAt = next.generatedAt;
  state.snapshot = next;
  state.fetchError = next.error;
  render();
}

async function loadCosts(refresh = false): Promise<void> {
  const window = state.costWindow;
  state.costsLoading = true;
  state.costsError = null;
  render();
  try {
    const costs = await orca.plugin.request("quotamax.costs", { window, refresh }, { timeoutMs: 120_000 });
    if (state.costWindow === window) state.costs = costs;
  } catch (err) {
    if (state.costWindow === window) state.costsError = errorText(err);
  } finally {
    if (state.costWindow === window) state.costsLoading = false;
    render();
  }
}

async function refresh(): Promise<void> {
  if (state.refreshing) return;
  state.refreshing = true;
  state.fetchError = null;
  render();
  try {
    const [snapshot] = await Promise.all([
      orca.plugin.request("quotamax.snapshot", { refresh: true }),
      loadCosts(true),
    ]);
    applySnapshot(snapshot);
  } catch (err) {
    state.fetchError = errorText(err);
  } finally {
    state.refreshing = false;
    render();
  }
}

async function apply(index: number, confirm: boolean): Promise<void> {
  const recs = state.snapshot?.recommendations[state.tier] ?? [];
  const rec = confirm ? recs.find((r) => recKey(r) === state.apply?.key) : recs[index];
  if (!rec || state.applying) return;
  state.applying = true;
  render();
  try {
    const result = await orca.plugin.request("quotamax.apply", {
      provider: rec.provider,
      modelId: rec.modelId,
      label: rec.label,
      thinking: rec.recommendedThinking,
      confirm,
      ...(confirm && state.apply?.result.terminalId ? { terminalId: state.apply.result.terminalId } : {}),
    });
    state.apply = { key: recKey(rec), result };
    if (result.status === "sent") {
      state.appliedKey = recKey(rec);
      if (appliedTimer) clearTimeout(appliedTimer);
      appliedTimer = setTimeout(() => {
        state.appliedKey = null;
        render();
      }, 2200);
    }
  } catch (err) {
    state.apply = { key: recKey(rec), result: { status: "failed", message: errorText(err), commands: [] } };
  } finally {
    state.applying = false;
    render();
  }
}

async function saveKey(key: string): Promise<boolean> {
  state.savingKey = true;
  state.keyNotice = null;
  render();
  try {
    const { hasKey } = await orca.plugin.request("quotamax.aaKey", { key });
    state.keyDraft = "";
    state.keyNotice = { ok: true, text: hasKey ? "API key saved in Orca's encrypted secrets." : "API key removed." };
    applySnapshot(await orca.plugin.request("quotamax.snapshot", {}));
    return true;
  } catch (err) {
    state.keyNotice = { ok: false, text: `Could not save the API key: ${errorText(err)}` };
    return false;
  } finally {
    state.savingKey = false;
    render();
  }
}

async function syncAa(from: string): Promise<void> {
  if (state.syncing) return;
  // Paseo's footer link opens Settings when no key is saved yet; so does this one.
  if (from === "footer" && state.snapshot && !state.snapshot.hasAaKey) {
    state.settingsOpen = true;
    render();
    document.getElementById("qm-key")?.focus();
    return;
  }
  if (from === "settings" && state.keyDraft.trim() && !(await saveKey(state.keyDraft))) return;
  state.syncing = true;
  state.syncNotice = null;
  render();
  try {
    const result = await orca.plugin.request("quotamax.syncAa", { recalibrate: state.recalibrate }, { timeoutMs: 60_000 });
    if (result.missingKey) state.settingsOpen = true;
    state.syncNotice = result;
    applySnapshot(await orca.plugin.request("quotamax.snapshot", {}));
  } catch (err) {
    state.syncNotice = { ok: false, matched: 0, total: 0, updatedAt: "-", message: errorText(err) };
  } finally {
    state.syncing = false;
    render();
  }
}

function toDatetimeLocalValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function saveBankedReset(): Promise<void> {
  if (state.savingReset) return;
  const pools = state.snapshot ? sortPools(state.snapshot.pools) : { tracked: [], untracked: [] };
  const targetPool = state.resetPool || pools.tracked[0]?.pool || pools.untracked[0]?.pool || "";
  if (!targetPool) return;
  let expiresAt: string | null = null;
  if (state.resetExpiry !== "none") {
    const parsed = state.resetExpiryInput ? Date.parse(state.resetExpiryInput) : NaN;
    if (Number.isFinite(parsed)) {
      expiresAt = new Date(parsed).toISOString();
    } else {
      const preset = RESET_EXPIRY_PRESETS.find((p) => p.id === state.resetExpiry);
      if (preset && preset.hours != null) {
        expiresAt = new Date(Date.now() + preset.hours * 3_600_000).toISOString();
      }
    }
  }
  state.savingReset = true;
  render();
  try {
    const next = await orca.plugin.request("quotamax.addBankedReset", {
      pool: targetPool,
      kind: state.resetKind,
      count: state.resetCount,
      expiresAt,
    });
    state.addResetOpen = false;
    state.resetCount = 1;
    applySnapshot(next);
  } catch (err) {
    state.fetchError = errorText(err);
  } finally {
    state.savingReset = false;
    render();
  }
}

async function consumeBankedReset(id: string): Promise<void> {
  try {
    applySnapshot(await orca.plugin.request("quotamax.consumeBankedReset", { id, amount: 1 }));
  } catch (err) {
    state.fetchError = errorText(err);
    render();
  }
}

root.addEventListener("click", (event) => {
  const el = (event.target as Element | null)?.closest<HTMLElement>("[data-action]");
  if (!el || el.hasAttribute("disabled")) return;
  const value = el.dataset.value ?? "";
  switch (el.dataset.action) {
    case "refresh":
      void refresh();
      return;
    case "toggle-settings":
      state.settingsOpen = !state.settingsOpen;
      break;
    case "tier":
      if (TASK_TIERS.some((t) => t.id === value)) {
        state.tier = value as TaskTier;
        state.showAllModels = false;
        state.apply = null;
        void orca.storage.set(UI_TIER, value).catch(() => {});
      }
      break;
    case "cost-window":
      if (COST_WINDOWS.some((w) => w.id === value) && value !== state.costWindow) {
        state.costWindow = value as CostWindow;
        state.costs = null;
        void orca.storage.set(UI_COST_WINDOW, value).catch(() => {});
        void loadCosts();
      }
      break;
    case "apply":
      void apply(Number(value), false);
      return;
    case "apply-send":
      void apply(-1, true);
      return;
    case "apply-cancel":
      state.apply = null;
      break;
    case "toggle-all-models":
      state.showAllModels = !state.showAllModels;
      break;
    case "toggle-cost-models":
      state.showCostModels = !state.showCostModels;
      break;
    case "toggle-untracked":
      state.showUntrackedReasons = !state.showUntrackedReasons;
      break;
    case "toggle-reveal":
      state.revealKey = !state.revealKey;
      break;
    case "save-key":
      void saveKey(state.keyDraft);
      return;
    case "remove-key":
      void saveKey("");
      return;
    case "sync-aa":
      void syncAa(value);
      return;
    case "toggle-recalibrate":
      state.recalibrate = !state.recalibrate;
      void orca.settings.set("recalibrateOnSync", state.recalibrate).catch(() => {});
      break;
    case "open-aa-site":
      if (orca.shell) void orca.shell.openExternal(AA_KEY_URL).catch(() => {});
      else state.keyNotice = { ok: true, text: `Get a free key at ${AA_KEY_URL}` };
      break;
    case "toggle-add-reset":
      state.addResetOpen = !state.addResetOpen;
      break;
    case "reset-pool":
      if (value) state.resetPool = value;
      break;
    case "reset-kind":
      if (RESET_KINDS.some((k) => k.id === value)) state.resetKind = value as BankedResetKind;
      break;
    case "reset-count": {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 1 && n <= 99) state.resetCount = n;
      break;
    }
    case "reset-expiry": {
      const preset = RESET_EXPIRY_PRESETS.find((p) => p.id === value);
      if (preset) {
        state.resetExpiry = value;
        state.resetExpiryInput =
          preset.hours != null ? toDatetimeLocalValue(Date.now() + preset.hours * 3_600_000) : "";
      }
      break;
    }
    case "save-reset":
      void saveBankedReset();
      return;
    case "consume-reset":
      if (value) void consumeBankedReset(value);
      return;
    default:
      return;
  }
  render();
});

root.addEventListener("input", (event) => {
  const el = event.target as HTMLInputElement;
  if (el.id === "qm-key") {
    state.keyDraft = el.value;
    state.keyNotice = null;
    render();
    return;
  }
  if (el.id === "qm-reset-expires") {
    state.resetExpiryInput = el.value;
    state.resetExpiry = el.value ? "custom" : "none";
  }
});

root.addEventListener("keydown", (event) => {
  const el = event.target as HTMLInputElement;
  if (el.id === "qm-key" && event.key === "Enter" && state.keyDraft.trim()) void saveKey(state.keyDraft);
});

async function start(): Promise<void> {
  render();
  orca.plugin.on("quotamax.snapshot", (snapshot) => {
    lastPushAt = Date.now();
    applySnapshot(snapshot);
  });
  const [tier, costWindow, recalibrate] = await Promise.all([
    orca.storage.get(UI_TIER).catch(() => null),
    orca.storage.get(UI_COST_WINDOW).catch(() => null),
    orca.settings.get("recalibrateOnSync").catch(() => true),
  ]);
  if (TASK_TIERS.some((t) => t.id === tier)) state.tier = tier as TaskTier;
  if (COST_WINDOWS.some((w) => w.id === costWindow)) state.costWindow = costWindow as CostWindow;
  state.recalibrate = recalibrate !== false;
  void loadCosts();
  try {
    lastPushAt = Date.now();
    applySnapshot(await orca.plugin.request("quotamax.snapshot", {}));
  } catch (err) {
    state.fetchError = errorText(err);
    render();
  }
  // Keeps "updated Xs ago" and the live dot current, as the Paseo panel does every 15s.
  setInterval(render, 15_000);
}

void start();
