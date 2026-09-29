import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  CodexStdioStatus,
  CodexStatusError,
  probeCodexStatus,
} from "../server/agents/codex-stdio.mjs";

function fixture({
  onInitialize = (message, reply) =>
    reply({ id: message.id, result: { userAgent: "fixture/1" } }),
  onRequest = () => {},
  closeOnEof = true,
} = {}) {
  const child = new EventEmitter();
  const sent = [],
    signals = [],
    spawned = [];
  let pending = "";
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      pending += chunk.toString();
      while (pending.includes("\n")) {
        const index = pending.indexOf("\n");
        const message = JSON.parse(pending.slice(0, index));
        pending = pending.slice(index + 1);
        sent.push(message);
        queueMicrotask(() => {
          if (message.method === "initialize")
            onInitialize(message, reply, child);
          else onRequest(message, reply, child);
        });
      }
      callback();
    },
    final(callback) {
      callback();
      if (closeOnEof) queueMicrotask(() => child.emit("close", 0, null));
    },
  });
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit("close", null, signal));
  };
  function reply(message) {
    child.stdout.write(JSON.stringify(message) + "\n");
  }
  const spawnProcess = (...args) => {
    spawned.push(args);
    return child;
  };
  const adapter = new CodexStdioStatus({
    spawnProcess,
    requestTimeoutMs: 100,
    shutdownGraceMs: 10,
    maxFrameBytes: 512,
  });
  return { adapter, child, sent, signals, spawned, reply, spawnProcess };
}

test("Codex status uses only initialization and account/read without refresh, redacting metadata", async () => {
  const f = fixture({
    onRequest(message, reply, child) {
      if (message.method !== "account/read") return;
      child.stderr.write("private fixture diagnostic\n");
      reply({
        method: "account/updated",
        params: { email: "fixture@example.invalid" },
      });
      reply({
        id: message.id,
        result: {
          requiresOpenaiAuth: true,
          account: {
            type: "chatgpt",
            email: "fixture@example.invalid",
            planType: "fixture-plan",
            accessToken: "fixture-only-secret",
          },
          extra: "fixture-only-secret",
        },
      });
    },
  });
  const status = await f.adapter.readStatus();
  assert.deepEqual(Object.keys(status).sort(), [
    "authentication",
    "caveat",
    "connected",
    "credentialState",
    "experimental",
    "inferenceTested",
    "provider",
    "requiresOpenaiAuth",
  ]);
  assert.equal(status.authentication, "chatgpt");
  assert.equal(status.credentialState, "present");
  assert.equal(status.inferenceTested, false);
  assert.equal(status.experimental, true);
  assert.match(status.caveat, /not supported for production/);
  assert.ok(!JSON.stringify(status).includes("fixture"));
  assert.deepEqual(
    f.sent.map((x) => x.method),
    ["initialize", "initialized", "account/read"],
  );
  assert.deepEqual(f.sent[2].params, { refreshToken: false });
  assert.equal(f.spawned[0][2].shell, false);
  assert.deepEqual(f.spawned[0][1], ["app-server", "--listen", "stdio://"]);
  assert.ok(!Object.hasOwn(f.spawned[0][2].env, "CODEX_HOME"));
  assert.ok(!Object.hasOwn(f.spawned[0][2].env, "OPENAI_API_KEY"));
  assert.deepEqual(await f.adapter.close(), {
    completed: true,
    method: "stdinEof",
  });
  assert.deepEqual(f.signals, []);
});

