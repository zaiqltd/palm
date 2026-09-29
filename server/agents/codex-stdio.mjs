import { spawn } from "node:child_process";

// A status-only proof, not an agent runner. Public protocol reference:
// https://learn.chatgpt.com/docs/app-server
export const CODEX_STATUS_CAVEAT =
  "Codex app-server is experimental and is not supported for production workloads.";

const messages = {
  OPT_IN_REQUIRED: "The local Codex status probe requires explicit opt-in.",
  NOT_FOUND: "The Codex executable is unavailable.",
  SPAWN_FAILED: "The Codex status process could not start.",
  DISCONNECTED: "The Codex status connection closed.",
  TIMEOUT: "The Codex status request timed out.",
  PROTOCOL_ERROR: "Codex returned an invalid status protocol message.",
  FRAME_TOO_LARGE: "Codex exceeded the status message size limit.",
  REMOTE_ERROR: "Codex could not complete the status request.",
  UNSUPPORTED_REQUEST: "Codex requested an operation outside the status probe.",
  BUSY: "The Codex status probe has too many pending requests.",
  SHUTDOWN_FAILED: "The Codex status process did not confirm shutdown.",
};

export class CodexStatusError extends Error {
  constructor(code) {
    super(messages[code] ?? messages.PROTOCOL_ERROR);
    this.name = "CodexStatusError";
    this.code = Object.hasOwn(messages, code) ? code : "PROTOCOL_ERROR";
  }
}

function boundedInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new TypeError("Invalid Codex status probe bound.");
  return value;
}

// The child can use its own normal credential store. Never forward unrelated
// provider keys, account overrides, desktop session credentials, or telemetry.
function childEnvironment() {
  return Object.fromEntries(
    ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SystemRoot"]
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  );
}

