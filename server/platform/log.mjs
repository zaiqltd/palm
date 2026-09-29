import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A small diagnostic log for "the connection keeps dropping": when Palm
// started and stopped, fatal errors with their stack, and when each phone
// connection closed and how. One JSON line per event, at most about 2 MB
// (the current file and one older). Never tokens, typed text, clipboard,
// file contents or screen frames.

const cap = 1024 * 1024;
let file = null;

export function openLog({ synthetic = false, dir = process.env.PALM_LOG_DIR } = {}) {
  if (synthetic && !dir) return;
  const folder = dir || path.join(os.homedir(), "Library/Logs/Palm");
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    file = path.join(folder, "host.log");
  } catch {
    file = null;
  }
}

export function log(kind, detail = {}) {
  if (!file) return;
  try {
    try {
      if (statSync(file).size > cap) renameSync(file, file + ".1");
    } catch {}
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, ...detail }) + "\n", { mode: 0o600 });
  } catch {}
}

/** Fatal errors are written down before Palm exits, so a crash leaves a trace. */
export function logCrashes() {
  process.on("uncaughtException", (error) => {
    log("crash", { error: String(error?.message || error).slice(0, 500), stack: String(error?.stack || "").slice(0, 4000) });
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    log("crash", { unhandled: true, error: String(error?.message || error).slice(0, 500), stack: String(error?.stack || "").slice(0, 4000) });
    process.exit(1);
  });
}
