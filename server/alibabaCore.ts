// Alibaba Cloud quota, read through a vendor CLI. Host-neutral: no zod and no Paseo SDK,
// so Orca can load it as-is. Paseo wraps it as a usage source (alibabaUsage.ts); Orca
// calls it from its quota adapter (orca/orcaQuotaSource.ts).
import { findOnPath, type ExecFn } from "./exec";

const CLI_TIMEOUT_MS = 20_000;

export interface AlibabaWindow {
  id: "five_hour" | "weekly" | "monthly";
  label: string;
  shortLabel: string;
  /** Clamped to 0..100. */
  usedPct: number;
  resetsAt: string | null;
  durationSeconds?: number;
}

export type AlibabaProblem =
  | { kind: "rejected"; status: 401; refreshedBy: string }
  | { kind: "no_quota"; detail: string };

export type AlibabaResult =
  | { status: "available"; planLabel: string; windows: AlibabaWindow[] }
  | { status: "unavailable"; problem: AlibabaProblem };

// Model API keys alone cannot read subscription quota from the console RPC.
// Quota is therefore read through a vendor CLI that holds a console login,
// tried in order; the first logged-in one wins.
type Run = (args: string[]) => Promise<{ json: string; code: number }>;

interface Transport {
  bin: string;
  /** The remedy shown when this CLI is installed but not logged in. */
  login: string;
  statusArgs: string[];
  loggedIn: (status: Record<string, unknown>) => boolean;
  /** An exit or error code that means "log in again" rather than a fault. */
  isAuthError: (exitCode: number, code: string) => boolean;
  read: (run: Run) => Promise<AlibabaResult>;
}

class CliMissingError extends Error {}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Handle CLIs that emit a leading warning/update line before the JSON payload.
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const candidate = lines[i]!.trim();
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        // Keep scanning upward
      }
    }
    return trimmed;
  }
}

// A CLI prints a JSON envelope and then exits with its status, so a non-zero exit
// with parseable output is a result, not a failure. Success JSON goes to stdout,
// but the error envelope goes to stderr — accept either.
async function runCli(exec: ExecFn, bin: string, args: string[]): Promise<{ json: string; code: number }> {
  // Checked up front: on Windows a missing CLI run through cmd.exe exits 1 with a
  // localized message instead of failing with ENOENT.
  if (!findOnPath(bin)) throw new CliMissingError(`${bin} is not installed`);
  try {
    const { stdout, stderr } = await exec(bin, args, {
      encoding: "utf8",
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const json = extractJsonText(stdout) || extractJsonText(stderr);
    if (!json) throw new Error(`${bin} produced no output`);
    return { json, code: 0 };
  } catch (err) {
    const e = err as { code?: string | number; stdout?: string; stderr?: string };
    const json = extractJsonText(e?.stdout ?? "") || extractJsonText(e?.stderr ?? "");
    if (!json) {
      if (e?.code === "ENOENT") {
        throw new CliMissingError(`${bin} is not installed`);
      }
      throw err instanceof Error ? err : new Error(`${bin} failed`);
    }
    return { json, code: Number(e?.code) || 1 };
  }
}

// ── Output validation (replaces the former zod schemas; same acceptance rules) ──

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function unexpected(bin: string, what: string): never {
  throw new Error(`Unexpected ${bin} output: ${what}`);
}

/** `number | null | undefined`, else throws (zod `.nullish()` semantics). */
function optNum(bin: string, v: unknown, field: string, positive = false): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || Number.isNaN(v)) unexpected(bin, `${field} is not a number`);
  if (positive && v <= 0) unexpected(bin, `${field} is not positive`);
  return v;
}

function optStr(bin: string, v: unknown, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") unexpected(bin, `${field} is not a string`);
  return v;
}

function optObj(bin: string, v: unknown, field: string): Obj | null {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) unexpected(bin, `${field} is not an object`);
  return v;
}

