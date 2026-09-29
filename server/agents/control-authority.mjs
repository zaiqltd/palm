import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const messages = {
  INVALID_ARGUMENT: "Invalid control authority argument.",
  INVALID_PRINCIPAL: "The control principal is not recognized.",
  HUMAN_REQUIRED: "A human must authorize this control transfer.",
  BUSY: "Control is owned or changing ownership.",
  CLOSED: "The control authority is closed.",
  FAULTED:
    "Control cleanup is uncertain. Create a new authority after recovery.",
  STALE_LEASE: "The control lease is stale or belongs to another principal.",
  LEASE_EXPIRED: "The control lease expired.",
  LEASE_REVOKED: "The control lease was revoked.",
  STALE_EPOCH: "Control ownership changed before this request.",
  SUPERSEDED: "A stop or close superseded this control transfer.",
  QUEUE_FULL: "The control mutation queue is full.",
  QUEUE_EXPIRED: "The mutation expired before dispatch.",
  MUTATION_TIMEOUT: "The mutation timed out; its outcome is unknown.",
  EXECUTION_FAILED: "The executor failed; its outcome is unknown.",
  BARRIER_TIMEOUT: "Control cleanup timed out.",
  BARRIER_FAILED: "Control cleanup failed.",
  BARRIER_UNCONFIRMED:
    "Control cleanup did not confirm quiescence and input release.",
};

export class ControlAuthorityError extends Error {
  constructor(code, outcome = "notDispatched") {
    super(messages[code] ?? messages.INVALID_ARGUMENT);
    this.name = "ControlAuthorityError";
    this.code = Object.hasOwn(messages, code) ? code : "INVALID_ARGUMENT";
    this.outcome = outcome;
  }
}

const failure = (code, outcome) => new ControlAuthorityError(code, outcome);
const activePhase = (phase) => phase === "human" || phase === "agent";
function bound(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw failure("INVALID_ARGUMENT");
  return value;
}
function targetKey(value) {
  if (typeof value !== "string" || !value || value.length > 200)
    throw failure("INVALID_ARGUMENT");
  return value;
}

/**
 * Isolated in-process ownership core; not wired to Palm's live host.
 *
 * Trusted host code creates opaque principals and maps authenticated callers to
 * those handles. Never expose createPrincipal/stop/close as arbitrary remote RPCs.
 * Only humans claim idle control; resume explicitly transfers a human lease to
 * an agent. takeover, changeTarget, release, stop and close revoke before waiting.
 *
 * execute(command, context) must check context.assertCurrent() immediately before
 * each native post, including after awaits, and propagate boot/epoch into native.
 * barrier(context) runs independently of the mutation FIFO and MUST attest
 * {quiescent:true, released:true}: no revoked-epoch operation can post more input,
 * and held input has been released. AbortSignal alone is not that guarantee.
 * Already-issued OS effects can remain unknown even after successful cleanup.
 * This core cannot constrain arbitrary shell/browser tools outside its executor.
 * Native generation enforcement, observation/focus checks, permission scopes and
 * authentication on EVERY caller remain integration requirements.
 *
 * Leases and deadlines use the injected host monotonic clock. snapshot() excludes
 * lease secrets and command payloads. Executor/barrier errors are never forwarded.
 */
export class ControlAuthority {
  #execute;
  #barrier;
  #now;
  #options;
  #principals = new WeakSet();
  #bootId = randomUUID();
  #epoch = 0;
  #phase = "idle";
  #owner = null;
  #lease = null;
  #leaseTimer;
  #target = null;
  #targetGeneration = 0;
  #queue = [];
  #active = null;
  #transaction = null;
  #closed = false;
  #closing;
  #cleanup = "confirmed";

