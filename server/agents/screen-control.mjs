import { ControlAuthority } from "./control-authority.mjs";

// One owner of Mac input at a time: the person on the phone, or one agent task.
//
// Built on the tested ControlAuthority core. The phone's manual input claims
// idle control; an agent only acts after the user allowed screen control for its
// task, and never while the phone holds the screen. "Take over" revokes the agent's
// lease and runs the native release barrier before any phone input is
// accepted; "Hand back" transfers a fresh lease to the agent. A native command
// that is rejected before dispatch comes back as a value, so ordinary errors
// ("that window moved") never fault the authority. A genuine fault rebuilds it.
export class ScreenControl {
  constructor({ native, onChange = () => {}, leaseMs = 20000 }) {
    this.native = native;
    this.onChange = onChange;
    this.leaseMs = leaseMs;
    this.hold = null; // taskId the human took the screen from, while held
    this.humanLease = null;
    this.agentLeases = new Map(); // taskId -> lease
    this.agentPrincipals = new Map();
    this.allowed = new Set(); // taskIds with screen control permitted
    this.build();
    this.renewTimer = setInterval(() => this.renew(), 4000);
    this.renewTimer.unref();
  }

  build() {
    this.authority = new ControlAuthority({
      leaseMs: this.leaseMs,
      mutationTimeoutMs: 15000,
      maxQueueMs: 3000,
      barrierTimeoutMs: 4000,
      execute: async (command, context) => {
        context.assertCurrent();
        try {
          return { ok: true, value: await this.native.request(command) };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      },
      barrier: async () => {
        const result = await this.native.request({ op: "release" });
        return { quiescent: result?.quiescent === true, released: result?.released === true };
      },
    });
    this.human = this.authority.createPrincipal("human");
    this.agentPrincipals.clear();
    this.humanLease = null;
    this.agentLeases.clear();
  }

  recoverIfFaulted() {
    const phase = this.authority.snapshot().phase;
    if (phase === "faulted" || phase === "closed") {
      this.build();
      this.onChange(this.state());
    }
  }

  agent(taskId) {
    let principal = this.agentPrincipals.get(taskId);
    if (!principal) {
      principal = this.authority.createPrincipal("agent");
      this.agentPrincipals.set(taskId, principal);
    }
    return principal;
  }

  state() {
    const snap = this.authority.snapshot();
    let owner = null;
    if (snap.phase === "human") owner = { kind: "human" };
    if (snap.phase === "agent")
      for (const [taskId, principal] of this.agentPrincipals)
        if (snap.owner?.id === principal.id) owner = { kind: "agent", taskId };
    return { phase: snap.phase, owner, held: !!this.hold, heldFrom: this.hold, epoch: snap.epoch };
  }

  ownerTask() {
    return this.state().owner?.kind === "agent" ? this.state().owner.taskId : null;
  }

  allow(taskId, allowed) {
    if (allowed) this.allowed.add(taskId);
    else {
      this.allowed.delete(taskId);
      if (this.ownerTask() === taskId) void this.releaseAgent(taskId);
    }
  }

  // Phone input. Claims idle control; refuses while an agent is working.
  async humanInput(command) {
    this.recoverIfFaulted();
    const snap = this.authority.snapshot();
    if (snap.phase === "agent")
      throw new Error("An agent is using the screen. Tap Take over to control it yourself.");
    if (snap.phase === "transitioning") throw new Error("Screen control is changing hands. Try again.");
    if (snap.phase === "idle") {
      this.humanLease = this.authority.claim(this.human, "mac");
      this.onChange(this.state());
    }
    const outcome = await this.mutate(this.human, () => this.humanLease, command);
    return outcome;
  }

  async mutate(principal, leaseOf, command) {
    let lease = leaseOf();
    try {
      lease = this.authority.renew(principal, lease);
      if (principal === this.human) this.humanLease = lease;
    } catch (error) {
      throw new Error(error.code === "LEASE_EXPIRED" ? "Screen control expired. Try again." : "Screen control changed hands.");
    }
    try {
      const result = await this.authority.mutate(principal, lease, command);
      if (result.value?.ok === false) throw new Error(result.value.error);
      return result.value?.value;
    } catch (error) {
      if (error.name === "ControlAuthorityError") {
        this.recoverIfFaulted();
        if (error.code === "LEASE_REVOKED" || error.code === "STALE_LEASE" || error.code === "STALE_EPOCH")
          throw new Error("Screen control changed hands before this action ran. It was not repeated.");
        throw new Error(error.message);
      }
      throw error;
    }
  }

  // Take the screen from an agent (or keep it). Held until handBack.
  async takeOver() {
    this.recoverIfFaulted();
    const before = this.state();
    const from = before.owner?.kind === "agent" ? before.owner.taskId : this.hold;
    if (before.phase === "agent") {
      this.humanLease = await this.authority.takeover(this.human, this.authority.snapshot().epoch);
      this.agentLeases.clear();
    } else if (before.phase === "idle") {
      this.humanLease = this.authority.claim(this.human, "mac");
    }
    this.hold = from || "manual";
    this.onChange(this.state());
    return { ...this.state(), from };
  }

  // Give the screen back to the agent task that had it (or a chosen task).
  async handBack(taskId) {
    this.recoverIfFaulted();
    const target = taskId || (this.hold !== "manual" ? this.hold : null);
    this.hold = null;
    if (!target || !this.allowed.has(target)) {
      // Nothing to resume: release to idle so an agent can ask again later.
      if (this.authority.snapshot().phase === "human") await this.authority.release(this.human, this.humanLease).catch(() => {});
      this.humanLease = null;
      this.onChange(this.state());
      return this.state();
    }
    const snap = this.authority.snapshot();
    if (snap.phase === "idle") this.humanLease = this.authority.claim(this.human, "mac");
    else if (snap.phase === "agent") {
      this.humanLease = await this.authority.takeover(this.human, snap.epoch);
    }
    const lease = await this.authority.resume(this.human, this.humanLease, this.agent(target));
    this.humanLease = null;
    this.agentLeases.set(target, lease);
    this.onChange(this.state());
    return this.state();
  }

  // Agent input: allowed only for a permitted task, never while the phone holds it.
  async agentInput(taskId, command) {
    this.recoverIfFaulted();
    if (!this.allowed.has(taskId))
      throw new Error("Screen control is off for this task. Ask the user to allow it in Palm.");
    if (this.hold)
      throw new Error("The user has taken control of the Mac screen. Do not use screen tools until they hand it back; continue other work or wait.");
    let snap = this.authority.snapshot();
    const principal = this.agent(taskId);
    const mine = snap.phase === "agent" && snap.owner?.id === principal.id;
    if (!mine) {
      if (snap.phase === "human")
        throw new Error("The user is controlling the Mac screen right now. Wait a moment, then take a new screenshot.");
      if (snap.phase === "agent") throw new Error("Another agent task is using the screen.");
      if (snap.phase !== "idle") throw new Error("Screen control is changing hands. Try again shortly.");
      // The user allowed this task to use the screen; grant it from idle.
      const humanLease = this.authority.claim(this.human, "mac");
      const lease = await this.authority.resume(this.human, humanLease, principal);
      this.agentLeases.set(taskId, lease);
      this.onChange(this.state());
    }
    return this.mutate(principal, () => this.agentLeases.get(taskId), command);
  }

  // The phone's live screen closed. Its claim ends now instead of 20 s later,
  // so an agent allowed the screen can use it at once; a screen taken over
  // stays held until Hand back.
  async releaseHuman() {
    if (this.hold) return;
    if (this.authority.snapshot().phase === "human" && this.humanLease)
      await this.authority.release(this.human, this.humanLease).catch(() => {});
    this.humanLease = null;
    this.onChange(this.state());
  }

  async releaseAgent(taskId) {
    const principal = this.agentPrincipals.get(taskId);
    const lease = this.agentLeases.get(taskId);
    if (!principal || !lease) return;
    this.agentLeases.delete(taskId);
    await this.authority.release(principal, lease).catch(() => {});
    this.onChange(this.state());
  }

  // Keep a held screen held, and a working agent's lease alive while its turn runs.
  renew() {
    const snap = this.authority.snapshot();
    try {
      if (snap.phase === "human" && this.hold && this.humanLease)
        this.humanLease = this.authority.renew(this.human, this.humanLease);
    } catch {}
    for (const [taskId, lease] of this.agentLeases) {
      if (!this.activeTasks?.has(taskId)) continue;
      try {
        this.agentLeases.set(taskId, this.authority.renew(this.agent(taskId), lease));
      } catch {
        this.agentLeases.delete(taskId);
      }
    }
  }

  close() {
    clearInterval(this.renewTimer);
    return this.authority.close();
  }
}
