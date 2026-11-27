// Formatting shared by the Orca panel's renderer. Ported as-is from the Paseo panel
// (client/panel.tsx) so both hosts word and round things the same way.
import type { BurnMode } from "../../shared/types";

export const MODE_ORDER: Record<BurnMode, number> = {
  HAMMER: 0,
  PUSH: 1,
  BALANCED: 2,
  CONSERVE: 3,
  THROTTLED_5H: 4,
  EXHAUSTED: 5,
  UNTRACKED: 6,
};

export function formatDuration(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours)) return "-";
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

export function formatRelativeAge(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const secs = Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export function modeLabel(mode: BurnMode, pace: number | null): string {
  if (mode === "THROTTLED_5H") return "5H CAP";
  if (mode === "EXHAUSTED") return "EXHAUSTED";
  if (mode === "UNTRACKED") return "UNTRACKED";
  if (pace != null && Number.isFinite(pace)) return `${mode} · ${pace.toFixed(1)}x`;
  return mode;
}

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) return "<$0.01";
  if (amount < 100) return `$${amount.toFixed(2)}`;
  if (amount < 1000) return `$${amount.toFixed(1)}`;
  return `$${Math.round(amount).toLocaleString("en-US")}`;
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(Math.round(tokens));
}

/** Escapes text for HTML element content and quoted attribute values. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
