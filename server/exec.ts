// Host-neutral command running. Paseo passes its SDK's `execCommand`; Orca (which has no
// SDK at runtime) uses `nodeExec` below. Both reject like `child_process.execFile`: the
// error carries `code` (an exit code, or "ENOENT"), `stdout` and `stderr`.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ExecOptions {
  encoding?: BufferEncoding;
  timeout?: number;
  maxBuffer?: number;
  signal?: AbortSignal;
  /** The child's environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: ExecOptions
) => Promise<{ stdout: string; stderr: string }>;

const isWindows = process.platform === "win32";

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves a bare command name the way the OS shell would (PATH, plus PATHEXT on
 * Windows), or null when it is not installed. Checking up front gives a missing CLI the
 * same answer on every OS and locale; on Windows, a missing command run through cmd.exe
 * otherwise exits 1 with a localized message instead of failing with ENOENT.
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (command.includes("/") || command.includes("\\")) return isFile(command) ? command : null;
  const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean);
  const exts = isWindows
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext.toLowerCase());
      // On Windows only an extension makes a file runnable.
      if ((!isWindows || ext) && isFile(candidate)) return candidate;
    }
  }
  return null;
}

function missing(command: string): Error {
  return Object.assign(new Error(`spawn ${command} ENOENT`), {
    code: "ENOENT",
    stdout: "",
    stderr: "",
  });
}

/**
 * cmd.exe argument quoting for `.cmd`/`.bat` launchers (npm-style shims). Inside quotes
 * cmd ignores & | < > ^; QuotaMax only passes fixed flags and ids, never `%`.
 */
function quoteForCmd(arg: string): string {
  if (/^[\w./:=@,+-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** `execFile` with PATH resolution and Windows `.cmd` shim support; no shell otherwise. */
export const nodeExec: ExecFn = (command, args, options = {}) => {
  const env = options.env ?? process.env;
  const resolved = findOnPath(command, env);
  if (!resolved) return Promise.reject(missing(command));
  const common = {
    encoding: options.encoding ?? ("utf8" as BufferEncoding),
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
    signal: options.signal,
    windowsHide: true,
    env,
  };
  const useCmd = isWindows && /\.(cmd|bat)$/i.test(resolved);
  const file = useCmd ? (env.ComSpec ?? env.COMSPEC ?? "cmd.exe") : resolved;
  const argv = useCmd
    ? ["/d", "/s", "/c", `"${[`"${resolved}"`, ...args.map(quoteForCmd)].join(" ")}"`]
    : args;
  return new Promise((resolve, reject) => {
    execFile(
      file,
      argv,
      { ...common, windowsVerbatimArguments: useCmd },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");
        if (error) {
          reject(Object.assign(error, { stdout: out, stderr: err }));
          return;
        }
        resolve({ stdout: out, stderr: err });
      }
    );
  });
};
