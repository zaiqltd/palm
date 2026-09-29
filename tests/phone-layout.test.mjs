import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Native } from "../server/native.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const executable = path.join(
  root,
  "build/Palm Companion.app/Contents/MacOS/PalmCompanion",
);

test("native Phone Layout geometry respects work areas and user changes without AX access", async () => {
  const { stdout } = await promisify(execFile)(
    executable,
    ["--test-phone-layout"],
    { timeout: 5000 },
  );
  assert.deepEqual(JSON.parse(stdout), { ok: true, checks: 27 });
});

test("synthetic native portrait capture, desktop exemption, fallback and stop stay truthful", async () => {
  const native = new Native(root, { synthetic: true });
  let frameCount = 0;
  let config;
  native.on("event", (event) => {
    if (event.event === "frame") frameCount += 1;
    if (event.event === "config")
      config = { width: event.width, height: event.height };
  });
  async function waitForFrame() {
    const before = frameCount;
    for (let i = 0; i < 100; i++) {
      if (frameCount > before && config) return;
      await pause(20);
    }
    assert.fail("Synthetic video did not arrive.");
  }
  try {
    await assert.rejects(
      native.request({ op: "start", windowId: 7, phoneLayout: "true" }),
      /Invalid Phone Layout/,
    );
    const portrait = await native.request({
      op: "start",
      windowId: 7,
      phoneLayout: true,
    });
    assert.equal(portrait.synthetic, true);
    assert.deepEqual(
      [
        portrait.width,
        portrait.height,
        portrait.sourceWidth,
        portrait.sourceHeight,
      ],
      [460, 800, 460, 800],
    );
    assert.deepEqual(
      [
        portrait.phoneLayout.requested,
        portrait.phoneLayout.applied,
        portrait.phoneLayout.state,
      ],
      [true, false, "synthetic"],
    );
    await waitForFrame();
    assert.deepEqual(config, { width: 460, height: 800 });
    for (const invalid of [
      { phoneLayoutWidth: 758 },
      { phoneLayoutHeight: 409 },
      { phoneLayoutWidth: true, phoneLayoutHeight: 409 },
      { phoneLayoutWidth: 758, phoneLayoutHeight: 199 },
      { phoneLayoutWidth: 1401, phoneLayoutHeight: 409 },
      { phoneLayout: false, phoneLayoutWidth: 758, phoneLayoutHeight: 409 },
    ])
      await assert.rejects(
        native.request({
          op: "start",
          windowId: 7,
          phoneLayout: true,
          ...invalid,
        }),
        /viewport/,
      );
    for (const [requested, source, pixels] of [
      [
        [393, 700],
        [430, 765],
        [644, 1146],
      ],
      [
        [758, 409],
        [758, 409],
        [1136, 612],
      ],
      [
        [780, 300],
        [1040, 400],
        [1560, 600],
      ],
    ]) {
      config = null;
      const changed = await native.request({
        op: "start",
        windowId: 7,
        phoneLayout: true,
        phoneLayoutWidth: requested[0],
        phoneLayoutHeight: requested[1],
      });
      assert.equal(changed.phoneLayout.state, "synthetic");
      assert.deepEqual([changed.sourceWidth, changed.sourceHeight], source);
      assert.deepEqual([changed.width, changed.height], pixels);
      await waitForFrame();
      assert.deepEqual(config, { width: pixels[0], height: pixels[1] });
    }
    const firstClick = await native.request({
      op: "pointer",
      action: "click",
      x: 0.5,
      y: 0.5,
    });
    const secondClick = await native.request({
      op: "pointer",
      action: "doubleSecond",
      x: 0.5,
      y: 0.5,
    });
    assert.equal(firstClick.syntheticInputSequence, 1);
    assert.equal(secondClick.syntheticInputSequence, 2);
    config = null;
    const desktop = await native.request({
      op: "start",
      windowId: 0,
      phoneLayout: true,
    });
    assert.equal(desktop.phoneLayout.state, "desktop");
    assert.equal(desktop.phoneLayout.applied, false);
    assert.deepEqual([desktop.width, desktop.height], [1280, 800]);
    await waitForFrame();
    assert.deepEqual(config, { width: 1280, height: 800 });
    const ordinary = await native.request({ op: "start", windowId: 7 });
    assert.equal(ordinary.phoneLayout.state, "off");
    assert.deepEqual(
      [ordinary.sourceWidth, ordinary.sourceHeight],
      [1280, 800],
    );
    // Opening an app fills the Mac screen: the window keeps the Mac's shape.
    const filled = await native.request({ op: "start", windowId: 7, fill: true });
    assert.deepEqual(
      [filled.phoneLayout.requested, filled.phoneLayout.state],
      [true, "synthetic"],
    );
    assert.deepEqual([filled.sourceWidth, filled.sourceHeight], [1280, 800]);
    await assert.rejects(
      native.request({ op: "start", windowId: 7, fill: "yes" }),
      /Invalid window layout/,
    );
    await assert.rejects(
      native.request({ op: "start", windowId: 7, fill: true, phoneLayout: true }),
      /one window layout/,
    );
    const desktopFill = await native.request({ op: "start", windowId: 0, fill: true });
    assert.equal(desktopFill.phoneLayout.state, "off", "the desktop is never resized");
    const stopped = await native.request({ op: "stop" });
    assert.deepEqual(stopped, { ok: true, phoneLayoutRestore: "unchanged" });
    const afterStop = frameCount;
    await pause(150);
    assert.equal(
      frameCount,
      afterStop,
      "A retired encoder emitted a late frame after stop acknowledgement.",
    );
    // Bypass Node's normal serialization to exercise the companion's own generation checks.
    const [startResult, stopResult] = await Promise.allSettled([
      native.rawRequest({ op: "start", windowId: 7, phoneLayout: true }),
      native.rawRequest({ op: "stop" }),
    ]);
    assert.equal(stopResult.status, "fulfilled");
    assert.equal(stopResult.value.ok, true);
    if (startResult.status === "rejected")
      assert.match(startResult.reason.message, /session changed/);
    const afterConcurrentStop = frameCount;
    await pause(150);
    assert.equal(
      frameCount,
      afterConcurrentStop,
      "A superseded start resumed streaming after stop.",
    );
  } finally {
    await native.close();
  }
});
