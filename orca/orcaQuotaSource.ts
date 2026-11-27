// Orca only: quota windows from Orca's own rate-limit tracking (`orca account list --json`,
// field `rateLimits`), converted to the report shape the shared advisor reads. Alibaba is
// not tracked by Orca, so its quota is read here through the shared Alibaba CLI reader.
import os from "node:os";
import path from "node:path";
import { alibabaCliInstalled, readAlibabaQuota } from "../server/alibabaCore";
import { findOnPath, nodeExec, type ExecFn } from "../server/exec";
import type { QuotaSource, UsageReportEntry, UsageWindowRaw } from "../server/quotaSource";

/** Orca's rate-limit keys → the catalog's source ids (see server/default-models.json pools). */
export const ORCA_SOURCE_IDS: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "codex",
  antigravity: "antigravity",
  zcode: "glm",
  kimi: "kimi",
  minimax: "minimax",
  grok: "grok",
  cursor: "cursor",
  opencodeGo: "opencode-go",
  muse: "muse",
};

interface OrcaWindow {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: number | null;
}

interface OrcaBucket extends OrcaWindow {
  name?: string;
  group?: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isWindow = (v: unknown): v is OrcaWindow =>
  isObj(v) && typeof v.usedPercent === "number" && Number.isFinite(v.usedPercent);

const DEFAULT_SECONDS: Record<string, number> = { five_hour: 18_000, weekly: 604_800 };

function toWindow(w: OrcaWindow, id: string, label: string): UsageWindowRaw {
  const usedPct = Math.max(0, Math.min(100, w.usedPercent ?? 0));
  const minutes = typeof w.windowMinutes === "number" && w.windowMinutes > 0 ? w.windowMinutes : null;
  const durationSeconds = minutes ? minutes * 60 : DEFAULT_SECONDS[id];
  return {
    id,
    label,
    usedPct,
    remainingPct: 100 - usedPct,
    ...(typeof w.resetsAt === "number" && w.resetsAt > 0
      ? { resetsAt: new Date(w.resetsAt).toISOString() }
      : {}),
    ...(durationSeconds ? { durationSeconds } : {}),
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Window ids follow Paseo's, so one catalog serves both hosts: `session` → five_hour,
 * `weekly`, `monthly`, and a model's own weekly limit (`fableWeekly`) →
 * `weekly_model_fable`, as Paseo names Claude's Fable limit.
 */
function standardWindows(limits: Obj): UsageWindowRaw[] {
  const out: UsageWindowRaw[] = [];
  for (const [key, value] of Object.entries(limits)) {
    if (!isWindow(value)) continue;
    if (key === "session") out.push(toWindow(value, "five_hour", "Session"));
    else if (key === "weekly") out.push(toWindow(value, "weekly", "Weekly"));
    else if (key === "monthly") out.push(toWindow(value, "monthly", "Monthly"));
    else {
      const model = /^([a-z0-9]+)Weekly$/i.exec(key)?.[1];
      if (model) out.push(toWindow(value, `weekly_model_${model.toLowerCase()}`, `Weekly · ${capitalize(model)}`));
    }
  }
  return out;
}

/**
 * Antigravity reports quota per model group. QuotaMax keeps Gemini apart from the
 * Claude & GPT ("3p") models, so each bucket goes to `gemini-*` or `3p-*` by its group
 * name; within one, the most-used bucket binds. Without buckets, the overall windows stand.
 */
function antigravityWindows(limits: Obj): UsageWindowRaw[] {
  const buckets = Array.isArray(limits.buckets) ? limits.buckets.filter(isWindow) : [];
  const picked = new Map<string, OrcaBucket>();
  for (const b of buckets as OrcaBucket[]) {
    const span = b.windowMinutes === 300 ? "5h" : b.windowMinutes === 10_080 ? "weekly" : null;
    if (!span) continue;
    const family = `${b.group ?? ""} ${b.name ?? ""}`.toLowerCase().includes("gemini") ? "gemini" : "3p";
    const id = `${family}-${span}`;
    const prev = picked.get(id);
    if (!prev || (b.usedPercent ?? 0) > (prev.usedPercent ?? 0)) picked.set(id, b);
  }
  if (picked.size === 0) return standardWindows(limits);
  const labels: Record<string, string> = {
    "gemini-5h": "Gemini 5h",
    "gemini-weekly": "Gemini weekly",
    "3p-5h": "Claude & GPT 5h",
    "3p-weekly": "Claude & GPT weekly",
  };
  return [...picked].map(([id, b]) => toWindow(b, id, labels[id] ?? id));
}

/** Converts Orca's `rateLimits` object into advisor reports. Pure, for tests. */
export function rateLimitsToReports(rateLimits: unknown): UsageReportEntry[] {
  if (!isObj(rateLimits)) return [];
  const reports: UsageReportEntry[] = [];
  for (const [key, sourceId] of Object.entries(ORCA_SOURCE_IDS)) {
    const limits = rateLimits[key];
    if (!isObj(limits)) continue;
    const ok = limits.status === "ok";
    const planType = typeof limits.planType === "string" ? limits.planType : null;
    const message = typeof limits.error === "string" && limits.error ? limits.error : undefined;
    reports.push({
      sourceId,
      report: {
        status: ok ? "available" : typeof limits.status === "string" ? limits.status : "unavailable",
        ...(planType ? { planLabel: capitalize(planType.replace(/_/g, " ")) } : {}),
        windows: ok ? (key === "antigravity" ? antigravityWindows(limits) : standardWindows(limits)) : [],
        ...(message ? { message } : {}),
      },
    });
  }
  return reports;
}

/**
 * The Orca CLI for this machine: ORCA_CLI_COMMAND when Orca sets it, else the CLI that
 * ships beside the running app, else one on PATH. On Linux the bare `orca` is usually
 * the GNOME screen reader, so only `orca-ide` is looked up there.
 */
export function resolveOrcaCli(
  env: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
  platform: NodeJS.Platform = process.platform
): string | null {
  const fromEnv = env.ORCA_CLI_COMMAND?.trim();
  if (fromEnv) {
    const found = findOnPath(fromEnv, env, platform);
    if (found) return found;
  }
  const appDir = path.dirname(execPath);
  const bundled =
    platform === "darwin"
      ? [path.join(appDir, "..", "Resources", "bin", "orca")]
      : platform === "win32"
        ? [path.join(appDir, "resources", "bin", "orca.exe"), path.join(appDir, "resources", "bin", "orca.cmd")]
        : [path.join(appDir, "resources", "bin", "orca-ide"), path.join(appDir, "resources", "bin", "orca")];
  for (const candidate of bundled) {
    const found = findOnPath(candidate, env, platform);
    if (found) return found;
  }
  return findOnPath(platform === "linux" ? "orca-ide" : "orca", env, platform);
}

/**
 * Orca starts plugin workers with a trimmed environment (on Windows: no APPDATA,
 * LOCALAPPDATA or HOME). CLIs keep their state in those folders, and the Orca CLI cannot
 * find the running app without them, so each CLI gets the standard locations back.
 */
export function cliEnv(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  if (platform === "win32") {
    out.USERPROFILE ??= home;
    out.APPDATA ??= path.join(home, "AppData", "Roaming");
    out.LOCALAPPDATA ??= path.join(home, "AppData", "Local");
  } else {
    out.HOME ??= home;
  }
  return out;
}

const ALIBABA_CACHE_MS = 5 * 60_000;

export function createOrcaQuotaSource(options: { exec?: ExecFn; cli?: string | null } = {}): QuotaSource {
  const baseExec = options.exec ?? nodeExec;
  const exec: ExecFn = (command, args, opts) => baseExec(command, args, { ...opts, env: cliEnv() });
  let alibaba: { at: number; entry: UsageReportEntry | null } | null = null;

  async function alibabaEntry(refresh: boolean): Promise<UsageReportEntry | null> {
    if (!refresh && alibaba && Date.now() - alibaba.at < ALIBABA_CACHE_MS) return alibaba.entry;
    // Orca doesn't track Alibaba; QuotaMax reads it here, so say what it needs when it can't.
    let entry: UsageReportEntry | null = {
      sourceId: "alibaba",
      report: { status: "unavailable", windows: [], message: "Needs the `bl` or `qwencloud` CLI, logged in" },
    };
    try {
      if (await alibabaCliInstalled(exec)) {
        const r = await readAlibabaQuota(exec);
        entry =
          r.status === "available"
            ? {
                sourceId: "alibaba",
                report: {
                  status: "available",
                  planLabel: r.planLabel,
                  windows: r.windows.map((w) => ({
                    id: w.id,
                    label: w.label,
                    usedPct: w.usedPct,
                    remainingPct: 100 - w.usedPct,
                    ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}),
                    ...(w.durationSeconds ? { durationSeconds: w.durationSeconds } : {}),
                  })),
                },
              }
            : {
                sourceId: "alibaba",
                report: {
                  status: "unavailable",
                  windows: [],
                  message:
                    r.problem.kind === "rejected"
                      ? `Not logged in — run \`${r.problem.refreshedBy}\``
                      : r.problem.detail,
                },
              };
      }
    } catch (err) {
      entry = {
        sourceId: "alibaba",
        report: { status: "error", windows: [], message: err instanceof Error ? err.message : String(err) },
      };
    }
    alibaba = { at: Date.now(), entry };
    return entry;
  }

  return {
    name: "Orca",
    displayName: "Orca rate limits",
    async fetch(refresh, signal) {
      const cli = options.cli === undefined ? resolveOrcaCli() : options.cli;
      if (!cli) throw new Error("Orca CLI not found (set ORCA_CLI_COMMAND to its path)");
      let stdout: string;
      try {
        ({ stdout } = await exec(cli, ["account", "list", "--json"], {
          encoding: "utf8",
          timeout: 20_000,
          maxBuffer: 10 * 1024 * 1024,
          signal,
        }));
      } catch (err) {
        // With --json the CLI prints its error envelope on stdout and exits non-zero.
        const e = err as { stdout?: string; stderr?: string; message?: string };
        stdout = e.stdout ?? "";
        if (!stdout.trim().startsWith("{")) {
          const detail = (e.stderr ?? "").trim().split(/\r?\n/)[0] || e.message || "failed";
          throw new Error(`orca account list: ${detail}`);
        }
      }
      type Envelope = { ok?: boolean; result?: { rateLimits?: unknown }; error?: { code?: string; message?: string } };
      const parsed = JSON.parse(stdout) as Envelope;
      if (parsed.ok === false) {
        const { code, message } = parsed.error ?? {};
        throw new Error(`orca account list: ${[code, message].filter(Boolean).join(" — ") || "failed"}`);
      }
      const reports = rateLimitsToReports(parsed.result?.rateLimits);
      const ali = await alibabaEntry(refresh);
      if (ali) reports.push(ali);
      return reports;
    },
  };
}