// A missing login is a state, not a fault: "unavailable" is what makes the host show the remedy.
function rejected(login: string): AlibabaResult {
  return { status: "unavailable", problem: { kind: "rejected", status: 401, refreshedBy: login } };
}

function noQuota(detail: string): AlibabaResult {
  return { status: "unavailable", problem: { kind: "no_quota", detail } };
}

/** Handles a CLI's error envelope; null when `payload` is a normal result. */
function errorReport(payload: unknown, exitCode: number, t: Transport): AlibabaResult | null {
  if (!isObj(payload) || !isObj(payload.error)) return null;
  const { code, message } = payload.error;
  if (t.isAuthError(exitCode, String(code ?? ""))) return rejected(t.login);
  throw new Error((typeof message === "string" && message) || `${t.bin} exited with ${exitCode}`);
}

// Window ids match the catalog's pool windows (weeklyWindowId / shortWindowId).
const FIVE_HOUR = { id: "five_hour", label: "5-hour", shortLabel: "5h" } as const;
const WEEKLY = { id: "weekly", label: "Weekly", shortLabel: "wk" } as const;
const MONTHLY = { id: "monthly", label: "Monthly", shortLabel: "mo" } as const;
type WindowSpec = typeof FIVE_HOUR | typeof WEEKLY | typeof MONTHLY;

function isoFromMs(ms: unknown): string | null {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null;
}

