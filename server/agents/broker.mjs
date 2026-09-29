import { randomBytes, randomUUID } from "node:crypto";
import { readFile, stat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AcpAdapter, acpAgent, detectAcpAgents } from "./acp.mjs";
import { ClaudeAdapter, describeTool } from "./claude.mjs";
import { CodexAdapter, CodexServer } from "./codex.mjs";
import { ScriptedAdapter } from "./scripted.mjs";
import { turnFiles } from "./turn-files.mjs";
import { JsonlLog, privateDir, readJSON, writePrivateJSON } from "../platform/store.mjs";
import { expandHome, run } from "../platform/env.mjs";

const systemPrompt = `You are running on the user's Mac through Palm. The user is directing you from their iPhone and may not be watching the Mac, so keep replies short and readable on a phone. When you create or change a file they should receive, give its absolute path.
Palm's "palm" tools can see and control the Mac screen (screenshot, click, type_text, press_key, scroll, drag, open_app) when the user has allowed screen control for this task. Prefer shell and file tools for code; use the screen tools for GUI apps, browsers and dialogs. Coordinates are pixels in your latest screenshot; take a fresh one before acting. If a screen tool says the user has taken control, stop using screen tools until they hand control back, then take a new screenshot because things may have changed.`;

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff"]);

// Agent tasks live on the Mac. Closing Palm on the phone never stops them; the
// phone reads the durable transcript and live stream again when it returns.
export class AgentBroker {
  // `scripted` (the test host) swaps both providers for a deterministic stand-in.
  constructor({ stateDir, hub, screen, native, system, mcpScript, apiOrigin, scripted = false, apiRoute = null, apiAgent = null, policy = null, deviceName = null }) {
    this.policy = policy;
    this.deviceName = deviceName;
    this.dir = path.join(stateDir, "agents");
    this.scripted = scripted;
    // The optional OpenRouter route: OpenCode with the user's key, paid per use.
    this.apiRoute = apiRoute;
    this.apiAgent = apiAgent ?? { ...acpAgent("opencode"), id: "openrouter", name: "OpenCode · OpenRouter" };
    this.hub = hub;
    this.screen = screen;
    this.native = native;
    this.system = system;
    this.mcpScript = mcpScript;
    this.apiOrigin = apiOrigin;
    this.tasks = new Map();
    // Who follows task changes (the Assistant watches the sessions it handed work to).
    this.updateListeners = new Set();
    // Each session's latest full reply, for results handed back to the Assistant.
    this.lastText = new Map();
    this.adapters = new Map();
    this.logs = new Map();
    this.live = new Map(); // taskId -> Map(itemId -> text)
    this.tokens = new Map(); // agent token -> taskId
    this.shots = new Map(); // taskId -> last screenshot geometry
    this.queue = new Map(); // taskId -> pending messages while a turn runs
    this.resumes = new Map(); // taskId -> "the screen is yours again", sent when its turn ends
    this.turns = new Map(); // taskId -> { since, tools, texts } of the turn running now
    this.codex = new CodexServer();
    this.providerCache = null;
    this.running = new Set();
    screen.activeTasks = this.running;
  }

  async open() {
    await privateDir(this.dir);
    const saved = await readJSON(path.join(this.dir, "tasks.json"), { version: 1, tasks: [] });
    const interrupted = [];
    for (const task of saved.tasks || []) {
      if (["running", "waiting", "starting"].includes(task.status)) {
        task.status = "interrupted";
        interrupted.push(task);
      }
      task.pendingApprovals = [];
      this.tasks.set(task.id, task);
      if (task.screenControl) this.screen.allow(task.id, true);
    }
    // Palm restarted on the Mac while these were working. Their conversations
    // continue from the provider's saved session when the user sends a message.
    for (const task of interrupted)
      this.emit(task, { type: "notice", text: "Palm restarted on the Mac and this step stopped. Send a message to carry on where it left off." });
  }

