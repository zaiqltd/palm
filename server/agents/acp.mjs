import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { run, userEnvironment, which } from "../platform/env.mjs";
import { agentEnvironment } from "./claude.mjs";

// Agents that speak the Agent Client Protocol (agentclientprotocol.com):
// JSON-RPC 2.0, one message per line on the agent's standard input and
// output. Each agent keeps its own sign-in and account; Palm starts it on the
// Mac, relays its replies and steps to the phone and answers its permission
// requests. Commands follow the ACP registry (September 2026). Claude Code
// and Codex keep their own adapters.
export const ACP_AGENTS = [
  { id: "grok", name: "Grok", commands: ["grok"], args: ["agent", "stdio"], signIn: "grok login", install: "npm install -g @xai-official/grok" },
  { id: "gemini", name: "Gemini CLI", commands: ["gemini"], args: ["--acp"], install: "npm install -g @google/gemini-cli" },
  { id: "copilot", name: "GitHub Copilot", commands: ["copilot"], args: ["--acp"], install: "npm install -g @github/copilot" },
  { id: "cursor", name: "Cursor", commands: ["cursor-agent"], args: ["acp"] },
  { id: "opencode", name: "OpenCode", commands: ["opencode"], args: ["acp"] },
  { id: "goose", name: "goose", commands: ["goose"], args: ["acp"] },
  { id: "qwen", name: "Qwen Code", commands: ["qwen"], args: ["--acp"], install: "npm install -g @qwen-code/qwen-code" },
  { id: "kimi", name: "Kimi CLI", commands: ["kimi"], args: ["acp"] },
  { id: "vibe", name: "Mistral Vibe", commands: ["vibe-acp"], args: [] },
  { id: "droid", name: "Factory Droid", commands: ["droid"], args: ["exec", "--output-format", "acp-daemon"], install: "npm install -g droid" },
  { id: "cline", name: "Cline", commands: ["cline"], args: ["--acp"], install: "npm install -g cline" },
  { id: "kilo", name: "Kilo", commands: ["kilo"], args: ["acp"], install: "npm install -g @kilocode/cli" },
  { id: "auggie", name: "Auggie", commands: ["auggie"], args: ["--acp"], install: "npm install -g @augmentcode/auggie" },
  { id: "devin", name: "Devin", commands: ["devin"], args: ["acp"] },
  { id: "amp", name: "Amp", commands: ["amp-acp"], args: [] },
];

const acpModes = ["ask", "workspace", "full", "plan"];
const readOnlyKinds = new Set(["read", "search", "think", "fetch"]);

export function acpAgent(id) {
  return ACP_AGENTS.find((agent) => agent.id === id) || null;
}

// Where installers commonly put these tools, in case the login shell's PATH
// does not include them.
function searchPath(env) {
  const home = os.homedir();
  const extra = [".grok/bin", ".local/bin", ".opencode/bin", ".cargo/bin", ".bun/bin"].map((dir) => path.join(home, dir));
  return { ...env, PATH: [env.PATH, ...extra, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":") };
}

export async function findAcpAgent(agent, env) {
  if (agent.executable) return agent.executable;
  const search = searchPath(env || (await userEnvironment()));
  for (const command of agent.commands) {
    const found = await which(command, search);
    if (found) return found;
  }
  return null;
}

/** The ACP agents installed on this Mac, for the phone's agent list. */
export async function detectAcpAgents() {
  const env = await userEnvironment();
  const found = await Promise.all(
    ACP_AGENTS.map(async (agent) => {
      const executable = await findAcpAgent(agent, env);
      if (!executable) return null;
      const result = await run(executable, ["--version"], { env: searchPath(env), timeout: 5000 });
      const version = /\d+\.\d+(\.\d+)?/.exec(result.stdout || "")?.[0] || null;
      return { id: agent.id, name: agent.name, available: true, version, signedIn: null, modes: acpModes, acp: true };
    }),
  );
  return found.filter(Boolean);
}

export class AcpAdapter {
  constructor({ task, emit, agent, mcp, systemPrompt, extraEnv = null }) {
    this.task = task;
    this.emit = emit;
    this.agent = agent;
    // Given only to this agent (the OpenRouter route's key and model).
    this.extraEnv = extraEnv;
    this.mcp = mcp;
    this.systemPrompt = systemPrompt;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map(); // request id -> { resolve, reject, timer }
    this.approvals = new Map(); // Palm approval id -> { requestId, options }
    this.tools = new Map(); // tool call id -> { title, kind, detail }
    this.sessionId = null;
    this.capabilities = {};
    this.turnActive = false;
    this.cancelled = false;
    this.loading = false;
    this.primed = false;
    this.message = null;
    this.planId = null;
  }