  constructor({
    execute,
    barrier,
    now = () => performance.now(),
    maxPending = 32,
    maxQueueMs = 1000,
    mutationTimeoutMs = 5000,
    barrierTimeoutMs = 2000,
    leaseMs = 15000,
  } = {}) {
    if (
      typeof execute !== "function" ||
      typeof barrier !== "function" ||
      typeof now !== "function"
    )
      throw failure("INVALID_ARGUMENT");
    this.#execute = execute;
    this.#barrier = barrier;
    this.#now = now;
    this.#options = {
      maxPending: bound(maxPending, 1, 256),
      maxQueueMs: bound(maxQueueMs, 1, 30000),
      mutationTimeoutMs: bound(mutationTimeoutMs, 10, 60000),
      barrierTimeoutMs: bound(barrierTimeoutMs, 10, 30000),
      leaseMs: bound(leaseMs, 10, 300000),
    };
  }

  createPrincipal(kind) {
    this.#available();
    if (kind !== "human" && kind !== "agent") throw failure("INVALID_ARGUMENT");
    const principal = Object.freeze({ kind, id: randomUUID() });
    this.#principals.add(principal);
    return principal;
  }

  snapshot() {
    return Object.freeze({
      bootId: this.#bootId,
      epoch: this.#epoch,
      phase: this.#phase,
      owner: this.#owner
        ? Object.freeze({ kind: this.#owner.kind, id: this.#owner.id })
        : null,
      target: this.#target,
      targetGeneration: this.#targetGeneration,
      pending: this.#queue.length + Number(!!this.#active),
      cleanup: this.#cleanup,
    });
  }

  claim(principal, target) {
    this.#available();
    this.#principal(principal, "human");
    targetKey(target);
    if (this.#phase !== "idle") throw failure("BUSY");
    this.#epoch++;
    return this.#grant(principal, target);
  }

  renew(principal, lease) {
    this.#checkLease(principal, lease);
    this.#lease = Object.freeze({
      ...this.#lease,
      expiresAtHostMs: this.#now() + this.#options.leaseMs,
    });
    this.#armLease();
    return this.#lease;
  }

  async resume(human, lease, agent) {
    this.#checkLease(human, lease);
    this.#principal(human, "human");
    this.#principal(agent, "agent");
    return this.#transfer(
      { principal: agent, target: this.#target, phase: "agent" },
      "resume",
    );
  }

  async takeover(human, expectedEpoch) {
    this.#available();
    this.#principal(human, "human");
    if (expectedEpoch !== this.#epoch) throw failure("STALE_EPOCH");
    if (!activePhase(this.#phase)) throw failure("BUSY");
    return this.#transfer(
      { principal: human, target: this.#target, phase: "human" },
      "takeover",
    );
  }

  async changeTarget(principal, lease, target) {
    this.#checkLease(principal, lease);
    targetKey(target);
    return this.#transfer(
      { principal, target, phase: principal.kind },
      "target-change",
    );
  }

  async release(principal, lease) {
    this.#checkLease(principal, lease);
    return this.#begin({ phase: "idle" }, "release").promise;
  }

  // Trusted local stop supersedes an in-progress grant without starting another barrier.
  async stop() {
    if (this.#closed)
      return (
        this.#closing ?? { state: this.snapshot(), cleanup: this.#cleanup }
      );
    const tx = this.#transaction;
    if (tx) {
      tx.destination = {
        phase: tx.destination.phase === "faulted" ? "faulted" : "idle",
      };
    }
    return this.#cleanupResult(
      tx ??
        this.#begin(
          { phase: this.#phase === "faulted" ? "faulted" : "idle" },
          "stop",
        ),
    );
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    const tx = this.#transaction;
    if (tx) tx.destination = { phase: "closed" };
    this.#closing = this.#cleanupResult(
      tx ?? this.#begin({ phase: "closed" }, "close"),
    );
    return this.#closing;
  }

  async mutate(principal, lease, command) {
    this.#checkLease(principal, lease);
    if (this.#queue.length + Number(!!this.#active) >= this.#options.maxPending)
      throw failure("QUEUE_FULL");
    let copy;
    try {
      if (!command || typeof command !== "object" || Array.isArray(command))
        throw new Error();
      const json = JSON.stringify(command);
      if (Buffer.byteLength(json) > 16384) throw new Error();
      copy = JSON.parse(json);
      if (!copy || typeof copy !== "object" || Array.isArray(copy))
        throw new Error();
    } catch {
      throw failure("INVALID_ARGUMENT");
    }
    return new Promise((resolve, reject) => {
      this.#queue.push({
        principal,
        lease: { ...lease },
        command: copy,
        created: this.#now(),
        actionId: randomUUID(),
        resolve,
        reject,
        started: false,
        settled: false,
        abort: new AbortController(),
      });
      queueMicrotask(() => this.#pump());
    });
  }

  #available() {
    if (this.#closed || this.#phase === "closed") throw failure("CLOSED");
    if (this.#phase === "faulted") throw failure("FAULTED");
  }
  #principal(value, kind) {
    if (!value || !this.#principals.has(value))
      throw failure("INVALID_PRINCIPAL");
    if (kind && value.kind !== kind) throw failure("HUMAN_REQUIRED");
  }
  #checkLease(principal, lease) {
    this.#available();
    this.#principal(principal);
    if (
      activePhase(this.#phase) &&
      this.#lease.expiresAtHostMs <= this.#now()
    ) {
      this.#expireLease(this.#epoch);
      throw failure("LEASE_EXPIRED");
    }
    if (
      !activePhase(this.#phase) ||
      this.#owner !== principal ||
      !lease ||
      lease.bootId !== this.#bootId ||
      lease.epoch !== this.#epoch ||
      lease.leaseId !== this.#lease?.leaseId ||
      lease.targetGeneration !== this.#targetGeneration
    )
      throw failure("STALE_LEASE");
  }
  #grant(principal, target) {
    this.#owner = principal;
    this.#target = target;
    this.#targetGeneration++;
    this.#phase = principal.kind;
    this.#lease = Object.freeze({
      bootId: this.#bootId,
      epoch: this.#epoch,
      leaseId: randomUUID(),
      targetGeneration: this.#targetGeneration,
      expiresAtHostMs: this.#now() + this.#options.leaseMs,
    });
    this.#armLease();
    return this.#lease;
  }
  #armLease() {
    clearTimeout(this.#leaseTimer);
    const epoch = this.#epoch;
    this.#leaseTimer = setTimeout(
      () => this.#expireLease(epoch),
      Math.max(1, this.#lease.expiresAtHostMs - this.#now()),
    );
  }
  #expireLease(epoch) {
    if (this.#epoch !== epoch || !activePhase(this.#phase)) return;
    if (this.#lease.expiresAtHostMs > this.#now()) {
      this.#armLease();
      return;
    }
    void this.#begin({ phase: "idle" }, "lease-expired").promise.catch(
      () => {},
    );
  }

  async #transfer(destination, reason) {
    const tx = this.#begin(destination, reason);
    const result = await tx.promise;
    if (tx.destination !== destination) throw failure("SUPERSEDED");
    return result.lease;
  }

  #begin(destination, reason) {
    if (this.#transaction) throw failure("BUSY");
    const revokedEpoch = this.#epoch;
    const tx = {
      destination,
      reason,
      settled: false,
      deadline: this.#now() + this.#options.barrierTimeoutMs,
    };
    tx.promise = new Promise((resolve, reject) => {
      tx.resolve = resolve;
      tx.reject = reject;
    });
    this.#transaction = tx;
    this.#epoch++;
    this.#phase = "transitioning";
    this.#cleanup = "pending";
    this.#owner = null;
    this.#lease = null;
    clearTimeout(this.#leaseTimer);
    const active = this.#active;
    this.#active = null;
    const queued = this.#queue.splice(0);
    for (const entry of queued) this.#settle(entry, failure("LEASE_REVOKED"));
    if (active) {
      this.#settle(
        active,
        failure("LEASE_REVOKED", active.started ? "unknown" : "notDispatched"),
      );
      active.abort.abort();
    }
    const context = Object.freeze({
      bootId: this.#bootId,
      throughEpoch: revokedEpoch,
      epoch: this.#epoch,
      reason,
      activeActionId: active?.actionId ?? null,
    });
    tx.timer = setTimeout(
      () => this.#finishBarrier(tx, null, "BARRIER_TIMEOUT"),
      this.#options.barrierTimeoutMs,
    );
    // Separate from execute() and its promise: urgent revocation cannot wait on a stuck mutation.
    Promise.resolve()
      .then(() => this.#barrier(context))
      .then(
        (result) => this.#finishBarrier(tx, result),
        () => this.#finishBarrier(tx, null, "BARRIER_FAILED"),
      );
    return tx;
  }

  #finishBarrier(tx, result, errorCode) {
    if (tx.settled || this.#transaction !== tx) return;
    tx.settled = true;
    clearTimeout(tx.timer);
    this.#transaction = null;
    if (this.#now() >= tx.deadline) errorCode = "BARRIER_TIMEOUT";
    if (!errorCode && (result?.quiescent !== true || result?.released !== true))
      errorCode = "BARRIER_UNCONFIRMED";
    if (errorCode) {
      this.#cleanup = "unknown";
      this.#phase = this.#closed ? "closed" : "faulted";
      this.#target = null;
      tx.reject(failure(errorCode, "unknown"));
      return;
    }
    this.#cleanup = "confirmed";
    const destination = tx.destination;
    let lease;
    if (!this.#closed && destination.principal)
      lease = this.#grant(destination.principal, destination.target);
    else {
      this.#phase = this.#closed ? "closed" : destination.phase;
      this.#target = null;
    }
    tx.resolve({
      state: this.snapshot(),
      cleanup: "confirmed",
      ...(lease ? { lease } : {}),
    });
  }

  async #cleanupResult(tx) {
    try {
      return await tx.promise;
    } catch (error) {
      return {
        state: this.snapshot(),
        cleanup: "unknown",
        errorCode: error.code,
      };
    }
  }

  #settle(entry, error, value) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    if (error) entry.reject(error);
    else
      entry.resolve({ actionId: entry.actionId, outcome: "executed", value });
  }

  #pump() {
    if (this.#active || !activePhase(this.#phase)) return;
    const entry = this.#queue.shift();
    if (!entry) return;
    try {
      this.#checkLease(entry.principal, entry.lease);
      if (this.#now() - entry.created >= this.#options.maxQueueMs)
        throw failure("QUEUE_EXPIRED");
    } catch (error) {
      this.#settle(entry, error);
      queueMicrotask(() => this.#pump());
      return;
    }
    this.#active = entry;
    entry.deadline = this.#now() + this.#options.mutationTimeoutMs;
    const assertCurrent = () => {
      if (this.#active !== entry || entry.abort.signal.aborted)
        throw failure("LEASE_REVOKED", "unknown");
      if (this.#now() >= entry.deadline) {
        this.#executionFailed(entry, "MUTATION_TIMEOUT");
        throw failure(
          "MUTATION_TIMEOUT",
          entry.started ? "unknown" : "notDispatched",
        );
      }
      this.#checkLease(entry.principal, entry.lease);
    };
    const context = Object.freeze({
      bootId: this.#bootId,
      epoch: this.#epoch,
      target: this.#target,
      targetGeneration: this.#targetGeneration,
      actionId: entry.actionId,
      signal: entry.abort.signal,
      assertCurrent,
    });
    entry.timer = setTimeout(
      () => this.#executionFailed(entry, "MUTATION_TIMEOUT"),
      this.#options.mutationTimeoutMs,
    );
    Promise.resolve()
      .then(() => {
        assertCurrent();
        entry.started = true;
        return this.#execute(entry.command, context);
      })
      .then(
        (value) => {
          if (this.#active !== entry) return;
          try {
            assertCurrent();
          } catch {
            return;
          } // Expiry already revoked and settled this entry.
          this.#active = null;
          this.#settle(entry, null, value);
          this.#pump();
        },
        () => this.#executionFailed(entry, "EXECUTION_FAILED"),
      );
  }

  #executionFailed(entry, code) {
    if (this.#active !== entry) return;
    this.#settle(
      entry,
      failure(code, entry.started ? "unknown" : "notDispatched"),
    );
    void this.#begin({ phase: "faulted" }, code).promise.catch(() => {});
  }
}
