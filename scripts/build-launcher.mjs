import { mkdir, writeFile, chmod } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = path.join(root, "build/Palm.app");
const identity = process.env.PALM_MAC_SIGNING_IDENTITY || "-";
execFileSync(
  "/usr/bin/swift",
  [path.join(root, "scripts/verify-signing.swift"), identity],
  { stdio: "inherit" },
);
await mkdir(path.join(app, "Contents/MacOS"), { recursive: true });
execFileSync(
  "/usr/bin/swiftc",
  [
    "native/PalmLauncher.swift",
    "-o",
    path.join(app, "Contents/MacOS/Palm"),
    "-framework",
    "Cocoa",
  ],
  { cwd: root, stdio: "inherit" },
);
const xml = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
await writeFile(
  path.join(app, "Contents/Info.plist"),
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.palm.launcher</string><key>CFBundleName</key><string>Palm</string><key>CFBundleExecutable</key><string>Palm</string><key>CFBundlePackageType</key><string>APPL</string><key>PalmProjectRoot</key><string>${xml(root)}</string><key>PalmNodePath</key><string>${xml(process.execPath)}</string><key>CFBundleVersion</key><string>2</string><key>CFBundleShortVersionString</key><string>0.2.0</string><key>LSMinimumSystemVersion</key><string>26.0</string><key>LSUIElement</key><true/></dict></plist>`,
);
execFileSync("/usr/bin/codesign", ["--force", "--sign", identity, app], {
  stdio: "ignore",
});
execFileSync("/usr/bin/codesign", ["--verify", "--strict", app], {
  stdio: "inherit",
});
console.log("Built Palm.app.");
