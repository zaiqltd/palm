#!/usr/bin/env node
// Runs Palm's iPhone UI tests in the Simulator against an isolated test host.
//
// The host is Palm's own server in test mode (PALM_SYNTHETIC=1): a simulated
// Mac screen, scripted agents instead of Claude Code and Codex, and no real
// lock, sleep, display or network actions. It runs with a throwaway HOME that
// holds sample files and a sample web project, its own state folder and its
// own ports, so the tests never read or change the real home folder.
//
//   node scripts/ios-ui-tests.mjs [--device "iPhone 17 Pro"] [--only testName[,testName2]]
//
// Screenshots from every test land in .local/ui-test-runs/<time>/screens.
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, rename, rm, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
// The reference phone is an iPhone 15 Pro Max on iOS 26; the nearest Simulator.
const device = option("--device", "iPhone 17 Pro Max");
const osVersion = option("--os", "26.5");
const only = option("--only", null);
// --demo records the paced demo walk-throughs (testDemo*) for Palm's product
// video: the test host shows a sample desktop and its agents do realistic
// work, the Simulator's screen is recorded to demo.mp4, nothing is asserted
// beyond what the walk-through needs.
const demo = args.includes("--demo");
// --remote <url> records the remote walk-throughs (testRemote*) against a real
// Mac running Palm (the product film's demo VM, through its tunnel) to
// remote.mp4, with each beat's time in film-events.log.
const remote = option("--remote", null);
// testRemote2Window (one window, phone-shaped) runs with --only: window capture
// in the demo VM never started streaming.
const remoteTests = ["testRemote1WholeMac"];
const filmEvents = [];
const demoTests = ["testDemo1AgentsAndApproval", "testDemo2Screen", "testDemo3EveryAgent", "testDemo4Files", "testDemo5Assistant", "testDemo6Terminal"];
// xcodebuild needs Xcode itself; a shell may point DEVELOPER_DIR at the
// Command Line Tools (for git and python3), so it is not inherited here.
const developerDir = process.env.PALM_XCODE_DEVELOPER_DIR || "/Applications/Xcode.app/Contents/Developer";

