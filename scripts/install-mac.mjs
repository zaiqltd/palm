#!/usr/bin/env node
// Installs the packaged Palm host (build/release/Palm.app) for this Mac user.
//
//   npm run package:mac && node scripts/install-mac.mjs
//
// - Stops only the installed Palm runtime (checked by its command line).
// - Never deletes: the previous app is moved to an archive folder, and when
//   PALM_CHANGELOG names a file the move is recorded there with the way back.
// - Keeps every pairing and permission; fails loudly if the paired devices change.
// - Shells in Palm's terminal service keep running through the update.
// - Writes docs/evidence/platform-host-update.json.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = os.homedir();
const installed = path.join(process.env.PALM_INSTALL_DIR || path.join(home, "Applications"), "Palm.app");
const source = path.join(root, "build/release/Palm.app");
const archiveDir =
  process.env.PALM_ARCHIVE_DIR ||
  path.join(home, "Applications/Palm Archive");
const changelog = process.env.PALM_CHANGELOG || "";
const origin = "http://localhost:4318";
const plist = (app) => {
  try {
    return execFileSync("/usr/bin/defaults", ["read", path.join(app, "Contents/Info.plist"), "CFBundleVersion"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

async function setup() {
  const response = await fetch(origin + "/api/local/setup", { headers: { Origin: origin } });
  if (!response.ok) throw new Error("Palm's setup page is unavailable.");
  return response.json();
}
const sha = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const devices = (state) => (state?.devices || []).filter((d) => d.kind === "native").map((d) => d.id).sort();

if (!existsSync(source)) throw new Error("Build the package first: npm run package:mac");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", source]);
const newBuild = plist(source);

let before = null;
let archive = null;
const oldBuild = existsSync(installed) ? plist(installed) : null;
try {
  before = await setup();
} catch {}
if (before?.status?.synthetic) throw new Error("Port 4318 is a test host, not the installed Palm.");

if (before) {
  const pid = Number(execFileSync("/usr/sbin/lsof", ["-nP", "-tiTCP:4318", "-sTCP:LISTEN"], { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("Expected one Palm listener on port 4318.");
  const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (!command.includes(installed + "/Contents/MacOS/node") || !command.includes("server/index.mjs"))
    throw new Error("The listener on 4318 is not the installed Palm runtime; stopping nothing.");
  process.kill(pid, "SIGTERM");
  for (let i = 0; ; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(pid, 0);
    } catch {
      break;
    }
    if (i === 60) throw new Error("The installed Palm did not stop.");
  }
}

const stamp = new Date().toISOString().replaceAll(":", "-");
if (existsSync(installed)) {
  await mkdir(archiveDir, { recursive: true });
  archive = path.join(archiveDir, `Palm-build-${oldBuild}-before-${newBuild}-${stamp}.app`);
  await rename(installed, archive);
  if (changelog && existsSync(changelog))
    await appendFile(
      changelog,
      `\n- ${stamp}: Palm host updated from build ${oldBuild} to ${newBuild}. The previous app moved from ${installed} to ${archive}. Way back: quit Palm, move the current app into ${archiveDir}, and move the archived app back to ${installed}.\n`,
    );
}
await mkdir(path.dirname(installed), { recursive: true });
execFileSync("/usr/bin/ditto", [source, installed]);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", installed]);
execFileSync("/usr/bin/open", [installed, "--args", "--quiet"]);

let after = null;
for (let i = 0; i < 60 && !after; i++) {
  await new Promise((r) => setTimeout(r, 250));
  after = await setup().catch(() => null);
}
if (!after) throw new Error("The updated Palm did not become ready.");
const preserved = !before || JSON.stringify(devices(before)) === JSON.stringify(devices(after));
if (!preserved) throw new Error("The set of paired iPhones changed during the update.");

const companion = "Contents/Resources/palm/build/Palm Companion.app/Contents/MacOS/PalmCompanion";
const evidence = {
  updatedAt: new Date().toISOString(),
  installedApp: installed,
  archive,
  build: newBuild,
  previousBuild: oldBuild,
  nativePairingCountBefore: devices(before).length,
  nativePairingCountAfter: devices(after).length,
  nativePairingsPreserved: preserved,
  screenPermission: after.status?.screenPermission,
  controlPermission: after.status?.controlPermission,
  synthetic: after.status?.synthetic,
  privatePort: 4318,
};
if (existsSync(path.join(installed, companion))) {
  evidence.nativeSHA256 = await sha(path.join(installed, companion));
  if (evidence.nativeSHA256 !== (await sha(path.join(source, companion))))
    throw new Error("The installed companion differs from the packaged one.");
}
const evidencePath = path.join(root, "docs/evidence/platform-host-update.json");
try {
  const old = JSON.parse(await readFile(evidencePath, "utf8"));
  evidence.priorInstalls = [...(old.priorInstalls ?? []), { updatedAt: old.updatedAt, archive: old.archive, build: old.build }];
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify(evidence, null, 2));