function pctWindow(
  spec: WindowSpec,
  usedPct: number,
  resetsAt: string | null,
  durationSeconds?: number
): AlibabaWindow {
  return {
    ...spec,
    usedPct: Math.max(0, Math.min(100, usedPct)),
    resetsAt,
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

/** A monthly quota resets on the same day each month; its cycle is the month before that. */
function monthCycleSeconds(reset: Date): number {
  const start = new Date(reset);
  const previousMonth = start.getUTCMonth() - 1;
  start.setUTCMonth(previousMonth);
  if (start.getUTCMonth() !== (previousMonth + 12) % 12) start.setUTCDate(0); // the 31st in a short month
  return (reset.getTime() - start.getTime()) / 1000;
}

// ── Alibaba Cloud Model Studio CLI (`bl`): the documented tool for these plans ──
// Output shapes are the CLI's own source (commands/usage/*.ts). It refreshes a
// console session by itself only when an AccessKey pair is configured.
const BAILIAN: Transport = {
  bin: "bl",
  // International console accounts require `--console-site international`;
  // domestic China accounts can omit the flag.
  login: "bl auth login --console --console-site international",
  statusArgs: ["auth", "status", "--output", "json"],
  // `bl usage *` needs a console session: a console token, or an AccessKey pair it
  // mints and refreshes one from. A model API key alone (it picks up
  // DASHSCOPE_API_KEY) also counts as "authenticated" but cannot read quota.
  loggedIn: (s) => s.authenticated === true && !!(s.console || s.openapi),
  isAuthError: (exitCode) => exitCode === 3,
  async read(run) {
    const coding = await run(["usage", "coding-plan", "--output", "json"]);
    const plan = bailianCodingPlan(JSON.parse(coding.json), coding.code);
    // No Coding Plan on this login: personal Token Plans are metered monthly instead.
    if (plan.status !== "unavailable" || plan.problem.kind !== "no_quota") return plan;
    const token = await run(["usage", "token-plan", "--output", "json"]);
    return bailianTokenPlan(JSON.parse(token.json), token.code);
  },
};

/** Coding Plan window: request counts, or {} when the account has none. */
function codingPlanWindow(spec: WindowSpec, raw: unknown, field: string, durationSeconds: number): AlibabaWindow | null {
  const w = optObj("bl", raw, field);
  if (!w) return null;
  const usedQuota = optNum("bl", w.usedQuota, `${field}.usedQuota`);
  const totalQuota = optNum("bl", w.totalQuota, `${field}.totalQuota`);
  /** used / total in [0, 1]; absent when the window has no positive total. */
  const percentage = optNum("bl", w.percentage, `${field}.percentage`);
  /** Epoch milliseconds. */
  const resetTime = optNum("bl", w.resetTime, `${field}.resetTime`);
  const usedPct =
    percentage != null
      ? percentage * 100
      : usedQuota != null && totalQuota
        ? (usedQuota / totalQuota) * 100
        : NaN;
  if (!Number.isFinite(usedPct)) return null;
  return pctWindow(spec, usedPct, isoFromMs(resetTime), durationSeconds);
}

function bailianCodingPlan(payload: unknown, exitCode: number): AlibabaResult {
  const error = errorReport(payload, exitCode, BAILIAN);
  if (error) return error;
  if (!isObj(payload)) unexpected("bl", "coding-plan result is not an object");
  const instanceType = optStr("bl", payload.instanceType, "instanceType");
  const windows = [
    codingPlanWindow(FIVE_HOUR, payload.per5Hour, "per5Hour", 18_000),
    codingPlanWindow(WEEKLY, payload.perWeek, "perWeek", 604_800),
  ].filter((w): w is AlibabaWindow => w != null);
  if (!windows.length) return noQuota("No active Coding Plan on this Alibaba Cloud login");
  return {
    status: "available",
    planLabel: instanceType ? `Coding Plan (${instanceType})` : "Coding Plan",
    windows,
  };
}

// Token Plan: the CLI keeps the API's per<N><Unit>Percentage / …ResetTime fields
// as-is. Personal plans are metered monthly, so only per1Month is returned.
function tokenPlanWindow(
  spec: WindowSpec,
  key: string,
  usage: Record<string, number | boolean>,
  durationSeconds?: number
): AlibabaWindow | null {
  // Despite the name, the API reports a 0..1 ratio: the CLI's own renderer shows it × 100.
  const ratio = usage[`${key}Percentage`];
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
  const resetsAt = isoFromMs(usage[`${key}ResetTime`]);
  return pctWindow(
    spec,
    ratio * 100,
    resetsAt,
    durationSeconds ?? (resetsAt ? monthCycleSeconds(new Date(resetsAt)) : undefined)
  );
}

function bailianTokenPlan(payload: unknown, exitCode: number): AlibabaResult {
  const error = errorReport(payload, exitCode, BAILIAN);
  if (error) return error;
  if (!isObj(payload)) unexpected("bl", "token-plan result is not an object");
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v !== "number" && typeof v !== "boolean") unexpected("bl", `${k} is not a number or boolean`);
  }
  const usage = payload as Record<string, number | boolean>;
  const windows = [
    tokenPlanWindow(FIVE_HOUR, "per5Hour", usage, 18_000),
    tokenPlanWindow(WEEKLY, "per1Week", usage, 604_800),
    tokenPlanWindow(MONTHLY, "per1Month", usage),
  ].filter((w): w is AlibabaWindow => w != null);
  if (!windows.length) return noQuota("No Coding Plan or Token Plan on this Alibaba Cloud login");
  return { status: "available", planLabel: "Token Plan", windows };
}