for (const needed of ["build/Palm Companion.app/Contents/MacOS/PalmCompanion", "build/bin/palm-pty"])
  if (!existsSync(path.join(root, needed))) throw new Error(`Missing ${needed}. Run npm run native:build first.`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const run = path.join(root, ".local/ui-test-runs", stamp);
const home = path.join(run, "home");
const state = path.join(run, "state");
await mkdir(state, { recursive: true, mode: 0o700 });
await writeFixture(home);
const demoScreens = path.join(root, "demo/mac-screens");
const demoScreen = path.join(run, "screen.png");
if (demo) {
  await writeDemoFixture(home);
  await writeFile(demoScreen, await readFile(path.join(demoScreens, "before.png")));
}

const port = await freePort();
const slots = [await freePort(), await freePort(), await freePort()];
const nodeBin = path.dirname(process.execPath);
const host = spawn(process.execPath, [path.join(root, "server/index.mjs")], {
  cwd: root,
  env: {
    PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    USER: os.userInfo().username,
    SHELL: "/bin/zsh",
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    PALM_SYNTHETIC: "1",
    PALM_STATE_DIR: state,
    PALM_PORT: String(port),
    PALM_PREVIEW_SLOTS: slots.map((local, i) => `${18444 + i}:${local}`).join(","),
    ...(demo
      ? { PALM_DEMO: "1", PALM_COMPUTER_NAME: "MacBook Pro", PALM_DEMO_SCREENS: demoScreens, PALM_SYNTHETIC_SCREEN: demoScreen }
      : {}),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let hostLog = "";
host.stdout.on("data", (d) => (hostLog += d));
host.stderr.on("data", (d) => (hostLog += d));
// A second, isolated test Mac ("Studio Mac") for the several-computers tests:
// its own throwaway home, state, port and preview slots.
const home2 = path.join(run, "home-studio");
const state2 = path.join(run, "state-studio");
await mkdir(state2, { recursive: true, mode: 0o700 });
for (const folder of ["Documents", "Downloads", "work"]) await mkdir(path.join(home2, folder), { recursive: true });
await writeFile(path.join(home2, "Documents/studio-notes.txt"), "Only on the Studio Mac.\n");
const port2 = await freePort();
const slots2 = [await freePort(), await freePort(), await freePort()];
const host2 = spawn(process.execPath, [path.join(root, "server/index.mjs")], {
  cwd: root,
  env: {
    PATH: `${nodeBin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home2,
    USER: os.userInfo().username,
    SHELL: "/bin/zsh",
    TMPDIR: os.tmpdir(),
    LANG: "en_US.UTF-8",
    PALM_SYNTHETIC: "1",
    PALM_STATE_DIR: state2,
    PALM_PORT: String(port2),
    PALM_COMPUTER_NAME: "Studio Mac",
    PALM_PREVIEW_SLOTS: slots2.map((local, i) => `${18544 + i}:${local}`).join(","),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
host2.stdout.on("data", (d) => (hostLog += d));
host2.stderr.on("data", (d) => (hostLog += d));
const stopHost = () => {
  if (host.exitCode === null) host.kill("SIGTERM");
  if (host2.exitCode === null) host2.kill("SIGTERM");
};
process.on("exit", stopHost);
// Exiting through process.exit runs the handler above, so the test host never
// outlives this script.
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("SIGHUP", () => process.exit(129));

await waitForHost(`http://127.0.0.1:${port}`);
await waitForHost(`http://127.0.0.1:${port2}`);
console.log(`Test host on http://127.0.0.1:${port} with HOME=${home}`);
if (args.includes("--serve")) {
  // Manual checks: keep the test host running until this process is stopped.
  console.log("Serving until stopped (Ctrl-C).");
  await new Promise(() => {});
}

const result = path.join(run, "ui.xcresult");
const xcodeArgs = [
  "-project", path.join(root, "ios/Palm.xcodeproj"),
  "-scheme", "Palm",
  "-destination", `platform=iOS Simulator,name=${device},OS=${osVersion}`,
  "-derivedDataPath", path.join(root, ".local/sim-derived-data"),
  "-resultBundlePath", result,
  "-skipPackagePluginValidation",
  // A failed run otherwise spends ten minutes collecting Simulator diagnostics.
  "-collect-test-diagnostics", "never",
  // --only takes one test name or several, comma-separated, run in order.
  ...(only || demo || remote
    ? (only ? only.split(",") : remote ? remoteTests : demoTests).map((name) => `-only-testing:PalmUITests/PalmUITests/${name.trim()}`)
    : ["-only-testing:PalmUITests"]),
  "test",
];
const recording = demo || remote ? await startRecording(path.join(run, remote ? "remote.mp4" : "demo.mp4")) : null;
const code = await new Promise((resolve) => {
  const child = spawn("xcodebuild", xcodeArgs, {
    env: {
      ...process.env, DEVELOPER_DIR: developerDir, TEST_RUNNER_PALM_UITEST_HOST: remote || `http://127.0.0.1:${port}`,
      TEST_RUNNER_PALM_UITEST_HOST2: `http://127.0.0.1:${port2}`,
      ...(demo ? { TEST_RUNNER_PALM_UITEST_DEMO: "1" } : {}),
      ...(remote ? { TEST_RUNNER_PALM_UITEST_REMOTE: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let tail = "";
  const keep = (d) => {
    const text = String(d);
    tail = (tail + text).slice(-20000);
    for (const line of text.split("\n")) {
      if (line.includes("PALMFILM ")) filmEvents.push(line.slice(line.indexOf("PALMFILM ")).trim());
      if (/Test Case .*(passed|failed)|error:|\*\* TEST|Executed \d+ test/.test(line)) console.log(line.trim());
    }
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  child.on("exit", (status) => {
    if (status !== 0) console.log(tail.split("\n").slice(-40).join("\n"));
    resolve(status);
  });
});

if (recording) await recording.stop();
if (filmEvents.length) await writeFile(path.join(run, "film-events.log"), filmEvents.join("\n") + "\n");
const screens = path.join(run, "screens");
await mkdir(screens, { recursive: true });
try {
  execFileSync("xcrun", ["xcresulttool", "export", "attachments", "--path", result, "--output-path", screens], {
    env: { ...process.env, DEVELOPER_DIR: developerDir },
    stdio: "ignore",
  });
} catch {}
// Name each screenshot after the test's attachment name.
try {
  const manifest = JSON.parse(await readFile(path.join(screens, "manifest.json"), "utf8"));
  for (const test of manifest)
    for (const item of test.attachments || []) {
      const from = path.join(screens, item.exportedFileName);
      const readable = String(item.suggestedHumanReadableName || "").replace(/_\d+_[0-9A-F-]{36}(\.\w+)?$/i, "");
      const ext = path.extname(item.exportedFileName);
      // Screenshots and screen recordings stay; hierarchy dumps go.
      if (readable.startsWith("debug-")) await rename(from, path.join(screens, `${readable.replace(/\.txt$/, "")}.txt`)).catch(() => {});
      else if ([".png", ".mp4"].includes(ext) && readable)
        await rename(from, path.join(screens, `${readable.replace(/\.(png|mp4)$/i, "")}${ext}`)).catch(() => {});
      else if (![".png", ".mp4"].includes(ext)) await rm(from, { force: true }).catch(() => {});
    }
} catch {}
await writeFile(path.join(run, "host.log"), hostLog.replace(/[A-Z0-9]{10}/g, "[code]"));
stopHost();
const files = (await readdir(screens).catch(() => [])).filter((f) => f.endsWith(".png"));
console.log(`\n${code === 0 ? "PASSED" : "FAILED"} · ${files.length} screenshots in ${screens}`);
// The throwaway home holds only generated sample files.
await rm(home, { recursive: true, force: true }).catch(() => {});
await rm(home2, { recursive: true, force: true }).catch(() => {});
process.exit(code ?? 1);

// ---------------------------------------------------------------------------

// The Simulator's screen, recorded while the demo walk-throughs run, with a
// clean status bar (9:41, full signal and battery).
async function startRecording(file) {
  const env = { ...process.env, DEVELOPER_DIR: developerDir };
  const list = JSON.parse(execFileSync("xcrun", ["simctl", "list", "devices", "available", "-j"], { env, encoding: "utf8" }));
  const runtime = Object.keys(list.devices).find((k) => k.endsWith(`iOS-${osVersion.replace(".", "-")}`));
  const sim = (list.devices[runtime] || []).find((d) => d.name === device);
  if (!sim) throw new Error(`No Simulator named ${device} on iOS ${osVersion}.`);
  try { execFileSync("xcrun", ["simctl", "boot", sim.udid], { env, stdio: "ignore" }); } catch {}
  execFileSync("xcrun", ["simctl", "bootstatus", sim.udid, "-b"], { env, stdio: "ignore" });
  execFileSync("xcrun", ["simctl", "status_bar", sim.udid, "override", "--time", "9:41", "--dataNetwork", "wifi", "--wifiMode", "active",
    "--wifiBars", "3", "--cellularMode", "active", "--cellularBars", "4", "--batteryState", "charged", "--batteryLevel", "100"], { env, stdio: "ignore" });
  const child = spawn("xcrun", ["simctl", "io", sim.udid, "recordVideo", "--codec=h264", "--force", file], { env, stdio: ["ignore", "pipe", "pipe"] });
  // The moment the recording starts, for lining it up with the film's beats.
  const started = (d) => {
    if (/Recording started/i.test(String(d)) && !filmEvents.some((e) => e.endsWith(" recording-started")))
      filmEvents.push(`PALMFILM ${(Date.now() / 1000).toFixed(3)} recording-started`);
  };
  child.stdout.on("data", started);
  child.stderr.on("data", started);
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`Recording the Simulator to ${file}`);
  return {
    stop: () => new Promise((resolve) => {
      child.on("exit", () => {
        try { execFileSync("xcrun", ["simctl", "status_bar", sim.udid, "clear"], { env, stdio: "ignore" }); } catch {}
        resolve();
      });
      child.kill("SIGINT");
    }),
  };
}

// Sample files for demo recordings: a web project, invoices and documents
// with believable names and ages.
async function writeDemoFixture(dir) {
  const project = path.join(dir, "Developer/acme-web");
  for (const folder of ["src/components", "src/styles", "tests"]) await mkdir(path.join(project, folder), { recursive: true });
  await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "acme-web", private: true, scripts: { dev: "node server.mjs", test: "vitest run" } }, null, 2));
  await writeFile(path.join(project, "server.mjs"), await readFile(path.join(dir, "work/apps/sample-site/server.mjs"), "utf8"));
  await writeFile(path.join(project, "src/components/Settings.tsx"), "export function Settings() {\n  return <section className=\"settings\" />;\n}\n");
  await writeFile(path.join(project, "src/styles/theme.css"), ":root { color-scheme: light dark; }\n");
  await writeFile(path.join(project, "tests/checkout.test.ts"), "describe(\"checkout\", () => {});\n");
  await writeFile(path.join(project, "README.md"), "# acme-web\n\nThe Acme customer app.\n");
  const invoices = path.join(dir, "Documents/Invoices");
  await mkdir(invoices, { recursive: true });
  const day = 86400;
  const now = Date.now() / 1000;
  const files = [
    ["Documents/Invoices/Invoice 1040.pdf", pdf("Invoice 1040"), 30 * day],
    ["Documents/Invoices/Invoice 1041.pdf", pdf("Invoice 1041"), 12 * day],
    ["Documents/Invoices/Invoice 1042.pdf", pdf("Invoice 1042"), 0.2 * day],
    ["Documents/Q3 report.pdf", pdf("Q3 report"), 2 * day],
    ["Documents/Offsite plan.md", "# Offsite plan\n", 5 * day],
    ["Downloads/brand-guidelines.pdf", pdf("Brand guidelines"), 1 * day],
    ["Desktop/Launch checklist.md", "# Launch checklist\n", 0.5 * day],
  ];
  for (const [rel, body, age] of files) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body);
    await utimes(full, now - age, now - age);
  }
  await utimes(project, now - 600, now - 600);
}

// A small valid one-page PDF with a title.
function pdf(title) {
  const text = `BT /F1 24 Tf 72 720 Td (${title}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  // Real PDFs are tens of kilobytes; a comment block gives these a believable size.
  let out = "%PDF-1.4\n" + ("%" + "0".repeat(99) + "\n").repeat(820);
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

async function writeFixture(dir) {
  const site = path.join(dir, "work/apps/sample-site");
  await mkdir(site, { recursive: true });
  for (const folder of ["Desktop", "Documents", "Downloads", "Pictures"]) await mkdir(path.join(dir, folder), { recursive: true });
  await writeFile(
    path.join(site, "package.json"),
    JSON.stringify({ name: "sample-site", private: true, scripts: { dev: "node server.mjs", build: "echo built" } }, null, 2),
  );
  await writeFile(
    path.join(site, "server.mjs"),
    `import http from "node:http";
const port = Number(process.env.PORT || 0);
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sample Site</title>' +
    '<body style="font:18px -apple-system;background:#fff;color:#111;padding:24px"><h1>Hello from the sample site</h1><p>Served on the test Mac.</p></body>');
});
server.listen(port, "127.0.0.1", () => console.log("Local: http://127.0.0.1:" + server.address().port + "/"));
`,
  );
  await writeFile(path.join(site, "README.md"), "# Sample site\n\nA fixture for Palm's UI tests.\n");
  await writeFile(path.join(dir, "Documents/notes.txt"), "Palm UI test notes.\nLine two.\n");
  // Real requests from daily use: a daily log for a manager, and Downloads.
  await writeFile(path.join(dir, "Documents/Daily log 22 Sep.txt"), "Sample daily log.\n");
  await writeFile(path.join(dir, "Downloads/boarding-pass.pdf"), "%PDF-1.4 sample\n");
  await writeFile(path.join(dir, "Documents/Proposal - Acme.docx"), "Sample proposal.\n");
  // A 2×2 PNG.
  await writeFile(
    path.join(dir, "Pictures/sample.png"),
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64"),
  );
  await writeFile(
    path.join(dir, ".zshrc"),
    `export PATH="${path.dirname(process.execPath)}:$PATH"\nexport DEVELOPER_DIR=/Library/Developer/CommandLineTools\nPROMPT='%~ %# '\n`,
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHost(origin) {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${origin}/api/session`, { headers: { Origin: origin } });
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`The test host did not start:\n${hostLog}`);
}
