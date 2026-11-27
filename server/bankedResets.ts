/**
 * Banked Resets store + read-only API auto-detection (host-neutral, zero external deps).
 *
 * Combines:
 *  1. Live read-only API detection for providers that expose banked reset credits:
 *     - Codex: `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
 *       (using local `~/.codex/auth.json` OAuth token)
 *     - Claude: `GET https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1`
 *       (using local `~/.claude/.credentials.json` OAuth token; skipped on macOS Keychain)
 *  2. Friction-free manual banked-reset planner persisted atomically to
 *     `${dataDir}/banked-resets.json`, rendered identically to API-backed resets.
 *
 * Security: OAuth tokens are read only for read-only GET requests to hard-coded
 * first-party HTTPS endpoints and are never logged, stored, or sent to the UI.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AddBankedResetInput,
  BankedResetEntry,
  BankedResetKind,
  ResetAdvice,
  WindowStats,
} from "../shared/types";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1";
const CODEX_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const API_CACHE_TTL_MS = 5 * 60_000;
const API_TIMEOUT_MS = 8_000;

interface StoredManualReset {
  id: string;
  pool: string;
  kind: BankedResetKind;
  count: number;
  expiresAt: string | null;
  note?: string;
  createdAt: string;
}

const VALID_KINDS = new Set<string>(["5h", "weekly", "full", "fable"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function expandHome(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function remainingHoursFromIso(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Number(Math.max(0, (ms - nowMs) / 3_600_000).toFixed(2));
}

function kindLabel(kind: BankedResetKind): string {
  switch (kind) {
    case "5h":
      return "5-hour reset";
    case "weekly":
      return "Weekly reset";
    case "fable":
      return "Fable reset";
    case "full":
      return "Full reset";
  }
}

function formatShortDuration(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return "";
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

// ---------------------------------------------------------------------------
// 1. Pure parsers for Claude (cedar_ember) & Codex (rate-limit-reset-credits)
// ---------------------------------------------------------------------------

export function parseClaudeResetCredits(body: unknown, nowMs: number): BankedResetEntry[] {
  if (!isObj(body) || !isObj(body.cedar_ember)) return [];
  const block = body.cedar_ember;
  if (block.eligible !== true || !Array.isArray(block.grants)) return [];

  const grouped = new Map<BankedResetKind, { count: number; earliestExpMs: number | null; earliestExpIso: string | null }>();

  for (const raw of block.grants) {
    if (!isObj(raw)) continue;
    if (raw.paused === true || raw.usable_now === false) continue;
    const left = typeof raw.resets_left === "number" && Number.isInteger(raw.resets_left) ? raw.resets_left : 0;
    if (left <= 0) continue;

    let expIso: string | null = null;
    let expMs: number | null = null;
    if (typeof raw.ends_at === "string" && raw.ends_at.trim()) {
      const parsed = Date.parse(raw.ends_at);
      if (!Number.isFinite(parsed) || parsed <= nowMs) continue;
      expMs = parsed;
      expIso = new Date(parsed).toISOString();
    }

    let kind: BankedResetKind = "full";
    if (raw.gives_back_weekly === true) {
      kind = "fable";
    } else if (raw.type === "session") {
      kind = "5h";
    } else if (raw.type === "weekly") {
      kind = "weekly";
    } else if (raw.type === "full") {
      kind = "full";
    } else if (Array.isArray(raw.clears)) {
      const hasSession = raw.clears.includes("five_hour");
      const hasOther = raw.clears.some((c) => c !== "five_hour");
      kind = hasSession && !hasOther ? "5h" : hasOther && !hasSession ? "weekly" : "full";
    }

    const prev = grouped.get(kind);
    if (!prev) {
      grouped.set(kind, { count: left, earliestExpMs: expMs, earliestExpIso: expIso });
    } else {
      const nextExpMs =
        prev.earliestExpMs === null
          ? expMs
          : expMs === null
            ? prev.earliestExpMs
            : Math.min(prev.earliestExpMs, expMs);
      grouped.set(kind, {
        count: prev.count + left,
        earliestExpMs: nextExpMs,
        earliestExpIso: nextExpMs === prev.earliestExpMs ? prev.earliestExpIso : expIso,
      });
    }
  }

  const out: BankedResetEntry[] = [];
  for (const [kind, info] of grouped) {
    out.push({
      id: `api:claude:${kind}`,
      pool: "claude",
      kind,
      count: info.count,
      expiresAt: info.earliestExpIso,
      remainingHours: remainingHoursFromIso(info.earliestExpIso, nowMs),
      source: "api",
      label: kindLabel(kind),
    });
  }
  return out;
}

export function parseCodexResetCredits(body: unknown, nowMs: number): BankedResetEntry[] {
  if (!isObj(body) || !Array.isArray(body.credits)) return [];

  const grouped = new Map<BankedResetKind, { count: number; earliestExpMs: number | null; earliestExpIso: string | null }>();

  for (const raw of body.credits) {
    if (!isObj(raw)) continue;
    if (raw.status !== "available") continue;

    let expIso: string | null = null;
    let expMs: number | null = null;
    if (typeof raw.expires_at === "string" && raw.expires_at.trim()) {
      const parsed = Date.parse(raw.expires_at);
      if (Number.isFinite(parsed)) {
        if (parsed <= nowMs) continue;
        expMs = parsed;
        expIso = new Date(parsed).toISOString();
      }
    } else if (typeof raw.expires_at === "number" && Number.isFinite(raw.expires_at)) {
      const ms = raw.expires_at > 1e12 ? raw.expires_at : raw.expires_at * 1000;
      if (ms <= nowMs) continue;
      expMs = ms;
      expIso = new Date(ms).toISOString();
    }

    const rt = typeof raw.reset_type === "string" ? raw.reset_type.toLowerCase() : "";
    const kind: BankedResetKind = rt.includes("5h") || rt.includes("session") || rt.includes("primary")
      ? "5h"
      : rt.includes("full") || rt.includes("all")
        ? "full"
        : "weekly";

    const prev = grouped.get(kind);
    if (!prev) {
      grouped.set(kind, { count: 1, earliestExpMs: expMs, earliestExpIso: expIso });
    } else {
      const nextExpMs =
        prev.earliestExpMs === null
          ? expMs
          : expMs === null
            ? prev.earliestExpMs
            : Math.min(prev.earliestExpMs, expMs);
      grouped.set(kind, {
        count: prev.count + 1,
        earliestExpMs: nextExpMs,
        earliestExpIso: nextExpMs === prev.earliestExpMs ? prev.earliestExpIso : expIso,
      });
    }
  }

  const out: BankedResetEntry[] = [];
  for (const [kind, info] of grouped) {
    out.push({
      id: `api:codex:${kind}`,
      pool: "codex",
      kind,
      count: info.count,
      expiresAt: info.earliestExpIso,
      remainingHours: remainingHoursFromIso(info.earliestExpIso, nowMs),
      source: "api",
      label: kindLabel(kind),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. Strategic Reset Advice calculator
// ---------------------------------------------------------------------------

export function computeResetAdvice(
  resets: readonly BankedResetEntry[],
  weekly: WindowStats | null,
  short: WindowStats | null,
  fableWindow: WindowStats | null = null
): { advice: ResetAdvice | null; forceHammer: boolean; urgencyBoost: number } {
  if (resets.length === 0) {
    return { advice: null, forceHammer: false, urgencyBoost: 0 };
  }

  // Pick the reset with the soonest expiry (or first if none have expiry)
  const sorted = [...resets].sort((a, b) => {
    const ah = a.remainingHours ?? Infinity;
    const bh = b.remainingHours ?? Infinity;
    return ah - bh;
  });
  const soonest = sorted[0]!;
  const totalCount = resets.reduce((sum, r) => sum + r.count, 0);

  const relevantWindow =
    soonest.kind === "5h"
      ? short ?? weekly
      : soonest.kind === "fable"
        ? fableWindow ?? weekly
        : weekly ?? short;

  const usedPct = relevantWindow?.usedPct ?? 0;
  const remainingPct = relevantWindow?.remainingPct ?? 100 - usedPct;
  const regularResetHrs = relevantWindow?.remainingHours ?? null;
  const expHrs = soonest.remainingHours;
  const expText = expHrs != null ? formatShortDuration(expHrs) : "";
  const kindWord = soonest.kind === "5h" ? "5h" : soonest.kind;

  // Case A: Pool is >= 85% used -> optimal moment to pop the banked reset!
  if (relevantWindow && usedPct >= 85) {
    return {
      advice: {
        action: "pop_now",
        severity: "urgent",
        headline: `Pop banked ${kindWord} reset now`,
        detail: `${usedPct.toFixed(0)}% used — trigger reset to refill to 100%${expText ? ` (exp ${expText})` : ""}`,
      },
      forceHammer: false,
      urgencyBoost: 0,
    };
  }

  // Case B: Reset expires soon (<= 48h, or before regular reset if <= 72h) and pool still has >= 15% left
  const expiresBeforeRegular =
    expHrs != null && regularResetHrs != null && expHrs < regularResetHrs && expHrs <= 72;
  if (expHrs != null && (expHrs <= 48 || expiresBeforeRegular) && remainingPct >= 15) {
    const urgent = expHrs <= 12;
    const boost = urgent ? 34 : expHrs <= 24 ? 28 : 22;
    return {
      advice: {
        action: "burn_before_expiry",
        severity: urgent ? "urgent" : "warning",
        headline: `Burn ${remainingPct.toFixed(0)}% before reset expires (${expText})`,
        detail: `Use remaining quota first, then pop your banked ${kindWord} reset for a fresh 100%`,
      },
      forceHammer: true,
      urgencyBoost: boost,
    };
  }

  // Case C: Banked reset available, no immediate urgency
  return {
    advice: {
      action: "hold",
      severity: "info",
      headline: `${totalCount} banked ${kindWord} ${totalCount === 1 ? "reset" : "resets"} ready`,
      detail: `Save until usage nears 85%+${expText ? ` · expires in ${expText}` : ""}`,
    },
    forceHammer: false,
    urgencyBoost: 0,
  };
}

// ---------------------------------------------------------------------------
// 3. BankedResetManager: manual persistence + cached read-only API detection
// ---------------------------------------------------------------------------

async function fetchJsonQuiet(url: string, headers: Record<string, string>): Promise<unknown | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchClaudeApiResets(nowMs: number): Promise<BankedResetEntry[]> {
  if (process.platform === "darwin") return [];
  const claudeDir = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? expandHome(process.env.CLAUDE_CONFIG_DIR.trim())
    : path.join(os.homedir(), ".claude");
  try {
    const raw = fs.readFileSync(path.join(claudeDir, ".credentials.json"), "utf8");
    const creds = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    const token = creds.claudeAiOauth?.accessToken?.trim();
    if (!token) return [];
    const json = await fetchJsonQuiet(CLAUDE_USAGE_URL, {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": "claude-cli/2.1.0 (external, cli)",
      accept: "application/json",
    });
    return parseClaudeResetCredits(json, nowMs);
  } catch {
    return [];
  }
}

async function fetchCodexApiResets(nowMs: number): Promise<BankedResetEntry[]> {
  const codexDir = process.env.CODEX_HOME?.trim()
    ? expandHome(process.env.CODEX_HOME.trim())
    : path.join(os.homedir(), ".codex");
  try {
    const raw = fs.readFileSync(path.join(codexDir, "auth.json"), "utf8");
    const auth = JSON.parse(raw) as {
      tokens?: { access_token?: string; account_id?: string };
    };
    const token = auth.tokens?.access_token?.trim();
    if (!token) return [];
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    const accountId = auth.tokens?.account_id?.trim();
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const json = await fetchJsonQuiet(CODEX_CREDITS_URL, headers);
    return parseCodexResetCredits(json, nowMs);
  } catch {
    return [];
  }
}

function writeFileAtomically(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export interface BankedResetManagerOptions {
  dataDir: string;
  /** Disable live API calls (used in unit tests). */
  disableApiFetch?: boolean;
}

