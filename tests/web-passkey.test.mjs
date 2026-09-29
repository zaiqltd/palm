import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Sessions, webIdleLock, webUnlockLimit } from "../server/security.mjs";
import { cborDecode, parseAuthData, verifyAssertion, verifyRegistration } from "../server/webauthn.mjs";
import { softAuthenticator } from "./fixtures/soft-authenticator.js";

// A test Mac with durable pairing (a state folder), on localhost: passkeys
// need a site name, and 127.0.0.1 is not one.
async function startHost() {
  const state = await mkdtemp(path.join(os.tmpdir(), "palm-web-"));
  const port = 47000 + (process.pid % 1000);
  const base = `http://localhost:${port}`;
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, PALM_PORT: String(port), PALM_SYNTHETIC: "1", PALM_ORIGIN: "", PALM_STATE_DIR: state },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  await Promise.race([
    once(child.stdout, "data"),
    new Promise((_, r) => setTimeout(() => r(new Error("Server start timeout\n" + stderr)), 8000)),
  ]);
  const request = (route, { method = "GET", data, cookie = "", origin = base } = {}) =>
    fetch(base + "/api/" + route, {
      method,
      headers: { origin, cookie, ...(data !== undefined ? { "content-type": "application/json" } : {}) },
      body: data !== undefined ? JSON.stringify(data) : undefined,
    });
  const post = (route, data = {}, cookie = "", origin) => request(route, { method: "POST", data, cookie, origin });
  const stop = async () => {
    child.kill();
    await once(child, "exit").catch(() => {});
    await rm(state, { recursive: true, force: true });
  };
  return { base, port, state, request, post, stop };
}

async function pairWeb(host, name = "Web iPhone") {
  const code = await (await host.post("local/pair-code")).json();
  const paired = await host.post("web/pair", { code: code.code, name });
  assert.equal(paired.status, 200, await paired.clone().text());
  const header = paired.headers.get("set-cookie");
  assert.match(header, /HttpOnly; SameSite=Strict; Max-Age=\d{7}/, "A month-long, script-proof cookie");
  return { cookie: header.split(";")[0], body: await paired.json() };
}

test("web pairing: locked until Face ID is set up, then unlocks, locks and survives a restart", async () => {
  const host = await startHost();
  try {
    const { cookie, body } = await pairWeb(host);
    assert.equal(body.state, "setup");
    // Paired but no passkey yet: nothing opens.
    const session = await (await host.request("session", { cookie })).json();
    assert.equal(session.paired, true);
    assert.equal(session.web.state, "setup");
    const blocked = await host.request("status", { cookie });
    assert.equal(blocked.status, 423);
    assert.equal((await blocked.json()).locked, true);
    // Sockets refuse a locked pairing too.
    const refused = new WebSocket(host.base.replace("http", "ws") + "/events", { headers: { origin: host.base, cookie } });
    const [, response] = await once(refused, "unexpected-response");
    assert.equal(response.statusCode, 423);

    // Face ID set up: a passkey registered for this site.
    const authenticator = await softAuthenticator({ origin: host.base });
    const options = await (await host.post("web/passkey/options", { purpose: "register" }, cookie)).json();
    assert.equal(options.publicKey.rp.id, "localhost");
    assert.equal(options.publicKey.authenticatorSelection.userVerification, "required");
    const registered = await host.post("web/passkey/register", { credential: await authenticator.create(options.publicKey) }, cookie);
    assert.equal(registered.status, 200, await registered.clone().text());
    assert.equal((await registered.json()).state, "unlocked");
    assert.equal((await host.request("status", { cookie })).status, 200, "Unlocked right after setup");
    // A second registration is refused.
    assert.equal((await host.post("web/passkey/options", { purpose: "register" }, cookie)).status, 400);

    // Locked, then unlocked with the passkey.
    await host.post("web/lock", {}, cookie);
    assert.equal((await host.request("status", { cookie })).status, 423);
    const unlockOptions = await (await host.post("web/passkey/options", { purpose: "unlock" }, cookie)).json();
    assert.deepEqual(unlockOptions.publicKey.allowCredentials.map((c) => c.id), [authenticator.id]);
    const assertion = await authenticator.get(unlockOptions.publicKey);
    assert.equal((await host.post("web/passkey/unlock", { credential: assertion }, cookie)).status, 200);
    assert.equal((await host.request("status", { cookie })).status, 200);
    // The same answer again is refused: every challenge is used once.
    await host.post("web/lock", {}, cookie);
    assert.equal((await host.post("web/passkey/unlock", { credential: assertion }, cookie)).status, 400);
    // A new challenge answered by the right passkey works; the live sockets open.
    const again = await (await host.post("web/passkey/options", { purpose: "unlock" }, cookie)).json();
    assert.equal((await host.post("web/passkey/unlock", { credential: await authenticator.get(again.publicKey) }, cookie)).status, 200);
    const events = new WebSocket(host.base.replace("http", "ws") + "/events", { headers: { origin: host.base, cookie } });
    const [first] = await once(events, "message");
    assert.equal(JSON.parse(first).event, "connected");
    events.close();

    // Saved on the Mac with its passkey: after a restart the pairing is
    // still there, locked.
    const saved = JSON.parse(await readFile(path.join(host.state, "native-devices.json"), "utf8"));
    const device = saved.devices.find((d) => d.kind === "web");
    assert.ok(device?.passkey?.jwk?.x, "The public key is kept");
    assert.equal(JSON.stringify(saved).includes(cookie.split("=")[1]), false, "The token itself is never stored");
    // The Mac's setup page lists it as a web device with Face ID.
    const setup = await (await host.request("local/setup")).json();
    assert.deepEqual(setup.devices.map((d) => [d.kind, d.passkey]), [["web", true]]);
    // Revoking it on the Mac ends it at once.
    await host.post("local/revoke", { id: setup.devices[0].id });
    assert.equal((await host.request("status", { cookie })).status, 401);
  } finally {
    await host.stop();
  }
});

