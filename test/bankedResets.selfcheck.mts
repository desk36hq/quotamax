import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QuotaAdvisorService } from "../server/advisor";
import {
  BankedResetManager,
  computeResetAdvice,
  parseClaudeResetCredits,
  parseCodexResetCredits,
} from "../server/bankedResets";
import bundled from "../server/default-models.json";
import type { QuotaSource } from "../server/quotaSource";
import type { WindowStats } from "../shared/types";

const nowMs = Date.UTC(2026, 10, 27, 20, 0, 0);
const isoIn = (hours: number) => new Date(nowMs + hours * 3_600_000).toISOString();

// A) Claude cedar_ember parser: groups live grants by kind, skips paused/expired/empty
const claudeResets = parseClaudeResetCredits(
  {
    cedar_ember: {
      eligible: true,
      grants: [
        { id: "g1", resets_left: 1, ends_at: isoIn(20), paused: false, usable_now: true, type: "weekly" },
        { id: "g2", resets_left: 2, ends_at: isoIn(48), paused: false, usable_now: true, type: "weekly" },
        { id: "g3", resets_left: 1, ends_at: isoIn(36), paused: false, usable_now: true, gives_back_weekly: true },
        { id: "g4", resets_left: 1, ends_at: isoIn(-5), paused: false, usable_now: true, type: "session" },
        { id: "g5", resets_left: 1, ends_at: isoIn(10), paused: true, usable_now: true, type: "full" },
      ],
    },
  },
  nowMs
);
assert.equal(claudeResets.length, 2, "weekly + fable live grants");
const claudeWeekly = claudeResets.find((r) => r.kind === "weekly")!;
assert.equal(claudeWeekly.count, 3);
assert.equal(claudeWeekly.remainingHours, 20, "earliest expiry wins");
assert.equal(claudeResets.find((r) => r.kind === "fable")!.count, 1);

// B) Codex rate-limit-reset-credits parser: counts available credits, skips redeemed/expired
const codexResets = parseCodexResetCredits(
  {
    credits: [
      { id: "c1", status: "available", reset_type: "weekly", expires_at: isoIn(10) },
      { id: "c2", status: "available", reset_type: "weekly", expires_at: isoIn(72) },
      { id: "c3", status: "redeemed", reset_type: "weekly", expires_at: isoIn(5) },
      { id: "c4", status: "available", reset_type: "5h_session", expires_at: isoIn(-1) },
    ],
  },
  nowMs
);
assert.equal(codexResets.length, 1);
assert.equal(codexResets[0]!.count, 2);
assert.equal(codexResets[0]!.remainingHours, 10);

// C) Strategic advice: pop_now when >=85% used, burn_before_expiry when expiring <=48h with >=15% left, hold otherwise
const mkWin = (usedPct: number, remainingHours: number): WindowStats => ({
  id: "weekly",
  label: "Weekly",
  usedPct,
  remainingPct: 100 - usedPct,
  resetsAt: isoIn(remainingHours),
  remainingHours,
  windowHours: 168,
  pace: 1,
  requiredPctPerHr: (100 - usedPct) / remainingHours,
});

const pop = computeResetAdvice([codexResets[0]!], mkWin(92, 80), null);
assert.equal(pop.advice?.action, "pop_now");
assert.equal(pop.forceHammer, false);

const burn = computeResetAdvice([codexResets[0]!], mkWin(40, 120), null);
assert.equal(burn.advice?.action, "burn_before_expiry");
assert.equal(burn.forceHammer, true);
assert.ok(burn.urgencyBoost >= 28);

const hold = computeResetAdvice(
  [{ ...codexResets[0]!, remainingHours: 240, expiresAt: isoIn(240) }],
  mkWin(30, 100),
  null
);
assert.equal(hold.advice?.action, "hold");
assert.equal(hold.forceHammer, false);

// D) Manual store: add, persist, consume (decrement & remove), auto-prune expired
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-banked-"));
process.on("exit", () => fs.rmSync(tmpDir, { recursive: true, force: true }));

const mgr = new BankedResetManager({ dataDir: tmpDir, disableApiFetch: true });
const added = mgr.addManual({ pool: "codex", kind: "weekly", count: 2, expiresAt: isoIn(18) }, nowMs);
mgr.addManual({ pool: "codex", kind: "5h", count: 1, expiresAt: isoIn(-2) }, nowMs);

let byPool = await mgr.getByPool(false, nowMs);
assert.equal(byPool.get("codex")?.length, 1, "expired manual entry pruned");
assert.equal(byPool.get("codex")![0]!.count, 2);

assert.equal(mgr.consumeManual(added.id, 1), true);
byPool = await mgr.getByPool(false, nowMs);
assert.equal(byPool.get("codex")![0]!.count, 1);

assert.equal(mgr.consumeManual(added.id, 1), true);
byPool = await mgr.getByPool(false, nowMs);
assert.equal(byPool.get("codex"), undefined);

// E) End-to-end advisor integration: expiring banked reset boosts a BALANCED pool into HAMMER mode
const source: QuotaSource = {
  name: "test",
  displayName: "test",
  async fetch() {
    return [
      {
        sourceId: "codex",
        report: {
          status: "available",
          planLabel: "Plus",
          windows: [
            { id: "weekly", label: "Weekly", usedPct: 45, remainingPct: 55, resetsAt: new Date(Date.now() + 90 * 3_600_000).toISOString(), durationSeconds: 604_800 },
            { id: "five_hour", label: "5h", usedPct: 10, remainingPct: 90, resetsAt: new Date(Date.now() + 4 * 3_600_000).toISOString(), durationSeconds: 18_000 },
          ],
        },
      },
    ];
  },
};

const svc = new QuotaAdvisorService({
  readSettings: async () => ({ aaApiKey: "", recalibrateOnSync: false }),
  quotaSource: source,
  bundledCatalog: bundled,
  dataDir: tmpDir,
  disableBankedResetApi: true,
});

const before = await svc.getSnapshot(true);
const codexBefore = before.pools.find((p) => p.pool === "codex")!;
assert.equal(codexBefore.mode, "BALANCED");

const after = await svc.addBankedReset({
  pool: "codex",
  kind: "weekly",
  count: 1,
  expiresAt: new Date(Date.now() + 14 * 3_600_000).toISOString(),
});
const codexAfter = after.pools.find((p) => p.pool === "codex")!;
assert.equal(codexAfter.mode, "HAMMER", "expiring banked reset should boost pool into HAMMER");
assert.equal(codexAfter.resetAdvice?.action, "burn_before_expiry");
assert.equal(codexAfter.bankedResets?.length, 1);

console.log("ALL BANKED RESET CHECKS PASSED (A–E)");
