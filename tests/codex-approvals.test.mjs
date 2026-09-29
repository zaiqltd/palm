import test from "node:test";
import assert from "node:assert/strict";
import { CodexAdapter, formDefaults } from "../server/agents/codex.mjs";

// Codex sessions could never open an app through Palm
// ("user rejected MCP tool call"). Codex asks before an agent uses an MCP tool
// with effects; Palm answered "cannot", which Codex reads as the user saying no.
function adapter() {
  const writes = [];
  const events = [];
  const codex = new CodexAdapter({
    task: { id: "t", access: "workspace", screenControl: true },
    emit: (event) => events.push(event),
    server: { write: (message) => writes.push(message) },
    mcp: {},
    systemPrompt: "",
  });
  return { codex, writes, events };
}
const ask = (id, params) => ({ id, method: "mcpServer/elicitation/request", params: { threadId: "th", mode: "form", ...params } });

test("Palm's own tools are allowed by Palm; another tool server's question goes to the phone", () => {
  const { codex, writes, events } = adapter();
  codex.onServerRequest(ask(7, { serverName: "palm", message: 'Allow the palm MCP server to run tool "open_app"?', requestedSchema: { type: "object", properties: {} } }));
  assert.deepEqual(writes.at(-1), { id: 7, result: { action: "accept", content: {} } });
  assert.equal(events.length, 0, "no question: the session's screen permission already decides");

  codex.onServerRequest(ask(8, { serverName: "github", message: "Allow github to create an issue?", requestedSchema: { type: "object", properties: { remember: { type: "boolean" } } } }));
  const asked = events.at(-1);
  assert.equal(asked.type, "approval");
  assert.equal(asked.title, "github asks");
  assert.deepEqual(asked.options, ["allow", "deny"]);
  codex.answer(asked.approvalId, "allow");
  assert.deepEqual(writes.at(-1), { id: 8, result: { action: "accept", content: { remember: true } } });

  codex.onServerRequest(ask(9, { serverName: "github", message: "Again?", requestedSchema: {} }));
  codex.answer(events.filter((e) => e.status === "pending").at(-1).approvalId, "deny");
  assert.deepEqual(writes.at(-1), { id: 9, result: { action: "decline" } });

  codex.onServerRequest({ id: 10, method: "mcpServer/elicitation/request", params: { threadId: "th", serverName: "x", mode: "url", elicitationId: "e", message: "Sign in", url: "https://example.com" } });
  assert.deepEqual(writes.at(-1), { id: 10, result: { action: "decline" } }, "a web page to open cannot be answered from the phone");
});

test("an accepted form carries each field's default, yes for yes/no, the first choice", () => {
  assert.deepEqual(
    formDefaults({ properties: { a: { type: "string", default: "x" }, b: { type: "boolean" }, c: { type: "string", enum: ["one", "two"] }, d: { type: "string" } } }),
    { a: "x", b: true, c: "one" },
  );
});