  async ensure() {
    if (this.child && this.child.exitCode === null && this.sessionId) return;
    const env = { ...agentEnvironment(await userEnvironment()), ...((await this.extraEnv?.()) || {}) };
    const executable = await findAcpAgent(this.agent, env);
    if (!executable) throw new Error(`${this.agent.name} is not installed on this Mac.`);
    const child = spawn(executable, this.agent.args || [], { cwd: this.task.cwd, env: searchPath(env), stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.sessionId = null;
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on("error", (error) => this.stopped(child, `${this.agent.name} could not start: ${error.message}`));
    child.on("exit", (code) => {
      const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
      this.stopped(child, detail || `${this.agent.name} stopped (${code}).`);
    });
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));

    const init = await this.request("initialize", {
      protocolVersion: 1,
      // Palm offers no file or terminal access of its own: the agent uses its
      // own tools on the Mac, and asks Palm before anything that needs a yes.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "Palm", version: "0.4.0" },
    });
    this.capabilities = init?.agentCapabilities || {};
    const params = { cwd: this.task.cwd, mcpServers: this.mcpServers() };
    const earlier = this.task.providerSessionId;
    if (earlier && this.capabilities.loadSession) {
      this.loading = true;
      try {
        await this.request("session/load", { sessionId: earlier, ...params }, 60000);
        this.sessionId = earlier;
        this.primed = true;
      } catch {
        // Fall back to a fresh session below.
      } finally {
        this.loading = false;
      }
    }
    if (!this.sessionId) {
      const created = await this.request("session/new", params, 60000);
      if (!created?.sessionId) throw new Error(`${this.agent.name} did not open a session.`);
      this.sessionId = created.sessionId;
      this.task.providerSessionId = created.sessionId;
      this.primed = false;
      if (earlier)
        this.emit({ type: "notice", text: `${this.agent.name} started a fresh session and does not remember the earlier messages here.` });
      this.emit({ type: "session", sessionId: created.sessionId, model: created.models?.currentModelId || null });
      // Plan only: use the agent's own planning mode when it has one.
      if (this.task.access === "plan") {
        const plan = created.modes?.availableModes?.find((mode) => /plan/i.test(`${mode.id} ${mode.name}`));
        if (plan) await this.request("session/set_mode", { sessionId: this.sessionId, modeId: plan.id }).catch(() => {});
      }
    }
  }

  mcpServers() {
    if (!this.mcp) return [];
    return [
      {
        name: "palm",
        command: this.mcp.command,
        args: this.mcp.args || [],
        env: Object.entries(this.mcp.env || {}).map(([name, value]) => ({ name, value: String(value) })),
      },
    ];
  }

  // Like the other agents, this returns once the turn is under way (the prompt
  // is with the agent); the turn itself runs on as this.turn. Waiting for the
  // whole turn here kept the phone's request open until the agent finished.
  async send({ text, images = [] }) {
    if (this.turnActive) throw new Error(`${this.agent.name} is already working.`);
    this.turnActive = true;
    this.cancelled = false;
    this.started = Date.now();
    this.emit({ type: "turn", status: "started" });
    let underway;
    const begun = new Promise((resolve) => (underway = resolve));
    this.turn = this.run({ text, images }, underway).finally(underway);
    await begun;
  }

  async run({ text, images }, underway) {
    try {
      await this.ensure();
      const prompt = [];
      // ACP has no separate system prompt: Palm's guidance leads the first message.
      const lead = !this.primed && this.systemPrompt ? `${this.systemPrompt}\n\n---\n\n` : "";
      prompt.push({ type: "text", text: lead + text });
      if (this.capabilities.promptCapabilities?.image)
        for (const image of images.slice(0, 6)) prompt.push({ type: "image", mimeType: image.mediaType, data: image.data });
      this.primed = true;
      const reply = this.request("session/prompt", { sessionId: this.sessionId, prompt }, 0);
      underway();
      const result = await reply;
      this.finishMessage();
      const reason = result?.stopReason;
      if (reason === "cancelled" || this.cancelled) this.endTurn("interrupted");
      else if (reason === "refusal") this.endTurn("failed", `${this.agent.name} declined this request.`);
      else this.endTurn("completed");
    } catch (error) {
      if (this.closed) return;
      this.finishMessage();
      if (this.cancelled) this.endTurn("interrupted");
      else this.endTurn("failed", this.friendly(error));
    }
  }