export class CodexStdioStatus {
  #child;
  #state = "new";
  #failure;
  #connecting;
  #closing;
  #pending = new Map();
  #nextId = 1;
  #partial = Buffer.alloc(0);
  #closed = false;
  #closeSignal;
  #closeEvent = new Promise((resolve) => {
    this.#closeSignal = resolve;
  });
  #options;

  constructor({
    executable = "codex",
    spawnProcess = spawn,
    requestTimeoutMs = 5000,
    shutdownGraceMs = 750,
    maxFrameBytes = 65536,
  } = {}) {
    if (
      typeof executable !== "string" ||
      !executable ||
      executable.includes("\0")
    )
      throw new TypeError("Invalid Codex executable.");
    this.#options = {
      executable,
      spawnProcess,
      requestTimeoutMs: boundedInteger(requestTimeoutMs, 10, 30000),
      shutdownGraceMs: boundedInteger(shutdownGraceMs, 10, 5000),
      maxFrameBytes: boundedInteger(maxFrameBytes, 128, 1048576),
    };
  }

  async connect() {
    if (this.#state === "ready") return;
    if (this.#state === "connecting" && this.#connecting)
      return this.#connecting;
    if (this.#state !== "new")
      throw this.#failure ?? new CodexStatusError("DISCONNECTED");
    this.#connecting = this.#connect();
    return this.#connecting;
  }

  async #connect() {
    this.#state = "connecting";
    try {
      this.#child = this.#options.spawnProcess(
        this.#options.executable,
        ["app-server", "--listen", "stdio://"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          detached: process.platform !== "win32",
          env: childEnvironment(),
        },
      );
      this.#child.on("error", (error) => {
        this.#fail(error?.code === "ENOENT" ? "NOT_FOUND" : "SPAWN_FAILED");
      });
      this.#child.once("exit", () => {
        if (this.#state !== "closing") this.#fail("DISCONNECTED");
      });
      this.#child.once("close", () => {
        this.#closed = true;
        this.#closeSignal();
        if (this.#state !== "closing") this.#fail("DISCONNECTED");
      });
      this.#child.stdin.on("error", () => this.#fail("DISCONNECTED"));
      this.#child.stdout.on("error", () => this.#fail("DISCONNECTED"));
      this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
      // Drain without retaining or printing diagnostics, which may contain
      // account identity, paths, configuration, or upstream error payloads.
      this.#child.stderr.on("error", () => {});
      this.#child.stderr.resume();
      const initialized = await this.#request("initialize", {
        clientInfo: { name: "palm_status_probe", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      });
      if (this.#state !== "connecting")
        throw this.#failure ?? new CodexStatusError("DISCONNECTED");
      if (!initialized || typeof initialized.userAgent !== "string")
        throw new CodexStatusError("PROTOCOL_ERROR");
      this.#write({ method: "initialized" });
      if (this.#state !== "connecting")
        throw this.#failure ?? new CodexStatusError("DISCONNECTED");
      this.#state = "ready";
    } catch (error) {
      const failure =
        error instanceof CodexStatusError
          ? error
          : new CodexStatusError(
              error?.code === "ENOENT" ? "NOT_FOUND" : "SPAWN_FAILED",
            );
      this.#fail(failure.code);
      throw this.#failure ?? failure;
    }
  }

  async readStatus() {
    await this.connect();
    if (this.#state !== "ready")
      throw this.#failure ?? new CodexStatusError("DISCONNECTED");
    const result = await this.#request("account/read", { refreshToken: false });
    if (this.#state !== "ready")
      throw this.#failure ?? new CodexStatusError("DISCONNECTED");
    if (
      !result ||
      typeof result.requiresOpenaiAuth !== "boolean" ||
      !Object.hasOwn(result, "account") ||
      (result.account !== null &&
        (typeof result.account !== "object" ||
          Array.isArray(result.account) ||
          typeof result.account.type !== "string"))
    ) {
      this.#fail("PROTOCOL_ERROR");
      throw this.#failure;
    }
    const type = result.account?.type;
    return {
      provider: "codex",
      connected: true,
      credentialState: result.account === null ? "absent" : "present",
      authentication:
        type === "chatgpt" || type === "apiKey"
          ? type
          : result.account === null
            ? "none"
            : "other",
      requiresOpenaiAuth: result.requiresOpenaiAuth,
      // A cached account is not evidence of model access or a valid next turn.
      inferenceTested: false,
      experimental: true,
      caveat: CODEX_STATUS_CAVEAT,
    };
  }

  #request(method, params) {
    if (this.#state !== "connecting" && this.#state !== "ready")
      return Promise.reject(
        this.#failure ?? new CodexStatusError("DISCONNECTED"),
      );
    if (this.#pending.size >= 8)
      return Promise.reject(new CodexStatusError("BUSY"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.#fail("TIMEOUT"),
        this.#options.requestTimeoutMs,
      );
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  #write(message) {
    try {
      this.#child.stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (error) this.#fail("DISCONNECTED");
      });
    } catch {
      this.#fail("DISCONNECTED");
    }
  }

  #consume(chunk) {
    if (this.#state !== "connecting" && this.#state !== "ready") return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (this.#partial.length + end - start > this.#options.maxFrameBytes) {
        this.#fail("FRAME_TOO_LARGE");
        return;
      }
      const line = Buffer.concat([this.#partial, bytes.subarray(start, end)]);
      this.#partial = newline < 0 ? line : Buffer.alloc(0);
      if (newline < 0) return;
      start = newline + 1;
      if (!line.length || (line.length === 1 && line[0] === 13)) continue;
      try {
        const message = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(line),
        );
        this.#receive(message);
      } catch {
        this.#fail("PROTOCOL_ERROR");
      }
      if (this.#state !== "connecting" && this.#state !== "ready") return;
    }
  }

  #receive(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.#fail("PROTOCOL_ERROR");
      return;
    }
    if (typeof message.method === "string") {
      // Notifications are deliberately not retained. No server-initiated tool,
      // approval, token refresh, or other operation is supported by this proof.
      if (Object.hasOwn(message, "id")) this.#fail("UNSUPPORTED_REQUEST");
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      this.#fail("PROTOCOL_ERROR");
      return;
    }
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (hasError) pending.reject(new CodexStatusError("REMOTE_ERROR"));
    else pending.resolve(message.result);
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#partial = Buffer.alloc(0);
  }

  #fail(code) {
    if (this.#state === "closing" || this.#state === "closed") return;
    this.#failure ??= new CodexStatusError(code);
    this.#state = "failed";
    this.#rejectPending(this.#failure);
    void this.close();
  }

  close() {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close() {
    this.#state = "closing";
    this.#rejectPending(this.#failure ?? new CodexStatusError("DISCONNECTED"));
    if (!this.#child || this.#closed) {
      this.#state = "closed";
      return { completed: true, method: "alreadyClosed" };
    }
    const grace = this.#options.shutdownGraceMs;
    let method = "stdinEof";
    const signal = (value) => {
      try {
        // Only the detached process group created by this adapter is targeted.
        if (process.platform !== "win32" && this.#child.pid)
          process.kill(-this.#child.pid, value);
        else this.#child.kill(value);
      } catch {
        /* The child may have exited just before the signal. */
      }
    };
    const terminate = setTimeout(() => {
      method = "sigterm";
      signal("SIGTERM");
    }, grace);
    const kill = setTimeout(() => {
      method = "sigkill";
      signal("SIGKILL");
    }, grace * 2);
    let limit;
    const deadline = new Promise((resolve) => {
      limit = setTimeout(resolve, grace * 3);
    });
    try {
      this.#child.stdin.end();
    } catch {
      method = "sigterm";
      signal("SIGTERM");
    }
    await Promise.race([this.#closeEvent, deadline]);
    clearTimeout(terminate);
    clearTimeout(kill);
    clearTimeout(limit);
    this.#state = "closed";
    return { completed: this.#closed, method };
  }
}

export async function probeCodexStatus({ optIn = false, ...options } = {}) {
  if (optIn !== true) throw new CodexStatusError("OPT_IN_REQUIRED");
  const adapter = new CodexStdioStatus(options);
  let status;
  let failure;
  try {
    status = await adapter.readStatus();
  } catch (error) {
    failure = error;
  }
  const shutdown = await adapter.close();
  if (failure) throw failure;
  if (!shutdown.completed) throw new CodexStatusError("SHUTDOWN_FAILED");
  return { ...status, shutdown };
}