  save() {
    const tasks = [...this.tasks.values()].map(({ agentToken, ...rest }) => rest);
    this.saving = (this.saving || Promise.resolve()).then(() =>
      writePrivateJSON(path.join(this.dir, "tasks.json"), { version: 1, tasks }).catch(() => {}),
    );
    return this.saving;
  }

  log(id) {
    let log = this.logs.get(id);
    if (!log) {
      log = new JsonlLog(path.join(this.dir, `${id}.jsonl`));
      this.logs.set(id, log);
    }
    return log;
  }

  async providers(options = {}) {
    const list = await this.agentProviders(options);
    // The paid route is its own entry, only when switched on and OpenCode is
    // installed: it is chosen, never fallen back to.
    const route = this.apiRoute ? await this.apiRoute.settings().catch(() => null) : null;
    if (!route?.enabled) return list;
    const opencode = this.scripted || this.apiAgent.executable ? { available: true } : list.find((p) => p.id === "opencode");
    return [
      ...list,
      {
        id: "openrouter", name: this.apiAgent.name, available: !!opencode?.available, acp: true, billing: "api",
        detail: opencode?.available ? `Paid per use through OpenRouter · ${route.model}` : "Install OpenCode on the Mac to use the OpenRouter route.",
        modes: ["ask", "workspace", "full", "plan"], models: [route.model], defaultModel: route.model,
      },
    ];
  }

  async agentProviders({ refresh = false } = {}) {
    if (this.scripted) return ScriptedAdapter.providers();
    if (this.providerCache && !refresh && Date.now() - this.providerCache.at < 60000) return this.providerCache.value;
    const [claudeCode, codexCli, others] = await Promise.all([
      ClaudeAdapter.detect().catch((e) => ({ id: "claude", name: "Claude Code", available: false, detail: e.message })),
      CodexServer.detect().catch((e) => ({ id: "codex", name: "Codex", available: false, detail: e.message })),
      // Any other installed agent that speaks the Agent Client Protocol.
      detectAcpAgents().catch(() => []),
    ]);
    const value = [claudeCode, codexCli, ...others];
    for (const p of value) delete p.executable;
    const codex = value.find((p) => p.id === "codex");
    if (codex?.available) {
      const models = await this.codex.models().catch(() => null);
      if (models) {
        codex.models = ["default", ...models.ids];
        codex.modelNames = models.names;
        codex.defaultModel = models.configured && models.ids.includes(models.configured) ? models.configured : models.accountDefault;
      }
    }
    this.providerCache = { at: Date.now(), value };
    return value;
  }

  agentName(provider) {
    if (provider === "codex") return "Codex";
    if (provider === "claude") return "Claude Code";
    if (provider === "openrouter") return this.apiAgent.name;
    return acpAgent(provider)?.name || this.providerCache?.value.find((p) => p.id === provider)?.name || provider;
  }

  summary(task) {
    return {
      id: task.id,
      provider: task.provider,
      agentName: this.agentName(task.provider),
      title: task.title,
      cwd: task.cwd,
      status: task.status,
      access: task.access,
      model: task.model,
      screenControl: !!task.screenControl,
      created: task.created,
      updated: task.updated,
      preview: task.preview || "",
      seq: task.seq,
      pendingApprovals: task.pendingApprovals?.length || 0,
      archived: !!task.archived,
      costUsd: task.costUsd || 0,
    };
  }

  /**
   * The provider session ids behind every Palm task (archived ones too), so
   * the agent watch does not list Palm's own runs a second time.
   */
  providerSessionIds() {
    return new Set([...this.tasks.values()].map((t) => t.providerSessionId).filter(Boolean));
  }

  list({ archived = false } = {}) {
    return [...this.tasks.values()]
      .filter((t) => !!t.archived === archived)
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .map((t) => this.summary(t));
  }

