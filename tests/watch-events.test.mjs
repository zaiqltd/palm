import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

// The phone's side of the agent watch, through the real server: the list, the
// events topic, an alert when a session finishes, and opening one on the Mac.
test("the watch reaches a paired phone: list, live updates, an alert and open", async () => {
  const port = 50000 + (process.pid % 1000);
  const base = `http://localhost:${port}`;
  const home = await mkdtemp(path.join(os.tmpdir(), "palm-watch-home-"));
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, HOME: home, PALM_PORT: String(port), PALM_SYNTHETIC: "1", PALM_ORIGIN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let ws;
  try {
    await Promise.race([
      once(child.stdout, "data"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Server start timeout\n" + stderr)), 8000)),
    ]);
    const post = (route, data = {}, cookie = "") =>
      fetch(base + "/api/" + route, { method: "POST", headers: { origin: base, "content-type": "application/json", cookie }, body: JSON.stringify(data) });
    const code = await (await post("local/pair-code")).json();
    const cookie = (await post("pair", { code: code.code, name: "Watch test" })).headers.get("set-cookie").split(";")[0];
    assert.equal((await post("local/test/agents", { action: "setup" })).status, 200);

    const list = await (await fetch(base + "/api/agents/watch", { headers: { cookie } })).json();
    const claude = list.sessions.find((s) => s.id === "claude:local_ui-1");
    assert.equal(claude?.status, "working");
    assert.deepEqual(claude.children.map((c) => c.title), ["Check the tests"]);
    assert.ok(list.sessions.some((s) => s.id === "codex:th-ui" && s.status === "working"));

    ws = new WebSocket(base.replace("http:", "ws:") + "/events", { headers: { origin: base, cookie } });
    await once(ws, "open");
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw)));
    const waitFor = async (predicate, ms) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
        const found = messages.find(predicate);
        if (found) return found;
      }
      throw new Error("Timed out; got " + JSON.stringify(messages.map((m) => m.event)));
    };
    ws.send(JSON.stringify({ op: "subscribe", topics: ["watch"] }));
    // Nothing is sent until something changes: the phone reads the list itself.
    await new Promise((r) => setTimeout(r, 4500));
    assert.equal(messages.filter((m) => m.topic === "watch").length, 0, "no update without a change");

    assert.equal((await post("local/test/agents", { action: "finish" })).status, 200);
    const changed = await waitFor((m) => m.topic === "watch" && m.event === "watch.changed", 9000);
    assert.deepEqual(changed.upserts.map((s) => [s.id, s.status]), [["claude:local_ui-1", "finished"]], "only what changed is sent");
    const alerts = await waitFor((m) => m.topic === "watch" && m.event === "watch.alerts", 9000);
    assert.deepEqual(alerts.alerts.map((a) => [a.id, a.kind, a.text]), [["claude:local_ui-1", "finished", "Refactor the checkout finished"]]);

    const opened = await (await post("agents/watch/open", { id: "claude:local_ui-1" }, cookie)).json();
    assert.equal(opened.opened, true);
    const refused = await post("agents/watch/open", { id: "claude:nothing-like-this" }, cookie);
    assert.equal(refused.status, 400, "only sessions the Mac found can be opened");
    // The test host never lets anything else into its fixture route.
    assert.equal((await post("local/test/agents", { action: "delete" })).status, 400);
  } finally {
    ws?.close();
    child.kill();
  }
});