// ── QwenCloud CLI (`qwencloud`): fallback for a plan on a QwenCloud login ──
// Shapes are the CLI's published types (CodingPlanWindow); unchanged 1.3 → 1.7.
// Console logins expire periodically and may require re-authenticating.
function qwencloudReport(payload: unknown, exitCode: number): AlibabaResult {
  const error = errorReport(payload, exitCode, QWENCLOUD);
  if (error) return error;
  if (!isObj(payload)) unexpected("qwencloud", "usage summary is not an object");
  const plan = optObj("qwencloud", payload.coding_plan, "coding_plan");
  if (plan && plan.subscribed !== undefined && plan.subscribed !== null && typeof plan.subscribed !== "boolean") {
    unexpected("qwencloud", "coding_plan.subscribed is not a boolean");
  }
  const planName = plan ? optStr("qwencloud", plan.plan, "coding_plan.plan") : null;
  const planWindows = plan ? optObj("qwencloud", plan.windows, "coding_plan.windows") : null;
  // Every window is validated, as before, even the ones QuotaMax does not read.
  const parsed: Record<string, { total: number | null; remaining: number | null; used_pct: number | null; next_reset_at: string | null }> = {};
  for (const [key, raw] of Object.entries(planWindows ?? {})) {
    if (!isObj(raw)) unexpected("qwencloud", `windows.${key} is not an object`);
    const w = raw;
    parsed[key] = {
      total: optNum("qwencloud", w.total, `windows.${key}.total`, true),
      remaining: optNum("qwencloud", w.remaining, `windows.${key}.remaining`),
      used_pct: optNum("qwencloud", w.used_pct, `windows.${key}.used_pct`),
      next_reset_at: optStr("qwencloud", w.next_reset_at, `windows.${key}.next_reset_at`),
    };
  }
  if (!plan?.subscribed) return noQuota("No Alibaba coding plan on this QwenCloud account");
  const windows: AlibabaWindow[] = [];
  for (const [s, key, durationSeconds] of [
    [FIVE_HOUR, "per_5h", 18_000],
    [WEEKLY, "weekly", 604_800],
  ] as const) {
    const w = parsed[key];
    if (!w || !w.total) continue;
    // Prefer the CLI's own percentage; derive it only if the CLI omitted it.
    const usedPct =
      w.used_pct ?? Math.max(0, Math.min(100, ((w.total - (w.remaining ?? 0)) / w.total) * 100));
    windows.push(pctWindow(s, usedPct, w.next_reset_at ?? null, durationSeconds));
  }
  if (!windows.length) return noQuota("Coding plan reports no usage windows yet");
  return {
    status: "available",
    planLabel: planName ? `Coding Plan (${planName})` : "Coding Plan",
    windows,
  };
}

const QWENCLOUD_AUTH_ERROR_RE = /^(?:TOKEN_EXPIRED|INVALID_TOKEN|UNAUTHORIZED|UNAUTHENTICATED|AUTH_FAILED|AUTH_REQUIRED|NOT_AUTHENTICATED)$/i;

const QWENCLOUD: Transport = {
  bin: "qwencloud",
  login: "qwencloud auth login",
  statusArgs: ["auth", "status", "--format", "json"],
  loggedIn: (s) => s.authenticated === true,
  isAuthError: (exitCode, code) => exitCode === 2 || QWENCLOUD_AUTH_ERROR_RE.test(code),
  async read(run) {
    const summary = await run(["usage", "summary", "--format", "json"]);
    return qwencloudReport(JSON.parse(summary.json), summary.code);
  },
};

const TRANSPORTS: readonly Transport[] = [BAILIAN, QWENCLOUD];

/** Reads the plan's quota through the first logged-in CLI; throws when none is installed. */
export async function readAlibabaQuota(exec: ExecFn): Promise<AlibabaResult> {
  let installed: Transport | undefined;
  let lastError: unknown = null;
  for (const t of TRANSPORTS) {
    let status: unknown;
    try {
      status = JSON.parse((await runCli(exec, t.bin, t.statusArgs)).json);
    } catch (err) {
      if (err instanceof CliMissingError) continue;
      lastError = err;
      continue;
    }
    installed ??= t;
    if (!t.loggedIn(status as Record<string, unknown>)) continue;
    return t.read((args) => runCli(exec, t.bin, args));
  }
  if (installed) return rejected(installed.login);
  if (lastError) throw lastError;
  throw new Error("Neither `bl` nor `qwencloud` is installed");
}

/**
 * Whether either CLI is installed, regardless of login state: a logged-out CLI still
 * counts, so the re-login remedy stays visible instead of Alibaba silently vanishing.
 */
export async function alibabaCliInstalled(exec: ExecFn): Promise<boolean> {
  for (const t of TRANSPORTS) {
    try {
      await runCli(exec, t.bin, t.statusArgs);
    } catch (err) {
      if (err instanceof CliMissingError) continue;
    }
    return true;
  }
  return false;
}