test("Codex framing handles split UTF-8 and batched lines; response IDs match out of order", async () => {
  const requests = [];
  const f = fixture({
    onRequest(message, reply, child) {
      if (message.method !== "account/read") return;
      requests.push(message);
      if (requests.length !== 2) return;
      const text =
        JSON.stringify({ method: "notice", params: { text: "💚" } }) +
        "\r\n" +
        JSON.stringify({ id: 999, result: {} }) +
        "\n" +
        JSON.stringify({ id: String(requests[0].id), result: {} }) +
        "\n" +
        JSON.stringify({
          id: requests[1].id,
          result: { account: null, requiresOpenaiAuth: false },
        }) +
        "\n" +
        JSON.stringify({
          id: requests[0].id,
          result: { account: { type: "apiKey" }, requiresOpenaiAuth: true },
        }) +
        "\n";
      const bytes = Buffer.from(text);
      const split = bytes.indexOf(Buffer.from("💚")) + 1;
      child.stdout.write(bytes.subarray(0, split));
      child.stdout.write(bytes.subarray(split));
    },
  });
  const [first, second] = await Promise.all([
    f.adapter.readStatus(),
    f.adapter.readStatus(),
  ]);
  assert.equal(first.authentication, "apiKey");
  assert.equal(second.authentication, "none");
  assert.equal(f.sent.filter((x) => x.method === "initialize").length, 1);
  await f.adapter.close();
});

