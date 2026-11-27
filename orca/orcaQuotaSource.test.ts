// `orca plugin test .` — Orca rate limits → advisor reports, and finding the Orca CLI.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cliEnv, createOrcaQuotaSource, rateLimitsToReports, resolveOrcaCli } from "./orcaQuotaSource";

const H = 3_600_000;
const now = Date.parse("2026-11-27T16:00:00Z");

// Shapes as `orca account list --json` (Orca 1.4.279) reports them.
const rateLimits = {
  claude: {
    provider: "claude",
    session: { usedPercent: 8, windowMinutes: 300, resetsAt: now + 3 * H, resetDescription: "19:20" },
    weekly: { usedPercent: 2, windowMinutes: 10080, resetsAt: now + 140 * H, resetDescription: "Thu 15:00" },
    fableWeekly: { usedPercent: 0, windowMinutes: 10080, resetsAt: now + 140 * H, resetDescription: "Thu 15:00" },
    monthly: null,
    status: "ok",
    planType: "team",
    error: null,
  },
  codex: { provider: "codex", session: null, weekly: null, status: "unavailable", error: "Codex not signed in" },
  antigravity: {
    provider: "antigravity",
    session: { usedPercent: 40, windowMinutes: 300, resetsAt: now + H },
    weekly: { usedPercent: 30, windowMinutes: 10080, resetsAt: now + 50 * H },
    buckets: [
      { name: "Gemini Pro", group: "Gemini", usedPercent: 40, windowMinutes: 300, resetsAt: now + H },
      { name: "Gemini Flash", group: "Gemini", usedPercent: 10, windowMinutes: 300, resetsAt: now + H },
      { name: "Gemini", group: "Gemini", usedPercent: 25, windowMinutes: 10080, resetsAt: now + 50 * H },
      { name: "Claude Opus", group: "Anthropic & OpenAI", usedPercent: 5, windowMinutes: 300, resetsAt: now + 2 * H },
      { name: "Claude Opus", group: "Anthropic & OpenAI", usedPercent: 30, windowMinutes: 10080, resetsAt: now + 50 * H },
    ],
    status: "ok",
  },
  zcode: {
    provider: "zcode",
    session: { usedPercent: 12, windowMinutes: 300, resetsAt: now + 4 * H },
    weekly: { usedPercent: 33, windowMinutes: 10080, resetsAt: now + 90 * H },
    monthly: null,
    status: "ok",
    planType: "pro",
  },
  opencodeGo: {
    provider: "opencode-go",
    session: { usedPercent: 5, windowMinutes: 300, resetsAt: now + H },
    weekly: { usedPercent: 50, windowMinutes: 10080, resetsAt: now + 20 * H },
    monthly: { usedPercent: 60, windowMinutes: 43200, resetsAt: now + 200 * H },
    status: "ok",
  },
  minimaxCookieConfigured: false,
};

test("maps Orca rate limits onto the catalog's source and window ids", () => {
  const reports = rateLimitsToReports(rateLimits);
  const by = new Map(reports.map((r) => [r.sourceId, r.report!]));

  const claude = by.get("claude")!;
  assert.equal(claude.status, "available");
  assert.equal(claude.planLabel, "Team");
  assert.deepEqual(
    claude.windows!.map((w) => [w.id, w.usedPct, w.durationSeconds]),
    [
      ["five_hour", 8, 18_000],
      ["weekly", 2, 604_800],
      ["weekly_model_fable", 0, 604_800],
    ]
  );
  assert.equal(claude.windows![0]!.resetsAt, new Date(now + 3 * H).toISOString());

  assert.deepEqual(by.get("codex"), { status: "unavailable", windows: [], message: "Codex not signed in" });

  // Buckets split into the two Antigravity pools; the most-used bucket binds.
  assert.deepEqual(
    by.get("antigravity")!.windows!.map((w) => [w.id, w.usedPct]).sort(),
    [
      ["3p-5h", 5],
      ["3p-weekly", 30],
      ["gemini-5h", 40],
      ["gemini-weekly", 25],
    ]
  );

  assert.equal(by.get("glm")!.planLabel, "Pro"); // zcode is the GLM Coding Plan
  assert.deepEqual(by.get("opencode-go")!.windows!.map((w) => w.id), ["five_hour", "weekly", "monthly"]);
  assert.equal(by.has("minimax"), false, "flags such as minimaxCookieConfigured are not providers");
});

