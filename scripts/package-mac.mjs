import {
  cp,
  copyFile,
  mkdir,
  readFile,
  writeFile,
  chmod,
  readdir,
  rename,
  lstat,
} from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(
  root,
  "build/.palm-package-" + randomUUID(),
  "Palm.app",
);
const release = path.join(root, "build/release/Palm.app");
const contents = path.join(output, "Contents");
const runtime = path.join(contents, "Resources/palm");
const identity = process.env.PALM_MAC_SIGNING_IDENTITY || "-";
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
run("/usr/bin/swift", [
  path.join(root, "scripts/verify-signing.swift"),
  identity,
]);
run("/usr/bin/codesign", ["--verify", "--strict", process.execPath]);
const nodeDetails = spawnSync(
  "/usr/bin/codesign",
  ["-dv", "--verbose=2", process.execPath],
  { encoding: "utf8" },
);
if (
  nodeDetails.status !== 0 ||
  !nodeDetails.stderr.includes(
    "Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)",
  ) ||
  !nodeDetails.stderr.includes("TeamIdentifier=HX7739G8FX")
) {
  throw new Error(
    "Packaging requires the official Node.js Foundation signed standalone runtime.",
  );
}
const sourceNodeHash = createHash("sha256")
  .update(await readFile(process.execPath))
  .digest("hex");

