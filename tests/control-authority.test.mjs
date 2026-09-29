import test from "node:test";
import assert from "node:assert/strict";
import {
  ControlAuthority,
  ControlAuthorityError,
} from "../server/agents/control-authority.mjs";

const confirmed = { quiescent: true, released: true };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture(t, options = {}) {
  const posted = [];
  const core = new ControlAuthority({
    execute(command, context) {
      context.assertCurrent();
      posted.push(command);
      return "done";
    },
    barrier: async () => confirmed,
    ...options,
  });
  const human = core.createPrincipal("human"),
    agent = core.createPrincipal("agent");
  t.after(() => core.close());
  return { core, human, agent, posted };
}
const rejected = (promise, code, outcome = "notDispatched") =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof ControlAuthorityError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    return true;
  });

test("control principals and leases are host-issued, scoped and single-owner", async (t) => {
  const { core, human, agent, posted } = fixture(t);
  const other = core.createPrincipal("human");
  assert.throws(() => core.claim(agent, "window:7"), {
    code: "HUMAN_REQUIRED",
  });
  const lease = core.claim(human, "window:7");
  assert.throws(() => core.claim(other, "window:7"), { code: "BUSY" });
  assert.equal(Object.isFrozen(lease), true);
  assert.equal(JSON.stringify(core.snapshot()).includes(lease.leaseId), false);
  await rejected(
    core.mutate({ ...human }, lease, { op: "click" }),
    "INVALID_PRINCIPAL",
  );
  await rejected(
    core.mutate(core.snapshot().owner, lease, { op: "click" }),
    "INVALID_PRINCIPAL",
  );
  await rejected(core.mutate(agent, lease, { op: "click" }), "STALE_LEASE");
  await rejected(
    core.mutate(human, { ...lease, bootId: "other-boot" }, { op: "click" }),
    "STALE_LEASE",
  );
  await rejected(
    core.mutate(human, { ...lease, targetGeneration: 0 }, { op: "click" }),
    "STALE_LEASE",
  );
  assert.deepEqual(posted, []);
  const agentLease = await core.resume(human, lease, agent);
  assert.equal(core.snapshot().phase, "agent");
  assert.ok(agentLease.epoch > lease.epoch);
  await rejected(core.mutate(human, lease, { op: "old" }), "STALE_LEASE");
  await rejected(core.takeover(agent, agentLease.epoch), "HUMAN_REQUIRED");
  await rejected(core.resume(agent, agentLease, agent), "HUMAN_REQUIRED");
  const result = await core.mutate(agent, agentLease, { op: "current" });
  assert.equal(result.outcome, "executed");
  assert.deepEqual(posted, [{ op: "current" }]);
});

test("mutations are serialized, bounded and copied before queuing", async (t) => {
  const gate = deferred(),
    began = deferred(),
    posted = [];
  const { core, human } = fixture(t, {
    maxPending: 2,
    execute: async (command, context) => {
      context.assertCurrent();
      posted.push(command.op);
      if (command.op === "first") {
        began.resolve();
        await gate.promise;
      }
      return command.op;
    },
  });
  const lease = core.claim(human, "window:7");
  const first = core.mutate(human, lease, { op: "first" });
  await began.promise;
  const command = { op: "second" };
  const second = core.mutate(human, lease, command);
  command.op = "changed after enqueue";
  await rejected(core.mutate(human, lease, { op: "overflow" }), "QUEUE_FULL");
  assert.deepEqual(posted, ["first"]);
  gate.resolve();
  assert.equal((await first).value, "first");
  assert.equal((await second).value, "second");
  assert.deepEqual(posted, ["first", "second"]);
  await rejected(
    core.mutate(human, lease, { text: "x".repeat(17000) }),
    "INVALID_ARGUMENT",
  );
  for (const command of [
    new Date(),
    { toJSON: () => "primitive" },
    { toJSON: () => [] },
  ])
    await rejected(core.mutate(human, lease, command), "INVALID_ARGUMENT");
});

