import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";
test("HTTP and socket boundary: auth, origins, single controller, downloads, revocation", async () => {
  const port = 49000 + (process.pid % 1000),
    base = `http://localhost:${port}`;
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: {
      ...process.env,
      PALM_PORT: String(port),
      PALM_SYNTHETIC: "1",
      PALM_ORIGIN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  let ws;
  try {
    await Promise.race([
      once(child.stdout, "data"),
      new Promise((_, r) =>
        setTimeout(() => r(new Error("Server start timeout\n" + stderr)), 5000),
      ),
    ]);
    assert.equal((await fetch(base + "/api/status")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/local/pair-code", {
          method: "POST",
          headers: {
            origin: "https://evil.example",
            "content-type": "application/json",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/local/setup", {
          headers: { "x-forwarded-for": "100.20.30.40" },
        })
      ).status,
      403,
    );
    const post = (route, data = {}, cookie = "") =>
      fetch(base + "/api/" + route, {
        method: "POST",
        headers: { origin: base, "content-type": "application/json", cookie },
        body: JSON.stringify(data),
      });
    const code = await (await post("local/pair-code")).json();
    const paired = await post("pair", { code: code.code, name: "Test iPhone" });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.get("set-cookie").split(";")[0];
    assert.match(paired.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    assert.equal((await post("pair", { code: code.code })).status, 429);
    assert.equal(
      (await fetch(base + "/api/status", { headers: { cookie } })).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/api/download?path=..%2Fpackage.json", {
          headers: { cookie },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/download?path=Welcome.txt", {
          headers: { cookie },
        })
      ).status,
      200,
    );
    const bad = new WebSocket(base.replace("http:", "ws:") + "/socket", {
      headers: { origin: "https://evil.example", cookie },
    });
    bad.on("error", () => {});
    await new Promise((resolve) => bad.once("close", resolve));
    ws = new WebSocket(base.replace("http:", "ws:") + "/socket", {
      headers: { origin: base, cookie },
    });
    await once(ws, "open");
    const second = new WebSocket(base.replace("http:", "ws:") + "/socket", {
      headers: { origin: base, cookie },
    });
    second.on("error", () => {});
    await new Promise((resolve) => second.once("close", resolve));
    const setup = await (await fetch(base + "/api/local/setup")).json();
    const d = setup.devices.find((x) => x.name === "Test iPhone");
    const closed = once(ws, "close");
    await post("local/revoke", { id: d.id });
    await closed;
    assert.equal(
      (await fetch(base + "/api/status", { headers: { cookie } })).status,
      401,
    );
  } finally {
    ws?.terminate();
    // A server that failed to start has already exited.
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
});
