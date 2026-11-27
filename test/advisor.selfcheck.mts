// Self-check for the host-neutral advisor: window matching by id pattern, source aliases,
// a model's own window (Claude Fable), source messages, and catalog merging/validation.
// Runs on any host with `npm test`; no Paseo or Orca needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate from catalogs synced on this machine (~/.agents, ~/.paseo).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "qa-advisor-home-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));

const { QuotaAdvisorService, mergeWithBundled, parseCatalog } = await import("../server/advisor");
type Entry = import("../server/quotaSource").UsageReportEntry;

const bundled = JSON.parse(fs.readFileSync(new URL("../server/default-models.json", import.meta.url), "utf8"));
const H = 3_600_000;
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const win = (id: string, usedPct: number, resetInHours: number, durationSeconds?: number) => ({
  id,
  usedPct,
  remainingPct: 100 - usedPct,
  resetsAt: iso(now + resetInHours * H),
  ...(durationSeconds ? { durationSeconds } : {}),
});

async function snapshotFor(reports: Entry[], catalog: unknown = bundled) {
  const svc = new QuotaAdvisorService({
    readSettings: async () => ({ aaApiKey: "", recalibrateOnSync: true }),
    quotaSource: { name: "test source", displayName: "test source", fetch: async () => reports },
    bundledCatalog: catalog,
    dataDir: path.join(home, "data"),
  });
  return svc.getSnapshot(true);
}

// A) The bundled catalog is valid, and every model belongs to a pool it defines.
const parsed = parseCatalog(bundled);
assert.ok(parsed, "bundled catalog validates");
for (const m of parsed.models) assert.ok(parsed.pools[m.pool], `model ${m.id} has pool ${m.pool}`);
assert.equal(parseCatalog({ ...bundled, models: [{ id: "x" }] }), null, "malformed models are rejected");

// B) Per-model MiniMax windows: the most-used `interval_*` / `weekly_*` window binds.
let s = await snapshotFor([
  {
    sourceId: "minimax",
    report: {
      status: "available",
      windows: [win("interval_m3", 10, 3, 18_000), win("interval_m3_flash", 60, 3, 18_000), win("weekly_m3", 5, 100), win("weekly_m3_flash", 40, 100)],
    },
  },
]);
let pool = s.pools.find((p) => p.pool === "minimax")!;
assert.equal(pool.tracked, true);
assert.equal(pool.short?.id, "interval_m3_flash");
assert.equal(pool.weekly?.id, "weekly_m3_flash");

// C) Kimi as Paseo names its windows (`coding_limit_<n>_time_unit_<unit>`).
s = await snapshotFor([
  {
    sourceId: "kimi",
    report: { status: "available", windows: [win("coding_limit_300_time_unit_minute", 20, 2), win("coding_limit_7_time_unit_day", 30, 80)] },
  },
]);
pool = s.pools.find((p) => p.pool === "kimi")!;
assert.deepEqual([pool.short?.id, pool.weekly?.id], ["coding_limit_300_time_unit_minute", "coding_limit_7_time_unit_day"]);

// D) X Subscription: reported by Cursor alone (alias), monthly-style id; Copilot uses a 30-day window.
s = await snapshotFor([
  { sourceId: "cursor", report: { status: "available", windows: [win("plan_usage", 50, 72)] } },
  { sourceId: "copilot", report: { status: "available", windows: [win("premium_interactions", 30, 300)] } },
]);
pool = s.pools.find((p) => p.pool === "xsub")!;
assert.equal(pool.tracked, true);
assert.equal(pool.weekly?.id, "plan_usage");
assert.equal(s.pools.find((p) => p.pool === "copilot")!.weekly?.windowHours, 720);
assert.ok(s.recommendations.standard.some((r) => r.provider === "cursor"));

// E) GLM through Paseo's `zai` source id; an available alias wins over an unavailable primary.
s = await snapshotFor([
  { sourceId: "glm", report: { status: "unavailable" } },
  { sourceId: "zai", report: { status: "available", windows: [win("five_hour", 10, 2, 18_000), win("weekly", 20, 50, 604_800)] } },
]);
assert.equal(s.pools.find((p) => p.pool === "glm")!.tracked, true);

