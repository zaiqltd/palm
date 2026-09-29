import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { run, userEnvironment, which } from "../platform/env.mjs";
import { agentEnvironment } from "./claude.mjs";

// Codex through the user's own `codex app-server` (stdio JSON-RPC) with their
// ~/.codex sign-in. CODEX_HOME is pinned to ~/.codex. One app-server serves every Codex task; each
// task is one Codex thread, resumable after Palm restarts.
const access = {
  ask: { approvalPolicy: "untrusted", sandbox: "workspace-write" },
  workspace: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  auto: { approvalPolicy: "on-request", sandbox: "workspace-write" },
  full: { approvalPolicy: "never", sandbox: "danger-full-access" },
  plan: { approvalPolicy: "on-request", sandbox: "read-only" },
};

export class CodexServer {
  constructor() {
    this.child = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.threads = new Map(); // threadId -> adapter
  }

  static async detect() {
    const env = await primaryEnvironment();
    const executable = await which("codex", env);
    if (!executable) return { id: "codex", name: "Codex", available: false, detail: "Install the Codex CLI on the Mac." };
    const version = await run(executable, ["--version"], { env, timeout: 8000 });
    return {
      id: "codex",
      name: "Codex",
      available: true,
      version: version.stdout.trim().replace(/^codex-cli\s*/, "") || null,
      executable,
      modes: ["ask", "workspace", "full", "plan"],
      models: ["default"],
    };
  }

  async start() {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const env = await primaryEnvironment();
      const executable = await which("codex", env);
      if (!executable) throw new Error("Codex is not installed on this Mac.");
      const child = spawn(executable, ["app-server", "--listen", "stdio://"], { env, stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.on("exit", () => {
        if (this.child !== child) return;
        this.child = null;
        this.ready = null;
        for (const p of this.pending.values()) p.reject(new Error("Codex stopped."));
        this.pending.clear();
        for (const adapter of this.threads.values()) adapter.serverStopped();
      });
      createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => this.receive(line));
      const info = await this.request("initialize", {
        clientInfo: { name: "palm", title: "Palm", version: "0.3.0" },
        capabilities: { experimentalApi: true },
      });
      this.write({ method: "initialized" });
      return info;
    })();
    try {
      return await this.ready;
    } catch (error) {
      this.ready = null;
      throw error;
    }
  }

  write(message) {
    this.child?.stdin.write(JSON.stringify(message) + "\n");
  }

  // Codex runs each command in its own process group under the app-server.
  // Palm records which groups appear while a task's command starts, so Stop
  // can end exactly that task's commands (Codex's interrupt leaves them).
  async commandGroups() {
    const root = this.child?.pid;
    if (!root) return [];
    const table = await run("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid="], { timeout: 4000 });
    const rows = table.stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter((r) => r.length === 3 && r.every(Number.isFinite));
    const children = new Map();
    for (const [pid, ppid] of rows) children.set(ppid, [...(children.get(ppid) || []), pid]);
    const descendants = new Set();
    const walk = (pid) => {
      for (const child of children.get(pid) || []) {
        if (descendants.has(child)) continue;
        descendants.add(child);
        walk(child);
      }
    };
    walk(root);
    return rows.filter(([pid, , pgid]) => descendants.has(pid) && pid === pgid && pgid !== root).map(([pid]) => pid);
  }

  async claimGroups(adapter) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const groups = await this.commandGroups().catch(() => []);
    this.claimed = this.claimed || new Map();
    for (const pgid of groups) if (!this.claimed.has(pgid)) this.claimed.set(pgid, adapter);
  }

  release(adapter) {
    for (const [pgid, owner] of this.claimed || []) if (owner === adapter) this.claimed.delete(pgid);
  }

  async killGroups(adapter) {
    const mine = [...(this.claimed || [])].filter(([, owner]) => owner === adapter).map(([pgid]) => pgid);
    this.release(adapter);
    const alive = (pgid) => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const signal = (pgid, name) => {
      try {
        process.kill(-pgid, name);
      } catch {}
    };
    const running = mine.filter(alive);
    for (const pgid of running) signal(pgid, "SIGTERM");
    if (running.length) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      for (const pgid of running.filter(alive)) signal(pgid, "SIGKILL");
    }
    return running.length;
  }

  // Models this sign-in can actually use. A config can name a model that
  // the ChatGPT login rejects, so Palm checks before relying on it.
  async models({ refresh = false } = {}) {
    if (this.modelCache && !refresh && Date.now() - this.modelCache.at < 10 * 60 * 1000) return this.modelCache.value;
    await this.start();
    const [list, config] = await Promise.all([
      this.request("model/list", {}),
      this.request("config/read", {}).catch(() => null),
    ]);
    const available = (list.data || []).filter((m) => !m.hidden);
    const value = {
      ids: available.map((m) => m.id),
      names: Object.fromEntries(available.map((m) => [m.id, m.displayName || m.id])),
      accountDefault: available.find((m) => m.isDefault)?.id || available[0]?.id || null,
      configured: config?.config?.model || null,
      configKnown: !!config,
    };
    // A failed config read is not cached: it would pin the account default.
    if (config) this.modelCache = { at: Date.now(), value };
    return value;
  }

  async resolveModel(requested) {
    const models = await this.models().catch(() => null);
    if (requested && requested !== "default") return requested;
    // Let Codex apply the user's config unless Palm knows the configured model is
    // one this sign-in rejects; only then choose the account's default.
    if (!models || !models.configKnown || !models.configured) return null;
    if (models.ids.includes(models.configured)) return null;
    return models.accountDefault;
  }

  request(method, params, timeout = 60000) {
    if (!this.child) return Promise.reject(new Error("Codex is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method}.`));
      }, timeout);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ id, method, params });
    });
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex error."));
      else pending.resolve(message.result);
      return;
    }
    const threadId = message.params?.threadId;
    const adapter = threadId ? this.threads.get(threadId) : null;
    if (message.id !== undefined) {
      // A server request (approval, question). Unknown ones are declined.
      if (adapter) return adapter.onServerRequest(message);
      return this.write({ id: message.id, error: { code: -32601, message: "Palm cannot answer this request." } });
    }
    adapter?.onNotification(message.method, message.params || {});
  }

  close() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    child?.stdin.end();
    if (child) setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 2000).unref();
  }
}