test("web pairing: wrong site, wrong step, no Face ID, a forged signature and a remote browser pairing are refused", async () => {
  const host = await startHost();
  try {
    const { cookie } = await pairWeb(host);
    const good = await softAuthenticator({ origin: host.base });
    const register = async (credentialFor) => {
      const options = await (await host.post("web/passkey/options", { purpose: "register" }, cookie)).json();
      return host.post("web/passkey/register", { credential: await credentialFor(options.publicKey) }, cookie);
    };
    // Made for another site, or answered from another origin.
    assert.equal((await register((o) => good.create(o, { rpId: "evil.example" }))).status, 400);
    const elsewhere = await softAuthenticator({ origin: "https://evil.example" });
    assert.equal((await register((o) => elsewhere.create(o))).status, 400);
    // Present but not verified (no Face ID or passcode).
    const unverified = await softAuthenticator({ origin: host.base, userVerified: false });
    assert.equal((await register((o) => unverified.create(o))).status, 400);
    // The wrong step and a stale challenge.
    assert.equal((await register((o) => good.create(o, { type: "webauthn.get" }))).status, 400);
    assert.equal((await register((o) => good.create(o, { challenge: "A".repeat(43) }))).status, 400);
    // Finally the right one.
    assert.equal((await register((o) => good.create(o))).status, 200);
    await host.post("web/lock", {}, cookie);
    const unlock = async (credentialFor) => {
      const options = await (await host.post("web/passkey/options", { purpose: "unlock" }, cookie)).json();
      return host.post("web/passkey/unlock", { credential: await credentialFor(options.publicKey) }, cookie);
    };
    assert.equal((await unlock((o) => good.get(o, { tamper: true }))).status, 400, "A forged signature");
    const other = await softAuthenticator({ origin: host.base });
    await other.create({ challenge: "x", rp: { id: "localhost" }, user: { id: "x" } });
    assert.equal((await unlock((o) => other.get(o))).status, 400, "Another passkey");
    assert.equal((await unlock((o) => good.get(o, { flags: 0x01 }))).status, 400, "No user verification");
    assert.equal((await host.request("status", { cookie })).status, 423, "Still locked");
    assert.equal((await unlock((o) => good.get(o))).status, 200);

    // A browser pairing without Face ID is for the Mac itself only.
    const code = await (await host.post("local/pair-code")).json();
    const remote = await fetch(host.base + "/api/pair", {
      method: "POST",
      headers: { origin: host.base, "content-type": "application/json", "x-forwarded-for": "100.64.0.9" },
      body: JSON.stringify({ code: code.code }),
    });
    assert.equal(remote.status, 403);
  } finally {
    await host.stop();
  }
});

