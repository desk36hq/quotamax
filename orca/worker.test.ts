// `orca plugin test .` — the worker over Orca's mock host, with a fake quota source.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, mockHost, mountWorker, test } from "orca/testing";
import type { QuotaSource, UsageReportEntry } from "../server/quotaSource";
import type { CostEstimateSummary } from "../shared/types";
import { activateWith, deactivate, statusBarFor } from "./worker";

const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

function reports(fableUsedPct: number): UsageReportEntry[] {
  const now = Date.now();
  return [
    {
      sourceId: "claude",
      report: {
        status: "available",
        planLabel: "Team",
        windows: [
          { id: "five_hour", usedPct: 20, remainingPct: 80, resetsAt: iso(now + 1.5 * H), durationSeconds: 18_000 },
          { id: "weekly", usedPct: 10, remainingPct: 90, resetsAt: iso(now + 10 * H), durationSeconds: 604_800 },
          { id: "weekly_model_fable", label: "Weekly · Fable", usedPct: fableUsedPct, remainingPct: 100 - fableUsedPct, resetsAt: iso(now + 10 * H), durationSeconds: 604_800 },
        ],
      },
    },
    { sourceId: "codex", report: { status: "unavailable", windows: [], message: "Codex not signed in" } },
  ];
}

const emptyCosts = { window: "7d", byPool: [], byModel: [] } as unknown as CostEstimateSummary;

async function mount(fableUsedPct = 0) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-orca-worker-"));
  const quotaSource: QuotaSource = {
    name: "Orca",
    displayName: "Orca rate limits",
    fetch: async () => reports(fableUsedPct),
  };
  const host = mockHost({
    capabilities: ["storage:own", "secrets:own", "settings:own", "agent:read", "terminal:send"],
    settings: { recalibrateOnSync: true },
    results: { "agents.list": { agents: [] } },
  });
  const worker = await mountWorker(
    {
      default: (orca: Parameters<typeof activateWith>[0]) =>
        activateWith(orca, { quotaSource, dataDir, fallbackCatalogPaths: [], costs: { getSummary: async () => emptyCosts } }),
      deactivate,
    } as never,
    { host, commands: ["quotamax.refresh"] }
  );
  return { worker, host, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test("ranks models from the quota source and explains untracked pools", async () => {
  const { worker, cleanup } = await mount();
  try {
    const snap = await worker.request("quotamax.snapshot", { refresh: true });
    const claude = snap.pools.find((p) => p.pool === "claude")!;
    assert.equal(claude.tracked, true);
    assert.equal(claude.mode, "HAMMER"); // 90% left with 10h to reset
    assert.equal(snap.pools.find((p) => p.pool === "codex")!.reason, "Status: unavailable — Codex not signed in");
    assert.equal(snap.pools.find((p) => p.pool === "kimi")!.reason, "Not reported by Orca");
    assert.ok(snap.recommendations.frontier.length > 0);
    assert.ok(snap.recommendations.frontier.every((r) => r.pool === "claude"));
    assert.ok(worker.posts.some((p) => p.event === "quotamax.snapshot"), "open panels hear each poll");
    assert.deepEqual(worker.refusals, []);
  } finally {
    await worker.deactivate();
    cleanup();
  }
});

test("demotes Claude Fable when its own weekly limit is nearly used", async () => {
  const { worker, cleanup } = await mount(97);
  try {
    const snap = await worker.request("quotamax.snapshot", { refresh: true });
    const fable = snap.recommendations.frontier.find((r) => r.modelId === "claude-fable-5-2")!;
    assert.match(fable.notes, /^Weekly · Fable limit nearly used up \(3% left\)/);
    assert.notEqual(snap.recommendations.frontier[0]!.modelId, "claude-fable-5-2");
  } finally {
    await worker.deactivate();
    cleanup();
  }
});

test("stores the Artificial Analysis key as a secret and reports it", async () => {
  const { worker, host, cleanup } = await mount();
  try {
    assert.deepEqual(await worker.request("quotamax.aaKey", { key: "  aa-key  " }), { hasKey: true });
    assert.equal(host.data().secrets.aaApiKey, "aa-key");
    assert.equal((await worker.request("quotamax.snapshot", {})).hasAaKey, true);
    assert.deepEqual(await worker.request("quotamax.aaKey", { key: "" }), { hasKey: false });
    assert.equal(host.data().secrets.aaApiKey, undefined);
  } finally {
    await worker.deactivate();
    cleanup();
  }
});

test("the refresh command re-polls and says how many pools are tracked", async () => {
  const { worker, cleanup } = await mount();
  try {
    const text = await worker.command("quotamax.refresh");
    assert.match(String(text), /^QuotaMax refreshed: 1 of \d+ pools tracked\.$/);
  } finally {
    await worker.deactivate();
    cleanup();
  }
});

test("status bar names the pool to use now", () => {
  const item = statusBarFor({
    generatedAt: "",
    lastPolledAt: "",
    pollIntervalMs: 90_000,
    catalogUpdatedAt: "",
    hasAaKey: false,
    error: null,
    pools: [
      { pool: "claude", label: "Claude", planLabel: null, paseoProvider: "claude", tracked: true, mode: "HAMMER", urgencyBonus: 30, shortCaution: false, reason: "", weekly: { id: "weekly", label: "Weekly", usedPct: 20, remainingPct: 80, resetsAt: null, remainingHours: 10, windowHours: 168, pace: 13, requiredPctPerHr: 8 }, short: null, burn: { sampleCount: 0, windowMinutes: 0, shortRatePctPerMin: null, weeklyRatePctPerMin: null, etaLabel: "Idle", etaSeverity: "idle", etaMinutes: null, etaWindow: null } },
    ],
    recommendations: { quick: [], standard: [], hard: [], frontier: [] },
  });
  assert.equal(item.text, "Claude · Hammer");
  assert.equal(item.tone, "accent");
  assert.match(item.tooltip, /Claude: Hammer — 80% left/);
});
