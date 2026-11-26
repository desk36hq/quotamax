/**
 * Local session transcript & DB usage scanners ported from pingdotgg/t3code:
 *  - Claude Code (`~/.claude/projects/**\/*.jsonl`)
 *  - Codex (`~/.codex/sessions/**\/*.jsonl`)
 *  - Antigravity (`~/.gemini/antigravity-cli/conversations/*.db` via node:sqlite)
 *  - Pi (`~/.pi/agent/sessions/**\/*.jsonl`, covering GLM & Alibaba plans)
 *
 * Uses per-file stat fingerprints (`size:mtimeMs`) so repeated scans only
 * re-parse files that actually changed.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { UsageSpeed, UsageTokenTotals } from "./usagePricing";

export type UsageProvider = "claude" | "codex" | "antigravity" | "pi";

export interface UsageRecord {
  readonly provider: UsageProvider;
  readonly timestampMs: number;
  readonly model: string;
  readonly rateModel?: string;
  readonly sessionId: string;
  readonly totals: UsageTokenTotals;
  readonly cacheCreation1hTokens?: number;
  readonly reportedCostUsd: number | null;
  readonly speed: UsageSpeed;
  readonly dedupeKey: string | null;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function totalTokens(totals: UsageTokenTotals): number {
  return (
    totals.uncachedInputTokens +
    totals.cachedInputTokens +
    totals.cacheCreationTokens +
    totals.outputTokens
  );
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function expandHome(raw: string): string {
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

// ---------------------------------------------------------------------------
// 1. Claude Code JSONL parser (ported from t3code/claudeUsage.ts)
// ---------------------------------------------------------------------------

const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

function cacheCreation1h(usage: Record<string, unknown>): { cacheCreation1hTokens?: number } {
  const split = usage["cache_creation"];
  if (typeof split !== "object" || split === null) return {};
  const tokens = tokenCount((split as Record<string, unknown>)["ephemeral_1h_input_tokens"]);
  return tokens > 0 ? { cacheCreation1hTokens: tokens } : {};
}

export function parseClaudeLine(line: string): readonly UsageRecord[] {
  if (!line.includes('"usage"')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return [];

  const message = record["message"];
  if (typeof message !== "object" || message === null) return [];
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return [];
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return [];

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return [];

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `claude:${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  const executor: UsageRecord = {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: tokenCount(usageRecord["input_tokens"]),
      cachedInputTokens: tokenCount(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usageRecord["output_tokens"]),
      reasoningTokens: 0,
    },
    ...cacheCreation1h(usageRecord),
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
  };

  const records: UsageRecord[] = [executor];
  const iterations: readonly unknown[] = Array.isArray(usageRecord["iterations"])
    ? usageRecord["iterations"]
    : [];
  for (const [index, iteration] of iterations.entries()) {
    if (typeof iteration !== "object" || iteration === null) continue;
    const advisor = iteration as Record<string, unknown>;
    if (advisor["type"] !== "advisor_message") continue;

    const advisorModel = typeof advisor["model"] === "string" ? advisor["model"] : "";
    if (advisorModel.length === 0 || advisorModel === CLAUDE_SYNTHETIC_MODEL) continue;

    records.push({
      provider: "claude",
      timestampMs,
      model: advisorModel,
      sessionId: executor.sessionId,
      totals: {
        uncachedInputTokens: tokenCount(advisor["input_tokens"]),
        cachedInputTokens: tokenCount(advisor["cache_read_input_tokens"]),
        cacheCreationTokens: tokenCount(advisor["cache_creation_input_tokens"]),
        outputTokens: tokenCount(advisor["output_tokens"]),
        reasoningTokens: 0,
      },
      ...cacheCreation1h(advisor),
      reportedCostUsd: null,
      speed: executor.speed,
      dedupeKey: dedupeKey === null ? null : `${dedupeKey}:advisor:${index}`,
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// 2. Codex JSONL parser (ported from t3code/codexUsage.ts)
// ---------------------------------------------------------------------------

interface CodexTokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

const CODEX_USAGE_FIELDS: (keyof CodexTokenUsage)[] = [
  "input_tokens",
  "cached_input_tokens",
  "cache_write_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function readCodexTokenUsage(value: unknown): CodexTokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const input = raw["input_tokens"];
  const output = raw["output_tokens"];
  if (!isNonNegInt(input) || !isNonNegInt(output)) return null;
  const cached = raw["cached_input_tokens"] === undefined ? 0 : raw["cached_input_tokens"];
  const cacheWrite =
    raw["cache_write_input_tokens"] === undefined ? 0 : raw["cache_write_input_tokens"];
  const reasoning =
    raw["reasoning_output_tokens"] === undefined ? 0 : raw["reasoning_output_tokens"];
  const total = raw["total_tokens"] === undefined ? input + output : raw["total_tokens"];
  if (!isNonNegInt(cached) || !isNonNegInt(cacheWrite) || !isNonNegInt(reasoning) || !isNonNegInt(total)) {
    return null;
  }
  if (cached + cacheWrite > input || reasoning > output || total < input + output) {
    return null;
  }
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: total,
  };
}

interface CodexPendingRequest {
  timestampMs: number;
  model: string;
  speed: UsageSpeed;
  usage: CodexTokenUsage;
}

export interface CodexScanState {
  model: string;
  speed: UsageSpeed;
  sessionId: string;
  lastUsageSignature: string | null;
  lastCumulativeUsage: CodexTokenUsage | null;
  sequenceStartSignature?: string;
  latestCumulativeAtMs?: number;
  unreportedRequests?: CodexPendingRequest[];
  requestLedgerActive?: boolean;
  sawSessionMeta: boolean;
  suppressingForkCopies: boolean;
  forkCopyAnchorMs: number;
}

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    speed: "standard",
    sessionId: "",
    lastUsageSignature: null,
    lastCumulativeUsage: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

const FORK_COPY_MAX_GAP_MS = 1000;

function codexSpeed(serviceTier: unknown): UsageSpeed {
  if (serviceTier === "priority" || serviceTier === "fast") return "fast";
  if (serviceTier === "ultrafast") return "ultrafast";
  return "standard";
}

function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string";
}

function isForkCopy(state: CodexScanState, timestampMs: number): boolean {
  if (!state.suppressingForkCopies) return false;
  if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
    state.forkCopyAnchorMs = timestampMs;
    return true;
  }
  state.suppressingForkCopies = false;
  state.lastUsageSignature = null;
  return false;
}

function dateCodexBaseline(state: CodexScanState, timestampMs: number): void {
  state.latestCumulativeAtMs = Math.max(state.latestCumulativeAtMs ?? timestampMs, timestampMs);
}

function rebaseCodexUsage(state: CodexScanState, cumulative: CodexTokenUsage, timestampMs: number): void {
  state.lastCumulativeUsage = cumulative;
  dateCodexBaseline(state, timestampMs);
  delete state.unreportedRequests;
  if (cumulative.input_tokens + cumulative.output_tokens === 0) delete state.sequenceStartSignature;
}

function advanceCodexUsage(previous: CodexTokenUsage | null, last: CodexTokenUsage): CodexTokenUsage | null {
  return readCodexTokenUsage(
    Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, (previous?.[key] ?? 0) + last[key]]))
  );
}

function unreportedRequests(
  previous: CodexTokenUsage | null,
  cumulative: CodexTokenUsage,
  last: CodexTokenUsage,
  pending: readonly CodexPendingRequest[] | undefined
): CodexPendingRequest[] | null {
  if (
    previous === null ||
    pending === undefined ||
    pending.length === 0 ||
    CODEX_USAGE_FIELDS.some(
      (key) =>
        cumulative[key] - previous[key] !==
        pending.reduce((sum, req) => sum + req.usage[key], 0)
    )
  ) {
    return null;
  }
  const final = pending[pending.length - 1]!;
  const remainder = readCodexTokenUsage(
    Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, final.usage[key] - last[key]]))
  );
  if (remainder === null) return null;
  return [...pending.slice(0, -1), { ...final, usage: remainder }].filter(
    (req) => req.usage.input_tokens + req.usage.output_tokens > 0
  );
}

function codexRequestRecord(
  sessionId: string,
  usage: CodexTokenUsage,
  timestampMs: number,
  model: string,
  speed: UsageSpeed,
  dedupeKey: string | null = null
): UsageRecord {
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = usage.cached_input_tokens;
  const cacheCreationTokens = usage.cache_write_input_tokens;
  return {
    provider: "codex",
    timestampMs,
    model,
    sessionId,
    totals: {
      uncachedInputTokens: inputTokens - cachedInputTokens - cacheCreationTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens: usage.output_tokens,
      reasoningTokens: usage.reasoning_output_tokens,
    },
    reportedCostUsd: null,
    speed,
    dedupeKey,
  };
}

export function parseCodexLine(line: string, state: CodexScanState): readonly UsageRecord[] {
  if (
    !line.includes('"token_count"') &&
    !line.includes('"token_usage_record"') &&
    !line.includes('"turn_context"') &&
    !line.includes('"thread_settings_applied"') &&
    !line.includes('"session_meta"')
  ) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return [];
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    if (state.sawSessionMeta) return [];
    state.sawSessionMeta = true;
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return [];
  }

  if (record["type"] === "turn_context") {
    state.requestLedgerActive = false;
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return [];
  }

  if (record["type"] === "token_usage_record") {
    const timestampMs = parseTimestampMs(record["timestamp"]);
    const usage = readCodexTokenUsage(payloadRecord["usage"]);
    if (timestampMs === null || usage === null || state.model.length === 0) return [];
    if (isForkCopy(state, timestampMs)) return [];
    const responseId = payloadRecord["response_id"];
    if (typeof responseId === "string" && responseId.length > 0) {
      const pending = state.unreportedRequests ?? [];
      state.requestLedgerActive = true;
      for (const req of pending) {
        state.lastCumulativeUsage = advanceCodexUsage(state.lastCumulativeUsage, req.usage);
      }
      state.lastCumulativeUsage = advanceCodexUsage(state.lastCumulativeUsage, usage);
      dateCodexBaseline(state, timestampMs);
      delete state.unreportedRequests;
      return [
        ...pending.map((req) =>
          codexRequestRecord(state.sessionId, req.usage, req.timestampMs, req.model, req.speed)
        ),
        codexRequestRecord(
          state.sessionId,
          usage,
          timestampMs,
          state.model,
          state.speed,
          JSON.stringify(["codex", state.sessionId, responseId])
        ),
      ];
    }
    state.requestLedgerActive = false;
    (state.unreportedRequests ??= []).push({
      timestampMs,
      model: state.model,
      speed: state.speed,
      usage,
    });
    return [];
  }

  if (payloadType === "thread_settings_applied") {
    const settings = payloadRecord["thread_settings"];
    if (typeof settings === "object" && settings !== null) {
      state.speed = codexSpeed((settings as Record<string, unknown>)["service_tier"]);
    }
    return [];
  }

  if (payloadType !== "token_count") return [];
  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return [];
  const infoRecord = info as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null || state.model.length === 0) return [];

  const last = readCodexTokenUsage(infoRecord["last_token_usage"]);
  const rawCumulative = infoRecord["total_token_usage"];
  const hasCumulative = rawCumulative !== undefined && rawCumulative !== null;
  const cumulative = hasCumulative ? readCodexTokenUsage(rawCumulative) : null;

  if (isForkCopy(state, timestampMs)) {
    const signature = last === null ? null : JSON.stringify(last);
    if (cumulative !== null) rebaseCodexUsage(state, cumulative, timestampMs);
    else if (!hasCumulative && last !== null && signature !== state.lastUsageSignature) {
      state.lastCumulativeUsage = advanceCodexUsage(state.lastCumulativeUsage, last);
      dateCodexBaseline(state, timestampMs);
    }
    state.lastUsageSignature = signature;
    return [];
  }

  if (state.requestLedgerActive) {
    if (cumulative !== null) rebaseCodexUsage(state, cumulative, timestampMs);
    return [];
  }

  const previous = state.lastCumulativeUsage;
  const latestCumulativeAtMs = state.latestCumulativeAtMs;
  const pending = state.unreportedRequests;
  if (cumulative !== null) rebaseCodexUsage(state, cumulative, timestampMs);
  if (last === null || (hasCumulative && cumulative === null)) return [];

  if (last.input_tokens + last.output_tokens === 0) {
    state.lastUsageSignature = null;
    return [];
  }
  if (
    cumulative !== null &&
    previous !== null &&
    CODEX_USAGE_FIELDS.every((key) => cumulative[key] === previous[key])
  ) {
    return [];
  }
  if (last.total_tokens !== last.input_tokens + last.output_tokens) return [];

  const signature = JSON.stringify(last);
  let unreported: readonly CodexPendingRequest[] = [];
  if (cumulative !== null) {
    const restarted = CODEX_USAGE_FIELDS.every((key) => cumulative[key] === last[key]);
    const sequenceStart = JSON.stringify([timestampMs, last]);
    if (restarted && sequenceStart === state.sequenceStartSignature) {
      state.lastCumulativeUsage = previous;
      if (latestCumulativeAtMs === undefined) delete state.latestCumulativeAtMs;
      return [];
    }
    const lowered =
      previous !== null && CODEX_USAGE_FIELDS.some((key) => cumulative[key] < previous[key]);
    const rewound =
      lowered && latestCumulativeAtMs !== undefined && timestampMs > latestCumulativeAtMs;
    const reconciled =
      previous === null || rewound
        ? readCodexTokenUsage(
            Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, cumulative[key] - last[key]]))
          ) !== null
        : CODEX_USAGE_FIELDS.every((key) => cumulative[key] - previous[key] === last[key]);
    if (!restarted && !reconciled) {
      const bridged = unreportedRequests(previous, cumulative, last, pending);
      if (bridged === null) {
        const replayed =
          latestCumulativeAtMs !== undefined &&
          (timestampMs < latestCumulativeAtMs ||
            (timestampMs === latestCumulativeAtMs &&
              lowered &&
              cumulative.input_tokens + cumulative.output_tokens > 0));
        if (replayed) {
          state.lastCumulativeUsage = previous;
          if (pending !== undefined) state.unreportedRequests = pending;
        }
        return [];
      }
      unreported = bridged;
    }
    if (restarted) state.sequenceStartSignature = sequenceStart;
  } else {
    if (signature === state.lastUsageSignature) return [];
    const advanced = advanceCodexUsage(previous, last);
    if (advanced === null) return [];
    state.lastCumulativeUsage = advanced;
    dateCodexBaseline(state, timestampMs);
  }
  state.lastUsageSignature = signature;

  return [
    ...unreported.map((req) =>
      codexRequestRecord(state.sessionId, req.usage, req.timestampMs, req.model, req.speed)
    ),
    codexRequestRecord(state.sessionId, last, timestampMs, state.model, state.speed),
  ];
}

// ---------------------------------------------------------------------------
// 3. Pi JSONL parser (ported from t3code/packages/provider-pi/src/server/usage.ts)
// ---------------------------------------------------------------------------

export interface PiScanState {
  sessionId: string;
}

export function parsePiLine(line: string, state: PiScanState): readonly UsageRecord[] {
  if (!line.includes('"usage"') && !line.includes('"session"')) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const entry = parsed as Record<string, unknown>;
  const type = entry["type"];

  if (type === "session" && typeof entry["id"] === "string" && entry["id"].length > 0) {
    state.sessionId = entry["id"];
    return [];
  }

  const id = typeof entry["id"] === "string" ? entry["id"] : "";
  const tsRaw = typeof entry["timestamp"] === "string" ? entry["timestamp"] : "";
  const timestampMs = parseTimestampMs(tsRaw);
  if (!id || timestampMs === null) return [];

  let source: Record<string, unknown> | null = null;
  if (type === "message") {
    const msg = entry["message"];
    if (typeof msg !== "object" || msg === null) return [];
    const msgRec = msg as Record<string, unknown>;
    if (msgRec["role"] !== "assistant" && msgRec["role"] !== "toolResult") return [];
    source = msgRec;
  } else if (type === "usage" || type === "compaction" || type === "branch_summary") {
    source = entry;
  } else {
    return [];
  }

  const usage = source["usage"];
  if (typeof usage !== "object" || usage === null) return [];
  const usageRec = usage as Record<string, unknown>;

  const rawProvider = typeof source["provider"] === "string" ? source["provider"] : "";
  const rawModel = typeof source["model"] === "string" ? source["model"] : "";
  const responseModel =
    typeof source["responseModel"] === "string" && source["responseModel"].length > 0
      ? source["responseModel"]
      : undefined;

  const rateModel = rawModel ? (responseModel ?? rawModel) : undefined;
  const model = rawProvider && rateModel ? `${rawProvider}/${rateModel}` : "Tools/summaries";

  const outputTokens = tokenCount(usageRec["output"]);
  const totals: UsageTokenTotals = {
    uncachedInputTokens: tokenCount(usageRec["input"]),
    cachedInputTokens: tokenCount(usageRec["cacheRead"]),
    cacheCreationTokens: tokenCount(usageRec["cacheWrite"]),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usageRec["reasoning"])),
  };

  const costObj = usageRec["cost"];
  const rawCost =
    typeof costObj === "object" && costObj !== null
      ? (costObj as Record<string, unknown>)["total"]
      : undefined;
  const reportedCostUsd =
    typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost > 0 ? rawCost : null;

  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];

  return [
    {
      provider: "pi",
      timestampMs,
      model,
      ...(rateModel ? { rateModel } : {}),
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: JSON.stringify(["pi", id, tsRaw, model]),
    },
  ];
}

// ---------------------------------------------------------------------------
// 4. Antigravity SQLite + protobuf reader (ported from t3code/antigravityUsageReader.ts)
// ---------------------------------------------------------------------------

type FieldValue = number | bigint | Uint8Array;
type Fields = Map<number, FieldValue[]>;

function decodeProtobufFields(bytes: Uint8Array): Fields {
  let offset = 0;
  const result: Fields = new Map();
  const varint = (): number | bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) {
        throw new Error("Invalid protobuf varint");
      }
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error("Invalid protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value: FieldValue;
    if (wire === 0) {
      value = varint();
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number" || length > bytes.length - offset) {
        throw new Error("Truncated protobuf field");
      }
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const pbNum = (f: Fields, k: number) => {
  const e = f.get(k)?.[0];
  return typeof e === "number" ? e : 0;
};
const pbBytes = (f: Fields, k: number) => {
  const e = f.get(k)?.[0];
  return e instanceof Uint8Array ? e : undefined;
};
const pbNested = (f: Fields, k: number) => {
  const b = pbBytes(f, k);
  return b === undefined ? new Map<number, FieldValue[]>() : decodeProtobufFields(b);
};
const pbText = (f: Fields, k: number) => {
  const b = pbBytes(f, k);
  return b === undefined ? "" : new TextDecoder("utf-8", { fatal: false }).decode(b).trim();
};
const pbTimestamp = (f: Fields) => {
  const seconds = pbNum(f, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(pbNum(f, 2) / 1_000_000) : null;
};

const ANTIGRAVITY_MODEL_IDS: Record<number, string> = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  342: "gpt-oss-120b-medium",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview",
  1020: "gemini-3.5-flash-medium",
  1021: "gemini-3.1-flash-image",
  1050: "gemini-3.1-flash-lite",
  1071: "gemini-3.6-flash-high",
  1072: "gemini-3.6-flash-medium",
  1073: "gemini-3.6-flash-low",
  1132: "gemini-3.5-flash-high",
  1133: "gemini-3.5-flash-high",
  1187: "gemini-3.5-flash-extra-low",
  1196: "gemini-3.6-flash",
  1266: "gemini-3.6-flash",
  1298: "gemini-3.7-flash-high",
  1299: "gemini-3.7-flash-medium",
  1300: "gemini-3.7-flash-low",
  1301: "gemini-3.7-flash-tiered",
  1318: "gemini-3.8-flash-high",
  1319: "gemini-3.8-flash-medium",
  1320: "gemini-3.8-flash-low",
  1322: "gemini-3.8-flash-tiered",
  1402: "claude-opus-5-5",
  1417: "gemini-4-argon",
  1418: "gemini-4-argon",
  1419: "gemini-4-argon",
  1427: "gemini-4-carbon",
  1437: "gemini-4-carbon",
  1525: "gemini-4-hydrogen",
  1526: "gemini-4-hydrogen",
  1527: "gemini-4-hydrogen",
  1532: "gemini-4-neon",
  1533: "gemini-4-neon",
  1537: "gemini-pro-orchestrator-neon",
  1667: "gemini-pro-orchestrator",
  1669: "gemini-4-hydrogen-orchestrator",
};

export function antigravityRateModel(model: string): string {
  const base = model.replace(
    /(?:-(?:extra-low|low|medium|high|tiered|control|thinking|agent|orchestrator|trial|n|r))+$/,
    ""
  );
  if (/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)) return "gemini-3.5-flash";
  if (model === "gemini-3.7-flash-safety-le") return "gemini-3.7-flash";
  if (model === "gemini-pro-orchestrator-neon") return "gemini-4-neon";
  if (model === "gemini-pro-orchestrator-g1-pro") return "gemini-4-argon";
  if (model === "gemini-pro-orchestrator") return "gemini-4-carbon";
  if (base === "gemini-3-flash") return "gemini-3-flash-preview";
  return base;
}

function normalizeAgModelName(name: string): string {
  if (!name) return "";
  const normalized = name
    .toLowerCase()
    .replace(/\s*\(([^)]*)\)\s*$/, "-$1")
    .replace(/\s+/g, "-");
  if (normalized.startsWith("claude-")) {
    return normalized
      .replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
      .replaceAll(".", "-");
  }
  return normalized;
}

function isConcreteAgModel(model: string): boolean {
  return (
    /^(?:gemini-\d|claude-(?:sonnet|opus|haiku|fable)-\d|gpt-)/.test(model) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
  );
}

interface AgMetadata {
  model: string;
  modelId: number;
  timestampMs: number | null;
  usages: Fields[];
}

function decodeAgMetadata(bytes: Uint8Array, step: boolean): AgMetadata {
  const root = decodeProtobufFields(bytes);
  const data = step ? root : pbNested(root, 1);
  const modelField = step ? pbNested(data, 24) : data;
  const usageBytes = pbBytes(data, step ? 9 : 4);
  const primaryUsage = usageBytes ? decodeProtobufFields(usageBytes.slice()) : undefined;
  const usages: Fields[] = primaryUsage ? [primaryUsage] : [];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (retry instanceof Uint8Array) {
      const retryUsage = pbBytes(decodeProtobufFields(retry), 2);
      if (retryUsage) usages.push(decodeProtobufFields(retryUsage.slice()));
    }
  }
  const names = [pbText(modelField, step ? 12 : 19), pbText(modelField, step ? 8 : 21)].map(
    normalizeAgModelName
  );
  return {
    model:
      names.find(isConcreteAgModel) ?? names.find((n) => n && !/^model[_-]/.test(n)) ?? "",
    modelId:
      pbNum(modelField, step ? 1 : 3) || (primaryUsage ? pbNum(primaryUsage, 1) : 0),
    timestampMs: step
      ? (pbTimestamp(pbNested(data, 8)) ?? pbTimestamp(pbNested(data, 1)))
      : pbTimestamp(pbNested(pbNested(data, 9), 4)),
    usages,
  };
}

interface AgDbCacheEntry {
  fingerprint: string;
  records: UsageRecord[];
}

function readAntigravityDb(dbPath: string, fallbackTimestamp: number): UsageRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 100");
    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name)
    );
    if (!tables.has("gen_metadata") && !tables.has("steps")) return [];

    const sessionId = path.basename(dbPath, ".db");
    const readRows = (sql: string, step: boolean): Array<{ idx: number; entry: AgMetadata }> => {
      const out: Array<{ idx: number; entry: AgMetadata }> = [];
      const rows = db.prepare(sql).all() as Array<{ idx: number; data: Uint8Array | null }>;
      for (const row of rows) {
        if (!row.data || !(row.data instanceof Uint8Array)) continue;
        try {
          out.push({ idx: Number(row.idx), entry: decodeAgMetadata(row.data, step) });
        } catch {
          // Ignore malformed row
        }
      }
      return out.sort((a, b) => a.idx - b.idx);
    };

    const generations = tables.has("gen_metadata")
      ? readRows("SELECT idx, data FROM gen_metadata ORDER BY rowid", false)
      : [];
    const steps = tables.has("steps")
      ? readRows("SELECT idx, metadata AS data FROM steps WHERE metadata IS NOT NULL ORDER BY rowid", true)
      : [];

    let trajectoryTimestamp: number | null = null;
    if (tables.has("trajectory_metadata_blob")) {
      const rows = db.prepare("SELECT data FROM trajectory_metadata_blob LIMIT 1").all() as Array<{
        data: Uint8Array | null;
      }>;
      const first = rows[0]?.data;
      if (first instanceof Uint8Array) {
        try {
          trajectoryTimestamp = pbTimestamp(pbNested(decodeProtobufFields(first), 2));
        } catch {
          // Ignore
        }
      }
    }

    const learnedModels = new Map<number, string>();
    for (const { entry } of [...generations, ...steps]) {
      if (entry.modelId > 0 && isConcreteAgModel(entry.model)) {
        learnedModels.set(entry.modelId, entry.model);
      }
    }

    const genByIdx = new Map(generations.map((g) => [g.idx, g.entry]));
    const byKey = new Map<string, UsageRecord>();

    for (const [source, entries] of [
      ["step", steps],
      ["generation", generations],
    ] as const) {
      for (const [index, { idx, entry }] of entries.entries()) {
        for (const [usageIndex, usage] of entry.usages.entries()) {
          const modelId = pbNum(usage, 1) || entry.modelId;
          const gen = source === "step" ? genByIdx.get(idx) : undefined;
          const matches = (m: AgMetadata) => modelId === 0 || m.modelId === modelId;
          const rawModel =
            (matches(entry) && entry.model) ||
            (gen && matches(gen) && gen.model) ||
            learnedModels.get(modelId) ||
            ANTIGRAVITY_MODEL_IDS[modelId] ||
            (modelId > 0 ? `antigravity-model-${modelId}` : "antigravity-unknown");

          const outputTokens = Math.max(pbNum(usage, 3), pbNum(usage, 9) + pbNum(usage, 10));
          const totals: UsageTokenTotals = {
            uncachedInputTokens: pbNum(usage, 2),
            cachedInputTokens: pbNum(usage, 5),
            cacheCreationTokens: pbNum(usage, 4),
            outputTokens,
            reasoningTokens: Math.min(outputTokens, pbNum(usage, 9)),
          };
          if (totalTokens(totals) === 0) continue;

          const idKey =
            ([11, 12, 7] as const)
              .map((k) => {
                const v = pbText(usage, k);
                return v ? `antigravity:${k}:${v}` : "";
              })
              .find(Boolean) ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}`;

          const rateModel = antigravityRateModel(rawModel);
          const candidate: UsageRecord = {
            provider: "antigravity",
            sessionId,
            timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
            model: rawModel,
            ...(rateModel !== rawModel ? { rateModel } : {}),
            totals,
            reportedCostUsd: null,
            speed: "standard",
            dedupeKey: idKey,
          };

          const prev = byKey.get(idKey);
          if (!prev) {
            byKey.set(idKey, candidate);
          } else {
            byKey.set(idKey, {
              ...prev,
              model: isConcreteAgModel(candidate.model) ? candidate.model : prev.model,
              rateModel: isConcreteAgModel(candidate.model) ? candidate.rateModel : prev.rateModel,
              timestampMs: Math.min(prev.timestampMs, candidate.timestampMs),
              totals: {
                uncachedInputTokens: Math.max(
                  prev.totals.uncachedInputTokens,
                  candidate.totals.uncachedInputTokens
                ),
                cachedInputTokens: Math.max(
                  prev.totals.cachedInputTokens,
                  candidate.totals.cachedInputTokens
                ),
                cacheCreationTokens: Math.max(
                  prev.totals.cacheCreationTokens,
                  candidate.totals.cacheCreationTokens
                ),
                outputTokens: Math.max(prev.totals.outputTokens, candidate.totals.outputTokens),
                reasoningTokens: Math.max(
                  prev.totals.reasoningTokens,
                  candidate.totals.reasoningTokens
                ),
              },
            });
          }
        }
      }
    }

    return [...byKey.values()];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 5. Incremental file walker & scanner cache
// ---------------------------------------------------------------------------

interface CachedJsonl {
  fingerprint: string;
  records: UsageRecord[];
}

const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;

async function walkFiles(
  root: string,
  ext: string,
  sinceMs: number
): Promise<Array<{ filePath: string; size: number; mtimeMs: number; ctimeMs: number }>> {
  const results: Array<{ filePath: string; size: number; mtimeMs: number; ctimeMs: number }> = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        try {
          const st = await fsp.stat(full);
          if (st.mtimeMs >= sinceMs - MTIME_SLACK_MS) {
            results.push({
              filePath: full,
              size: st.size,
              mtimeMs: st.mtimeMs,
              ctimeMs: st.ctimeMs,
            });
          }
        } catch {
          // Ignore vanished files
        }
      }
    }
  }
  return results;
}

async function scanJsonlFile(
  filePath: string,
  parse: (line: string) => readonly UsageRecord[]
): Promise<UsageRecord[]> {
  const records: UsageRecord[] = [];
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line.length === 0) continue;
      const parsed = parse(line);
      for (const r of parsed) records.push(r);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return records;
}

export interface UsageScanRoots {
  claudeProjectsDir?: string;
  codexSessionsDir?: string;
  piSessionsDir?: string;
  antigravityConversationsDir?: string;
}

export function defaultUsageScanRoots(): UsageScanRoots {
  const home = os.homedir();
  const claudeHome = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? expandHome(process.env.CLAUDE_CONFIG_DIR.trim())
    : path.join(home, ".claude");
  const codexHome = process.env.CODEX_HOME?.trim()
    ? expandHome(process.env.CODEX_HOME.trim())
    : path.join(home, ".codex");
  const piSessions = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
    ? expandHome(process.env.PI_CODING_AGENT_SESSION_DIR.trim())
    : path.join(
        process.env.PI_CODING_AGENT_DIR?.trim()
          ? expandHome(process.env.PI_CODING_AGENT_DIR.trim())
          : path.join(home, ".pi", "agent"),
        "sessions"
      );
  const agyDir = process.env.ANTIGRAVITY_DATA_DIR?.trim()
    ? expandHome(process.env.ANTIGRAVITY_DATA_DIR.trim())
    : path.join(home, ".gemini", "antigravity-cli", "conversations");

  return {
    claudeProjectsDir: path.join(claudeHome, "projects"),
    codexSessionsDir: path.join(codexHome, "sessions"),
    piSessionsDir: piSessions,
    antigravityConversationsDir: agyDir,
  };
}

export class LocalUsageScanner {
  private readonly jsonlCache = new Map<string, CachedJsonl>();
  private readonly agyCache = new Map<string, AgDbCacheEntry>();
  private readonly roots: UsageScanRoots;

  constructor(roots: UsageScanRoots = defaultUsageScanRoots()) {
    this.roots = roots;
  }

  async scanSince(sinceMs: number): Promise<UsageRecord[]> {
    const [claude, codex, pi, agy] = await Promise.all([
      this.scanClaude(sinceMs),
      this.scanCodex(sinceMs),
      this.scanPi(sinceMs),
      this.scanAntigravity(sinceMs),
    ]);
    return [...claude, ...codex, ...pi, ...agy];
  }

  private async scanClaude(sinceMs: number): Promise<UsageRecord[]> {
    if (!this.roots.claudeProjectsDir) return [];
    const files = await walkFiles(this.roots.claudeProjectsDir, ".jsonl", sinceMs);
    const out: UsageRecord[] = [];
    for (const f of files) {
      const fp = `${f.size}:${f.mtimeMs}`;
      const cached = this.jsonlCache.get(f.filePath);
      if (cached && cached.fingerprint === fp) {
        for (const r of cached.records) if (r.timestampMs >= sinceMs) out.push(r);
        continue;
      }
      const records = await scanJsonlFile(f.filePath, parseClaudeLine);
      this.jsonlCache.set(f.filePath, { fingerprint: fp, records });
      for (const r of records) if (r.timestampMs >= sinceMs) out.push(r);
    }
    return out;
  }

  private async scanCodex(sinceMs: number): Promise<UsageRecord[]> {
    if (!this.roots.codexSessionsDir) return [];
    const files = await walkFiles(this.roots.codexSessionsDir, ".jsonl", sinceMs);
    const out: UsageRecord[] = [];
    for (const f of files) {
      const fp = `${f.size}:${f.mtimeMs}`;
      const cached = this.jsonlCache.get(f.filePath);
      if (cached && cached.fingerprint === fp) {
        for (const r of cached.records) if (r.timestampMs >= sinceMs) out.push(r);
        continue;
      }
      const state = initialCodexScanState();
      const records = await scanJsonlFile(f.filePath, (line) => parseCodexLine(line, state));
      this.jsonlCache.set(f.filePath, { fingerprint: fp, records });
      for (const r of records) if (r.timestampMs >= sinceMs) out.push(r);
    }
    return out;
  }

  private async scanPi(sinceMs: number): Promise<UsageRecord[]> {
    if (!this.roots.piSessionsDir) return [];
    const files = await walkFiles(this.roots.piSessionsDir, ".jsonl", sinceMs);
    const out: UsageRecord[] = [];
    for (const f of files) {
      const fp = `${f.size}:${f.mtimeMs}`;
      const cached = this.jsonlCache.get(f.filePath);
      if (cached && cached.fingerprint === fp) {
        for (const r of cached.records) if (r.timestampMs >= sinceMs) out.push(r);
        continue;
      }
      const state: PiScanState = { sessionId: "" };
      const records = await scanJsonlFile(f.filePath, (line) => parsePiLine(line, state));
      this.jsonlCache.set(f.filePath, { fingerprint: fp, records });
      for (const r of records) if (r.timestampMs >= sinceMs) out.push(r);
    }
    return out;
  }

  private async scanAntigravity(sinceMs: number): Promise<UsageRecord[]> {
    if (!this.roots.antigravityConversationsDir) return [];
    const files = await walkFiles(this.roots.antigravityConversationsDir, ".db", sinceMs);
    const out: UsageRecord[] = [];
    for (const f of files) {
      let walPart = "-";
      try {
        const walStat = await fsp.stat(`${f.filePath}-wal`);
        walPart = `${walStat.size}:${walStat.mtimeMs}:${walStat.ctimeMs}`;
      } catch {
        // No WAL file
      }
      const fp = `${f.size}:${f.mtimeMs}:${f.ctimeMs}/${walPart}`;
      const cached = this.agyCache.get(f.filePath);
      if (cached && cached.fingerprint === fp) {
        for (const r of cached.records) if (r.timestampMs >= sinceMs) out.push(r);
        continue;
      }
      try {
        const records = readAntigravityDb(f.filePath, f.mtimeMs);
        this.agyCache.set(f.filePath, { fingerprint: fp, records });
        for (const r of records) if (r.timestampMs >= sinceMs) out.push(r);
      } catch {
        // Skip locked or unreadable DB
      }
    }
    return out;
  }
}
