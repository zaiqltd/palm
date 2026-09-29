import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import path from "node:path";

export class Native extends EventEmitter {
  constructor(root, { synthetic = false, requestTimeout = 10000 } = {}) {
    super();
    this.pending = new Map();
    this.seq = 0;
    this.requestTimeout = requestTimeout;
    this.child = spawn(
      process.env.PALM_NATIVE_PATH ||
        path.join(
          root,
          "build/Palm Companion.app/Contents/MacOS/PalmCompanion",
        ),
      synthetic ? ["--synthetic"] : [],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    this.child.on("error", () =>
      this.fail(
        "The Mac companion is unavailable. Run the native build first.",
      ),
    );
    this.child.on("exit", () =>
      this.fail("The Mac companion has stopped. Restart Palm."),
    );
    this.child.stderr.on("data", () => {});
    this.child.stdin.on("error", () =>
      this.fail("The Mac companion connection stopped. Restart Palm."),
    );
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const x = JSON.parse(line);
        if (x.id) {
          const p = this.pending.get(x.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(x.id);
            x.error ? p.reject(new Error(x.error)) : p.resolve(x.result);
          }
        } else this.emit("event", x);
      } catch {}
    });
  }
  fail(message) {
    if (this.dead) return;
    this.dead = true;
    this.close();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
    this.emit("event", { event: "error", message });
  }
  request(command) {
    if (["start", "stop", "mediaStart", "mediaStop"].includes(command.op)) {
      const run = () => this.rawRequest(command);
      const next = (this.transition || Promise.resolve()).then(run, run);
      this.transition = next.catch(() => {});
      return next;
    }
    return this.rawRequest(command);
  }
  rawRequest(command) {
    if (this.dead)
      return Promise.reject(new Error("Mac companion is unavailable."));
    if (this.pending.size >= 64 || this.child.stdin.writableLength > 65536)
      return Promise.reject(new Error("The Mac companion is busy. Try again."));
    return new Promise((resolve, reject) => {
      const id = String(++this.seq);
      const timer = setTimeout(() => {
        // A timed-out mutation may still be in flight. Terminate the companion
        // instead of allowing uncertain old input to reach a later session.
        this.fail("The Mac did not respond. Restart Palm to reconnect safely.");
      }, this.requestTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }
  close() {
    if (this.closing) return this.closing;
    if (
      !this.child.pid ||
      this.child.exitCode !== null ||
      this.child.signalCode !== null
    )
      return Promise.resolve();
    this.closing = new Promise((resolve) => {
      // EOF gives the companion a chance to stop capture and release held input.
      const terminate = setTimeout(() => this.child.kill("SIGTERM"), 500);
      const force = setTimeout(() => this.child.kill("SIGKILL"), 1500);
      this.child.once("exit", () => {
        clearTimeout(terminate);
        clearTimeout(force);
        resolve();
      });
      this.child.stdin.end();
    });
    return this.closing;
  }
}