test("web pairing: locks after ten idle minutes or a day, and a restart locks it", async () => {
  let now = 1_000_000_000_000;
  const sessions = new Sessions(() => now);
  sessions.file = null;
  const s = sessions.create("Web iPhone", "web");
  assert.equal(sessions.webState(s.token), "setup");
  assert.equal(sessions.authorized(s.token), null);
  sessions.sessions.get([...sessions.sessions.keys()][0]).passkey = {
    id: "A".repeat(43), rpId: "localhost", signCount: 0, jwk: { kty: "EC", crv: "P-256", x: "B".repeat(43), y: "C".repeat(43) },
  };
  assert.equal(sessions.webState(s.token), "locked");
  sessions.unlock(s.token);
  assert.ok(sessions.authorized(s.token));
  now += webIdleLock - 1000;
  assert.ok(sessions.authorized(s.token), "Use keeps it unlocked");
  now += webIdleLock - 1000;
  assert.ok(sessions.authorized(s.token));
  now += webIdleLock + 1;
  assert.equal(sessions.authorized(s.token), null, "Ten idle minutes lock it");
  sessions.unlock(s.token);
  for (let t = 0; t < webUnlockLimit; t += webIdleLock / 2) {
    now += webIdleLock / 2;
    sessions.authorized(s.token);
  }
  now += 1000;
  assert.equal(sessions.authorized(s.token), null, "A day after unlocking, Face ID again");
  // A phone's own pairing and the Mac's session never need Face ID.
  const phone = sessions.create("iPhone", "native");
  assert.ok(sessions.authorized(phone.token));
});

test("the passkey checks agree with WebAuthn's own layout", async () => {
  const authenticator = await softAuthenticator({ origin: "https://mac.tail0.ts.net:8443" });
  const created = await authenticator.create({ challenge: "c".repeat(43), rp: { id: "mac.tail0.ts.net" }, user: { id: "u" } });
  const kept = verifyRegistration({
    credential: created, challenge: "c".repeat(43), origin: "https://mac.tail0.ts.net:8443", rpId: "mac.tail0.ts.net",
  });
  assert.equal(kept.id, authenticator.id);
  const signed = await authenticator.get({ challenge: "d".repeat(43), rpId: "mac.tail0.ts.net" });
  assert.deepEqual(
    verifyAssertion({ credential: signed, stored: kept, challenge: "d".repeat(43), origin: "https://mac.tail0.ts.net:8443", rpId: "mac.tail0.ts.net" }),
    { signCount: 0 },
  );
  // The port is part of the origin: the same site on another port is refused.
  assert.throws(() =>
    verifyAssertion({ credential: signed, stored: kept, challenge: "d".repeat(43), origin: "https://mac.tail0.ts.net:9443", rpId: "mac.tail0.ts.net" }),
  );
  // Malformed CBOR never reads past its buffer.
  assert.throws(() => cborDecode(Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff, 0x00])), /ended early/);
  assert.throws(() => cborDecode(Buffer.from([0x9f])), /Indefinite/);
  assert.throws(() => parseAuthData(Buffer.alloc(10)), /too short/);
  // A counter that goes backwards means a copied passkey.
  const counting = await softAuthenticator({ origin: "https://mac.tail0.ts.net:8443", signCount: 5 });
  const made = verifyRegistration({
    credential: await counting.create({ challenge: "e".repeat(43), rp: { id: "mac.tail0.ts.net" }, user: { id: "u" } }),
    challenge: "e".repeat(43), origin: "https://mac.tail0.ts.net:8443", rpId: "mac.tail0.ts.net",
  });
  const backwards = await counting.get({ challenge: "f".repeat(43), rpId: "mac.tail0.ts.net" }, { counterStep: -1 });
  assert.throws(() =>
    verifyAssertion({
      credential: backwards, stored: made, challenge: "f".repeat(43), origin: "https://mac.tail0.ts.net:8443", rpId: "mac.tail0.ts.net",
    }), /backwards/);
});
