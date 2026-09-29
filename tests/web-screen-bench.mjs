// How the web app's live screen keeps up: pictures received, decoded and
// drawn per second, and how smooth the page stays (animation-frame gaps)
// while a finger scrolls the Mac, against the test host. Compares the GPU
// worker (default) with the main-thread picture (?mainvideo).
//
//   node tests/web-screen-bench.mjs
import { webkit } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = await mkdtemp(path.join(os.tmpdir(), "palm-bench-state-"));
const home = await mkdtemp(path.join(os.tmpdir(), "palm-bench-home-"));
const port = 47000 + (process.pid % 900);
const base = `http://localhost:${port}`;
const host = spawn(process.execPath, ["server/index.mjs"], {
  cwd: root,
  env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, USER: os.userInfo().username, SHELL: "/bin/zsh", TMPDIR: os.tmpdir(), PALM_SYNTHETIC: "1", PALM_STATE_DIR: state, PALM_PORT: String(port), PALM_ORIGIN: "", PALM_COMPUTER_NAME: "Sample Mac" },
  stdio: ["ignore", "pipe", "pipe"],
});
await once(host.stdout, "data");
const authenticator = (await readFile(path.join(root, "tests/fixtures/soft-authenticator.js"), "utf8")).replaceAll("export ", "") + "\ninstallInPage();";
const browser = await webkit.launch(process.env.PALM_WEBKIT === "bundled" ? {} : { executablePath: path.join(os.homedir(), "Library/Caches/ms-playwright/webkit-2336/pw_run.sh") });

async function run(mode) {
  const context = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await context.addInitScript({ content: authenticator });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const code = (await (await fetch(base + "/api/local/pair-code", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{}" })).json()).code;
  await page.goto(`${base}/?phone=1&debug=1${mode === "main" ? "&mainvideo=1" : ""}#pair=${code}`);
  await page.locator('[data-id="pair.connect"]').click();
  await page.locator('[data-id="faceid.setup"]').click();
  await page.getByRole("navigation", { name: "Palm" }).waitFor({ timeout: 15000 });
  await page.locator('[data-id="tab.screen"]').click();
  await page.locator('[data-id="screen.desktop"]').click();
  await page.locator(".remote-status").getByText("Live").waitFor({ timeout: 20000 });
  await page.waitForTimeout(2000);
  const result = await page.evaluate(async () => {
    const c = window.__palm.connection;
    const v = c.video;
    const gaps = [];
    let last = performance.now();
    let running = true;
    const tick = (t) => {
      gaps.push(t - last);
      last = t;
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    await new Promise((r) => setTimeout(r, 1200));
    const before = { ...v.diagnostics };
    const started = performance.now();
    // A finger scrolling the Mac for five seconds: the remote scroll path.
    const end = started + 5000;
    while (performance.now() < end) {
      c.sendScroll?.(0, 40);
      await new Promise((r) => setTimeout(r, 16));
    }
    await new Promise((r) => setTimeout(r, 1200));
    running = false;
    const after = { ...v.diagnostics };
    const seconds = (performance.now() - started) / 1000;
    const sorted = gaps.slice(5).sort((a, b) => a - b);
    return {
      received: Math.round((after.receivedPackets - before.receivedPackets) / seconds),
      decoded: after.submittedFrames !== undefined ? Math.round((after.submittedFrames - before.submittedFrames) / seconds) : null,
      drawn: after.drawnFrames !== undefined ? Math.round((after.drawnFrames - before.drawnFrames) / seconds) : null,
      keyframeWaits: (after.keyframeWaitDrops || 0) - (before.keyframeWaitDrops || 0),
      backpressure: (after.backpressureFlushes || 0) - (before.backpressureFlushes || 0),
      frameGapMedian: Math.round(sorted[sorted.length >> 1]),
      frameGapP95: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
      jankOver50ms: sorted.filter((g) => g > 50).length,
      decodeDelayAvgMs: after.decodeDelayAvgMs ?? null,
      maxDecodeQueue: after.maxQueue ?? null,
      canvas: `${v.canvas.width}x${v.canvas.height}`,
      avcC: c.lastVideoConfig?.description,
      worker: !!v.worker,
    };
  });
  await context.close();
  return { mode, ...result, errors: errors.slice(0, 3) };
}

try {
  for (const mode of ["main", "worker"]) console.log(JSON.stringify(await run(mode)));
} finally {
  await browser.close();
  host.kill();
  await rm(state, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
