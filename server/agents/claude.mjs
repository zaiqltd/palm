import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { userEnvironment, which } from "../platform/env.mjs";

// Claude Code, running as the user's own unmodified `claude` binary in headless
// stream-JSON mode with their existing sign-in. Palm never reads its credentials.
// Permission prompts arrive as control requests and are answered from the
// phone; Stop sends the CLI's interrupt control request.
const modes = {
  ask: "default",
  workspace: "acceptEdits",
  auto: "auto",
  full: "bypassPermissions",
  plan: "plan",
};

export class ClaudeAdapter {
  constructor({ task, emit, mcp, systemPrompt }) {
    this.task = task;
    this.emit = emit; // (event) => void
    this.mcp = mcp; // { command, args, env } or null
    this.systemPrompt = systemPrompt;
    this.child = null;
    this.pendingControl = new Map();
    this.approvals = new Map(); // requestId -> { input }
    this.partial = new Map(); // stream index -> { itemId, text }
    this.messageId = null;
    this.turnActive = false;
    this.idleTimer = null;
  }

  static async detect() {
    const env = await userEnvironment();
    const executable = await which("claude", env);
    if (!executable) return { id: "claude", name: "Claude Code", available: false, detail: "Install Claude Code on the Mac." };
    const { run } = await import("../platform/env.mjs");
    const [version, auth] = await Promise.all([
      run(executable, ["--version"], { env, timeout: 8000 }),
      run(executable, ["auth", "status"], { env, timeout: 8000 }),
    ]);
    let signedIn = null;
    let plan = null;
    try {
      const status = JSON.parse(auth.stdout);
      signedIn = !!status.loggedIn;
      plan = status.subscriptionType || status.authMethod || null;
    } catch {}
    return {
      id: "claude",
      name: "Claude Code",
      available: true,
      version: version.stdout.trim().split(" ")[0] || null,
      signedIn,
      plan,
      executable,
      modes: ["ask", "workspace", "auto", "full", "plan"],
      models: ["default", "fable", "opus", "sonnet", "haiku"],
    };
  }