// Refuse a dynamically linked Homebrew-style Node binary: a copied executable
// with unresolved package-manager libraries would not be a portable app.
const linked = execFileSync("/usr/bin/otool", ["-L", process.execPath], {
  encoding: "utf8",
});
if (
  linked
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .some((line) => !/^\s+\/(System\/Library|usr\/lib)\//.test(line))
) {
  throw new Error(
    "Use an official standalone Node distribution; this Node links external libraries.",
  );
}
await mkdir(path.join(contents, "MacOS"), { recursive: true });
await mkdir(runtime, { recursive: true });
run("/usr/bin/swiftc", [
  "native/PalmLauncher.swift",
  "-o",
  path.join(contents, "MacOS/Palm"),
  "-framework",
  "Cocoa",
]);
await cp(process.execPath, path.join(contents, "MacOS/node"));
await chmod(path.join(contents, "MacOS/node"), 0o755);
const copiedNodeHash = createHash("sha256")
  .update(await readFile(path.join(contents, "MacOS/node")))
  .digest("hex");
if (copiedNodeHash !== sourceNodeHash)
  throw new Error("Bundled Node differs from its verified source.");
run("/usr/bin/codesign", [
  "--verify",
  "--strict",
  path.join(contents, "MacOS/node"),
]);
for (const name of ["server", "dist", "shared"]) {
  await cp(path.join(root, name), path.join(runtime, name), {
    recursive: true,
  });
}
await mkdir(path.join(runtime, "node_modules"), { recursive: true });
// Runtime dependencies only: the WebSocket server and the headless terminal
// state used for persistent terminal sessions.
for (const dependency of ["ws", "@xterm/headless", "@xterm/addon-serialize"])
  await cp(
    path.join(root, "node_modules", dependency),
    path.join(runtime, "node_modules", dependency),
    { recursive: true },
  );
// The PTY helper for terminal sessions, built from native/palm-pty.c.
await mkdir(path.join(runtime, "build/bin"), { recursive: true });
run("/usr/bin/clang", ["-O2", "-Wall", "-o", path.join(runtime, "build/bin/palm-pty"), "native/palm-pty.c"]);
// verbatimSymlinks: the embedded WebRTC.framework's version symlinks must stay
// relative, or its signature breaks.
await cp(
  path.join(root, "build/Palm Companion.app"),
  path.join(runtime, "build/Palm Companion.app"),
  { recursive: true, verbatimSymlinks: true },
);
await writeFile(
  path.join(runtime, "package.json"),
  JSON.stringify({
    name: "palm-host",
    version: "0.4.0",
    private: true,
    type: "module",
  }),
);
const nodeLicence = await readFile(
  path.join(path.dirname(path.dirname(process.execPath)), "LICENSE"),
  "utf8",
);
let notices = `Palm runtime third-party licences\n\nNODE.JS\n${nodeLicence}`;
const lock = JSON.parse(
  await readFile(path.join(root, "package-lock.json"), "utf8"),
);
for (const [name, info] of Object.entries(lock.packages)) {
  if (!name.startsWith("node_modules/") || info.dev) continue;
  const folder = path.join(root, name);
  const licences = (await readdir(folder)).filter((file) =>
    /^(licen[cs]e|copying|notice)([.-]|$)/i.test(file),
  ).map((file) => path.join(folder, file));
  // npm tarballs for xterm.js packages omit the text of their MIT licence;
  // the repository's own LICENSE is vendored in licenses/.
  const vendored = {
    "node_modules/@xterm/headless": "licenses/xterm.js-LICENSE",
    "node_modules/@xterm/addon-serialize": "licenses/xterm.js-LICENSE",
  };
  if (!licences.length && vendored[name]) licences.push(path.join(root, vendored[name]));
  if (!licences.length)
    throw new Error(`No licence notice found for shipped dependency ${name}.`);
  notices += `\n\n${name.replace(/^node_modules\//, "")} ${info.version}\n`;
  for (const file of licences)
    notices += `\n${await readFile(file, "utf8")}\n`;
}
await writeFile(
  path.join(contents, "Resources/Third-Party-Licences.txt"),
  notices,
);
// Palm's hand as the app icon (scripts/render-brand.swift).
await copyFile(path.join(root, "native/Palm.icns"), path.join(contents, "Resources/Palm.icns"));
await writeFile(
  path.join(contents, "Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>local.palm.launcher</string>
<key>CFBundleName</key><string>Palm</string>
<key>CFBundleExecutable</key><string>Palm</string>
<key>CFBundleIconFile</key><string>Palm</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>44</string>
<key>CFBundleShortVersionString</key><string>0.4.0</string>
<key>LSMinimumSystemVersion</key><string>26.0</string>
<key>LSUIElement</key><true/>
<key>PalmBundledRuntime</key><true/>
<key>NSScreenCaptureUsageDescription</key><string>Palm shares your chosen Mac window with your paired iPhone.</string>
<key>NSCameraUsageDescription</key><string>Palm Companion streams this Mac's camera to your paired iPhone only while you turn it on.</string>
<key>NSMicrophoneUsageDescription</key><string>Palm Companion streams this Mac's microphone to your paired iPhone only while you turn it on.</string>
</dict></plist>`,
);
// Preserve the official Node binary's publisher signature and original entitlements.
run("/usr/bin/codesign", [
  "--force",
  "--sign",
  identity,
  "--identifier",
  "local.palm.pty",
  ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
  path.join(runtime, "build/bin/palm-pty"),
]);
run("/usr/bin/codesign", [
  "--force", "--sign", identity,
  ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
  "--entitlements", path.join(root, "native/PalmMedia.entitlements"),
  path.join(runtime, "build/Palm Companion.app"),
]);
run("/usr/bin/codesign", [
  "--force", "--sign", identity,
  ...(identity === "-" ? [] : ["--options", "runtime", "--timestamp"]),
  "--entitlements", path.join(root, "native/PalmMedia.entitlements"),
  output,
]);
for (const bundle of [path.join(runtime, "build/Palm Companion.app"), output]) {
  const inspection = spawnSync("/usr/bin/codesign", ["-d", "--entitlements", "-", bundle],
    { encoding: "utf8" });
  const details = `${inspection.stdout || ""}\n${inspection.stderr || ""}`;
  if (inspection.status !== 0 || !details.includes("com.apple.security.device.camera") ||
      !details.includes("com.apple.security.device.audio-input"))
    throw new Error(`Camera and microphone signing entitlements are missing from ${bundle}.`);
}
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", output]);
await mkdir(path.dirname(release), { recursive: true });
if (
  await lstat(release).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  })
) {
  const archive = path.join(root, ".local/package-archive");
  await mkdir(archive, { recursive: true, mode: 0o700 });
  await rename(
    release,
    path.join(
      archive,
      "Palm-" + new Date().toISOString().replaceAll(":", "-") + ".app",
    ),
  );
}
await rename(output, release);
await mkdir(path.join(root, "docs/evidence"), { recursive: true });
await writeFile(
  path.join(root, "docs/evidence/mac-package-build.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      artifact: release,
      signingCertificateSHA1: identity,
      signingTrust:
        identity === "-"
          ? "ad-hoc; no certificate"
          : "Apple code-signing policy and positive revocation response passed",
      node: {
        sourceSHA256: sourceNodeHash,
        copiedSHA256: copiedNodeHash,
        originalPublisherSignaturePreserved: true,
        originalPublisherVerified: "Node.js Foundation (HX7739G8FX)",
        strictSignatureVerified: true,
      },
      deepStrictBundleSignature: true,
      minimumMacOS: "26.0",
      architecture: process.arch,
      publicNotarisationVerified: false,
      runtimeRelocationVerified: false,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Built relocatable Mac app: ${release}`);
console.log(
  "Current build targets macOS 26.0 or later. Older macOS compatibility is unverified.",
);
console.log(
  identity === "-"
    ? "Local ad-hoc signature only; public distribution still requires Developer ID signing and notarisation."
    : "Signed bundle built. An Apple Development signature is for development; public Mac distribution still requires Developer ID signing and notarisation.",
);