  async get(id, after = 0) {
    const task = this.require(id);
    const events = (await this.log(id).readAll()).filter((e) => e.seq > after);
    const live = [...(this.live.get(id)?.entries() || [])].map(([itemId, text]) => ({ itemId, text }));
    return { task: this.summary(task), events, live, screen: this.screen.state() };
  }

  publishTask(task) {
    task.updated = new Date().toISOString();
    const summary = this.summary(task);
    this.hub.publish("tasks", { event: "task.updated", task: summary });
    for (const listener of this.updateListeners) {
      try {
        listener(summary);
      } catch {}
    }
    this.save();
  }

  onUpdate(listener) {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  /** A session's latest reply in full (from memory, else from its log). */
  async finalText(id) {
    if (this.lastText.has(id)) return this.lastText.get(id);
    const events = await this.log(id).readAll().catch(() => []);
    return [...events].reverse().find((e) => e.type === "assistant")?.text ?? "";
  }

  emit(task, event) {
    if (event.type === "assistant.delta") {
      const live = this.live.get(task.id) || new Map();
      live.set(event.itemId, (live.get(event.itemId) || "") + event.text);
      this.live.set(task.id, live);
      this.hub.publish(`task:${task.id}`, { event: "task.delta", taskId: task.id, itemId: event.itemId, text: event.text });
      return;
    }
    if (event.type === "assistant") {
      this.turns.get(task.id)?.texts.push(String(event.text || "").slice(-20000));
      this.live.get(task.id)?.delete(event.itemId);
      task.preview = event.text.replace(/\s+/g, " ").slice(0, 160);
      this.lastText.set(task.id, String(event.text).slice(-20000));
    }
    if (event.type === "session") {
      if (event.sessionId) task.providerSessionId = event.sessionId;
      if (event.model) task.modelInUse = event.model;
    }
    if (event.type === "approval") {
      task.pendingApprovals = task.pendingApprovals || [];
      if (event.status === "pending") task.pendingApprovals.push(event.approvalId);
      else task.pendingApprovals = task.pendingApprovals.filter((a) => a !== event.approvalId);
      if (task.status === "running" || task.status === "waiting")
        task.status = task.pendingApprovals.length ? "waiting" : "running";
    }
    if (event.type === "tool" && event.name) this.turns.get(task.id)?.tools.push({ name: event.name, detail: event.detail });
    if (event.type === "turn") {
      if (event.status === "started") {
        this.turns.set(task.id, { since: Date.now(), tools: [], texts: [] });
        task.status = "running";
        this.running.add(task.id);
        this.system?.agentActivity(this.running.size);
        if (task.provider === "openrouter" && this.apiRoute)
          void this.apiRoute.guard(task.id, {
            spentBefore: task.costUsd || 0,
            report: (spent) => (task.costUsd = spent),
            stop: async (reason) => {
              this.emit(task, { type: "notice", text: reason });
              await this.stop(task.id).catch(() => {});
            },
          }).catch(() => {});
      } else {
        if (task.provider === "openrouter" && this.apiRoute)
          void this.apiRoute.finish(task.id).then((spent) => {
            if (spent != null) {
              task.costUsd = spent;
              this.publishTask(task);
            }
          }).catch(() => {});
        this.running.delete(task.id);
        this.system?.agentActivity(this.running.size);
        this.live.delete(task.id);
        task.pendingApprovals = [];
        task.status = event.status === "completed" ? "idle" : event.status === "interrupted" ? "stopped" : "failed";
        if (event.costUsd) task.costUsd = event.costUsd;
        if (this.screen.ownerTask() === task.id) void this.screen.releaseAgent(task.id);
        const turn = this.turns.get(task.id);
        this.turns.delete(task.id);
        if (turn) setTimeout(() => void this.announceFiles(task, turn).catch(() => {}), 0);
        // Messages sent during the turn go next, in order.
        const waiting = this.queue.get(task.id);
        const resume = this.resumes.get(task.id);
        this.resumes.delete(task.id);
        if (waiting?.length && event.status === "completed") {
          const next = waiting.shift();
          setTimeout(() => this.deliver(task, next).catch(() => {}), 50);
        } else if (waiting?.length) this.queue.delete(task.id);
        else if (resume && event.status === "completed") setTimeout(() => this.deliver(task, { text: resume }).catch(() => {}), 50);
      }
    }
    task.seq = (task.seq || 0) + 1;
    const entry = { seq: task.seq, at: new Date().toISOString(), ...event };
    this.log(task.id).append(entry);
    this.hub.publish(`task:${task.id}`, { event: "task.event", taskId: task.id, entry });
    this.publishTask(task);
  }

  mcpFor(task) {
    const token = randomBytes(24).toString("base64url");
    for (const [existing, id] of this.tokens) if (id === task.id) this.tokens.delete(existing);
    this.tokens.set(token, task.id);
    return {
      command: process.execPath,
      args: [this.mcpScript],
      env: { PALM_API: this.apiOrigin, PALM_AGENT_TOKEN: token },
    };
  }

  adapter(task) {
    let adapter = this.adapters.get(task.id);
    if (adapter) return adapter;
    const emit = (event) => this.emit(task, event);
    const mcp = this.mcpFor(task);
    const other = acpAgent(task.provider);
    const route = task.provider === "openrouter";
    adapter = this.scripted
      ? new ScriptedAdapter({ task, emit, tool: (name, args) => this.toolCall(mcp.env.PALM_AGENT_TOKEN, name, args) })
      : route
        ? new AcpAdapter({ task, emit, agent: this.apiAgent, mcp, systemPrompt, extraEnv: () => this.apiRoute.environment() })
        : task.provider === "codex"
          ? new CodexAdapter({ task, emit, server: this.codex, mcp, systemPrompt })
          : other
            ? new AcpAdapter({ task, emit, agent: other, mcp, systemPrompt })
            : new ClaudeAdapter({ task, emit, mcp, systemPrompt });
    this.adapters.set(task.id, adapter);
    return adapter;
  }

  async create({ provider, cwd, text, attachments = [], access = "workspace", model = "default", screenControl = false, title } = {}) {
    const known = (await this.providers()).find((p) => p.id === provider);
    if (!known) throw new Error("Choose an agent that is installed on this Mac.");
    if (!known.available) throw new Error(`${known.name} is not installed on this Mac.`);
    // No first message makes a ready session (the assistant's "start Claude
    // in my website project"): it waits in Agents for its first instruction.
    const hasText = typeof text === "string" && !!text.trim();
    if (text != null && typeof text !== "string") throw new Error("Write what you want the agent to do.");
    if (hasText && text.length > 20000) throw new Error("That message is too long.");
    const folder = path.resolve(expandHome(cwd) || os.homedir());
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) throw new Error("Choose an existing project folder on the Mac.");
    if (!["ask", "workspace", "auto", "full", "plan"].includes(access)) access = "workspace";
    if (provider !== "claude" && access === "auto") access = "workspace";
    if (typeof model !== "string" || !/^[\w.:-]{1,60}$/.test(model)) model = "default";
    const task = {
      id: randomUUID(),
      provider,
      title: String(title || (hasText ? text : "New session")).replace(/\s+/g, " ").trim().slice(0, 80),
      cwd: folder,
      access,
      model,
      screenControl: !!screenControl,
      status: hasText ? "starting" : "idle",
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      seq: 0,
      pendingApprovals: [],
      providerSessionId: null,
    };
    this.tasks.set(task.id, task);
    this.screen.allow(task.id, task.screenControl);
    this.publishTask(task);
    if (hasText) await this.deliver(task, { text, attachments });
    return this.summary(task);
  }

