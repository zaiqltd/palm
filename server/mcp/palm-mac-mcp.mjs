#!/usr/bin/env node
// Palm's Mac screen tools for local agents (Claude Code, Codex), as a stdio MCP
// server. Every call goes back to the Palm host over loopback with a per-task
// token, so the host's control ownership decides whether the agent may act:
// when the person on the phone takes over, input tools stop working until the
// screen is handed back. This process holds no permissions of its own.
import { createInterface } from "node:readline";

const api = process.env.PALM_API || "http://127.0.0.1:4318";
const token = process.env.PALM_AGENT_TOKEN || "";

const tools = [
  {
    name: "screenshot",
    description:
      "See the Mac's main display as it is now. Returns a JPEG. Coordinates for click, scroll and drag are pixels in the most recent screenshot. Take a fresh screenshot before acting after any wait, and after the user hands control back.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, title: "See the Mac screen" },
  },
  {
    name: "click",
    description: "Click at a point in the latest screenshot (pixel coordinates).",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"], default: "left" },
        double: { type: "boolean", default: false },
        modifiers: { type: "array", items: { type: "string", enum: ["cmd", "shift", "opt", "ctrl"] } },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    annotations: { title: "Click on the Mac" },
  },
  {
    name: "type_text",
    description: "Type text into the focused field on the Mac. Newlines press Return.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 8000 } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: { title: "Type on the Mac" },
  },
  {
    name: "press_key",
    description:
      "Press one key with optional modifiers, e.g. key 's' with ['cmd'] to save, 'tab', 'escape', 'return', 'left', 'f5'.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        modifiers: { type: "array", items: { type: "string", enum: ["cmd", "shift", "opt", "ctrl", "fn"] } },
      },
      required: ["key"],
      additionalProperties: false,
    },
    annotations: { title: "Press a key on the Mac" },
  },
  {
    name: "scroll",
    description: "Scroll at a point in the latest screenshot. Positive dy scrolls down.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, dx: { type: "number", default: 0 }, dy: { type: "number" } },
      required: ["x", "y", "dy"],
      additionalProperties: false,
    },
    annotations: { title: "Scroll on the Mac" },
  },
  {
    name: "drag",
    description: "Drag with the left button from one screenshot point to another.",
    inputSchema: {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" }, toX: { type: "number" }, toY: { type: "number" } },
      required: ["x", "y", "toX", "toY"],
      additionalProperties: false,
    },
    annotations: { title: "Drag on the Mac" },
  },
  {
    name: "open_app",
    description: "Open or bring forward a Mac app by name, e.g. 'Safari', or open a URL or file path with its default app.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, target: { type: "string", description: "URL or absolute file path" } },
      additionalProperties: false,
    },
    annotations: { title: "Open an app" },
  },
  {
    name: "list_apps",
    description: "List the apps running on the Mac with their visible windows.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, title: "List Mac apps" },
  },
  {
    name: "wait",
    description: "Wait 1-10 seconds for the Mac to finish something before looking again.",
    inputSchema: {
      type: "object",
      properties: { seconds: { type: "number", minimum: 1, maximum: 10 } },
      required: ["seconds"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, title: "Wait" },
  },
  {
    name: "tell_user",
    description:
      "Send a short progress note to the user's phone chat without ending your turn. Use sparingly, e.g. before a long step.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", maxLength: 600 } },
      required: ["message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, title: "Tell the user" },
  },
];

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

async function call(name, args) {
  const response = await fetch(api + "/api/agent-tools/call", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: api,
      Authorization: "Palm-Agent " + token,
    },
    body: JSON.stringify({ tool: name, arguments: args || {} }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return { content: [{ type: "text", text: body.error || `Palm refused the ${name} tool.` }], isError: true };
  return body;
}

createInterface({ input: process.stdin }).on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined || id === null) return; // notifications
  try {
    if (method === "initialize")
      return write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "palm", version: "0.3.0" },
          instructions:
            "Palm controls the user's Mac screen for GUI work. Prefer shell and file tools for code; use these tools for apps, browsers and dialogs. The user can take over at any time; if a tool says the user has control, stop GUI actions and wait or continue with other work.",
        },
      });
    if (method === "ping") return write({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return write({ jsonrpc: "2.0", id, result: { tools } });
    if (method === "tools/call") {
      const result = await call(params?.name, params?.arguments);
      return write({ jsonrpc: "2.0", id, result });
    }
    write({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  } catch (error) {
    write({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `Palm is not reachable: ${error.message}` }], isError: true },
    });
  }
});
