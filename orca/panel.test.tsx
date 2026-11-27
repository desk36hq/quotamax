// `orca plugin test .` — the panel with a stand-in worker (what each plugin.request answers).
import { assert, mockHost, mount, test } from "orca/testing";
import type { ModelRecommendation, PoolStatus, QuotaAdvisorSnapshot } from "../shared/types";
import type { ApplyRequest } from "./applyTypes";
import * as panel from "./panel";

const burn = { sampleCount: 0, windowMinutes: 0, shortRatePctPerMin: null, weeklyRatePctPerMin: null, etaLabel: "Idle", etaSeverity: "idle" as const, etaMinutes: null, etaWindow: null };

const claude: PoolStatus = {
  pool: "claude",
  label: "Claude",
  planLabel: "Team",
  paseoProvider: "claude",
  tracked: true,
  mode: "HAMMER",
  urgencyBonus: 30,
  shortCaution: false,
  reason: "80% left with 10.0h to reset",
  weekly: { id: "weekly", label: "Weekly", usedPct: 20, remainingPct: 80, resetsAt: null, remainingHours: 10, windowHours: 168, pace: 13.4, requiredPctPerHr: 8 },
  short: { id: "five_hour", label: "Session", usedPct: 30, remainingPct: 70, resetsAt: null, remainingHours: 1.5, windowHours: 5, pace: 2.3, requiredPctPerHr: 46 },
  burn,
};

const rec = (modelId: string, label: string, score: number): ModelRecommendation => ({
  provider: "claude",
  modelId,
  paseoTarget: `claude/${modelId}`,
  label,
  pool: "claude",
  poolLabel: "Claude",
  poolMode: "HAMMER",
  tier: "frontier",
  intelligence: 97,
  coding: 98,
  efficiency: 52,
  quotaCost: 2.2,
  recommendedThinking: "xhigh",
  fitScore: score - 30,
  urgencyBonus: 30,
  totalScore: score,
  notes: `${label} notes`,
});

const recs = [rec("claude-opus-5-5", "Claude Opus 5.5", 120), rec("claude-sonnet-5-5", "Claude Sonnet 5.5", 110)];

const snapshot: QuotaAdvisorSnapshot = {
  generatedAt: "2026-11-27T16:00:00.000Z",
  lastPolledAt: "2026-11-27T16:00:00.000Z",
  pollIntervalMs: 90_000,
  catalogUpdatedAt: "2026-11-27",
  hasAaKey: false,
  error: null,
  pools: [claude, { ...claude, pool: "kimi", label: "Kimi Code", planLabel: null, tracked: false, mode: "UNTRACKED", reason: "Not reported by Orca", weekly: null, short: null }],
  recommendations: { quick: recs, standard: recs, hard: recs, frontier: recs },
};

test("shows the ranked models and applies the chosen one after confirmation", async () => {
  const applied: ApplyRequest[] = [];
  const host = mockHost({
    capabilities: ["storage:own", "secrets:own", "settings:own", "agent:read", "terminal:send"],
    settings: { recalibrateOnSync: true },
    requests: {
      "quotamax.snapshot": () => snapshot,
      "quotamax.apply": (input) => {
        applied.push(input);
        return input.confirm
          ? { status: "sent", message: "Sent to Main.", commands: ["/model claude-opus-5-5", "/effort xhigh"], terminalId: "t1" }
          : { status: "ready", message: "Type into Main:", commands: ["/model claude-opus-5-5", "/effort xhigh"], terminalId: "t1", agentTitle: "Main" };
      },
    },
  });
  const view = await mount(panel, { host });
  assert.deepEqual(view.errors, []);
  assert.deepEqual(view.rowsOf({ label: "Recommended models" }), ["claude|claude|claude-opus-5-5", "claude|claude|claude-sonnet-5-5"]);

  await view.press({ text: "Apply to agent" });
  assert.equal(applied.at(-1)?.confirm, false);
  assert.ok(view.find({ text: "Send" }), "a preview asks before typing anything");

  await view.press({ text: "Send" });
  assert.deepEqual(
    [applied.at(-1)?.confirm, applied.at(-1)?.terminalId, applied.at(-1)?.thinking],
    [true, "t1", "xhigh"]
  );
  assert.ok(view.find({ text: "Sent to Main." }));
  assert.deepEqual(view.refusals, []);
  await view.unmount();
});

test("pools tab lists tracked pools and explains the rest", async () => {
  const host = mockHost({
    capabilities: ["storage:own", "secrets:own", "settings:own"],
    requests: { "quotamax.snapshot": () => snapshot },
  });
  const view = await mount(panel, { host });
  await view.select({ label: "QuotaMax views" }, "pools");
  assert.ok(view.find({ text: "HAMMER" }));
  assert.ok(view.find({ type: "Collapsible", label: "Not tracked (1)" }) ?? view.find({ label: "Untracked pools" }));
  assert.deepEqual(view.errors, []);
  await view.unmount();
});
