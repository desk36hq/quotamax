import { execFile } from "node:child_process";
import { z } from "zod";
import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";

const CLI_TIMEOUT_MS = 20_000;

export const alibabaInputSchema = z.object({ account: z.literal("default") }).strict();
export type AlibabaUsageInput = z.infer<typeof alibabaInputSchema>;

// The plan API key (sk-sp-...) cannot read quota for this account: the console RPC
// answers ConsoleNeedLogin on every host. Quota is therefore read through a vendor
// CLI that holds a console login, tried in order; the first logged-in one wins.
// shortcut: one account key, so a second login or region would need its own key.
type Run = (args: string[]) => Promise<{ json: string; code: number }>;

interface Transport {
  bin: string;
  /** Remedy Paseo shows when this CLI is installed but not logged in. */
  login: string;
  statusArgs: string[];
  loggedIn: (status: Record<string, unknown>) => boolean;
  /** An exit or error code that means "log in again" rather than a fault. */
  isAuthError: (exitCode: number, code: string) => boolean;
  read: (run: Run) => Promise<UsageReport>;
}

class CliMissingError extends Error {}

// A CLI prints a JSON envelope and then exits with its status, so a non-zero exit
// with parseable output is a result, not a failure. Success JSON goes to stdout,
// but the error envelope goes to stderr — accept either.
function runCli(bin: string, args: string[]): Promise<{ json: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { encoding: "utf8", timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const json = stdout.trim() || stderr.trim();
        if (!json) {
          if ((err as { code?: string | number } | null)?.code === "ENOENT") {
            return reject(new CliMissingError(`${bin} is not installed`));
          }
          return reject(err ?? new Error(`${bin} produced no output`));
        }
        resolve({ json, code: err ? Number((err as { code?: string | number }).code) || 1 : 0 });
      },
    );
  });
}

const ErrorEnvelopeSchema = z
  .object({ error: z.object({ code: z.unknown().optional(), message: z.string().optional() }).passthrough() })
  .passthrough();

// A missing login is a state, not a fault: "unavailable" is what makes Paseo render the remedy.
function rejected(login: string): UsageReport {
  return unavailable({ kind: "rejected", status: 401, refreshedBy: login });
}

/** Handles a CLI's error envelope; null when `payload` is a normal result. */
function errorReport(payload: unknown, exitCode: number, t: Transport): UsageReport | null {
  const envelope = ErrorEnvelopeSchema.safeParse(payload);
  if (!envelope.success) return null;
  const { code, message } = envelope.data.error;
  if (t.isAuthError(exitCode, String(code ?? ""))) return rejected(t.login);
  throw new Error(message || `${t.bin} exited with ${exitCode}`);
}

// Window ids match the quota-advisor catalog (weeklyWindowId / shortWindowId), so
// the sidebar picks the pool up with no further wiring.
const FIVE_HOUR = { id: "five_hour", label: "5-hour", shortLabel: "5h" } as const;
const WEEKLY = { id: "weekly", label: "Weekly", shortLabel: "wk" } as const;
const MONTHLY = { id: "monthly", label: "Monthly", shortLabel: "mo" } as const;

function isoFromMs(ms: unknown): string | null {
  return typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null;
}

