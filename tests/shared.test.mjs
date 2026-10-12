import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { isLink } from "../server/shared/shared.mjs";

const run = promisify(execFile);

test("a single web address is a link; anything else is a note", () => {
  assert.equal(isLink("https://example.com/a?b=c#d"), true);
  assert.equal(isLink("http://localhost:3000"), true);
  assert.equal(isLink("see https://example.com"), false);
  assert.equal(isLink("https://example.com\nsecond line"), false);
  assert.equal(isLink("javascript:alert(1)"), false);
  assert.equal(isLink("ftp://example.com"), false);
});

// Shared through the real server: the Mac (palm-share, the local API) hands
// links, notes and files to the phone, the phone adds its own, live updates
// reach the phone, and Palm's own folder can never be shared.
test("Shared: Mac to phone and back, live updates, files, the palm-share command", async () => {
  const port = 51000 + (process.pid % 1000);
  const base = `http://localhost:${port}`;
  const home = await mkdtemp(path.join(os.tmpdir(), "palm-shared-home-"));
  const stateDir = path.join(home, "state");
  await mkdir(stateDir);
  const child = spawn(process.execPath, ["server/index.mjs"], {
    env: { ...process.env, HOME: home, PALM_PORT: String(port), PALM_SYNTHETIC: "1", PALM_ORIGIN: "", PALM_STATE_DIR: stateDir },
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
    const post = (route, data = {}, cookie = "", headers = {}) =>
      fetch(base + "/api/" + route, { method: "POST", headers: { origin: base, "content-type": "application/json", cookie, ...headers }, body: JSON.stringify(data) });
    const get = (route, cookie) => fetch(base + "/api/" + route, { headers: { cookie } });

    assert.equal((await get("shared", "")).status, 401, "only a paired phone reads Shared");
    assert.equal((await post("local/shared", { text: "x" }, "", { "x-forwarded-for": "100.1.2.3" })).status, 403, "the Mac's own route is local");
    assert.equal(
      (await fetch(base + "/api/local/shared", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status,
      403,
      "no other site can add to Shared",
    );

    const code = await (await post("local/pair-code")).json();
    const cookie = (await post("pair", { code: code.code, name: "Test iPhone" })).headers.get("set-cookie").split(";")[0];

    ws = new WebSocket(base.replace("http:", "ws:") + "/events", { headers: { origin: base, cookie } });
    await once(ws, "open");
    const messages = [];
    ws.on("message", (raw) => messages.push(JSON.parse(raw)));
    ws.send(JSON.stringify({ op: "subscribe", topics: ["shared"], requestId: 1 }));
    const waitFor = async (predicate, ms = 3000) => {
      for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
        const found = messages.find(predicate);
        if (found) return found;
      }
      throw new Error("Timed out; got " + JSON.stringify(messages));
    };
    const subscribed = await waitFor((m) => m.event === "reply" && m.requestId === 1);
    assert.ok(subscribed.result.topics.includes("shared"));

    // From the Mac: a link, a note and a file.
    const link = await (await post("local/shared", { text: "  https://example.com/page?a=1  ", title: "Example" })).json();
    assert.deepEqual([link.kind, link.url, link.title, link.source], ["link", "https://example.com/page?a=1", "Example", "mac"]);
    const changed = await waitFor((m) => m.topic === "shared" && m.event === "shared.changed" && m.added === link.id);
    assert.ok(changed);
    const note = await (await post("local/shared", { text: "line one\nline two" })).json();
    assert.equal(note.kind, "text");
    const file = path.join(home, "report.pdf");
    await writeFile(file, "%PDF-1.4 sample");
    const shared = await (await post("local/shared", { path: file })).json();
    assert.deepEqual([shared.kind, shared.name, shared.size, shared.exists, shared.sensitive], ["file", "report.pdf", 15, true, false]);
    const homeRelative = await (await post("local/shared", { path: "~/report.pdf" })).json();
    assert.equal(homeRelative.path, file, "~ is the Mac user's home");

    // What can never be shared.
    const refusal = async (data) => (await (await post("local/shared", data)).json()).error;
    assert.match(await refusal({ path: path.join(stateDir, "shared.json") }), /cannot share/, "Palm's own folder stays closed");
    assert.match(await refusal({ path: home }), /not a folder/);
    assert.match(await refusal({ path: path.join(home, "missing.txt") }), /does not exist/);
    assert.match(await refusal({ path: "relative/file.txt" }), /full path/);
    assert.match(await refusal({ text: "   " }), /Nothing to share/);
    assert.match(await refusal({ text: "x".repeat(100001) }), /100,000/);

    // The phone sees them newest first, and adds its own.
    let list = await (await get("shared", cookie)).json();
    assert.deepEqual(list.items.map((i) => i.kind), ["file", "file", "text", "link"]);
    const fromPhone = (await (await post("shared", { text: "from the phone" }, cookie)).json()).items[0];
    assert.deepEqual([fromPhone.source, fromPhone.device], ["phone", "Test iPhone"]);
    // The Mac's clipboard in one tap (the test Mac's clipboard holds fixed text).
    const clip = (await (await post("shared", { macClipboard: true }, cookie)).json()).items[0];
    assert.deepEqual([clip.kind, clip.text, clip.source], ["text", "synthetic clipboard", "mac"]);

    // A long note: its start in the list, the whole of it on request.
    const long = (await (await post("shared", { text: "word ".repeat(3000) }, cookie)).json()).items[0];
    assert.equal(long.partial, true);
    assert.equal(long.text.length, 4000);
    list = await (await get("shared", cookie)).json();
    assert.equal(list.items[0].partial, true);
    const whole = await (await get(`shared/item?id=${long.id}`, cookie)).json();
    assert.equal(whole.text.length, "word ".repeat(3000).trim().length);
    assert.equal(whole.partial, false);

    // Removing takes it off the list (and nothing off the Mac); it is saved.
    list = await (await post("shared/remove", { id: shared.id }, cookie)).json();
    assert.ok(!list.items.some((i) => i.id === shared.id));
    await waitFor((m) => m.topic === "shared" && m.removed === shared.id);
    assert.equal(await readFile(file, "utf8"), "%PDF-1.4 sample", "the file itself is untouched");
    const saved = JSON.parse(await readFile(path.join(stateDir, "shared.json"), "utf8"));
    assert.equal(saved.items.length, list.items.length);

    // The palm-share command.
    const cli = (...args) => run(process.execPath, ["bin/palm-share", ...args], { env: { ...process.env, PALM_PORT: String(port) } });
    assert.match((await cli("https://example.org")).stdout, /Shared to your phone: link https:\/\/example\.org/);
    assert.match((await cli("buy", "milk")).stdout, /note "buy milk"/);
    assert.match((await cli(file, "--title", "The report")).stdout, /file report\.pdf/);
    const listed = (await cli("--list")).stdout;
    assert.match(listed, /Mac {4}file report\.pdf {2}\(The report\)/);
    assert.match(listed, /Phone {2}note "from the phone"/);
    await assert.rejects(cli(), /Usage/);
    await assert.rejects(
      run(process.execPath, ["bin/palm-share", "x"], { env: { ...process.env, PALM_PORT: "1" } }),
      /Palm is not running/,
    );
  } finally {
    ws?.close();
    child.kill();
  }
});
