import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TerminalService } from "../server/terminal/service.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const helper = path.join(root, "build/bin/palm-pty");

// A stand-in phone connection that records what Palm sends it.
function phone() {
  const received = [];
  const client = {
    ws: { readyState: 1, bufferedAmount: 0, send: (raw) => received.push(JSON.parse(raw)) },
    send: (message) => received.push(message),
    received,
    text: () => received.filter((m) => m.event === "terminal.output" || m.event === "terminal.snapshot").map((m) => m.data).join(""),
  };
  return client;
}

async function until(check, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("shells in the terminal service survive Palm stopping and reconnecting", { timeout: 40000 }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "palm-terminal-service-"));
  process.env.PALM_TERMINALD_IDLE_MS = "400";
  let service = await new TerminalService({ stateDir, helper, version: "test-1" }).start();
  try {
    const created = await service.create({ cwd: os.tmpdir(), command: "echo first-life", cols: 80, rows: 24 });
    assert.equal(service.list().length, 1, "the list updates before create returns");
    const first = phone();
    await service.attach(first, created.id, { cols: 80, rows: 24 });
    assert.ok(await until(() => first.text().includes("first-life")), "output reaches the phone");

    // Palm stops (update, restart): the shell keeps running in the service.
    service.disconnect();
    await new Promise((r) => setTimeout(r, 600));
    service = await new TerminalService({ stateDir, helper, version: "test-1" }).start();
    const listed = service.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.id);
    assert.equal(listed[0].running, true, "the shell outlived Palm");

    // A phone reattaches and gets the screen as it was, then live input.
    const second = phone();
    await service.attach(second, created.id, { cols: 80, rows: 24 });
    assert.ok(await until(() => second.text().includes("first-life")), "snapshot restores the screen");
    service.input(created.id, "echo second-$((20+22))\r");
    assert.ok(await until(() => second.text().includes("second-42")), "input after reconnecting runs");

    // A newer Palm version keeps the older service until its shells end.
    service.disconnect();
    service = await new TerminalService({ stateDir, helper, version: "test-2" }).start();
    const hello = await service.request({ op: "hello" });
    assert.equal(hello.version, "test-1");
    const pid = hello.pid;
    await service.close(created.id);
    assert.ok(await until(() => !alive(pid), 5000), "a retired service leaves once its shells are gone");
  } finally {
    service.disconnect();
    delete process.env.PALM_TERMINALD_IDLE_MS;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("Palm's own list listener runs while the service starts, and a dropped link reattaches phones", { timeout: 40000 }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "palm-terminal-link-"));
  process.env.PALM_TERMINALD_IDLE_MS = "400";
  // Like server/index.mjs: the listener reads the service, which is not
  // assigned until start() returns. Build 6 fell back to in-process shells here.
  let service = null;
  const published = [];
  const started = new TerminalService({ stateDir, helper, version: "link", onChange: () => published.push(service.list().length) });
  service = await started.start();
  try {
    assert.equal(service, started, "start() succeeds even though its first list update threw");
    const created = await service.create({ cwd: os.tmpdir(), command: "echo linked-once", cols: 80, rows: 24 });
    const viewer = phone();
    await service.attach(viewer, created.id, { cols: 80, rows: 24 });
    assert.ok(await until(() => viewer.text().includes("linked-once")));

    // Another connection takes the service over (as a newer Palm would); the
    // first Palm reconnects by itself and its phone gets a fresh screen.
    const snapshotsBefore = viewer.received.filter((m) => m.event === "terminal.snapshot").length;
    const intruder = await new TerminalService({ stateDir, helper, version: "link" }).start();
    intruder.disconnect();
    assert.ok(
      await until(() => viewer.received.filter((m) => m.event === "terminal.snapshot").length > snapshotsBefore),
      "the phone is reattached with a new snapshot",
    );
    service.input(created.id, "echo relinked-$((6*7))\r");
    assert.ok(await until(() => viewer.text().includes("relinked-42")), "typing works after the reconnect");
    assert.ok(!viewer.received.some((m) => m.event === "terminal.closed"), "the shell was never reported closed");
    await service.close(created.id);
  } finally {
    service.disconnect();
    delete process.env.PALM_TERMINALD_IDLE_MS;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("an idle terminal service exits when Palm is gone and no shell is open", { timeout: 20000 }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "palm-terminal-idle-"));
  process.env.PALM_TERMINALD_IDLE_MS = "300";
  const service = await new TerminalService({ stateDir, helper, version: "idle" }).start();
  try {
    const { pid } = await service.request({ op: "hello" });
    assert.ok(alive(pid));
    service.disconnect();
    assert.ok(await until(() => !alive(pid), 5000), "the service exits after its idle time");
  } finally {
    delete process.env.PALM_TERMINALD_IDLE_MS;
    await rm(stateDir, { recursive: true, force: true });
  }
});
