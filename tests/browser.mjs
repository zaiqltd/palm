import { chromium, webkit } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const base = process.env.PALM_TEST_URL || "http://localhost:4319";
await mkdir("test-results", { recursive: true });
const browser =
  process.env.PALM_TEST_ENGINE === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ headless: true, channel: "chrome" });
const errors = [];
try {
  const desktop = await browser.newPage({
    viewport: { width: 1440, height: 1100 },
  });
  desktop.on("pageerror", (e) => errors.push(e.message));
  await desktop.goto(base + "/?demo=1");
  await desktop
    .getByRole("heading", { name: "Your Mac. Within reach.", exact: true })
    .waitFor();
  await desktop.screenshot({
    path: "test-results/desktop.png",
    fullPage: true,
  });
  assert.equal(
    await desktop.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await desktop.getByRole("button", { name: "Apps", exact: true }).click();
  await desktop.getByPlaceholder("Find an app…").fill("Safari");
  assert.equal(await desktop.locator(".app-card").count(), 1);
  await desktop.getByRole("button", { name: /Safari/ }).click();
  await desktop.getByRole("button", { name: "Preview control view" }).click();
  await desktop
    .getByRole("heading", { name: "Your desktop belongs here." })
    .waitFor();
  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  mobile.on("pageerror", (e) => errors.push(e.message));
  await mobile.goto(base + "/?demo=1");
  await mobile
    .getByRole("heading", { name: "Your Mac. Within reach.", exact: true })
    .waitFor();
  await mobile.screenshot({ path: "test-results/iphone.png", fullPage: true });
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await mobile.getByRole("button", { name: "Files", exact: true }).click();
  await mobile.getByRole("heading", { name: "Right here." }).waitFor();
  await mobile.getByRole("button", { name: "Settings", exact: true }).click();
  await mobile.getByRole("heading", { name: /Make yourself/ }).waitFor();
  assert.equal(
    await mobile.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  const live = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  live.on("pageerror", (e) => errors.push(e.message));
  await live.goto(base);
  await live.getByRole("button", { name: "Open my workspace" }).click();
  await live
    .getByRole("heading", { name: "Your Mac. Within reach.", exact: true })
    .waitFor();
  await live.getByRole("button", { name: "Open desktop" }).click();
  await live.getByRole("button", { name: "Start session" }).click();
  await live
    .getByText("Live on your Mac", { exact: true })
    .waitFor({ timeout: 25000 });
  await live.waitForTimeout(2200);
  const canvas = await live.locator("canvas").evaluate((c) => ({
    width: c.width,
    height: c.height,
    pixel: Array.from(c.getContext("2d").getImageData(20, 20, 1, 1).data),
  }));
  assert.equal(canvas.width, 1280);
  assert.ok(canvas.pixel[1] > 20);
  await live.screenshot({
    path: "test-results/synthetic-stream.png",
    fullPage: true,
  });
  await live.getByRole("button", { name: "Type", exact: true }).click();
  await live
    .getByPlaceholder("Your iPhone keyboard, your Mac app…")
    .fill("Synthetic input only");
  await live.locator('.typing-panel button[type="submit"]').click();
  await live.getByRole("button", { name: "End", exact: true }).click();
  await live.getByRole("button", { name: "Start session" }).waitFor();
  await live.getByRole("button", { name: "Start session" }).click();
  await live
    .getByText("Live on your Mac", { exact: true })
    .waitFor({ timeout: 25000 });
  await live.getByRole("button", { name: "End", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: desktop/mobile layouts, app search, navigation, synthetic H.264 decoding, text protocol, and reconnect.",
  );
} finally {
  await browser.close();
}
