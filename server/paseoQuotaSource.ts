// Paseo only: quota windows from Paseo's usage tracker (`paseo usage --json`).
import { execCommand } from "@getpaseo/plugin/server";
import type { QuotaSource, UsageReportEntry } from "./quotaSource";

export function createPaseoQuotaSource(): QuotaSource {
  return {
    name: "paseo usage",
    displayName: "Paseo usage",
    async fetch(refresh, signal) {
      const cmdArgs = ["usage", "--json"];
      if (refresh) cmdArgs.push("--refresh");
      const { stdout } = await execCommand("paseo", cmdArgs, {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        timeout: 20_000,
        signal,
      });
      return JSON.parse(stdout) as UsageReportEntry[];
    },
  };
}
