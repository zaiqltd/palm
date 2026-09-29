import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpAdapter, ACP_AGENTS } from "../server/agents/acp.mjs";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-acp-agent.mjs");
const mcp = { command: "/usr/bin/true", args: [], env: { PALM_AGENT_TOKEN: "test-token" } };

async function adapter({ access = "ask", args = [], providerSessionId = null, systemPrompt = "" } = {}) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "palm-acp-"));
  const events = [];
  const task = { id: "task", cwd, access, providerSessionId };
  const agent = { id: "fake", name: "Fake Agent", executable: process.execPath, args: [fixture, ...args] };
  const acp = new AcpAdapter({ task, agent, mcp, systemPrompt, emit: (event) => events.push(event) });
  return { acp, events, task };
}

// send returns once a turn is under way, as the other agents' adapters do;
// these tests wait for the whole turn.
const whole = async (acp, message) => {
  await acp.send(message);
  await acp.turn;
};
const replies = (events) => events.filter((e) => e.type === "assistant").map((e) => e.text);
const turns = (events) => events.filter((e) => e.type === "turn").map((e) => e.status);
async function until(predicate, ms = 5000) {
  for (const start = Date.now(); Date.now() - start < ms; ) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

test("the agent catalogue follows the ACP registry's commands", () => {
  const grok = ACP_AGENTS.find((a) => a.id === "grok");
  assert.deepEqual(grok.args, ["agent", "stdio"]);
  assert.equal(new Set(ACP_AGENTS.map((a) => a.id)).size, ACP_AGENTS.length, "ids are unique");
  assert.ok(!ACP_AGENTS.some((a) => ["claude", "codex"].includes(a.id)), "Claude Code and Codex keep their own adapters");
});

test("a reply streams, tool steps and the plan update in place, thoughts stay private", async () => {
  const { acp, events } = await adapter();
  try {
    await whole(acp, { text: "#hello" });
    assert.deepEqual(turns(events), ["started", "completed"]);
    assert.deepEqual(replies(events), ["Hello from fake"]);
    const deltas = events.filter((e) => e.type === "assistant.delta").map((e) => e.text);
    assert.deepEqual(deltas, ["Hello ", "from fake"]);
    const tool = events.filter((e) => e.type === "tool" && e.itemId === "t1");
    assert.deepEqual(tool.map((e) => e.status), ["running", "completed"]);
    assert.equal(tool[1].output, "# Readme");
    const plan = events.filter((e) => e.type === "tool" && e.name === "plan");
    assert.equal(new Set(plan.map((e) => e.itemId)).size, 1, "one plan step, updated in place");
    assert.equal(plan.at(-1).status, "completed");
    assert.ok(!JSON.stringify(events).includes("private thought"));
    assert.ok(events.some((e) => e.type === "session" && e.sessionId === "fake-session"));
  } finally {
    acp.close();
  }
});

test("Palm's guidance leads only the first message of a session", async () => {
  const { acp, events } = await adapter({ systemPrompt: "PALM-GUIDANCE" });
  try {
    await whole(acp, { text: "#echo one" });
    await whole(acp, { text: "#echo two" });
    const [first, second] = replies(events);
    assert.ok(first.includes("PALM-GUIDANCE") && first.includes("#echo one"));
    assert.ok(!second.includes("PALM-GUIDANCE") && second.includes("#echo two"));
  } finally {
    acp.close();
  }
});

test("Ask: a permission request reaches the phone and the answer goes back", async () => {
  const { acp, events } = await adapter({ access: "ask" });
  try {
    const turn = whole(acp, { text: "#run" });
    assert.ok(await until(() => events.some((e) => e.type === "approval" && e.status === "pending")));
    const approval = events.find((e) => e.type === "approval");
    assert.deepEqual(approval.options, ["allow", "allowSession", "deny"]);
    assert.equal(approval.detail, "echo hi");
    acp.answer(approval.approvalId, "allow");
    await turn;
    assert.deepEqual(replies(events), ["outcome: allow-once"]);
    assert.throws(() => acp.answer(approval.approvalId, "allow"), /no longer waiting/);
  } finally {
    acp.close();
  }
});

test("access levels answer permission requests on the Mac", async () => {
  const cases = [
    ["full", "#run", "outcome: allow-always"],
    ["plan", "#run", "outcome: reject-once"],
    ["workspace", "#edit-inside", "outcome: allow-once"],
  ];
  for (const [access, text, expected] of cases) {
    const { acp, events } = await adapter({ access });
    try {
      await whole(acp, { text });
      assert.ok(!events.some((e) => e.type === "approval"), `${access} needs no phone approval`);
      assert.deepEqual(replies(events), [expected], access);
    } finally {
      acp.close();
    }
  }
  // Editing outside the project still asks, even with "Edit this project".
  const { acp, events } = await adapter({ access: "workspace" });
  try {
    const turn = whole(acp, { text: "#edit-outside" });
    assert.ok(await until(() => events.some((e) => e.type === "approval" && e.status === "pending")));
    acp.answer(events.find((e) => e.type === "approval").approvalId, "deny");
    await turn;
    assert.deepEqual(replies(events), ["outcome: reject-once"]);
  } finally {
    acp.close();
  }
});

test("Plan only switches the agent to its own plan mode", async () => {
  const { acp, events } = await adapter({ access: "plan" });
  try {
    await whole(acp, { text: "#mode" });
    assert.deepEqual(replies(events), ["mode: plan"]);
  } finally {
    acp.close();
  }
});

test("Stop cancels the turn", async () => {
  const { acp, events } = await adapter();
  try {
    const turn = whole(acp, { text: "#slow" });
    assert.ok(await until(() => events.some((e) => e.type === "assistant.delta")));
    await acp.interrupt();
    await turn;
    assert.deepEqual(turns(events), ["started", "interrupted"]);
  } finally {
    acp.close();
  }
});

test("a saved session resumes without replaying its history", async () => {
  const { acp, events } = await adapter({ providerSessionId: "fake-session", systemPrompt: "PALM-GUIDANCE" });
  try {
    await whole(acp, { text: "#echo again" });
    assert.ok(!JSON.stringify(events).includes("old answer"), "history is not shown twice");
    assert.ok(!events.some((e) => e.type === "notice"), "no fresh-session notice");
    assert.ok(!replies(events)[0].includes("PALM-GUIDANCE"), "a resumed session already has the guidance");
  } finally {
    acp.close();
  }
});

test("signing in, file requests and a missing agent fail plainly", async () => {
  const signedOut = await adapter({ args: ["--auth-required"] });
  try {
    await whole(signedOut.acp, { text: "#hello" });
    const turn = signedOut.events.find((e) => e.type === "turn" && e.status === "failed");
    assert.match(turn.error, /needs you to sign in on your Mac/);
  } finally {
    signedOut.acp.close();
  }
  const files = await adapter();
  try {
    await whole(files.acp, { text: "#files" });
    assert.deepEqual(replies(files.events), ["fs declined -32601"], "Palm offers no file access of its own");
  } finally {
    files.acp.close();
  }
  const cwd = await mkdtemp(path.join(os.tmpdir(), "palm-acp-"));
  const events = [];
  const missing = new AcpAdapter({
    task: { id: "task", cwd, access: "ask" },
    agent: { id: "none", name: "Nobody", commands: ["palm-no-such-agent"], args: [] },
    emit: (event) => events.push(event),
  });
  await whole(missing, { text: "hi" });
  assert.match(events.find((e) => e.type === "turn" && e.status === "failed").error, /not installed/);
});