  async ensure() {
    if (this.child && this.child.exitCode === null) return;
    const env = agentEnvironment(await userEnvironment());
    // Do not hold the first reply until every MCP server has connected; a slow
    // remote connector otherwise stalls startup for ~30 seconds.
    env.MCP_CONNECTION_NONBLOCKING = "true";
    env.MCP_TIMEOUT = env.MCP_TIMEOUT || "15000";
    const executable = await which("claude", env);
    if (!executable) throw new Error("Claude Code is not installed on this Mac.");
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool", "stdio",
      "--permission-mode", modes[this.task.access] || "acceptEdits",
    ];
    if (this.task.providerSessionId) args.push("--resume", this.task.providerSessionId);
    else {
      this.task.providerSessionId = randomUUID();
      args.push("--session-id", this.task.providerSessionId);
    }
    if (this.task.model && this.task.model !== "default") args.push("--model", this.task.model);
    if (this.systemPrompt) args.push("--append-system-prompt", this.systemPrompt);
    if (this.mcp) {
      args.push("--mcp-config", JSON.stringify({ mcpServers: { palm: { type: "stdio", ...this.mcp } } }));
      args.push("--allowedTools", "mcp__palm__screenshot", "mcp__palm__list_apps", "mcp__palm__wait", "mcp__palm__tell_user",
        "mcp__palm__click", "mcp__palm__type_text", "mcp__palm__press_key", "mcp__palm__scroll", "mcp__palm__drag", "mcp__palm__open_app");
    }
    const child = spawn(executable, args, { cwd: this.task.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr = (stderr + d).slice(-4000);
    });
    child.on("error", (error) => this.emit({ type: "error", text: `Claude Code could not start: ${error.message}` }));
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      for (const pending of this.pendingControl.values()) pending.reject(new Error("Claude Code stopped."));
      this.pendingControl.clear();
      this.expireApprovals();
      if (this.turnActive) {
        this.turnActive = false;
        const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400);
        this.emit({ type: "turn", status: "failed", error: detail || `Claude Code exited (${code}).` });
      }
    });
    child.stdin.on("error", () => {});
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    // Optional handshake; never let it delay the first message.
    this.control({ subtype: "initialize" }).catch(() => {});
  }

  write(message) {
    this.child?.stdin.write(JSON.stringify(message) + "\n");
  }

  control(request, timeout = 20000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(id);
        reject(new Error("Claude Code did not answer."));
      }, timeout);
      this.pendingControl.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ type: "control_request", request_id: id, request });
    });
  }

  async send({ text, images = [] }) {
    clearTimeout(this.idleTimer);
    await this.ensure();
    const content = [];
    for (const image of images) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
    content.push({ type: "text", text });
    this.turnActive = true;
    this.emit({ type: "turn", status: "started" });
    this.write({ type: "user", message: { role: "user", content } });
  }

  async interrupt() {
    if (!this.child) return;
    this.expireApprovals("denied");
    try {
      await this.control({ subtype: "interrupt" }, 8000);
    } catch {
      // The CLI did not acknowledge: stop the process; the session resumes later.
      this.child?.kill("SIGINT");
    }
  }

  answer(approvalId, decision) {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new Error("That request is no longer waiting.");
    this.approvals.delete(approvalId);
    let response;
    if (decision === "deny")
      response = { behavior: "deny", message: "The user declined this on their phone.", interrupt: false };
    else {
      response = { behavior: "allow", updatedInput: pending.input };
      if (decision === "allowSession" && pending.suggestions?.length) response.updatedPermissions = pending.suggestions;
    }
    this.write({ type: "control_response", response: { subtype: "success", request_id: approvalId, response } });
    this.emit({ type: "approval", approvalId, status: decision === "deny" ? "denied" : "allowed" });
  }

  expireApprovals(status = "expired") {
    for (const [approvalId] of this.approvals) this.emit({ type: "approval", approvalId, status });
    this.approvals.clear();
  }

  receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    switch (message.type) {
      case "control_response": {
        const id = message.response?.request_id;
        const pending = this.pendingControl.get(id);
        if (pending) {
          this.pendingControl.delete(id);
          if (message.response.subtype === "error") pending.reject(new Error(message.response.error || "Claude Code refused."));
          else pending.resolve(message.response.response);
        }
        return;
      }
      case "control_request":
        return this.onControlRequest(message);
      case "system":
        if (message.subtype === "init") {
          if (message.session_id) this.task.providerSessionId = message.session_id;
          this.emit({ type: "session", model: message.model, permissionMode: message.permissionMode, sessionId: message.session_id });
        }
        return;
      case "stream_event":
        return this.onStream(message.event);
      case "assistant":
        return this.onAssistant(message.message);
      case "user":
        return this.onToolResults(message.message);
      case "result": {
        this.turnActive = false;
        this.expireApprovals();
        const interrupted = message.subtype === "error_during_execution" || /interrupt/i.test(message.result || "");
        this.emit({
          type: "turn",
          status: message.is_error && !interrupted ? "failed" : interrupted ? "interrupted" : "completed",
          durationMs: message.duration_ms,
          costUsd: message.total_cost_usd,
          error: message.is_error && !interrupted ? String(message.result || message.subtype || "").slice(0, 400) : undefined,
        });
        // Keep the process warm for a follow-up; resume from the session later.
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.close(), 15 * 60 * 1000);
        this.idleTimer.unref?.();
        return;
      }
      default:
        return;
    }
  }

  onControlRequest(message) {
    const request = message.request || {};
    if (request.subtype === "can_use_tool") {
      const summary = describeTool(request.tool_name, request.input);
      this.approvals.set(message.request_id, { input: request.input, suggestions: request.permission_suggestions });
      this.emit({
        type: "approval",
        approvalId: message.request_id,
        status: "pending",
        tool: request.tool_name,
        title: summary.title,
        detail: summary.detail || request.description || "",
        options: request.permission_suggestions?.length ? ["allow", "allowSession", "deny"] : ["allow", "deny"],
      });
      return;
    }
    // Anything else (hooks, MCP messages) is declined rather than guessed at.
    this.write({
      type: "control_response",
      response: { subtype: "error", request_id: message.request_id, error: "Palm does not handle this request." },
    });
  }

  onStream(event) {
    if (!event) return;
    if (event.type === "message_start") {
      this.messageId = event.message?.id || randomUUID();
      this.partial.clear();
      return;
    }
    if (event.type === "content_block_start" && event.content_block?.type === "text") {
      this.partial.set(event.index, { itemId: `${this.messageId}:${event.index}`, text: "" });
      return;
    }
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const part = this.partial.get(event.index);
      if (!part) return;
      part.text += event.delta.text;
      this.emit({ type: "assistant.delta", itemId: part.itemId, text: event.delta.text });
    }
  }

  onAssistant(message) {
    if (!message?.content) return;
    message.content.forEach((block, index) => {
      if (block.type === "text" && block.text?.trim()) {
        this.emit({ type: "assistant", itemId: `${message.id}:${index}`, text: block.text });
      } else if (block.type === "tool_use") {
        const summary = describeTool(block.name, block.input);
        this.emit({ type: "tool", itemId: block.id, name: block.name, title: summary.title, detail: summary.detail, status: "running" });
      }
    });
  }

  onToolResults(message) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      let output = "";
      if (typeof block.content === "string") output = block.content;
      else if (Array.isArray(block.content))
        output = block.content.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[image]" : "")).join("\n");
      this.emit({
        type: "tool",
        itemId: block.tool_use_id,
        status: block.is_error ? "failed" : "completed",
        output: output.slice(0, 6000),
      });
    }
  }

  close() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.turnActive = false;
    child.stdin.end();
    setTimeout(() => child.exitCode === null && child.kill("SIGTERM"), 2000).unref();
  }
}

