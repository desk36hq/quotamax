/**
 * Official Antigravity CLI (`agy -p /usage`) usage source for Paseo 0.18+.
 *
 * Runs only the official `agy` binary (never touches OAuth tokens or undocumented
 * endpoints). Caches results for 5 minutes so daemon polls don't spawn `agy`
 * unnecessarily.
 */

import { execCommand } from "@getpaseo/plugin/server";
import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
  type UsageWindow,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { findOnPath } from "./exec";

const CLI_TIMEOUT_MS = 25_000;
const CACHE_TTL_MS = 5 * 60_000;

export const antigravityInputSchema = z.object({ account: z.literal("default") }).strict();
export type AntigravityUsageInput = z.infer<typeof antigravityInputSchema>;

interface ParsedWindowSpec {
  id: string;
  label: string;
  shortLabel: string;
  remainingPct: number;
  resetsAt: string | null;
  durationSeconds: number;
}

/**
 * Parses the tab-separated output of `agy -p /usage`:
 *   Gemini Models\tWeekly Limit Remaining\t80%\t2026-12-03T08:16:32Z
 *   Gemini Models\tFive Hour Limit Remaining\t76%\t2026-11-27T22:21:57Z
 *   Claude and GPT models\tWeekly Limit Remaining\t97%\t2026-12-04T09:15:08Z
 *   Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z
 */
export function parseAgyUsageOutput(stdout: string): UsageWindow[] {
  const specs: ParsedWindowSpec[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split("\t").map((c) => c.trim());
    if (cols.length < 3) continue;

    const familyRaw = cols[0]!.toLowerCase();
    const windowRaw = cols[1]!.toLowerCase();
    const pctMatch = /(\d+(?:\.\d+)?)\s*%/.exec(cols[2]!);
    if (!pctMatch) continue;
    const pct = Number(pctMatch[1]);
    if (!Number.isFinite(pct)) continue;

    const isGemini = familyRaw.includes("gemini");
    const is3p = familyRaw.includes("claude") || familyRaw.includes("gpt") || familyRaw.includes("3p");
    if (!isGemini && !is3p) continue;

    const isFiveHour = windowRaw.includes("five hour") || windowRaw.includes("5h") || windowRaw.includes("5-hour");
    const isWeekly = windowRaw.includes("weekly") || windowRaw.includes("week");
    if (!isFiveHour && !isWeekly) continue;

    const isRemaining = windowRaw.includes("remaining") || windowRaw.includes("left");
    const remainingPct = Math.max(0, Math.min(100, isRemaining ? pct : 100 - pct));

    let resetsAt: string | null = null;
    if (cols[3]) {
      const parsed = Date.parse(cols[3]);
      // Ignore Unix epoch sentinel (1970-01-01T00:00:00Z) returned for unused 5h windows
      if (Number.isFinite(parsed) && parsed > 86_400_000) {
        resetsAt = new Date(parsed).toISOString();
      }
    }

    const prefix = isGemini ? "gemini" : "3p";
    const familyLabel = isGemini ? "Gemini" : "Claude & GPT";
    specs.push({
      id: `${prefix}-${isFiveHour ? "5h" : "weekly"}`,
      label: `${familyLabel} ${isFiveHour ? "5h" : "weekly"}`,
      shortLabel: isFiveHour ? "5h" : "wk",
      remainingPct,
      resetsAt,
      durationSeconds: isFiveHour ? 18_000 : 604_800,
    });
  }

  return specs.map((s) => {
    const usedPct = Number((100 - s.remainingPct).toFixed(1));
    return windowFromUsedPct({
      id: s.id,
      label: s.label,
      shortLabel: s.shortLabel,
      summary: true,
      utilizationPct: usedPct,
      durationSeconds: s.durationSeconds,
      resetsAt: s.resetsAt,
      tone: toneFromUsedPct(usedPct),
    });
  });
}

let cachedReport: { at: number; report: UsageReport } | null = null;

export async function discoverAntigravity(): Promise<UsageAccount[]> {
  if (!findOnPath("agy")) return [];
  return [{ key: "default", harness: "antigravity", provider: "antigravity", input: { account: "default" } }];
}

export async function fetchAntigravityUsage(_input: AntigravityUsageInput): Promise<UsageReport> {
  if (!findOnPath("agy")) {
    return unavailable({ kind: "no_quota", detail: "Antigravity CLI (`agy`) is not installed" });
  }
  const now = Date.now();
  if (cachedReport && now - cachedReport.at < CACHE_TTL_MS) {
    return cachedReport.report;
  }

  const { stdout } = await execCommand("agy", ["-p", "/usage", "--print-timeout", "20s"], {
    encoding: "utf8",
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  });

  const windows = parseAgyUsageOutput(stdout);
  const report: UsageReport =
    windows.length > 0
      ? {
          status: "available",
          planLabel: "Antigravity",
          windows,
          balances: [],
          details: [],
        }
      : unavailable({ kind: "no_quota", detail: "No Antigravity quota windows reported by `agy -p /usage`" });

  cachedReport = { at: now, report };
  return report;
}