  rename(id, title) {
    const task = this.require(id);
    const name = String(title || "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 80) throw new Error("Give the session a name of up to 80 characters.");
    task.title = name;
    this.publishTask(task);
    return this.summary(task);
  }

  /**
   * The files a turn made or pointed to, as cards the phone saves or opens
   * from the chat (a PDF made by an agent could not be
   * fetched from its chat, as it can from the Assistant).
   */
  async announceFiles(task, turn) {
    const found = await turnFiles({ ...turn, cwd: task.cwd, home: os.homedir(), policy: this.policy });
    if (!found.length || !this.tasks.has(task.id)) return;
    this.emit(task, {
      type: "files",
      files: found.map(({ file, info }) => ({
        type: "file", name: path.basename(file), path: file, folder: path.dirname(file), modified: info.mtime.toISOString(),
        size: info.size, sensitive: this.policy?.classify(file) === "sensitive", ...(this.deviceName ? { device: this.deviceName() } : {}),
      })),
    });
  }

  /**
   * The person handed the Mac screen back. An agent between turns continues
   * now; one still in its turn continues when that turn ends, unless it used
   * the screen again by itself first (E2E, 23 September: Codex ended its turn
   * "waiting for the handback" that had already happened).
   */
  async screenHandedBack(id, text) {
    const task = this.require(id);
    if (this.running.has(id)) {
      this.resumes.set(id, text);
      return this.summary(task);
    }
    return this.send(id, { text });
  }

  async send(id, { text, attachments = [] }) {
    const task = this.require(id);
    if (typeof text !== "string" || !text.trim()) throw new Error("Write a message first.");
    if (text.length > 20000) throw new Error("That message is too long.");
    if (task.archived) task.archived = false;
    if (this.running.has(id)) {
      const waiting = this.queue.get(id) || [];
      if (waiting.length >= 5) throw new Error("Wait for the agent to catch up before sending more.");
      waiting.push({ text, attachments });
      this.queue.set(id, waiting);
      this.emit(task, { type: "notice", text: "Queued. Palm will send this when the current step finishes." });
      return this.summary(task);
    }
    await this.deliver(task, { text, attachments });
    return this.summary(task);
  }

  async deliver(task, { text, attachments = [] }) {
    const files = await this.prepareAttachments(attachments);
    this.emit(task, {
      type: "user",
      text,
      attachments: files.map((f) => ({ path: f.path, name: path.basename(f.path), kind: f.image ? "image" : "file", size: f.size })),
    });
    const note = files.length ? `\n\nFiles attached from the phone (already on this Mac):\n${files.map((f) => `- ${f.path}`).join("\n")}` : "";
    const adapter = this.adapter(task);
    try {
      // Paid per use: not over today's limit before a turn starts.
      if (task.provider === "openrouter") await this.apiRoute.canStart();
      if (task.provider === "codex")
        await adapter.send({ text: text + note, imagePaths: files.filter((f) => f.modelImage).map((f) => f.modelImage) });
      else await adapter.send({ text: text + note, images: files.filter((f) => f.inline).map((f) => f.inline) });
    } catch (error) {
      this.emit(task, { type: "turn", status: "failed", error: error.message });
    }
  }

  // Files are uploaded to the Mac first (Files API); a message only refers to
  // them by path. Images are also shown to the model at a readable size.
  async prepareAttachments(paths) {
    if (!Array.isArray(paths)) return [];
    const out = [];
    for (const value of paths.slice(0, 10)) {
      if (typeof value !== "string" || !path.isAbsolute(value)) continue;
      const info = await stat(value).catch(() => null);
      if (!info?.isFile()) continue;
      const entry = { path: value, size: info.size, image: imageExtensions.has(path.extname(value).toLowerCase()) };
      if (entry.image) {
        const scratch = path.join(this.dir, "images");
        await mkdir(scratch, { recursive: true, mode: 0o700 });
        const converted = path.join(scratch, `${randomUUID()}.jpg`);
        const result = await run("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "82", "-Z", "1568", value, "--out", converted], { timeout: 20000 });
        if (result.ok) {
          const data = await readFile(converted).catch(() => null);
          if (data && data.length < 4.5 * 1024 * 1024) entry.inline = { mediaType: "image/jpeg", data: data.toString("base64") };
          entry.modelImage = converted;
        }
      }
      out.push(entry);
    }
    return out;
  }

  async stop(id) {
    const task = this.require(id);
    this.queue.delete(id);
    this.resumes.delete(id);
    const adapter = this.adapters.get(id);
    if (!adapter || !this.running.has(id)) {
      if (task.status === "running" || task.status === "waiting") {
        task.status = "stopped";
        this.running.delete(id);
        this.publishTask(task);
      }
      return this.summary(task);
    }
    // Stop the agent's screen access first so no late click lands, then the turn.
    if (this.screen.ownerTask() === id) await this.screen.releaseAgent(id);
    await adapter.interrupt();
    return this.summary(task);
  }

  answer(id, approvalId, decision) {
    const task = this.require(id);
    if (!["allow", "allowSession", "deny"].includes(decision)) throw new Error("Choose Allow or Deny.");
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error("That request is no longer waiting.");
    adapter.answer(approvalId, decision);
    return this.summary(task);
  }

  setScreenControl(id, allowed) {
    const task = this.require(id);
    task.screenControl = !!allowed;
    this.screen.allow(id, task.screenControl);
    this.emit(task, { type: "notice", text: allowed ? "Screen control allowed for this task." : "Screen control turned off for this task." });
    return this.summary(task);
  }

  // Removing a chat on the phone archives it: it leaves the list and its log
  // stays on the Mac. A chat that is still working is stopped first.
  async archive(id, archived = true) {
    const task = this.require(id);
    const busy = ["running", "waiting", "starting"];
    if (archived && (this.running.has(id) || busy.includes(task.status))) {
      await this.stop(id).catch(() => {});
      this.running.delete(id);
      this.queue.delete(id);
      this.live.delete(id);
      this.system?.agentActivity(this.running.size);
      task.pendingApprovals = [];
      if (busy.includes(task.status)) task.status = "stopped";
    }
    task.archived = !!archived;
    if (archived) {
      this.adapters.get(id)?.close();
      this.adapters.delete(id);
    }
    this.publishTask(task);
    return this.summary(task);
  }

  // Called by Palm's MCP server on behalf of a running agent.
  async toolCall(token, tool, args = {}) {
    const taskId = this.tokens.get(token);
    const task = taskId && this.tasks.get(taskId);
    if (!task) throw Object.assign(new Error("This agent is not connected to a Palm task."), { status: 401 });
    const text = (value) => ({ content: [{ type: "text", text: value }] });
    const refuse = (value) => ({ content: [{ type: "text", text: value }], isError: true });
    if (tool === "tell_user") {
      const message = String(args.message || "").slice(0, 600);
      if (message) this.emit(task, { type: "notice", text: message, fromAgent: true });
      return text("Sent to the user's phone.");
    }
    if (tool === "wait") {
      const seconds = Math.min(10, Math.max(1, Number(args.seconds) || 1));
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return text(`Waited ${seconds} seconds.`);
    }
    if (!task.screenControl)
      return refuse("Screen control is off for this task. Ask the user to allow screen control in Palm if you need the Mac's apps.");
    if (tool === "list_apps") {
      const apps = await this.native.request({ op: "apps" });
      return text(
        apps
          .map((a) => `${a.active ? "* " : "- "}${a.name}${a.windows.length ? `: ${a.windows.map((w) => w.title || "Untitled").slice(0, 6).join(" | ")}` : ""}`)
          .join("\n") || "No apps with windows.",
      );
    }
    if (tool === "screenshot") {
      const held = this.screen.state().held;
      const shot = await this.native.request({ op: "screenshot", maxWidth: 1440 });
      this.shots.set(task.id, { width: shot.width, height: shot.height, screen: shot.screen });
      // It sees the screen is its own again: no reminder needed after the turn.
      if (!held) this.resumes.delete(task.id);
      return {
        content: [
          ...(shot.jpeg ? [{ type: "image", data: shot.jpeg, mimeType: "image/jpeg" }] : []),
          {
            type: "text",
            text: `Screenshot ${shot.width}×${shot.height} px of the main display. Frontmost app: ${shot.frontmost?.name || "unknown"}.${held ? " The user currently has control of the screen: look only, do not act." : ""}`,
          },
        ],
      };
    }
    const shot = this.shots.get(task.id);
    const map = (x, y) => {
      if (!shot) throw new Error("Take a screenshot first so Palm knows where to act.");
      const px = Number(x);
      const py = Number(y);
      if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error("Give pixel coordinates from the screenshot.");
      return {
        x: shot.screen.x + (px / shot.width) * shot.screen.width,
        y: shot.screen.y + (py / shot.height) * shot.screen.height,
      };
    };
    let command;
    try {
      switch (tool) {
        case "click": {
          const p = map(args.x, args.y);
          command = { op: "agentInput", action: args.button === "right" ? "right" : args.double ? "double" : "click", ...p, modifiers: sanitizeModifiers(args.modifiers) };
          break;
        }
        case "scroll": {
          const p = map(args.x, args.y);
          command = { op: "agentInput", action: "scroll", ...p, dx: clampNumber(args.dx, 2000), dy: clampNumber(args.dy, 2000) };
          break;
        }
        case "drag": {
          const from = map(args.x, args.y);
          const to = map(args.toX, args.toY);
          command = { op: "agentInput", action: "drag", ...from, toX: to.x, toY: to.y };
          break;
        }
        case "type_text":
          if (typeof args.text !== "string" || args.text.length > 8000) throw new Error("Type up to 8,000 characters.");
          command = { op: "agentInput", action: "text", text: args.text };
          break;
        case "press_key":
          if (typeof args.key !== "string" || args.key.length > 20) throw new Error("Name one key.");
          command = { op: "agentInput", action: "key", key: args.key, modifiers: sanitizeModifiers(args.modifiers) };
          break;
        case "open_app": {
          const name = typeof args.name === "string" ? args.name.trim() : "";
          const target = typeof args.target === "string" ? args.target.trim() : "";
          if (!name && !target) throw new Error("Name an app, URL or file to open.");
          if (name && !/^[\w .&+()'-]{1,80}$/.test(name)) throw new Error("That app name is not valid.");
          if (target && !(/^https?:\/\//.test(target) || path.isAbsolute(target))) throw new Error("Open an http(s) URL or an absolute file path.");
          command = { op: "agentOpen", name, target };
          break;
        }
        default:
          return refuse(`Palm has no ${tool} tool.`);
      }
    } catch (error) {
      return refuse(error.message);
    }
    try {
      if (command.op === "agentOpen") {
        await this.screen.agentInput(task.id, { op: "release" });
        const argsList = command.name ? ["-a", command.name, ...(command.target ? [command.target] : [])] : [command.target];
        const result = await run("/usr/bin/open", argsList, { timeout: 15000 });
        if (!result.ok) return refuse(`macOS could not open ${command.name || command.target}.`);
        await new Promise((resolve) => setTimeout(resolve, 900));
        return text(`Opened ${command.name || command.target}. Take a screenshot to see it.`);
      }
      await this.screen.agentInput(task.id, command);
      this.resumes.delete(task.id);
      return text("Done. Take a screenshot to check the result.");
    } catch (error) {
      return refuse(error.message);
    }
  }

  require(id) {
    const task = this.tasks.get(id);
    if (!task) throw new Error("That task is no longer on this Mac.");
    return task;
  }

  async close() {
    for (const adapter of this.adapters.values()) adapter.close();
    this.codex.close();
    await this.save();
  }
}

function sanitizeModifiers(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((m) => ["cmd", "shift", "opt", "ctrl", "fn"].includes(m)).slice(0, 4);
}

function clampNumber(value, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(-max, Math.min(max, n)) : 0;
}

export { describeTool };