// Agents use the user's own subscriptions. Provider API keys from the shell would
// silently switch billing (or accounts), so they never reach agent processes.
export function agentEnvironment(base) {
  const env = { ...base };
  // Agents use their own sign-in. A paid API key in the shell (OpenRouter,
  // Gemini, xAI...) is never passed on, so no agent changes billing by itself;
  // the OpenRouter route passes its key explicitly, only to its own agent.
  for (const key of Object.keys(env))
    if (
      /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|OPENAI_ORG_ID|OPENAI_PROJECT_ID|CODEX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)$/.test(key) ||
      /(_API_KEY|_AUTH_TOKEN|_ACCESS_KEY)$/.test(key) ||
      /^(OPENROUTER_|XAI_|GEMINI_|GOOGLE_API|GROQ_|MISTRAL_|DEEPSEEK_|TOGETHER_)/.test(key)
    )
      delete env[key];
  delete env.PALM_AGENT_TOKEN;
  return env;
}

export function describeTool(name = "", input = {}) {
  const short = (value, n = 300) => String(value ?? "").slice(0, n);
  switch (name) {
    case "Bash":
      return { title: "Run command", detail: short(input.command, 1200) };
    case "Read":
      return { title: "Read file", detail: short(input.file_path) };
    case "Write":
      return { title: "Write file", detail: short(input.file_path) };
    case "Edit":
    case "MultiEdit":
      return { title: "Edit file", detail: short(input.file_path) };
    case "NotebookEdit":
      return { title: "Edit notebook", detail: short(input.notebook_path) };
    case "Glob":
      return { title: "Find files", detail: short(input.pattern) };
    case "Grep":
      return { title: "Search code", detail: short(input.pattern) };
    case "WebFetch":
      return { title: "Open web page", detail: short(input.url) };
    case "WebSearch":
      return { title: "Search the web", detail: short(input.query) };
    case "Task":
    case "Agent":
      return { title: "Start a helper agent", detail: short(input.description || input.prompt) };
    case "TodoWrite":
      return {
        title: "Update plan",
        detail: Array.isArray(input.todos) ? input.todos.map((t) => `${t.status === "completed" ? "✓" : "•"} ${t.content}`).join("\n").slice(0, 1200) : "",
      };
    default:
      if (name.startsWith("mcp__palm__")) {
        const tool = name.slice(11);
        const titles = {
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
        };
        const detail =
          tool === "click" ? `${input.double ? "Double-click" : input.button === "right" ? "Right-click" : "Click"} at ${Math.round(input.x)}, ${Math.round(input.y)}`
          : tool === "type_text" ? short(input.text, 200)
          : tool === "press_key" ? [...(input.modifiers || []), input.key].join("+")
          : tool === "open_app" ? short(input.name || input.target)
          : tool === "tell_user" ? short(input.message, 600)
          : tool === "wait" ? `${input.seconds}s`
          : "";
        return { title: titles[tool] || tool, detail };
      }
      if (name.startsWith("mcp__")) return { title: name.split("__").slice(1).join(" · "), detail: short(JSON.stringify(input), 300) };
      return { title: name || "Tool", detail: short(JSON.stringify(input), 300) };
  }
}