test("queued mutations expire before dispatch without faulting completed work", async (t) => {
  let now = 0;
  const gate = deferred(),
    began = deferred(),
    posted = [];
  const { core, human } = fixture(t, {
    now: () => now,
    maxQueueMs: 10,
    execute: async (command) => {
      posted.push(command.op);
      began.resolve();
      await gate.promise;
    },
  });
  const lease = core.claim(human, "window:7");
  const first = core.mutate(human, lease, { op: "first" });
  await began.promise;
  const queued = rejected(
    core.mutate(human, lease, { op: "late" }),
    "QUEUE_EXPIRED",
  );
  now = 11;
  gate.resolve();
  await Promise.all([first, queued]);
  assert.deepEqual(posted, ["first"]);
  assert.equal(core.snapshot().phase, "human");
});

test("takeover bypasses a stuck executor and rejects its queued epoch before granting", async (t) => {
  const began = deferred(),
    oldGate = deferred(),
    barrierBegan = deferred(),
    barrierGate = deferred();
  const posted = [];
  let oldContext;
  const { core, human, agent } = fixture(t, {
    execute: async (command, context) => {
      if (command.op === "old") {
        oldContext = context;
        began.resolve();
        await oldGate.promise; // Deliberately ignores AbortSignal while waiting.
      }
      context.assertCurrent();
      posted.push(command.op);
      return "done";
    },
    barrier: async (context) => {
      if (context.reason === "takeover") {
        barrierBegan.resolve(context);
        await barrierGate.promise;
      }
      return confirmed;
    },
  });
  const agentLease = await core.resume(
    human,
    core.claim(human, "window:7"),
    agent,
  );
  const running = rejected(
    core.mutate(agent, agentLease, { op: "old" }),
    "LEASE_REVOKED",
    "unknown",
  );
  await began.promise;
  const queued = rejected(
    core.mutate(agent, agentLease, { op: "queued old" }),
    "LEASE_REVOKED",
  );
  let granted = false;
  const takeover = core.takeover(human, agentLease.epoch).then((lease) => {
    granted = true;
    return lease;
  });
  const barrierContext = await barrierBegan.promise;
  await Promise.all([running, queued]);
  assert.equal(oldContext.signal.aborted, true);
  assert.equal(barrierContext.throughEpoch, agentLease.epoch);
  assert.equal(core.snapshot().phase, "transitioning");
  assert.equal(core.snapshot().owner, null);
  assert.equal(core.snapshot().cleanup, "pending");
  assert.equal(granted, false);
  barrierGate.resolve();
  const humanLease = await takeover;
  await core.mutate(human, humanLease, { op: "new human" });
  oldGate.resolve();
  await tick();
  assert.deepEqual(posted, ["new human"]);
  assert.equal(core.snapshot().phase, "human");
  assert.throws(() => oldContext.assertCurrent(), { code: "LEASE_REVOKED" });
  await rejected(
    core.mutate(agent, agentLease, { op: "old again" }),
    "STALE_LEASE",
  );
});

test("target change invalidates old generation and rejects stale takeover intents", async (t) => {
  const { core, human } = fixture(t);
  const before = core.claim(human, "window:7");
  const after = await core.changeTarget(human, before, "window:8");
  assert.ok(after.targetGeneration > before.targetGeneration);
  assert.equal(core.snapshot().target, "window:8");
  await rejected(
    core.mutate(human, before, { op: "old target" }),
    "STALE_LEASE",
  );
  await rejected(core.takeover(human, before.epoch), "STALE_EPOCH");
  await core.mutate(human, after, { op: "new target" });
  await core.release(human, after);
  assert.equal(core.snapshot().phase, "idle");
  await rejected(core.mutate(human, after, { op: "released" }), "STALE_LEASE");
});