test("Codex disconnect rejects every in-flight status request without replay", async () => {
  const f = fixture();
  await f.adapter.connect();
  const first = f.adapter.readStatus(),
    second = f.adapter.readStatus();
  const checks = [first, second].map((p) =>
    assert.rejects(p, { code: "DISCONNECTED" }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  f.child.emit("exit", 1, null);
  await Promise.all(checks);
  await assert.rejects(f.adapter.readStatus(), { code: "DISCONNECTED" });
  assert.equal(f.spawned.length, 1);
  await f.adapter.close();
});

test("Codex status times out and closes a stuck child within its shutdown bound", async () => {
  const f = fixture({ closeOnEof: false });
  await assert.rejects(f.adapter.readStatus(), { code: "TIMEOUT" });
  const shutdown = await f.adapter.close();
  assert.deepEqual(shutdown, { completed: true, method: "sigterm" });
  assert.deepEqual(f.signals, ["SIGTERM"]);
});

test("Codex remote errors never expose upstream identity or credential payloads", async () => {
  const f = fixture({
    onRequest(message, reply) {
      if (message.method === "account/read")
        reply({
          id: message.id,
          error: {
            code: -1,
            message: "fixture@example.invalid",
            data: { token: "fixture-only-secret" },
          },
        });
    },
  });
  await assert.rejects(f.adapter.readStatus(), (error) => {
    assert.ok(error instanceof CodexStatusError);
    assert.equal(error.code, "REMOTE_ERROR");
    assert.ok(!String(error).includes("fixture"));
    assert.equal(error.cause, undefined);
    return true;
  });
  await f.adapter.close();
});

test("Codex rejects malformed, excessive and operation-request frames", async (t) => {
  for (const [name, wire, code] of [
    ["invalid JSON", "{private fixture payload\n", "PROTOCOL_ERROR"],
    ["invalid UTF-8", Buffer.from([0xff, 0x0a]), "PROTOCOL_ERROR"],
    ["oversized partial", "x".repeat(513), "FRAME_TOO_LARGE"],
    [
      "unexpected request",
      JSON.stringify({ id: 90, method: "item/tool/call", params: {} }) + "\n",
      "UNSUPPORTED_REQUEST",
    ],
    [
      "ambiguous reply",
      (id) => JSON.stringify({ id, result: {}, error: {} }) + "\n",
      "PROTOCOL_ERROR",
    ],
    [
      "malformed status",
      (id) =>
        JSON.stringify({
          id,
          result: { account: "fixture", requiresOpenaiAuth: true },
        }) + "\n",
      "PROTOCOL_ERROR",
    ],
  ])
    await t.test(name, async () => {
      const f = fixture({
        onRequest(message, reply, child) {
          if (message.method === "account/read")
            child.stdout.write(
              typeof wire === "function" ? wire(message.id) : wire,
            );
        },
      });
      await assert.rejects(f.adapter.readStatus(), { code });
      await f.adapter.close();
      assert.equal(
        f.sent.some(
          (x) =>
            x.method?.startsWith("turn/") || x.method?.startsWith("thread/"),
        ),
        false,
      );
    });
});

test("Codex probe requires explicit opt-in before spawning anything", async () => {
  let called = false;
  await assert.rejects(
    probeCodexStatus({
      spawnProcess() {
        called = true;
      },
    }),
    { code: "OPT_IN_REQUIRED" },
  );
  assert.equal(called, false);
});

test("Codex close during initialization rejects with a safe error and never resumes", async () => {
  const f = fixture({ onInitialize() {} });
  const result = f.adapter.readStatus();
  const check = assert.rejects(
    result,
    (error) =>
      error instanceof CodexStatusError && error.code === "DISCONNECTED",
  );
  await f.adapter.close();
  await check;
  await assert.rejects(f.adapter.readStatus(), { code: "DISCONNECTED" });
  assert.deepEqual(
    f.sent.map((x) => x.method),
    ["initialize"],
  );
});

test("Codex close after initialize reply cannot send initialized or return ready", async () => {
  const f = fixture({
    onInitialize(message, reply) {
      reply({ id: message.id, result: { userAgent: "fixture/1" } });
      void f.adapter.close();
    },
  });
  await assert.rejects(f.adapter.readStatus(), { code: "DISCONNECTED" });
  await f.adapter.close();
  await assert.rejects(f.adapter.readStatus(), { code: "DISCONNECTED" });
  assert.deepEqual(
    f.sent.map((x) => x.method),
    ["initialize"],
  );
});

test("Codex close after status reply cannot report a live connection", async () => {
  const f = fixture({
    onRequest(message, reply) {
      if (message.method !== "account/read") return;
      reply({
        id: message.id,
        result: { account: null, requiresOpenaiAuth: true },
      });
      void f.adapter.close();
    },
  });
  await assert.rejects(f.adapter.readStatus(), { code: "DISCONNECTED" });
  await f.adapter.close();
});

test("Codex spawn failures omit paths and raw diagnostics", async () => {
  const adapter = new CodexStdioStatus({
    spawnProcess() {
      throw Object.assign(new Error("private fixture path"), {
        code: "ENOENT",
      });
    },
  });
  await assert.rejects(adapter.readStatus(), (error) => {
    assert.ok(error instanceof CodexStatusError);
    assert.equal(error.code, "NOT_FOUND");
    assert.ok(!String(error).includes("fixture"));
    return true;
  });
  assert.deepEqual(await adapter.close(), {
    completed: true,
    method: "alreadyClosed",
  });
});

test("Codex reports forced shutdown after an EOF error accurately", async () => {
  const f = fixture();
  await f.adapter.connect();
  f.child.stdin.end = () => {
    throw new Error("fixture EOF failure");
  };
  assert.deepEqual(await f.adapter.close(), {
    completed: true,
    method: "sigterm",
  });
  assert.deepEqual(f.signals, ["SIGTERM"]);
});

test("Codex cannot reconnect after explicit close despite cached initialization", async () => {
  const f = fixture();
  await f.adapter.connect();
  await f.adapter.close();
  await assert.rejects(f.adapter.connect(), { code: "DISCONNECTED" });
  await assert.rejects(f.adapter.readStatus(), { code: "DISCONNECTED" });
  assert.equal(f.spawned.length, 1);
});

test("Codex probe fails when its bounded shutdown cannot confirm child exit", async () => {
  const f = fixture({
    closeOnEof: false,
    onRequest(message, reply) {
      if (message.method === "account/read")
        reply({
          id: message.id,
          result: { account: null, requiresOpenaiAuth: true },
        });
    },
  });
  f.child.kill = (signal) => {
    f.signals.push(signal);
  };
  await assert.rejects(
    probeCodexStatus({
      optIn: true,
      spawnProcess: f.spawnProcess,
      requestTimeoutMs: 100,
      shutdownGraceMs: 10,
    }),
    { code: "SHUTDOWN_FAILED" },
  );
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]);
});
