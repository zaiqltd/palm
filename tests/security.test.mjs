import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  mkdir,
  symlink,
  realpath,
  rename,
  readFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Sessions,
  safeFile,
  listFiles,
  validateCommand,
  checkOrigin,
  isLocal,
  sessionCookie,
} from "../server/security.mjs";

test("pairing is single-use, expires, revokes, and bounds brute force", () => {
  let now = 1000000;
  const s = new Sessions(() => now),
    c = s.rotate();
  const d = s.pair(c.value, "iPhone");
  assert.equal(s.get(d.token)?.name, "iPhone");
  assert.throws(() => s.pair(c.value));
  s.revoke(d.id);
  assert.equal(s.get(d.token), null);
  const c2 = s.rotate();
  now += 120001;
  assert.throws(() => s.pair(c2.value));
  const c3 = s.rotate();
  for (let i = 0; i < 7; i++) assert.throws(() => s.pair("WRONG"));
  assert.throws(() => s.pair(c3.value), /Too many/);
  now += 60001;
  const d2 = s.pair(c3.value);
  now += 12 * 3600000;
  assert.equal(s.get(d2.token), null);
});
test("shared files block traversal, hidden paths and escaping symlinks", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "palm-security-")),
    root = path.join(base, "shared");
  await mkdir(root);
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "hello.txt"), "ok");
  await writeFile(path.join(root, ".secret"), "private");
  await writeFile(path.join(base, "outside.txt"), "private");
  await symlink(path.join(base, "outside.txt"), path.join(root, "escape.txt"));
  await symlink(path.join(root, ".secret"), path.join(root, "hidden-link"));
  assert.equal(
    await safeFile(root, "hello.txt"),
    await realpath(path.join(root, "hello.txt")),
  );
  for (const f of [
    "../outside.txt",
    "/etc/passwd",
    ".secret",
    "escape.txt",
    "hidden-link",
    "folder/../hello.txt",
    "foo\\bar",
    "\0",
  ])
    await assert.rejects(() => safeFile(root, f));
  assert.deepEqual(
    (await listFiles(root)).map((f) => f.name),
    ["folder", "hello.txt"],
  );
});
test("control protocol permits only bounded explicit actions", () => {
  for (const x of [
    { op: "shell", command: "anything" },
    { op: "key", key: "power" },
    { op: "lock" },
    { op: "text", text: "a".repeat(4001) },
    { op: "pointer", action: "click", x: NaN, y: 1 },
    { op: "activate", bundleId: "bad;command" },
    ...[-1, 0x100000000, Number.MAX_SAFE_INTEGER, 1.5, "7", null, NaN].map(
      (windowId) => ({ op: "start", windowId }),
    ),
  ])
    assert.throws(() => validateCommand(x));
  assert.deepEqual(
    validateCommand({ op: "pointer", action: "click", x: -40, y: 2 }),
    { op: "pointer", action: "click", x: 0, y: 1 },
  );
  assert.deepEqual(validateCommand({ op: "lock", confirm: true }), {
    op: "lock",
  });
  assert.deepEqual(validateCommand({ op: "start" }), {
    op: "start",
    windowId: 0,
  });
  assert.deepEqual(validateCommand({ op: "start", windowId: 0xffffffff }), {
    op: "start",
    windowId: 0xffffffff,
  });
  assert.deepEqual(
    validateCommand({ op: "pointer", action: "double", x: 0.25, y: 0.75 }),
    { op: "pointer", action: "double", x: 0.25, y: 0.75 },
  );
  assert.deepEqual(
    validateCommand({
      op: "pointer",
      action: "doubleSecond",
      x: 0.25,
      y: 0.75,
    }),
    { op: "pointer", action: "doubleSecond", x: 0.25, y: 0.75 },
  );
});
test("Phone Layout viewport dimensions are paired, bounded and explicitly opted into", () => {
  const start = {
    op: "start",
    windowId: 7,
    phoneLayout: true,
    phoneLayoutWidth: 758,
    phoneLayoutHeight: 409,
  };
  assert.deepEqual(validateCommand(start), start);
  for (const overrides of [
    { phoneLayout: false },
    { phoneLayout: undefined },
    { phoneLayoutWidth: undefined },
    { phoneLayoutHeight: undefined },
    ...[null, true, "758", NaN, Infinity, 239, 1401].map(
      (phoneLayoutWidth) => ({ phoneLayoutWidth }),
    ),
    ...[null, false, "409", NaN, Infinity, 199, 1401].map(
      (phoneLayoutHeight) => ({ phoneLayoutHeight }),
    ),
  ])
    assert.throws(
      () => validateCommand({ ...start, ...overrides }),
      /Unsupported command/,
    );
  for (const [phoneLayoutWidth, phoneLayoutHeight] of [
    [240, 200],
    [1400, 1400],
    [758.5, 409.5],
  ]) {
    const command = { ...start, phoneLayoutWidth, phoneLayoutHeight };
    assert.deepEqual(validateCommand(command), command);
  }
});
test("Fill is an explicit boolean and never combines with Phone Layout", () => {
  assert.deepEqual(validateCommand({ op: "start", windowId: 7, fill: true }), { op: "start", windowId: 7, fill: true });
  assert.deepEqual(validateCommand({ op: "start", windowId: 7, fill: false }), { op: "start", windowId: 7, fill: false });
  for (const fill of ["true", 1, null])
    assert.throws(() => validateCommand({ op: "start", windowId: 7, fill }), /Unsupported command/);
  assert.throws(
    () => validateCommand({ op: "start", windowId: 7, fill: true, phoneLayout: true }),
    /Unsupported command/,
  );
});
test("Phone Layout is explicitly boolean and never adds arbitrary window geometry", () => {
  for (const phoneLayout of [null, 0, 1, "true", {}, []])
    assert.throws(() =>
      validateCommand({ op: "start", windowId: 7, phoneLayout }),
    );
  assert.deepEqual(
    validateCommand({
      op: "start",
      windowId: 7,
      phoneLayout: true,
      width: 10000,
      height: -1,
      pid: 42,
    }),
    { op: "start", windowId: 7, phoneLayout: true },
  );
  assert.deepEqual(validateCommand({ op: "start", phoneLayout: false }), {
    op: "start",
    windowId: 0,
    phoneLayout: false,
  });
  // The native host reports desktop exemption; it must never resize a display.
  assert.deepEqual(
    validateCommand({ op: "start", windowId: 0, phoneLayout: true }),
    { op: "start", windowId: 0, phoneLayout: true },
  );
});
test("local setup and origin checks reject proxy and foreign access", () => {
  const req = {
    headers: {
      host: "localhost:4318",
      origin: "http://localhost:4318",
      cookie: "a=b; palm_session=test; x=y",
    },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.ok(isLocal(req));
  assert.equal(sessionCookie(req), "test");
  assert.ok(checkOrigin(req, new Set(["http://localhost:4318"])));
  assert.ok(!checkOrigin(req, new Set(["https://evil.test"])));
  assert.ok(
    !isLocal({
      ...req,
      headers: { ...req.headers, "x-forwarded-for": "100.1.2.3" },
    }),
  );
  assert.ok(!isLocal({ ...req, headers: { host: "evil.test" } }));
  assert.ok(!isLocal({ ...req, socket: { remoteAddress: "10.0.0.5" } }));
});

test("native credentials persist as private hashes, expire and revoke across restart", async () => {
  const { readFile, stat } = await import("node:fs/promises");
  let now = 1000000;
  const dir = await mkdtemp(path.join(os.tmpdir(), "palm-devices-"));
  const file = path.join(dir, "native-devices.json");
  const sessions = await Sessions.open(file, () => now);
  const device = await sessions.pairNative(
    sessions.rotate().value,
    "My iPhone",
  );
  const browser = sessions.create("Browser");
  const text = await readFile(file, "utf8");
  assert.ok(!text.includes(device.token));
  assert.ok(!text.includes(browser.token));
  assert.match(JSON.parse(text).devices[0].tokenHash, /^[a-f0-9]{64}$/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  let restored = await Sessions.open(file, () => now);
  assert.equal(restored.get(device.token).id, device.id);
  assert.equal(restored.get(browser.token), null);
  assert.deepEqual(Object.keys(restored.list()[0]).sort(), [
    "expires",
    "id",
    "kind",
    "name",
  ]);
  await restored.revoke(device.id);
  restored = await Sessions.open(file, () => now);
  assert.equal(restored.get(device.token), null);
  const second = await restored.pairNative(restored.rotate().value, "Phone 2");
  now = second.expires;
  assert.equal(restored.get(second.token), null);
  assert.equal((await Sessions.open(file, () => now)).get(second.token), null);
  const link = path.join(dir, "linked-devices.json");
  await symlink(file, link);
  await assert.rejects(Sessions.open(link));
});

test("native tokens require exact Bearer format and setup rejects all proxy forms", async () => {
  const { bearerToken } = await import("../server/security.mjs");
  const token = "a".repeat(43);
  assert.equal(
    bearerToken({ headers: { authorization: `Bearer ${token}` } }),
    token,
  );
  for (const authorization of [
    `Bearer ${token} extra`,
    "Basic whatever",
    `Bearer ${token},${token}`,
  ])
    assert.equal(bearerToken({ headers: { authorization } }), null);
  for (const header of [
    "forwarded",
    "x-forwarded-host",
    "x-forwarded-proto",
    "tailscale-user-login",
  ])
    assert.equal(
      isLocal({
        headers: { host: "localhost:4318", [header]: "untrusted" },
        socket: { remoteAddress: "127.0.0.1" },
      }),
      false,
    );
  const sessions = new Sessions();
  sessions.rotate();
  assert.throws(() => sessions.pair("💚".repeat(5)), /incorrect/);
});

test("failed native revocation blocks access, stays retryable and persists before restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "palm-revocation-"));
  const file = path.join(dir, "native-devices.json");
  const sessions = await Sessions.open(file);
  const removed = await sessions.pairNative(
    sessions.rotate().value,
    "Remove me",
  );
  const retained = await sessions.pairNative(
    sessions.rotate().value,
    "Keep me",
  );
  const browser = sessions.create("Local browser");
  const durableBefore = await readFile(file, "utf8");

  // A directory occupying the storage filename makes the real atomic rename
  // fail. Preserve the original file so recovery exercises its old credential.
  const backup = path.join(dir, "saved-devices.json");
  await rename(file, backup);
  await mkdir(file);
  await assert.rejects(sessions.revoke(removed.id), /could not save.*Retry/);
  assert.equal(sessions.get(removed.token), null);
  assert.ok(sessions.list().some((device) => device.id === removed.id));
  assert.equal(sessions.get(retained.token)?.id, retained.id);
  assert.equal(sessions.get(browser.token)?.id, browser.id);
  assert.equal(await readFile(backup, "utf8"), durableBefore);

  // A retry must attempt storage again instead of returning a false success.
  await assert.rejects(sessions.revoke(removed.id), /could not save.*Retry/);
  assert.equal(sessions.get(removed.token), null);
  assert.ok(sessions.list().some((device) => device.id === removed.id));

  await rename(file, path.join(dir, "storage-obstruction"));
  await rename(backup, file);
  await sessions.revoke(removed.id);
  assert.ok(!sessions.list().some((device) => device.id === removed.id));
  const restored = await Sessions.open(file);
  assert.equal(restored.get(removed.token), null);
  assert.equal(restored.get(retained.token)?.id, retained.id);
  assert.ok(!(await readFile(file, "utf8")).includes(removed.token));
  assert.ok(!(await readFile(file, "utf8")).includes(retained.token));
});

test("command queue cancels stale work, preserves transitions and bounds outstanding input", async () => {
  const { CommandQueue } = await import("../server/commands.mjs");
  let now = 0,
    owner = "old",
    unblock;
  const queue = new CommandQueue({ capacity: 2, maxWait: 10, now: () => now });
  const operations = [];
  const first = queue.run(
    () =>
      new Promise((resolve) => {
        unblock = resolve;
        operations.push("old start");
      }),
  );
  await Promise.resolve();
  const stale = queue.run(
    () => operations.push("stale input"),
    () => owner === "old",
  );
  const rejection = assert.rejects(stale, /no longer active/);
  await assert.rejects(
    queue.run(() => operations.push("overflow")),
    /busy/,
  );
  owner = "new";
  const stop = queue.run(
    () => operations.push("stop"),
    () => true,
    { cleanup: true },
  );
  unblock();
  await Promise.all([first, rejection, stop]);
  assert.deepEqual(operations, ["old start", "stop"]);
  const expired = queue.run(() => operations.push("expired"));
  now = 11;
  await assert.rejects(expired, /expired/);
  assert.equal(queue.pending, 0);
});