test("stop or close supersedes an in-flight transfer and late barrier never grants it", async (t) => {
  for (const operation of ["stop", "close"])
    await t.test(operation, async (t) => {
      const barrierGate = deferred(),
        barrierBegan = deferred();
      const { core, human, agent } = fixture(t, {
        barrier: async ({ reason }) => {
          if (reason === "resume") {
            barrierBegan.resolve();
            await barrierGate.promise;
          }
          return confirmed;
        },
      });
      const lease = core.claim(human, "window:7");
      const transfer = rejected(core.resume(human, lease, agent), "SUPERSEDED");
      await barrierBegan.promise;
      const stopped = core[operation]();
      barrierGate.resolve();
      await transfer;
      assert.equal((await stopped).cleanup, "confirmed");
      assert.equal(
        core.snapshot().phase,
        operation === "close" ? "closed" : "idle",
      );
      await rejected(
        core.mutate(human, lease, { op: "old" }),
        operation === "close" ? "CLOSED" : "STALE_LEASE",
      );
      if (operation === "close")
        assert.throws(() => core.claim(human, "window:7"), { code: "CLOSED" });
    });
});

test("unconfirmed, rejected and timed-out barriers fault closed, including late success", async (t) => {
  for (const mode of ["unconfirmed", "rejected", "timeout"])
    await t.test(mode, async (t) => {
      const late = deferred();
      const { core, human, agent } = fixture(t, {
        barrierTimeoutMs: 15,
        barrier: async ({ reason }) => {
          if (reason !== "resume") return confirmed;
          if (mode === "timeout") return late.promise;
          if (mode === "rejected")
            throw new Error("private executor diagnostic");
          return { quiescent: true, released: false };
        },
      });
      const lease = core.claim(human, "window:7");
      const code = {
        unconfirmed: "BARRIER_UNCONFIRMED",
        rejected: "BARRIER_FAILED",
        timeout: "BARRIER_TIMEOUT",
      }[mode];
      await rejected(core.resume(human, lease, agent), code, "unknown");
      assert.equal(core.snapshot().phase, "faulted");
      assert.equal(core.snapshot().cleanup, "unknown");
      late.resolve(confirmed);
      await tick();
      assert.equal(core.snapshot().phase, "faulted");
      assert.throws(() => core.claim(human, "window:7"), { code: "FAULTED" });
      await core.stop();
      assert.equal(core.snapshot().phase, "faulted");
    });
});

test("mutation timeout is outcome-unknown and a late executor cannot restore control", async (t) => {
  const late = deferred(),
    began = deferred(),
    cleanupBegan = deferred(),
    cleanupGate = deferred();
  const { core, human } = fixture(t, {
    mutationTimeoutMs: 15,
    execute: async () => {
      began.resolve();
      return late.promise;
    },
    barrier: async ({ reason }) => {
      if (reason === "MUTATION_TIMEOUT") {
        cleanupBegan.resolve();
        await cleanupGate.promise;
      }
      return confirmed;
    },
  });
  const lease = core.claim(human, "window:7");
  const first = rejected(
    core.mutate(human, lease, { op: "uncertain" }),
    "MUTATION_TIMEOUT",
    "unknown",
  );
  await began.promise;
  const waiting = rejected(
    core.mutate(human, lease, { op: "never dispatched" }),
    "LEASE_REVOKED",
  );
  await cleanupBegan.promise;
  await Promise.all([first, waiting]);
  assert.equal(core.snapshot().phase, "transitioning");
  cleanupGate.resolve();
  await tick();
  assert.equal(core.snapshot().phase, "faulted");
  late.resolve("late success");
  await tick();
  assert.equal(core.snapshot().phase, "faulted");
  await rejected(core.mutate(human, lease, { op: "retry" }), "FAULTED");
});