function pctWindow(
  spec: { id: string; label: string; shortLabel: string },
  usedPct: number,
  resetsAt: string | null,
  durationSeconds?: number,
): UsageWindow {
  const utilizationPct = Math.max(0, Math.min(100, usedPct));
  return windowFromUsedPct({
    ...spec,
    summary: true,
    utilizationPct,
    durationSeconds,
    resetsAt,
    tone: toneFromUsedPct(utilizationPct),
  });
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
  // This plan lives in the Singapore region, which `bl` only reads when signed in
  // to the international console site.
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

// Coding Plan: request-count windows, or {} when the account has none.
const BailianWindowSchema = z
  .object({
    usedQuota: z.number().nullish(),
    totalQuota: z.number().nullish(),
    /** used / total in [0, 1]; absent when the window has no positive total. */
    percentage: z.number().nullish(),
    /** Epoch milliseconds. */
    resetTime: z.number().nullish(),
  })
  .passthrough();
const BailianUsageSchema = z
  .object({
    instanceType: z.string().nullish(),
    per5Hour: BailianWindowSchema.nullish(),
    perWeek: BailianWindowSchema.nullish(),
  })
  .passthrough();

/** A window only has a quota with a positive total and a used value. */
function codingPlanWindow(
  spec: { id: string; label: string; shortLabel: string },
  w: z.infer<typeof BailianWindowSchema> | null | undefined,
  durationSeconds: number,
): UsageWindow | null {
  if (!w) return null;
  const usedPct =
    w.percentage != null
      ? w.percentage * 100
      : w.usedQuota != null && w.totalQuota
        ? (w.usedQuota / w.totalQuota) * 100
        : NaN;
  if (!Number.isFinite(usedPct)) return null;
  return pctWindow(spec, usedPct, isoFromMs(w.resetTime), durationSeconds);
}

function bailianCodingPlan(payload: unknown, exitCode: number): UsageReport {
  const error = errorReport(payload, exitCode, BAILIAN);
  if (error) return error;
  const usage = BailianUsageSchema.parse(payload);
  const windows = [
    codingPlanWindow(FIVE_HOUR, usage.per5Hour, 18_000),
    codingPlanWindow(WEEKLY, usage.perWeek, 604_800),
  ].filter((w): w is UsageWindow => w != null);
  if (!windows.length) {
    return unavailable({ kind: "no_quota", detail: "No active Coding Plan on this Alibaba Cloud login" });
  }
  return {
    status: "available",
    planLabel: usage.instanceType ? `Coding Plan (${usage.instanceType})` : "Coding Plan",
    windows,
    balances: [],
    details: [],
  };
}

// Token Plan: the CLI keeps the API's per<N><Unit>Percentage / …ResetTime fields
// as-is. Personal plans are metered monthly, so only per1Month is returned.
const TokenPlanUsageSchema = z.record(z.string(), z.union([z.number(), z.boolean()]));

function tokenPlanWindow(
  spec: { id: string; label: string; shortLabel: string },
  key: string,
  usage: Record<string, number | boolean>,
  durationSeconds?: number,
): UsageWindow | null {
  // Despite the name, the API reports a 0..1 ratio: the CLI's own renderer shows it × 100.
  const ratio = usage[`${key}Percentage`];
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
  const resetsAt = isoFromMs(usage[`${key}ResetTime`]);
  return pctWindow(spec, ratio * 100, resetsAt, durationSeconds ?? (resetsAt ? monthCycleSeconds(new Date(resetsAt)) : undefined));
}

function bailianTokenPlan(payload: unknown, exitCode: number): UsageReport {
  const error = errorReport(payload, exitCode, BAILIAN);
  if (error) return error;
  const usage = TokenPlanUsageSchema.parse(payload);
  const windows = [
    tokenPlanWindow(FIVE_HOUR, "per5Hour", usage, 18_000),
    tokenPlanWindow(WEEKLY, "per1Week", usage, 604_800),
    tokenPlanWindow(MONTHLY, "per1Month", usage),
  ].filter((w): w is UsageWindow => w != null);
  if (!windows.length) {
    return unavailable({ kind: "no_quota", detail: "No Coding Plan or Token Plan on this Alibaba Cloud login" });
  }
  return { status: "available", planLabel: "Token Plan", windows, balances: [], details: [] };
}

// ── QwenCloud CLI (`qwencloud`): fallback for a plan on a QwenCloud login ──
// Shapes are the CLI's published types (CodingPlanWindow); unchanged 1.3 → 1.7.
// It has no refresh flow: our login expired within ~3 months and needed re-running.
const QwencloudWindowSchema = z
  .object({
    total: z.number().positive().nullish(),
    remaining: z.number().nullish(),
    used_pct: z.number().nullish(),
    next_reset_at: z.string().nullish(),
  })
  .passthrough();
const QwencloudPlanSchema = z
  .object({
    subscribed: z.boolean().nullish(),
    plan: z.string().nullish(),
    windows: z.record(z.string(), QwencloudWindowSchema).nullish(),
  })
  .passthrough();
const QwencloudSummarySchema = z.object({ coding_plan: QwencloudPlanSchema.nullish() }).passthrough();

function qwencloudReport(payload: unknown, exitCode: number): UsageReport {
  const error = errorReport(payload, exitCode, QWENCLOUD);
  if (error) return error;
  const plan = QwencloudSummarySchema.parse(payload).coding_plan;
  if (!plan?.subscribed) {
    return unavailable({ kind: "no_quota", detail: "No Alibaba coding plan on this QwenCloud account" });
  }
  const windows: UsageWindow[] = [];
  for (const [s, key, durationSeconds] of [
    [FIVE_HOUR, "per_5h", 18_000],
    [WEEKLY, "weekly", 604_800],
  ] as const) {
    const w = plan.windows?.[key];
    if (!w || !w.total) continue;
    // Prefer the CLI's own percentage; derive it only if the CLI omitted it.
    const usedPct =
      w.used_pct ?? Math.max(0, Math.min(100, ((w.total - (w.remaining ?? 0)) / w.total) * 100));
    windows.push(pctWindow(s, usedPct, w.next_reset_at ?? null, durationSeconds));
  }
  if (!windows.length) {
    return unavailable({ kind: "no_quota", detail: "Coding plan reports no usage windows yet" });
  }
  return {
    status: "available",
    planLabel: plan.plan ? `Coding Plan (${plan.plan})` : "Coding Plan",
    windows,
    balances: [],
    details: [],
  };
}

const QWENCLOUD: Transport = {
  bin: "qwencloud",
  login: "qwencloud auth login",
  statusArgs: ["auth", "status", "--format", "json"],
  loggedIn: (s) => s.authenticated === true,
  isAuthError: (exitCode, code) => exitCode === 2 || /AUTH|TOKEN/i.test(code),
  async read(run) {
    const summary = await run(["usage", "summary", "--format", "json"]);
    return qwencloudReport(JSON.parse(summary.json), summary.code);
  },
};

const TRANSPORTS: readonly Transport[] = [BAILIAN, QWENCLOUD];

export async function fetchAlibabaUsage(_input: AlibabaUsageInput): Promise<UsageReport> {
  let installed: Transport | undefined;
  for (const t of TRANSPORTS) {
    let status: unknown;
    try {
      status = JSON.parse((await runCli(t.bin, t.statusArgs)).json);
    } catch (err) {
      if (err instanceof CliMissingError) continue;
      throw err;
    }
    installed ??= t;
    if (!t.loggedIn(status as Record<string, unknown>)) continue;
    return t.read((args) => runCli(t.bin, args));
  }
  if (!installed) throw new Error("Neither `bl` nor `qwencloud` is installed");
  return rejected(installed.login);
}

export async function discoverAlibaba(): Promise<UsageAccount[]> {
  // Report the account whenever a CLI is installed, regardless of login state: the
  // registry only lists discovered accounts, so hiding a logged-out CLI would make
  // Alibaba silently vanish instead of showing the re-login remedy.
  for (const t of TRANSPORTS) {
    try {
      await runCli(t.bin, t.statusArgs);
    } catch (err) {
      if (err instanceof CliMissingError) continue;
    }
    return [{ key: "default", harness: "pi", provider: "pi", input: { account: "default" } }];
  }
  return [];
}