export class BankedResetManager {
  private readonly filePath: string;
  private readonly disableApiFetch: boolean;
  private apiCache: { fetchedAtMs: number; entries: BankedResetEntry[] } | null = null;
  private apiInflight: Promise<BankedResetEntry[]> | null = null;

  constructor(options: BankedResetManagerOptions) {
    this.filePath = path.join(options.dataDir, "banked-resets.json");
    this.disableApiFetch = Boolean(options.disableApiFetch);
  }

  private readManualRaw(): StoredManualReset[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is StoredManualReset =>
          isObj(item) &&
          typeof item.id === "string" &&
          item.id.length > 0 &&
          typeof item.pool === "string" &&
          item.pool.length > 0 &&
          typeof item.kind === "string" &&
          VALID_KINDS.has(item.kind) &&
          typeof item.count === "number" &&
          Number.isInteger(item.count) &&
          item.count > 0
      );
    } catch {
      return [];
    }
  }

  private saveManualRaw(items: StoredManualReset[]): void {
    writeFileAtomically(this.filePath, JSON.stringify(items, null, 2) + "\n");
  }

  addManual(input: AddBankedResetInput, nowMs = Date.now()): StoredManualReset {
    const items = this.readManualRaw();
    const count =
      typeof input.count === "number" && Number.isInteger(input.count) && input.count > 0
        ? Math.min(99, input.count)
        : 1;
    let expiresAt: string | null = null;
    if (typeof input.expiresAt === "string" && input.expiresAt.trim()) {
      const parsed = Date.parse(input.expiresAt);
      if (Number.isFinite(parsed)) {
        expiresAt = new Date(parsed).toISOString();
      }
    }
    const entry: StoredManualReset = {
      id: `manual:${crypto.randomBytes(6).toString("hex")}`,
      pool: input.pool.trim(),
      kind: VALID_KINDS.has(input.kind) ? input.kind : "weekly",
      count,
      expiresAt,
      ...(input.note?.trim() ? { note: input.note.trim().slice(0, 160) } : {}),
      createdAt: new Date(nowMs).toISOString(),
    };
    items.push(entry);
    this.saveManualRaw(items);
    return entry;
  }

  consumeManual(id: string, amount = 1): boolean {
    const items = this.readManualRaw();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    const dec = Math.max(1, Math.floor(amount));
    if (items[idx]!.count <= dec) {
      items.splice(idx, 1);
    } else {
      items[idx] = { ...items[idx]!, count: items[idx]!.count - dec };
    }
    this.saveManualRaw(items);
    return true;
  }

  deleteManual(id: string): boolean {
    const items = this.readManualRaw();
    const next = items.filter((i) => i.id !== id);
    if (next.length === items.length) return false;
    this.saveManualRaw(next);
    return true;
  }

  private async readApiResets(refresh: boolean, nowMs: number): Promise<BankedResetEntry[]> {
    if (this.disableApiFetch) return [];
    if (!refresh && this.apiCache && nowMs - this.apiCache.fetchedAtMs < API_CACHE_TTL_MS) {
      // Recompute remainingHours relative to current nowMs
      return this.apiCache.entries
        .filter((e) => !e.expiresAt || Date.parse(e.expiresAt) > nowMs)
        .map((e) => ({ ...e, remainingHours: remainingHoursFromIso(e.expiresAt, nowMs) }));
    }
    if (this.apiInflight) return this.apiInflight;
    const run = Promise.all([fetchClaudeApiResets(nowMs), fetchCodexApiResets(nowMs)])
      .then(([claude, codex]) => {
        const entries = [...claude, ...codex];
        this.apiCache = { fetchedAtMs: nowMs, entries };
        return entries;
      })
      .catch(() => this.apiCache?.entries ?? [])
      .finally(() => {
        if (this.apiInflight === run) this.apiInflight = null;
      });
    this.apiInflight = run;
    return run;
  }

  async getByPool(refresh = false, nowMs = Date.now()): Promise<Map<string, BankedResetEntry[]>> {
    const apiEntries = await this.readApiResets(refresh, nowMs);
    const manualRaw = this.readManualRaw();
    const manualLive: BankedResetEntry[] = [];
    let pruned = false;

    for (const m of manualRaw) {
      if (m.expiresAt && Date.parse(m.expiresAt) <= nowMs) {
        pruned = true;
        continue;
      }
      manualLive.push({
        id: m.id,
        pool: m.pool,
        kind: m.kind,
        count: m.count,
        expiresAt: m.expiresAt,
        remainingHours: remainingHoursFromIso(m.expiresAt, nowMs),
        source: "manual",
        label: kindLabel(m.kind),
        ...(m.note ? { note: m.note } : {}),
      });
    }
    if (pruned) {
      this.saveManualRaw(manualRaw.filter((m) => !m.expiresAt || Date.parse(m.expiresAt) > nowMs));
    }

    const byPool = new Map<string, BankedResetEntry[]>();
    for (const entry of [...apiEntries, ...manualLive]) {
      const list = byPool.get(entry.pool) ?? [];
      list.push(entry);
      byPool.set(entry.pool, list);
    }
    for (const list of byPool.values()) {
      list.sort((a, b) => (a.remainingHours ?? Infinity) - (b.remainingHours ?? Infinity));
    }
    return byPool;
  }
}