test("executor rejection is redacted and cannot be described as not dispatched", async (t) => {
  const { core, human } = fixture(t, {
    execute() {
      throw new Error("private fixture text");
    },
  });
  const lease = core.claim(human, "window:7");
  await assert.rejects(
    core.mutate(human, lease, { text: "fixture only" }),
    (error) => {
      assert.equal(error.code, "EXECUTION_FAILED");
      assert.equal(error.outcome, "unknown");
      assert.equal(String(error).includes("private"), false);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
  await tick();
  assert.equal(core.snapshot().phase, "faulted");
});

test("lease renewal and expiry use host time, revoke access, and require a fresh claim", async (t) => {
  let now = 0;
  const cleanupBegan = deferred(),
    gate = deferred();
  const { core, human } = fixture(t, {
    now: () => now,
    leaseMs: 100,
    barrier: async ({ reason }) => {
      if (reason === "lease-expired") {
        cleanupBegan.resolve();
        await gate.promise;
      }
      return confirmed;
    },
  });
  let lease = core.claim(human, "window:7");
  now = 50;
  lease = core.renew(human, lease);
  assert.equal(lease.expiresAtHostMs, 150);
  now = 149;
  await core.mutate(human, lease, { op: "still valid" });
  now = 150;
  await rejected(core.mutate(human, lease, { op: "expired" }), "LEASE_EXPIRED");
  await cleanupBegan.promise;
  assert.throws(() => core.claim(human, "window:7"), { code: "BUSY" });
  gate.resolve();
  await tick();
  assert.equal(core.snapshot().phase, "idle");
  const fresh = core.claim(human, "window:7");
  assert.ok(fresh.epoch > lease.epoch);
});

test("monotonic mutation deadline rejects a late post before the timer callback runs", async (t) => {
  let now = 0;
  const gate = deferred(),
    began = deferred(),
    posted = [];
  const { core, human } = fixture(t, {
    now: () => now,
    mutationTimeoutMs: 1000,
    execute: async (command, context) => {
      began.resolve();
      await gate.promise;
      context.assertCurrent();
      posted.push(command.op);
    },
  });
  const lease = core.claim(human, "window:7");
  const result = rejected(
    core.mutate(human, lease, { op: "too late" }),
    "MUTATION_TIMEOUT",
    "unknown",
  );
  await began.promise;
  now = 1000;
  gate.resolve();
  await result;
  await tick();
  assert.deepEqual(posted, []);
  assert.equal(core.snapshot().phase, "faulted");
});

test("monotonic barrier deadline rejects late confirmation before its timer callback runs", async (t) => {
  let now = 0;
  const gate = deferred(),
    began = deferred();
  const { core, human, agent } = fixture(t, {
    now: () => now,
    barrierTimeoutMs: 1000,
    barrier: async ({ reason }) => {
      if (reason === "resume") {
        began.resolve();
        await gate.promise;
      }
      return confirmed;
    },
  });
  const result = rejected(
    core.resume(human, core.claim(human, "window:7"), agent),
    "BARRIER_TIMEOUT",
    "unknown",
  );
  await began.promise;
  now = 1000;
  gate.resolve();
  await result;
  assert.equal(core.snapshot().phase, "faulted");
  assert.equal(core.snapshot().owner, null);
});

test("close is terminal and reports unknown cleanup instead of pretending success", async () => {
  const core = new ControlAuthority({
    execute: async () => {},
    barrier: async () => ({ quiescent: false, released: false }),
  });
  const human = core.createPrincipal("human"),
    lease = core.claim(human, "window:7");
  const result = await core.close();
  assert.equal(result.cleanup, "unknown");
  assert.equal(result.errorCode, "BARRIER_UNCONFIRMED");
  assert.equal(result.state.phase, "closed");
  assert.equal(await core.close(), result);
  await rejected(core.mutate(human, lease, { op: "closed" }), "CLOSED");
  assert.throws(() => core.createPrincipal("human"), { code: "CLOSED" });
});