test("resolves the Orca CLI from ORCA_CLI_COMMAND, then beside the app, never the Linux screen reader", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-orca-cli-"));
  try {
    // Executable, so the checks hold on POSIX hosts too (only executables count there).
    const touch = (p: string) => fs.writeFileSync(p, "", { mode: 0o755 });
    const exe = path.join(dir, process.platform === "win32" ? "orca.exe" : "orca");
    touch(exe);
    assert.equal(resolveOrcaCli({ ORCA_CLI_COMMAND: exe, PATH: "" }, "/nowhere/app"), exe);

    const appDir = path.join(dir, "app");
    fs.mkdirSync(path.join(appDir, "resources", "bin"), { recursive: true });
    const bundled = path.join(appDir, "resources", "bin", "orca.exe");
    touch(bundled);
    assert.equal(resolveOrcaCli({ PATH: "" }, path.join(appDir, "Orca.exe"), "win32"), bundled);

    // On Linux a bare `orca` on PATH is the GNOME screen reader: only orca-ide counts.
    touch(path.join(dir, "orca"));
    assert.equal(resolveOrcaCli({ PATH: dir }, "/nowhere/app", "linux"), null);
    touch(path.join(dir, "orca-ide"));
    assert.equal(resolveOrcaCli({ PATH: dir }, "/nowhere/app", "linux"), path.join(dir, "orca-ide"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("gives CLIs the profile folders Orca's trimmed worker environment leaves out", () => {
  // What Orca 1.4.279 gives a plugin worker on Windows: no APPDATA, LOCALAPPDATA or HOME.
  const trimmed = { PATH: "C:\\bin", USERPROFILE: "C:\\Users\\me", SystemRoot: "C:\\Windows" };
  const win = cliEnv(trimmed, "C:\\Users\\me", "win32");
  assert.equal(win.APPDATA, path.join("C:\\Users\\me", "AppData", "Roaming"));
  assert.equal(win.LOCALAPPDATA, path.join("C:\\Users\\me", "AppData", "Local"));
  assert.equal(win.PATH, "C:\\bin");
  assert.equal(cliEnv({ APPDATA: "D:\\Roaming" }, "C:\\Users\\me", "win32").APPDATA, "D:\\Roaming", "a real value wins");
  assert.equal(cliEnv({ PATH: "/usr/bin" }, "/home/me", "linux").HOME, "/home/me");
});

test("reads `orca account list --json` and surfaces its errors", async () => {
  const ok = createOrcaQuotaSource({
    cli: "orca",
    exec: async (cmd, args) => {
      if (cmd === "orca") {
        assert.deepEqual(args, ["account", "list", "--json"]);
        return { stdout: JSON.stringify({ ok: true, result: { rateLimits } }), stderr: "" };
      }
      // `bl` / `qwencloud` are not installed in this test.
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  });
  const reports = await ok.fetch(false, new AbortController().signal);
  assert.ok(reports.some((r) => r.sourceId === "claude"));

  // The CLI's --json error envelope arrives on stdout with a non-zero exit.
  const failing = createOrcaQuotaSource({
    cli: "orca",
    exec: async () => {
      throw Object.assign(new Error("Command failed: orca account list --json"), {
        code: 1,
        stdout: JSON.stringify({ ok: false, error: { code: "runtime_unavailable", message: "Orca is not running" } }),
        stderr: "",
      });
    },
  });
  await assert.rejects(
    failing.fetch(false, new AbortController().signal),
    /orca account list: runtime_unavailable — Orca is not running/
  );

  const missing = createOrcaQuotaSource({ cli: null });
  await assert.rejects(missing.fetch(false, new AbortController().signal), /Orca CLI not found/);
});
