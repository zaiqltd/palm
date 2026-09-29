// Palm's web app in Safari's engine (WebKit) at iPhone 17 Pro Max size,
// against the test host (PALM_SYNTHETIC): pairing, Face ID (a software
// passkey), every tab and the live screen. Screenshots land in
// .local/web-parity/web/ for side-by-side checks with the iPhone app's own.
//
//   node tests/web-walkthrough.mjs [--only name,name] [--keep]
import { webkit } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",") : null;
const out = path.join(root, ".local/web-parity/web");
await mkdir(out, { recursive: true });

// ---- The test Mac ----
const state = await mkdtemp(path.join(os.tmpdir(), "palm-web-state-"));
const home = await mkdtemp(path.join(os.tmpdir(), "palm-web-home-"));
for (const folder of ["Documents", "Downloads", "Desktop", "work"]) await mkdir(path.join(home, folder), { recursive: true });
const port = 46000 + (process.pid % 1000);
const base = `http://localhost:${port}`;
const host = spawn(process.execPath, ["server/index.mjs"], {
  cwd: root,
  env: {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home, USER: os.userInfo().username, SHELL: "/bin/zsh", TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8",
    PALM_SYNTHETIC: "1", PALM_STATE_DIR: state, PALM_PORT: String(port), PALM_ORIGIN: "", PALM_COMPUTER_NAME: "Sample Mac",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let hostLog = "";
host.stdout.on("data", (d) => (hostLog += d));
host.stderr.on("data", (d) => (hostLog += d));
const cleanup = async () => {
  if (host.exitCode === null) host.kill();
  await rm(state, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
};
process.on("exit", () => host.exitCode === null && host.kill());
await Promise.race([once(host.stdout, "data"), new Promise((_, r) => setTimeout(() => r(new Error("host did not start\n" + hostLog)), 10000))]);

const api = async (route, body) => {
  const response = await fetch(base + "/api/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
};

// ---- Safari's engine, iPhone-sized, with a test passkey ----
const authenticatorSource = (await readFile(path.join(root, "tests/fixtures/soft-authenticator.js"), "utf8")).replaceAll("export ", "") + "\ninstallInPage();";
const installed = path.join(os.homedir(), "Library/Caches/ms-playwright/webkit-2336/pw_run.sh");
const browser = await webkit.launch(process.env.PALM_WEBKIT === "bundled" ? {} : { executablePath: installed });
const context = await browser.newContext({
  viewport: { width: 440, height: 956 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
});
await context.addInitScript({ content: authenticatorSource });
// The iPhone's safe areas (Dynamic Island, home indicator), as the app sees them in a Home Screen app.
await context.addInitScript(() => {
  Object.defineProperty(window.navigator, "standalone", { value: true });
  const add = () => {
    const style = document.createElement("style");
    style.textContent = ":root{--sat:62px!important;--sab:34px!important}";
    document.head.appendChild(style);
  };
  if (document.head) add();
  else document.addEventListener("DOMContentLoaded", add);
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const shot = async (name) => {
  if (only && !only.includes(name)) return;
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  console.log("shot", name);
};
const id = (value) => page.locator(`[data-id="${value}"]`);
let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log("✔", name);
  } catch (error) {
    failed = true;
    console.log("✖", name, "\n ", error.message.split("\n").slice(0, 6).join("\n  "));
    await page.screenshot({ path: path.join(out, `FAILED-${name.replace(/\W+/g, "-")}.png`) }).catch(() => {});
  }
};

try {
  const code = (await api("local/pair-code", {})).code;
  await step("pairing screen", async () => {
    await page.goto(`${base}/?phone=1#pair=${code}`);
    await page.getByRole("heading", { name: "Pair with your Mac" }).waitFor();
    await shot("pairing");
  });
  await step("pair and set up Face ID", async () => {
    await id("pair.connect").click();
    await page.getByRole("heading", { name: "Set up Face ID" }).waitFor();
    await shot("faceid-setup");
    await id("faceid.setup").click();
    await page.getByRole("navigation", { name: "Palm" }).waitFor({ timeout: 15000 });
  });
  await step("screen tab", async () => {
    await id("tab.screen").click();
    await id("screen.desktop").waitFor();
    await page.waitForTimeout(600);
    await shot("tab-screen");
  });
  await step("live screen", async () => {
    await id("screen.desktop").click();
    await page.locator(".remote-status").getByText("Live").waitFor({ timeout: 20000 });
    await page.waitForTimeout(1200);
    await shot("remote-touch");
  });
  await step("apps sheet", async () => {
    await id("remote.apps").click();
    await id("remote.appsSheet").waitFor();
    await page.waitForTimeout(800);
    await shot("remote-apps");
    await id("sheet.done").click();
  });
  await step("options sheet", async () => {
    await id("remote.options").click();
    await id("remote.optionsSheet").waitFor();
    await shot("remote-app-options");
    await id("sheet.done").click();
  });
  await step("landscape rail", async () => {
    await page.setViewportSize({ width: 956, height: 440 });
    await page.waitForTimeout(900);
    await shot("remote-landscape-rail");
    await page.setViewportSize({ width: 440, height: 956 });
  });
  await step("lock and unlock", async () => {
    await page.evaluate(() => fetch("/api/web/lock", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    await page.reload();
    await id("unlock.faceid").waitFor();
    await shot("unlock");
    await page.getByRole("navigation", { name: "Palm" }).waitFor({ timeout: 15000 });
  });
  const back = async () => {
    await id("nav.back").last().click();
    await page.waitForTimeout(400);
  };
  await step("assistant", async () => {
    await id("tab.assistant").click();
    await page.getByText("What needs my attention?").first().waitFor();
    await shot("tab-assistant");
    await page.getByText("What needs my attention?").first().click();
    await id("assistant.reply").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(800);
    await shot("assistant-session");
  });
  await step("agents list and a new task", async () => {
    await id("tab.agents").click();
    await page.waitForTimeout(1200);
    await shot("tab-agents");
    await id("agents.new").click();
    await id("newtask.message").waitFor();
    await id("newtask.message").fill("Say hello");
    await page.waitForTimeout(500);
    await shot("agent-new-task");
    await id("newtask.start").click();
    await id("task.composer").first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(2500);
    await shot("agent-working");
  });
  await step("files", async () => {
    await id("tab.files").click();
    await id("files.send").waitFor();
    await page.waitForTimeout(600);
    await shot("tab-files");
    await id("files.save").click();
    await page.locator('[data-id^="fs."]').first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    await shot("files-home");
    await back();
  });
  await step("more", async () => {
    await id("tab.more").click();
    await id("more.terminal").waitFor();
    await shot("tab-more");
  });
  await step("terminal", async () => {
    await id("more.terminal").click();
    await page.locator(".xterm-rows").waitFor({ timeout: 15000 });
    await page.waitForTimeout(1500);
    await shot("terminal-idle");
    await back();
  });
  await step("mac", async () => {
    await id("more.mac").click();
    await page.getByText("Dev servers", { exact: true }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    await shot("tab-mac");
    await back();
  });
  await step("preferences", async () => {
    await id("more.preferences").click();
    await page.getByText("Default agent", { exact: true }).waitFor();
    await page.waitForTimeout(800);
    await shot("preferences");
    await back();
  });
  await step("timings, settings, computers", async () => {
    await id("more.timings").click();
    await page.getByText("This phone", { exact: true }).waitFor();
    await shot("timings");
    await back();
    await id("more.settings").click();
    await page.getByText("Paired Mac", { exact: true }).waitFor();
    await shot("settings");
    await back();
    await id("more.computers").click();
    await id("computers.device").waitFor();
    await shot("computers");
    await back();
  });
  await step("camera and mic", async () => {
    await id("more.media").click();
    await id("media.start").waitFor();
    await shot("camera-and-mic");
    await back();
  });
} finally {
  if (errors.length) console.log("page errors:\n  " + [...new Set(errors)].slice(0, 12).join("\n  "));
  await browser.close();
  await cleanup();
}
process.exit(failed ? 1 : 0);
