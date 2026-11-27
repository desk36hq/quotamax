// Paseo only: registers Alibaba Cloud quota as a Paseo usage source (behind `paseo usage`).
// The CLI reading and parsing live in ./alibabaCore.ts, which the Orca plugin shares.
import { execCommand } from "@getpaseo/plugin/server";
import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageAccount,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { alibabaCliInstalled, readAlibabaQuota } from "./alibabaCore";
import type { ExecFn } from "./exec";

export const alibabaInputSchema = z.object({ account: z.literal("default") }).strict();
export type AlibabaUsageInput = z.infer<typeof alibabaInputSchema>;

const exec: ExecFn = (command, args, options) => execCommand(command, args, options);

export async function fetchAlibabaUsage(_input: AlibabaUsageInput): Promise<UsageReport> {
  const result = await readAlibabaQuota(exec);
  if (result.status === "unavailable") return unavailable(result.problem);
  return {
    status: "available",
    planLabel: result.planLabel,
    windows: result.windows.map((w) =>
      windowFromUsedPct({
        id: w.id,
        label: w.label,
        shortLabel: w.shortLabel,
        summary: true,
        utilizationPct: w.usedPct,
        durationSeconds: w.durationSeconds,
        resetsAt: w.resetsAt,
        tone: toneFromUsedPct(w.usedPct),
      })
    ),
    balances: [],
    details: [],
  };
}

export async function discoverAlibaba(): Promise<UsageAccount[]> {
  // Report the account whenever a CLI is installed, regardless of login state: the
  // registry only lists discovered accounts, so hiding a logged-out CLI would make
  // Alibaba silently vanish instead of showing the re-login remedy.
  if (!(await alibabaCliInstalled(exec))) return [];
  return [{ key: "default", harness: "pi", provider: "pi", input: { account: "default" } }];
}