async function primaryEnvironment() {
  const env = agentEnvironment(await userEnvironment());
  // Palm uses the default Codex home (~/.codex).
  env.CODEX_HOME = `${env.HOME}/.codex`;
  return env;
}

export class CodexAdapter {
  constructor({ task, emit, server, mcp, systemPrompt }) {
    this.task = task;
    this.emit = emit;
    this.server = server;
    this.mcp = mcp;
    this.systemPrompt = systemPrompt;
    this.threadId = task.providerSessionId || null;
    this.turnId = null;
    this.approvals = new Map(); // approvalId -> { id, method }
    this.attached = false;
  }

  async ensure() {
    await this.server.start();
    const policy = access[this.task.access] || access.workspace;
    const model = await this.server.resolveModel(this.task.model);
    const config = {};
    if (this.mcp)
      config["mcp_servers.palm"] = { command: this.mcp.command, args: this.mcp.args, env: this.mcp.env, startup_timeout_sec: 20 };
    const common = {
      cwd: this.task.cwd,
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      developerInstructions: this.systemPrompt,
      config,
      ...(model ? { model } : {}),
    };
    if (this.threadId && this.attached) return;
    let result;
    if (this.threadId) {
      this.server.threads.set(this.threadId, this);
      try {
        result = await this.server.request("thread/resume", { threadId: this.threadId, excludeTurns: true, ...common });
      } catch (error) {
        this.server.threads.delete(this.threadId);
        throw new Error(`Codex could not reopen this conversation: ${error.message}`);
      }
    } else {
      result = await this.server.request("thread/start", { ...common, serviceName: "Palm" });
      this.threadId = result.thread.id;
      this.task.providerSessionId = this.threadId;
      this.server.threads.set(this.threadId, this);
    }
    this.attached = true;
    this.emit({ type: "session", model: result.model, sessionId: this.threadId, sandbox: policy.sandbox });
  }

  serverStopped() {
    this.attached = false;
    for (const [approvalId] of this.approvals) this.emit({ type: "approval", approvalId, status: "expired" });
    this.approvals.clear();
    if (this.turnId) {
      this.turnId = null;
      this.emit({ type: "turn", status: "failed", error: "Codex stopped on the Mac." });
    }
  }

  async send({ text, imagePaths = [] }) {
    await this.ensure();
    const input = [{ type: "text", text }];
    for (const path of imagePaths) input.push({ type: "localImage", path });
    this.emit({ type: "turn", status: "started" });
    try {
      const model = await this.server.resolveModel(this.task.model);
      const result = await this.server.request("turn/start", { threadId: this.threadId, input, ...(model ? { model } : {}) });
      this.turnId = result.turn?.id || this.turnId;
    } catch (error) {
      this.emit({ type: "turn", status: "failed", error: error.message });
    }
  }

