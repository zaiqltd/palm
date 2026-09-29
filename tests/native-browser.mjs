import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await page.goto("http://localhost:4318");
  await page.getByRole("button", { name: "Open my workspace" }).click();
  await page
    .getByRole("heading", { name: "Your Mac. Within reach.", exact: true })
    .waitFor();
  const apps = await page.evaluate(() =>
    fetch("/api/apps").then((r) => r.json()),
  );
  const pad = apps.find((a) => a.bundleId === "local.palm.testpad");
  assert.ok(pad, "The isolated Palm Test Pad must be running.");
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  await page.getByPlaceholder("Find an app…").fill("Palm Test Pad");
  await page.getByRole("button", { name: /Palm Test Pad.*visible/ }).click();
  const status = await page.evaluate(() =>
    fetch("/api/status").then((r) => r.json()),
  );
  assert.equal(
    status.activeApp,
    "Palm Test Pad",
    "Refusing input unless the isolated test app is in front.",
  );
  assert.ok(status.screenPermission && status.controlPermission);
  await page.getByRole("button", { name: "Start session" }).click();
  await page
    .getByText("Live on your Mac", { exact: true })
    .waitFor({ timeout: 25000 });
  await page.getByRole("button", { name: "Type", exact: true }).click();
  await page
    .getByPlaceholder("Your iPhone keyboard, your Mac app…")
    .fill("Palm input verified ✓");
  assert.equal(
    (await page.evaluate(() => fetch("/api/status").then((r) => r.json())))
      .activeApp,
    "Palm Test Pad",
  );
  await page.locator('.typing-panel button[type="submit"]').click();
  await page.waitForTimeout(700);
  const typed = JSON.parse(
    await readFile(".local/test-pad-state.json", "utf8"),
  );
  assert.equal(typed.text, "Palm input verified ✓");
  await page.getByRole("button", { name: "Show app controls" }).click();
  await page.getByRole("button", { name: "Add note", exact: true }).waitFor();
  assert.equal(
    (await page.evaluate(() => fetch("/api/status").then((r) => r.json())))
      .activeApp,
    "Palm Test Pad",
  );
  await page.getByRole("button", { name: "Add note", exact: true }).click();
  await page.waitForTimeout(600);
  const acted = JSON.parse(
    await readFile(".local/test-pad-state.json", "utf8"),
  );
  assert.equal(acted.notes, 1);
  await page.screenshot({
    path: "test-results/real-mac-control.png",
    fullPage: true,
  });
  const metrics = await page.locator(".live-metrics").innerText();
  await writeFile(
    "test-results/native-verification.json",
    JSON.stringify(
      {
        date: new Date().toISOString(),
        video: true,
        typed: acted.text,
        buttonPresses: acted.notes,
        metrics,
        transport: "loopback",
        client: "Headless Chrome with iPhone viewport; not a physical iPhone",
      },
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "End", exact: true }).click();
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real Mac window capture, Unicode typing and native accessibility button activation. " +
      metrics.replace(/\n/g, " / "),
  );
} finally {
  await browser.close();
}