// F) Claude Fable's own weekly limit: nearly used → demoted with a note; plenty left → untouched.
const claudeWith = (fableUsed: number): Entry[] => [
  {
    sourceId: "claude",
    report: {
      status: "available",
      windows: [win("five_hour", 10, 2, 18_000), win("weekly", 10, 10, 604_800), { ...win("weekly_model_fable", fableUsed, 10, 604_800), label: "Weekly · Fable" }],
    },
  },
];
const low = await snapshotFor(claudeWith(97));
const ok = await snapshotFor(claudeWith(10));
const fableLow = low.recommendations.frontier.find((r) => r.modelId === "claude-fable-5-2")!;
const fableOk = ok.recommendations.frontier.find((r) => r.modelId === "claude-fable-5-2")!;
assert.match(fableLow.notes, /^Weekly · Fable limit nearly used up \(3% left\)\. /);
assert.ok(fableLow.totalScore < fableOk.totalScore - 50);
assert.ok(!fableOk.notes.startsWith("Weekly · Fable"));

// G) A source's own explanation is kept in the pool's reason.
s = await snapshotFor([{ sourceId: "codex", report: { status: "unavailable", message: "Codex not signed in" } }]);
assert.equal(s.pools.find((p) => p.pool === "codex")!.reason, "Status: unavailable — Codex not signed in");
assert.equal(s.pools.find((p) => p.pool === "claude")!.reason, "Not reported by test source");

// H) A catalog synced before new pools existed keeps its scores but gains the new pools and models.
const old = parseCatalog(bundled)!;
old.pools = { claude: old.pools.claude! };
old.models = old.models.filter((m) => m.pool === "claude").map((m) => ({ ...m, intelligence: 1 }));
const merged = mergeWithBundled(old, parseCatalog(bundled)!);
assert.ok(merged.pools.kimi && merged.pools.copilot);
assert.equal(merged.models.find((m) => m.id === "claude-opus-5-5" && m.pool === "claude")!.intelligence, 1);
assert.ok(merged.models.some((m) => m.pool === "muse"));

// I) A catalog synced before `modelWindowId` existed (claude-fable-5-2 is on main without it)
//    gets the bundled structural field, and keeps its synced scores and metrics.
const preFable = parseCatalog(bundled)!;
const aaMetrics = { name: "Claude Fable 5.2", slug: "fable-5-2", intelligenceIndex: 65, codingIndex: 70, blendedPricePer1M: 20, medianOutputTps: 50, syncedAt: "2026-11-20" };
preFable.models = preFable.models.map((m) => {
  if (m.id !== "claude-fable-5-2" || m.pool !== "claude") return m;
  const { modelWindowId: _dropped, ...rest } = m;
  return { ...rest, intelligence: 42, coding: 43, efficiency: 44, aaMetrics };
});
assert.equal(preFable.models.find((m) => m.id === "claude-fable-5-2")!.modelWindowId, undefined);
const fableMerged = mergeWithBundled(preFable, parseCatalog(bundled)!).models.find(
  (m) => m.id === "claude-fable-5-2" && m.pool === "claude"
)!;
assert.equal(fableMerged.modelWindowId, "weekly_model_fable");
assert.deepEqual([fableMerged.intelligence, fableMerged.coding, fableMerged.efficiency], [42, 43, 44]);
assert.deepEqual(fableMerged.aaMetrics, aaMetrics);

// J) End to end: that older catalog synced on disk still lets Fable's own limit demote it.
fs.mkdirSync(path.join(home, "data"), { recursive: true });
fs.writeFileSync(path.join(home, "data", "models.json"), JSON.stringify(preFable));
const fromDisk = await snapshotFor(claudeWith(97));
assert.match(
  fromDisk.recommendations.frontier.find((r) => r.modelId === "claude-fable-5-2")!.notes,
  /^Weekly · Fable limit nearly used up/
);
fs.rmSync(path.join(home, "data", "models.json"));

console.log("ALL ADVISOR CHECKS PASSED (A–J)");