  async interrupt() {
    for (const [approvalId, pending] of this.approvals) {
      this.server.write({ id: pending.id, result: { decision: "cancel" } });
      this.emit({ type: "approval", approvalId, status: "denied" });
    }
    this.approvals.clear();
    if (this.threadId && this.turnId)
      await this.server.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, 10000).catch(() => {});
    const ended = await this.server.killGroups(this);
    if (ended) this.emit({ type: "notice", text: `Stopped ${ended === 1 ? "the command" : `${ended} commands`} the agent was running.` });
  }

  answer(approvalId, decision) {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error("That request is no longer waiting.");
    this.approvals.delete(approvalId);
    const value = decision === "deny" ? "decline" : decision === "allowSession" ? "acceptForSession" : "accept";
    if (pending.method === "item/permissions/requestApproval") {
      this.server.write({ id: pending.id, result: decision === "deny" ? { permissions: {}, scope: "turn" } : { permissions: pending.permissions || {}, scope: decision === "allowSession" ? "session" : "turn" } });
    } else if (pending.method === "mcpServer/elicitation/request") {
      this.server.write({ id: pending.id, result: decision === "deny" ? { action: "decline" } : { action: "accept", content: pending.content } });
    } else this.server.write({ id: pending.id, result: { decision: value } });
    this.emit({ type: "approval", approvalId, status: decision === "deny" ? "denied" : "allowed" });
  }

  onServerRequest(message) {
    const p = message.params || {};
    const approvalId = `codex-${message.id}`;
    if (message.method === "item/commandExecution/requestApproval") {
      this.approvals.set(approvalId, { id: message.id, method: message.method });
      this.emit({
        type: "approval",
        approvalId,
        status: "pending",
        tool: "command",
        title: p.networkApprovalContext ? "Allow network access" : "Run command",
        detail: [p.command, p.reason].filter(Boolean).join("\n\n").slice(0, 1500),
        options: ["allow", "allowSession", "deny"],
      });
      return;
    }
    if (message.method === "item/fileChange/requestApproval") {
      this.approvals.set(approvalId, { id: message.id, method: message.method });
      this.emit({
        type: "approval",
        approvalId,
        status: "pending",
        tool: "files",
        title: "Change files",
        detail: [p.reason, p.grantRoot ? `Folder: ${p.grantRoot}` : ""].filter(Boolean).join("\n").slice(0, 1500) || "Codex wants to edit files.",
        options: ["allow", "allowSession", "deny"],
      });
      return;
    }
    if (message.method === "item/permissions/requestApproval") {
      this.approvals.set(approvalId, { id: message.id, method: message.method, permissions: p.permissions });
      this.emit({
        type: "approval",
        approvalId,
        status: "pending",
        tool: "permissions",
        title: "Grant more access",
        detail: [p.reason, JSON.stringify(p.permissions || {}).slice(0, 600)].filter(Boolean).join("\n"),
        options: ["allow", "allowSession", "deny"],
      });
      return;
    }
    if (message.method === "mcpServer/elicitation/request") {
      // Codex asks before an agent uses a tool with effects from an MCP server.
      // Palm answered "cannot" and Codex read that as the user saying no, so
      // Codex sessions could never open an app or use the screen through Palm. Palm's
      // own tools are governed by Palm (the session's screen permission, Take
      // over), so Palm answers for them; another server's question goes to the
      // phone. A web page to open (url mode) cannot be answered from here.
      if (p.mode === "url") return this.server.write({ id: message.id, result: { action: "decline" } });
      const content = formDefaults(p.requestedSchema);
      if (p.serverName === "palm") return this.server.write({ id: message.id, result: { action: "accept", content } });
      this.approvals.set(approvalId, { id: message.id, method: message.method, content });
      this.emit({
        type: "approval",
        approvalId,
        status: "pending",
        tool: "mcp",
        title: `${p.serverName || "A tool"} asks`,
        detail: String(p.message || "Codex wants to use a tool.").slice(0, 1500),
        options: ["allow", "deny"],
      });
      return;
    }
    // Questions and token refresh are not answered by Palm yet.
    this.server.write({ id: message.id, error: { code: -32601, message: "Palm cannot answer this request." } });
  }

  onNotification(method, p) {
    const item = p.item;
    switch (method) {
      case "turn/started":
        this.turnId = p.turn?.id || this.turnId;
        return;
      case "turn/completed": {
        const turn = p.turn || {};
        this.turnId = null;
        // Commands that outlive a finished turn (a server it started) are the
        // user's to keep; only the next turn's commands are stoppable.
        if (turn.status !== "interrupted") this.server.release(this);
        for (const [approvalId] of this.approvals) this.emit({ type: "approval", approvalId, status: "expired" });
        this.approvals.clear();
        this.emit({
          type: "turn",
          status: turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "failed" : "completed",
          durationMs: turn.durationMs ?? undefined,
          error: turn.status === "failed" ? String(turn.error?.message || "Codex could not finish.").slice(0, 400) : undefined,
        });
        return;
      }
      case "item/agentMessage/delta":
        this.emit({ type: "assistant.delta", itemId: p.itemId, text: p.delta || "" });
        return;
      case "item/started":
        if (item) this.itemEvent(item, true);
        return;
      case "item/completed":
        if (item) this.itemEvent(item, false);
        return;
      case "error":
        if (!p.willRetry) this.emit({ type: "error", text: String(p.error?.message || "Codex reported an error.").slice(0, 400) });
        return;
      case "thread/tokenUsage/updated":
        return;
      default:
        return;
    }
  }

  itemEvent(item, started) {
    const status = started ? "running" : item.status === "failed" || item.status === "declined" ? item.status : "completed";
    switch (item.type) {
      case "agentMessage":
        if (!started && item.text?.trim()) this.emit({ type: "assistant", itemId: item.id, text: item.text });
        return;
      case "reasoning": {
        const text = (item.summary || []).map((s) => (typeof s === "string" ? s : s.text || "")).join("\n").trim();
        if (!started && text) this.emit({ type: "reasoning", itemId: item.id, text: text.slice(0, 2000) });
        return;
      }
      case "commandExecution":
        if (started) void this.server.claimGroups(this);
        this.emit({
          type: "tool",
          itemId: item.id,
          name: "command",
          title: "Run command",
          detail: String(item.command || "").slice(0, 1200),
          status: started ? "running" : item.exitCode && item.exitCode !== 0 ? "failed" : status,
          output: started ? undefined : String(item.aggregatedOutput || "").slice(-6000),
          exitCode: started ? undefined : item.exitCode ?? undefined,
        });
        return;
      case "fileChange":
        this.emit({
          type: "tool",
          itemId: item.id,
          name: "files",
          title: "Edit files",
          detail: (item.changes || []).map((c) => `${c.kind?.type || c.kind || "update"} ${c.path}`).join("\n").slice(0, 1500),
          status,
        });
        return;
      case "mcpToolCall": {
        const title = item.server === "palm" ? describePalmTool(item.tool) : `${item.server} · ${item.tool}`;
        this.emit({
          type: "tool",
          itemId: item.id,
          name: `mcp__${item.server}__${item.tool}`,
          title,
          detail: item.server === "palm" ? palmDetail(item.tool, item.arguments) : JSON.stringify(item.arguments || {}).slice(0, 300),
          status: item.error ? "failed" : status,
          output: started ? undefined : item.error?.message || textOf(item.result).slice(0, 4000),
        });
        return;
      }
      case "webSearch":
        this.emit({ type: "tool", itemId: item.id, name: "web", title: "Search the web", detail: String(item.query || "").slice(0, 300), status });
        return;
      case "plan":
        if (!started && item.text) this.emit({ type: "notice", itemId: item.id, text: String(item.text).slice(0, 2000) });
        return;
      default:
        return;
    }
  }

  close() {
    if (this.threadId) this.server.threads.delete(this.threadId);
    this.attached = false;
  }
}

