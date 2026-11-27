// The quota data the advisor consumes, independent of where it came from. The shape is
// Paseo's `paseo usage --json` report (the format QuotaMax was built on); the Orca
// adapter (orca/orcaQuotaSource.ts) converts Orca's rate limits into the same shape.

export interface UsageWindowRaw {
  id: string;
  label?: string;
  usedPct?: number;
  remainingPct?: number;
  resetsAt?: string;
  durationSeconds?: number;
}

export interface UsageReportEntry {
  sourceId: string;
  defaultEnabled?: boolean;
  report?: {
    status?: string;
    planLabel?: string;
    windows?: UsageWindowRaw[];
    /** Why the source is not available, when it says (Orca reports e.g. "Codex not signed in"). */
    message?: string;
  };
}

export interface QuotaSource {
  /** Where pools come from, e.g. "paseo usage": shown as "Not reported by <name>". */
  readonly name: string;
  /** Used in "Failed to read <displayName>" when a poll fails without a message. */
  readonly displayName: string;
  fetch(refresh: boolean, signal: AbortSignal): Promise<UsageReportEntry[]>;
}
