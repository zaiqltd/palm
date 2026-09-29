// A stand-in agent for Palm's ACP adapter tests: JSON-RPC over stdio, as the
// Agent Client Protocol defines. A #tag in the prompt picks what it does.
import { createInterface } from "node:readline";

const authRequired = process.argv.includes("--auth-required");
let nextId = 1000;
let mode = "default";
let cancelled = false;
const waiting = new Map(); // our request id -> resolve
const prompts = [];

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function permission(sessionId, toolCall) {
  update(sessionId, { sessionUpdate: "tool_call", status: "pending", ...toolCall });
  const answer = await ask("session/request_permission", {
    sessionId,
    toolCall,
    options: [
      { optionId: "allow-once", name: "Allow", kind: "allow_once" },
      { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  const outcome = answer.result?.outcome;
  return outcome?.outcome === "selected" ? outcome.optionId : "cancelled";
}

async function prompt(id, { sessionId, prompt: blocks }) {
  const text = blocks.map((b) => b.text || "").join("");
  prompts.push(text);
  cancelled = false;
  if (text.includes("#env")) {
    // What this agent was given: presence only, never values (except the fake key's end).
    const key = process.env.OPENROUTER_API_KEY;
    let model = "none";
    try {
      model = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || "{}").model || "none";
    } catch {}
    const inherited = Object.keys(process.env).filter((k) => /(_API_KEY|_AUTH_TOKEN)$/.test(k) && k !== "OPENROUTER_API_KEY");
    say(sessionId, `key: ${key ? key.slice(-4) : "none"}; model: ${model}; other keys: ${inherited.length ? inherited.join(",") : "none"}`);
  } else if (text.includes("#echo")) {
    say(sessionId, `prompt#${prompts.length}: ${text}`);
  } else if (text.includes("#hello")) {
    say(sessionId, "Hello ");
    say(sessionId, "from fake");
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read README.md", kind: "read", status: "pending", rawInput: { path: "README.md" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "content", content: { type: "text", text: "# Readme" } }] });
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Look", priority: "high", status: "completed" }, { content: "Answer", priority: "high", status: "in_progress" }] });
    update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Look", priority: "high", status: "completed" }, { content: "Answer", priority: "high", status: "completed" }] });
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" } });
  } else if (text.includes("#run")) {
    const choice = await permission(sessionId, { toolCallId: "t2", title: "Run a command", kind: "execute", rawInput: { command: "echo hi" } });
    say(sessionId, `outcome: ${choice}`);
  } else if (text.includes("#edit-inside")) {
    const choice = await permission(sessionId, { toolCallId: "t3", title: "Edit notes", kind: "edit", locations: [{ path: "notes.txt" }] });
    say(sessionId, `outcome: ${choice}`);
  } else if (text.includes("#edit-outside")) {
    const choice = await permission(sessionId, { toolCallId: "t4", title: "Edit profile", kind: "edit", locations: [{ path: "/etc/profile" }] });
    say(sessionId, `outcome: ${choice}`);
  } else if (text.includes("#mode")) {
    say(sessionId, `mode: ${mode}`);
  } else if (text.includes("#files")) {
    const answer = await ask("fs/read_text_file", { sessionId, path: "/etc/hosts" });
    say(sessionId, answer.error ? `fs declined ${answer.error.code}` : "fs allowed");
  } else if (text.includes("#slow")) {
    for (let i = 0; i < 200 && !cancelled; i++) {
      say(sessionId, ".");
      await pause(50);
    }
    return send({ id, result: { stopReason: cancelled ? "cancelled" : "end_turn" } });
  }
  send({ id, result: { stopReason: "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
    return;
  }
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, authMethods: [{ id: "login", name: "Log in" }] } });
    case "session/new":
      if (authRequired) return send({ id, error: { code: -32000, message: "Authentication required" } });
      if (params.mcpServers?.[0]?.name !== "palm") return send({ id, error: { code: -32602, message: "Palm's tools were not offered" } });
      return send({ id, result: { sessionId: "fake-session", modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] } } });
    case "session/load":
      // Replays the history, which a client must not show again.
      update(params.sessionId, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
      say(params.sessionId, "old answer");
      return send({ id, result: null });
    case "session/set_mode":
      mode = params.modeId;
      return send({ id, result: null });
    case "session/prompt":
      return void prompt(id, params);
    case "session/cancel":
      cancelled = true;
      return;
    default:
      if (id !== undefined) send({ id, error: { code: -32601, message: "Unknown method" } });
  }
});