  friendly(error) {
    const message = String(error?.message || error || "");
    if (error?.code === -32000 || /auth|sign.?in|log.?in|credential/i.test(message)) {
      const how = this.agent.signIn ? ` Run "${this.agent.signIn}" in Palm's Terminal tab, then try again.` : " Sign in to it on the Mac, then try again.";
      return `${this.agent.name} needs you to sign in on your Mac.${how}`;
    }
    return message.slice(0, 400) || `${this.agent.name} stopped unexpectedly.`;
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    if (message.method === undefined && message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error)
        pending.reject(Object.assign(new Error(message.error.message || "The agent reported an error."), { code: message.error.code }));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "session/update") return this.update(message.params?.update);
    if (message.method === "session/request_permission" && message.id !== undefined) return this.permission(message.id, message.params || {});
    // Files and terminals are not offered, so any other request is declined.
    if (message.id !== undefined) this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Palm does not provide this." } });
  }

  update(update) {
    // A resumed session replays its history; Palm already has it.
    if (!update || this.loading) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOf(update.content);
        if (!text) return;
        if (!this.message) this.message = { itemId: randomUUID(), text: "" };
        this.message.text += text;
        this.emit({ type: "assistant.delta", itemId: this.message.itemId, text });
        return;
      }
      case "tool_call": {
        this.finishMessage();
        const tool = { title: update.title || "Tool", kind: update.kind || "other", detail: detailOf(update) };
        this.tools.set(update.toolCallId, tool);
        this.emit({ type: "tool", itemId: update.toolCallId, name: tool.kind, title: tool.title, detail: tool.detail, status: statusOf(update.status) || "running" });
        return;
      }
      case "tool_call_update": {
        if (!update.toolCallId) return;
        const tool = this.tools.get(update.toolCallId) || { title: update.title || "Tool", kind: update.kind || "other", detail: detailOf(update) };
        this.tools.set(update.toolCallId, tool);
        const status = statusOf(update.status);
        const output = outputOf(update.content);
        if (!status && !output) return;
        this.emit({
          type: "tool", itemId: update.toolCallId, name: tool.kind, title: update.title || tool.title, detail: tool.detail,
          status: status || "running", ...(output ? { output } : {}),
        });
        return;
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        if (!entries.length) return;
        // Agents resend the whole plan as it progresses: one step, updated in place.
        this.planId ||= randomUUID();
        const lines = entries.map((e) => `${e.status === "completed" ? "✓" : e.status === "in_progress" ? "→" : "·"} ${String(e.content || "").slice(0, 200)}`);
        const done = entries.every((e) => e.status === "completed");
        this.emit({ type: "tool", itemId: this.planId, name: "plan", title: "Plan", detail: lines.join("\n").slice(0, 1500), status: done ? "completed" : "running", output: lines.join("\n").slice(0, 2000) });
        return;
      }
      default:
        // Thoughts, modes, commands and usage are not shown on the phone.
        return;
    }
  }

  permission(requestId, params) {
    const call = params.toolCall || {};
    const options = Array.isArray(params.options) ? params.options : [];
    const pick = (...kinds) => {
      for (const kind of kinds) {
        const option = options.find((o) => o.kind === kind);
        if (option) return option.optionId;
      }
      return null;
    };
    const kind = call.kind || this.tools.get(call.toolCallId)?.kind || "other";
    const readOnly = readOnlyKinds.has(kind);
    const inProject = kind === "edit" && this.inProject(call);
    let automatic = null;
    switch (this.task.access) {
      case "full":
        automatic = pick("allow_always", "allow_once");
        break;
      case "plan":
        automatic = readOnly ? pick("allow_once", "allow_always") : pick("reject_once", "reject_always");
        break;
      case "workspace":
      case "auto":
        if (readOnly || inProject) automatic = pick("allow_once", "allow_always");
        break;
      default:
        break; // "ask": every request goes to the phone
    }
    if (automatic) {
      this.respond(requestId, { outcome: { outcome: "selected", optionId: automatic } });
      return;
    }
    const approvalId = randomUUID();
    this.approvals.set(approvalId, { requestId, options });
    const choices = [];
    if (pick("allow_once")) choices.push("allow");
    if (pick("allow_always")) choices.push("allowSession");
    if (pick("reject_once", "reject_always")) choices.push("deny");
    this.emit({
      type: "approval", approvalId, status: "pending", tool: kind,
      title: call.title || this.tools.get(call.toolCallId)?.title || "Allow this?",
      detail: detailOf(call) || this.tools.get(call.toolCallId)?.detail || "",
      options: choices.length ? choices : ["allow", "deny"],
    });
  }

  inProject(call) {
    const locations = Array.isArray(call.locations) ? call.locations : [];
    if (!locations.length) return false;
    const root = path.resolve(this.task.cwd) + path.sep;
    return locations.every((l) => typeof l?.path === "string" && path.resolve(this.task.cwd, l.path).startsWith(root));
  }

  answer(approvalId, decision) {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error("That request is no longer waiting.");
    this.approvals.delete(approvalId);
    const pick = (...kinds) => {
      for (const kind of kinds) {
        const option = pending.options.find((o) => o.kind === kind);
        if (option) return option.optionId;
      }
      return null;
    };
    const optionId =
      decision === "allowSession" ? pick("allow_always", "allow_once")
      : decision === "allow" ? pick("allow_once", "allow_always")
      : pick("reject_once", "reject_always");
    this.respond(pending.requestId, optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
    this.emit({ type: "approval", approvalId, status: decision === "deny" ? "denied" : "allowed" });
  }

  async interrupt() {
    if (!this.turnActive) return;
    this.cancelled = true;
    this.expireApprovals();
    if (this.child && this.sessionId) this.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
    // The prompt ends with stopReason "cancelled". An agent that ignores the
    // request is stopped; its session resumes with the next message.
    for (let i = 0; i < 80 && this.turnActive; i++) await new Promise((r) => setTimeout(r, 100));
    if (this.turnActive) this.child?.kill("SIGINT");
  }

  close() {
    this.closed = true;
    this.expireApprovals();
    this.turnActive = false;
    const child = this.child;
    if (!child) return;
    this.stopped(child, `${this.agent.name} was closed.`);
    child.stdin.end();
    setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 2000).unref();
  }

  // --- plumbing ---

  stopped(child, detail) {
    if (this.child !== child) return;
    this.child = null;
    this.sessionId = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(detail));
    }
    this.pending.clear();
    this.expireApprovals();
  }

  expireApprovals() {
    for (const [approvalId, pending] of this.approvals) {
      this.respond(pending.requestId, { outcome: { outcome: "cancelled" } });
      this.emit({ type: "approval", approvalId, status: "expired" });
    }
    this.approvals.clear();
  }

  finishMessage() {
    if (!this.message) return;
    const { itemId, text } = this.message;
    this.message = null;
    if (text.trim()) this.emit({ type: "assistant", itemId, text });
  }

  endTurn(status, error) {
    if (!this.turnActive) return;
    this.turnActive = false;
    this.cancelled = false;
    this.expireApprovals();
    this.emit({ type: "turn", status, durationMs: Date.now() - (this.started || Date.now()), ...(error ? { error } : {}) });
  }

  request(method, params, timeoutMs = 30000) {
    if (!this.child) return Promise.reject(new Error(`${this.agent.name} is not running.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`${this.agent.name} did not answer.`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  write(message) {
    this.child?.stdin.write(JSON.stringify(message) + "\n");
  }
}

function textOf(content) {
  if (!content) return "";
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (content.type === "text") return String(content.text || "");
  return "";
}

function statusOf(status) {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "pending" || status === "in_progress") return "running";
  return null;
}

function detailOf(call) {
  const input = call?.rawInput && typeof call.rawInput === "object" ? call.rawInput : {};
  const value =
    input.command || input.cmd || input.path || input.file_path || input.filePath || input.query || input.url || input.pattern ||
    (Array.isArray(call?.locations) ? call.locations.map((l) => l?.path).filter(Boolean).join("\n") : "");
  return String(Array.isArray(value) ? value.join(" ") : value || "").slice(0, 1200);
}

function outputOf(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (item?.type === "content") parts.push(textOf(item.content));
    else if (item?.type === "diff" && item.path) parts.push(`Edited ${item.path}`);
  }
  return parts.filter(Boolean).join("\n").slice(-4000);
}
