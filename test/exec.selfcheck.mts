// Self-check for findOnPath: how QuotaMax decides a CLI is installed before running it.
// Windows rules are checked on every OS (through the platform argument); the POSIX
// execute-permission rule needs a POSIX file system, so it runs only there.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findOnPath } from "../server/exec";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qa-exec-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const dir = (name: string) => {
  const d = path.join(root, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const file = (d: string, name: string, mode = 0o755) => {
  const p = path.join(d, name);
  fs.writeFileSync(p, "", { mode });
  return p;
};

// A) Windows: a bare name resolves only with a PATHEXT extension (an extensionless file
//    of the same name is not runnable there).
const win = dir("win");
file(win, "tool");
const toolExe = file(win, "tool.exe");
const env = { PATH: win, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
assert.equal(findOnPath("tool", env, "win32"), toolExe);

// B) Windows: a name that already has a runnable extension is looked up as is,
//    not as `orca.exe.exe`.
const orcaExe = file(win, "orca.exe");
assert.equal(findOnPath("orca.exe", env, "win32"), orcaExe);
assert.equal(findOnPath("ORCA.EXE", env, "win32") !== null, true, "extensions match case-insensitively");
const cmdShim = file(win, "bl.cmd");
assert.equal(findOnPath("bl.cmd", env, "win32"), cmdShim);
assert.equal(findOnPath("missing.exe", env, "win32"), null);

// C) POSIX: a non-executable file earlier in PATH doesn't shadow the real binary.
if (process.platform !== "win32") {
  const early = dir("early");
  const late = dir("late");
  file(early, "qwencloud", 0o644);
  const real = file(late, "qwencloud", 0o755);
  assert.equal(findOnPath("qwencloud", { PATH: `${early}:${late}` }, process.platform), real);
  assert.equal(findOnPath(path.join(early, "qwencloud"), {}, process.platform), null, "absolute paths need +x too");
  console.log("ALL EXEC CHECKS PASSED (A–C)");
} else {
  console.log("ALL EXEC CHECKS PASSED (A–B; C runs on POSIX only)");
}
