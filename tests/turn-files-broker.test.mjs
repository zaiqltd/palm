import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The whole file runs in a throwaway home: the test agent writes only there.
const home = await mkdtemp(path.join(os.tmpdir(), "palm-turn-files-home-"));
process.env.HOME = home;
const { AgentBroker } = await import("../server/agents/broker.mjs");
const { EventHub } = await import("../server/platform/events.mjs");
const { FsPolicy } = await import("../server/files/fs-api.mjs");

test("a PDF an agent makes comes back into its chat as a file card", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "palm-turn-files-state-"));
  const folder = path.join(home, "Reports");
  await mkdir(folder);
  const screen = { allow() {}, ownerTask: () => null, releaseAgent: async () => {}, state: () => ({}) };
  const broker = new AgentBroker({
    stateDir, hub: new EventHub(), screen, native: null, system: null, mcpScript: "", apiOrigin: "", scripted: true,
    policy: new FsPolicy({ stateDir }), deviceName: () => "Test Mac",
  });
  await broker.open();
  const task = await broker.create({ provider: "claude", cwd: folder, text: "make a pdf of this week's numbers" });
  let files = null;
  for (let i = 0; i < 100 && !files; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    files = (await broker.log(task.id).readAll()).find((e) => e.type === "files")?.files;
  }
  assert.ok(files, "the turn's files were announced");
  assert.deepEqual(files.map((f) => [f.type, f.name, f.folder, f.device]), [["file", "palm-report.pdf", folder, "Test Mac"]]);
  assert.ok(files[0].size > 0 && files[0].modified);

  // A turn that makes nothing announces nothing.
  await broker.send(task.id, { text: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal((await broker.log(task.id).readAll()).filter((e) => e.type === "files").length, 1);
  await broker.save();
});
