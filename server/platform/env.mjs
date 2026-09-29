import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The installed launcher gives the server a minimal environment on purpose.
// Agents, dev servers and terminals are user work, so they run with the
// environment of the user's login shell (nvm, Homebrew, ~/.local/bin), captured
// once and refreshed on demand. Nothing from it is logged or sent to clients.
let captured = null;
let capturing = null;

const fallbackPath = [
  path.join(os.homedir(), ".local/bin"),
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
].join(":");

function shell() {
  const candidate = process.env.SHELL;
  return candidate && /^\/(bin|usr\/bin|opt\/homebrew\/bin)\/(zsh|bash)$/.test(candidate)
    ? candidate
    : "/bin/zsh";
}

function readLoginEnvironment() {
  return new Promise((resolve) => {
    const child = execFile(
      shell(),
      ["-l", "-i", "-c", "env -0"],
      {
        env: {
          HOME: os.homedir(),
          USER: os.userInfo().username,
          LOGNAME: os.userInfo().username,
          TMPDIR: process.env.TMPDIR || os.tmpdir(),
          LANG: process.env.LANG || "en_US.UTF-8",
          TERM: "dumb",
          SHELL: shell(),
        },
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error && !stdout) return resolve(null);
        const env = {};
        for (const entry of stdout.split("\0")) {
          const eq = entry.indexOf("=");
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
        resolve(env.PATH ? env : null);
      },
    );
    child.stdin?.end();
  });
}

export async function userEnvironment({ refresh = false } = {}) {
  if (captured && !refresh) return captured;
  if (!capturing)
    capturing = readLoginEnvironment().then((env) => {
      const base = env || {};
      // Drop shell-session noise and Palm/runtime overrides.
      for (const key of Object.keys(base))
        if (
          /^(PALM_|NODE_OPTIONS$|DYLD_|LD_|_$|SHLVL$|PWD$|OLDPWD$|TERM_SESSION_ID$|ZDOTDIR$)/.test(key)
        )
          delete base[key];
      captured = {
        ...base,
        HOME: os.homedir(),
        USER: os.userInfo().username,
        LOGNAME: os.userInfo().username,
        SHELL: shell(),
        PATH: base.PATH || fallbackPath,
        LANG: base.LANG || "en_US.UTF-8",
      };
      capturing = null;
      return captured;
    });
  return capturing;
}

export async function which(name, env) {
  if (!/^[\w.+-]+$/.test(name)) return null;
  const search = (env?.PATH || (await userEnvironment()).PATH).split(":");
  for (const dir of search) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
}

export function loginShell() {
  return shell();
}

export function run(file, args, { timeout = 10000, env, cwd, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout, env, cwd, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        }),
    );
    if (input !== undefined) child.stdin?.end(input);
    else child.stdin?.end();
  });
}

// "~" and "~/x" from the phone mean this Mac user's home folder.
export function expandHome(value) {
  if (typeof value !== "string" || !value) return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
