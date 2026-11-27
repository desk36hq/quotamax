// Self-check for the Alibaba usage source. It runs the real fetch/discover code
// against stub CLIs that behave like the real ones: success JSON on stdout with
// exit 0, the error envelope on stderr with the CLI's own exit code.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { toneFromUsedPct } from "@getpaseo/plugin/server/usage";
import { discoverAlibaba, fetchAlibabaUsage } from "../server/alibabaUsage";

const dir = mkdtempSync(path.join(os.tmpdir(), "qa-alibaba-stub-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const isWindows = process.platform === "win32";
// Only `node` and the stubs are on PATH, so the real `bl` / `qwencloud` installed on
// this machine cannot leak into a case that is meant to run without them. On Windows
// each stub is a `.cmd` wrapper that runs node by absolute path, so PATH needs only
// the stub folder and System32 (for cmd.exe).
if (isWindows) {
  process.env.PATH = `${dir};${path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")}`;
} else {
  symlinkSync(process.execPath, `${dir}/node`);
  process.env.PATH = `${dir}:/usr/bin:/bin`;
}

// One stub per CLI; each call looks up its reply by argv in replies.json.
const STUB = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const key = path.basename(process.argv[1]) + " " + process.argv.slice(2).join(" ");
const reply = JSON.parse(fs.readFileSync(path.join(__dirname, "replies.json"), "utf8"))[key];
if (!reply) { console.error("no stub reply for: " + key); process.exit(99); }
(reply.code === 0 ? process.stdout : process.stderr).write(reply.out);
process.exit(reply.code);
`;

type Reply = { out: string; code: number };

/** Install only `bins` and make each argv resolve to its reply. */
function stage(bins: string[], map: Record<string, [unknown, number?]>) {
  for (const b of ["bl", "qwencloud"]) {
    rmSync(`${dir}/${b}`, { force: true });
    rmSync(`${dir}/${b}.cmd`, { force: true });
  }
  for (const b of bins) {
    writeFileSync(`${dir}/${b}`, STUB);
    chmodSync(`${dir}/${b}`, 0o755);
    if (isWindows) writeFileSync(`${dir}/${b}.cmd`, `@"${process.execPath}" "%~dp0${b}" %*\r\n`);
  }
  const replies = Object.fromEntries(
    Object.entries(map).map(([argv, [payload, code]]) => [argv, { out: JSON.stringify(payload), code: code ?? 0 }]),
  );
  writeFileSync(`${dir}/replies.json`, JSON.stringify(replies));
}

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const input = { account: "default" as const };
const summary = (windows: object, plan = "pro") => ({ coding_plan: { subscribed: true, plan, windows } });
const fiveHour = { total: 1000, remaining: 400, used_pct: 60, next_reset_at: iso(now + 3_600_000) };
const weekly = { total: 5000, remaining: 4500, next_reset_at: iso(now + 2 * 86_400_000) };
const qwenPlan = summary({ per_5h: fiveHour, weekly });
const blStatus = (extra: object) => [{ authenticated: true, config: "default", ...extra }, 0] as [unknown, number];
const blPlan = {
  instanceType: "pro",
  per5Hour: { usedQuota: 600, totalQuota: 6000, percentage: 0.1, resetTime: now + 2 * 3_600_000 },
  perWeek: { usedQuota: 9000, totalQuota: 45000, resetTime: now + 2 * 86_400_000 }, // no percentage: derived
  perBillMonth: { usedQuota: 1, totalQuota: 90000, percentage: 0.01 },
};

// A) Only qwencloud, logged in with a plan.
stage(["qwencloud"], {
  "qwencloud auth status --format json": [{ authenticated: true }, 0],
  "qwencloud usage summary --format json": [qwenPlan],
});
let r = await fetchAlibabaUsage(input);
assert.equal(r.status, "available");
if (r.status === "available") {
  assert.deepEqual(r.windows.map((w) => w.id), ["five_hour", "weekly"]);
  assert.equal(r.windows[0]!.usedPct, 60); // CLI's own used_pct
  assert.equal(r.windows[1]!.usedPct, 10); // derived from total/remaining
  assert.equal(r.planLabel, "Coding Plan (pro)");
  assert.equal(r.windows[0]!.tone, toneFromUsedPct(60)); // the SDK's shared colour scale
}

// B) Only qwencloud, logged in, no plan on that account (the state seen live).
stage(["qwencloud"], {
  "qwencloud auth status --format json": [{ authenticated: true, server_verified: true }],
  "qwencloud usage summary --format json": [{ coding_plan: { subscribed: false }, token_plan: { subscribed: false } }],
});
r = await fetchAlibabaUsage(input);
assert.equal(r.status, "unavailable");
assert.equal(r.problem.kind, "no_quota");

// C) Only qwencloud, login expired: unavailable with the remedy, not an error.
stage(["qwencloud"], {
  "qwencloud auth status --format json": [{ authenticated: false, reason: "token_expired" }],
  "qwencloud usage summary --format json": [{ error: { code: "TOKEN_EXPIRED", message: "Token expired" } }, 2],
});
r = await fetchAlibabaUsage(input);
assert.equal(r.status, "unavailable");
assert.equal(r.problem.kind, "rejected");
assert.match(r.problem.refreshedBy ?? "", /^qwencloud auth login$/);

// D) Both installed and logged in: `bl` (the documented tool) wins.
stage(["bl", "qwencloud"], {
  "bl auth status --output json": blStatus({ console: { source: "config", region: "ap-southeast-1", site: "international" } }),
  "bl usage coding-plan --output json": [blPlan],
  "qwencloud auth status --format json": [{ authenticated: true }],
  "qwencloud usage summary --format json": [qwenPlan],
});
r = await fetchAlibabaUsage(input);
assert.equal(r.status, "available");
if (r.status === "available") {
  assert.equal(r.planLabel, "Coding Plan (pro)");
  assert.deepEqual(r.windows.map((w) => [w.id, w.usedPct, w.resetsAt]), [
    ["five_hour", 10, iso(now + 2 * 3_600_000)], // percentage is a 0..1 ratio
    ["weekly", 20, iso(now + 2 * 86_400_000)], // derived from usedQuota/totalQuota
  ]); // perBillMonth is deliberately not emitted: the catalog has no window for it
  assert.equal(r.windows[1]!.durationSeconds, 604_800);
}

// E) `bl` present with only a model API key: cannot read quota, so qwencloud answers.
stage(["bl", "qwencloud"], {
  "bl auth status --output json": blStatus({ api_key: { source: "env", masked: "sk-…" } }),
  "qwencloud auth status --format json": [{ authenticated: true }],
  "qwencloud usage summary --format json": [qwenPlan],
});
r = await fetchAlibabaUsage(input);
assert.equal(r.status, "available");
if (r.status === "available") assert.equal(r.windows[0]!.usedPct, 60);

// F) `bl` with only an AccessKey pair: it mints a console session from that, so it counts.
stage(["bl", "qwencloud"], {
  "bl auth status --output json": blStatus({ openapi: { source: "env" } }),
  "bl usage coding-plan --output json": [blPlan],
});
r = await fetchAlibabaUsage(input);
assert.equal(r.status, "available");

// G) `bl` logged in, but the console session is gone: real envelope is stderr + exit 3.
stage(["bl"], {
  "bl auth status --output json": blStatus({ console: { source: "config" } }),
  "bl usage coding-plan --output json": [{ error: { code: 3, message: "No console access token found.", hint: "Run `bl auth login --console`." } }, 3],
});
r = await fetchAlibabaUsage(input);
assert.equal(r.status, "unavailable");
assert.equal(r.problem.kind, "rejected");
assert.match(r.problem.refreshedBy ?? "", /^bl auth login --console --console-site international$/);

// H) `bl` logged in with neither plan: coding-plan prints {}, token-plan has no quota data.
stage(["bl"], {
  "bl auth status --output json": blStatus({ console: {} }),
  "bl usage coding-plan --output json": [{}],
  "bl usage token-plan --output json": [{ hasQuotaData: false }],
});
r = await fetchAlibabaUsage(input);
assert.equal(r.status, "unavailable");
assert.equal(r.problem.kind, "no_quota");

// M) A personal Token Plan: coding-plan is {}, so the monthly quota is read instead.
//    This is the live shape seen on the account this plugin was built for.
const reset = Date.UTC(2026, 11, 21, 16); // 22 Dec 00:00 at UTC+8
stage(["bl"], {
  "bl auth status --output json": blStatus({ console: { region: "ap-southeast-1", site: "international" } }),
  "bl usage coding-plan --output json": [{}],
  "bl usage token-plan --output json": [{ per1MonthPercentage: 0, per1MonthResetTime: reset, hasQuotaData: true }],
});
r = await fetchAlibabaUsage(input);
assert.equal(r.status, "available");
if (r.status === "available") {
  assert.equal(r.planLabel, "Token Plan");
  assert.deepEqual(
    r.windows.map((w) => [w.id, w.label, w.usedPct, w.remainingPct, w.resetsAt, w.durationSeconds]),
    [["monthly", "Monthly", 0, 100, new Date(reset).toISOString(), 2_592_000]], // 22 Nov → 22 Dec
  );
}

// N) Every window the plan reports, and a cycle that follows the calendar.
const mar31 = Date.UTC(2027, 2, 31);
stage(["bl"], {
  "bl auth status --output json": blStatus({ openapi: { source: "env" } }),
  "bl usage coding-plan --output json": [{}],
  "bl usage token-plan --output json": [
    {
      per5HourPercentage: 0.125,
      per5HourResetTime: reset + 7_200_000,
      per1WeekPercentage: 0.5,
      per1MonthPercentage: 0.925,
      per1MonthResetTime: mar31,
      hasQuotaData: true,
    },
  ],
});
r = await fetchAlibabaUsage(input);
if (r.status !== "available") assert.fail("expected an available Token Plan");
else {
  assert.deepEqual(
    r.windows.map((w) => [w.id, w.usedPct, w.durationSeconds]),
    [
      ["five_hour", 12.5, 18_000],
      ["weekly", 50, 604_800],
      ["monthly", 92.5, 2_678_400], // 28 Feb → 31 Mar
    ],
  );
  assert.equal(r.windows[0]!.resetsAt, new Date(reset + 7_200_000).toISOString());
}

// I) Any other `bl` failure is surfaced as an error carrying the CLI's message.
stage(["bl"], {
  "bl auth status --output json": blStatus({ console: {} }),
  "bl usage coding-plan --output json": [{ error: { code: 6, message: "network unreachable" } }, 6],
});
await assert.rejects(fetchAlibabaUsage(input), /network unreachable/);

// J) `bl` installed but logged out, no qwencloud: the remedy names `bl`.
stage(["bl"], { "bl auth status --output json": [{ authenticated: false, message: "Not authenticated." }] });
r = await fetchAlibabaUsage(input);
assert.equal(r.problem.kind, "rejected");
assert.match(r.problem.refreshedBy ?? "", /^bl auth login/);

// K) Nothing installed: not discovered, and a fetch says so.
stage([], {});
assert.equal((await discoverAlibaba()).length, 0);
await assert.rejects(fetchAlibabaUsage(input), /installed/);

// L) Discovery follows installation, not login state, so a remedy stays visible.
stage(["bl", "qwencloud"], {
  "bl auth status --output json": [{ authenticated: false }],
  "qwencloud auth status --format json": [{ authenticated: false }],
});
assert.equal((await discoverAlibaba()).length, 1);

rmSync(dir, { recursive: true, force: true });
console.log("ALL CHECKS PASSED (A–N)");