function describePalmTool(tool) {
  return (
    {
      screenshot: "Look at the Mac screen",
      click: "Click on the Mac",
      type_text: "Type on the Mac",
      press_key: "Press a key on the Mac",
      scroll: "Scroll on the Mac",
      drag: "Drag on the Mac",
      open_app: "Open an app",
      list_apps: "List Mac apps",
      wait: "Wait",
      tell_user: "Note to you",
    }[tool] || tool
  );
}

function palmDetail(tool, a = {}) {
  if (tool === "click") return `${a.double ? "Double-click" : a.button === "right" ? "Right-click" : "Click"} at ${Math.round(a.x)}, ${Math.round(a.y)}`;
  if (tool === "type_text") return String(a.text || "").slice(0, 200);
  if (tool === "press_key") return [...(a.modifiers || []), a.key].join("+");
  if (tool === "open_app") return String(a.name || a.target || "");
  if (tool === "tell_user") return String(a.message || "").slice(0, 600);
  return "";
}

function textOf(result) {
  if (!result) return "";
  const content = result.content || result;
  if (Array.isArray(content)) return content.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).join("\n");
  return typeof content === "string" ? content : "";
}

// The answers an accepted MCP form carries: each field's default, "yes" for a
// yes/no field, the first choice of a list. Codex's tool approvals ask nothing.
export function formDefaults(schema) {
  const out = {};
  for (const [key, field] of Object.entries(schema?.properties || {})) {
    if (field?.default !== undefined && field.default !== null) out[key] = field.default;
    else if (field?.type === "boolean") out[key] = true;
    else if (Array.isArray(field?.enum) && field.enum.length) out[key] = field.enum[0];
    else if (Array.isArray(field?.oneOf) && field.oneOf[0]?.const !== undefined) out[key] = field.oneOf[0].const;
  }
  return out;
}
