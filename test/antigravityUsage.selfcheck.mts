import assert from "node:assert/strict";
import { parseAgyUsageOutput } from "../server/antigravityUsage";

const sample = [
  "Gemini Models\tWeekly Limit Remaining\t80%\t2026-12-03T08:16:32Z",
  "Gemini Models\tFive Hour Limit Remaining\t76%\t2026-11-27T22:21:57Z",
  "Claude and GPT models\tWeekly Limit Remaining\t97%\t2026-12-04T09:15:08Z",
  "Claude and GPT models\tFive Hour Limit Remaining\t100%\t1970-01-01T00:00:00Z",
].join("\n");

const windows = parseAgyUsageOutput(sample);
assert.equal(windows.length, 4);

const byId = new Map(windows.map((w) => [w.id, w]));
assert.equal(byId.get("gemini-weekly")!.usedPct, 20);
assert.equal(byId.get("gemini-weekly")!.resetsAt, "2026-12-03T08:16:32.000Z");
assert.equal(byId.get("gemini-5h")!.usedPct, 24);
assert.equal(byId.get("3p-weekly")!.usedPct, 3);
assert.equal(byId.get("3p-5h")!.usedPct, 0);
assert.equal(byId.get("3p-5h")!.resetsAt, null, "1970 epoch sentinel ignored");

assert.equal(parseAgyUsageOutput("not a valid table\n").length, 0);

console.log("ALL ANTIGRAVITY USAGE CHECKS PASSED");
