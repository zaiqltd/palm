import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Voice } from "../server/voice/voice.mjs";
import { ApiRoute } from "../server/agents/api-route.mjs";
import { AgentBroker } from "../server/agents/broker.mjs";
import { EventHub } from "../server/platform/events.mjs";

// Priority 4: the OpenRouter route runs a maintained agent (OpenCode through
// ACP; here a scripted stand-in) with the user's key and chosen model, only
// when chosen, within the limits set on the phone.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/fake-acp-agent.mjs");
const key = "sk-or-v1-" + "b".repeat(40) + "k3y9";

const brokers = [];
test.after(async () => {
  for (const broker of brokers) await broker.close().catch(() => {});
});

async function setup() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "palm-route-"));
  const usage = { today: 1.0 };
  const fetch = async (url) => {
    const route = new URL(url).pathname.replace("/api/v1", "");
    if (route === "/key") return new Response(JSON.stringify({ data: { usage: 20, usage_daily: usage.today, usage_monthly: 20, limit: null, limit_remaining: null } }), { status: 200 });
    if (route === "/models")
      return new Response(JSON.stringify({ data: [
        { id: "openai/gpt-6-luna", name: "GPT-6 Luna", supported_parameters: ["tools", "max_tokens"], pricing: { prompt: "0.0000004", completion: "0.0000016" } },
        { id: "some/image-only", name: "Image only", supported_parameters: ["max_tokens"], pricing: { prompt: "0", completion: "0" } },
      ] }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const voice = new Voice({ stateDir, fetch });
  await voice.setKey(key);
  const route = new ApiRoute({ stateDir, voice, fetch, pollMs: 40 });
  const screen = { allow() {}, ownerTask: () => null, releaseAgent: async () => {}, state: () => ({}) };
  const broker = new AgentBroker({
    stateDir, hub: new EventHub(), screen, native: null, system: null, mcpScript: "", apiOrigin: "",
    apiRoute: route, apiAgent: { id: "openrouter", name: "OpenCode · OpenRouter", executable: process.execPath, args: [fixture] },
  });
  // Only the route matters here: no detection of the Mac's own agents.
  broker.agentProviders = async () => [{ id: "claude", name: "Claude Code", available: true }];
  await broker.open();
  brokers.push(broker);
  const events = async (id) => (await broker.get(id)).events;
  const until = async (id, predicate, ms = 8000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 40))) {
      const list = await events(id);
      if (predicate(list, broker.list().find((t) => t.id === id))) return list;
    }
    throw new Error(`Timed out: ${JSON.stringify((await events(id)).map((e) => [e.type, e.status ?? "", (e.text ?? e.error ?? "").slice(0, 80)]))}`);
  };
  return { stateDir, usage, route, broker, until };
}

test("the route is its own, labelled agent, only when switched on", async () => {
  const { route, broker } = await setup();
  assert.deepEqual((await broker.providers()).map((p) => p.id), ["claude"], "off by default");
  await assert.rejects(route.update({ model: "not a model" }), /Choose a model/);
  await assert.rejects(route.update({ dailyLimitUsd: 0 }), /between/);
  await route.update({ enabled: true, model: "openai/gpt-6-luna", dailyLimitUsd: 5, taskLimitUsd: 2 });
  const listed = (await broker.providers()).find((p) => p.id === "openrouter");
  assert.equal(listed.billing, "api");
  assert.match(listed.detail, /Paid per use through OpenRouter · openai\/gpt-6-luna/);
  assert.deepEqual((await route.models()).map((m) => m.id), ["openai/gpt-6-luna"], "only models that can call tools");
  assert.equal((await route.models())[0].inputPerMillion, 0.4);
});

test("its agent alone gets the key and the model; no agent inherits shell keys", async () => {
  const { route, broker, until } = await setup();
  await route.update({ enabled: true, model: "openai/gpt-6-luna" });
  process.env.SOMETHING_API_KEY = "shell-secret";
  try {
    const task = await broker.create({ provider: "openrouter", cwd: os.tmpdir(), text: "#env" });
    const done = await until(task.id, (list) => list.some((e) => e.type === "assistant"));
    const said = done.find((e) => e.type === "assistant").text;
    assert.match(said, /key: k3y9/);
    assert.match(said, /model: openrouter\/openai\/gpt-6-luna/);
    assert.match(said, /other keys: none/, "nothing inherited from the shell");
  } finally {
    delete process.env.SOMETHING_API_KEY;
  }
});

test("over today's limit nothing starts; past the session's limit it stops", async () => {
  const { usage, route, broker, until } = await setup();
  await route.update({ enabled: true, dailyLimitUsd: 5, taskLimitUsd: 2 });
  usage.today = 5.2;
  const blocked = await broker.create({ provider: "openrouter", cwd: os.tmpdir(), text: "#echo hi" });
  const refused = await until(blocked.id, (list) => list.some((e) => e.type === "turn" && e.status === "failed"));
  assert.match(refused.find((e) => e.type === "turn" && e.status === "failed").error, /Today's OpenRouter limit of \$5\.00 is used/);

  usage.today = 1.0;
  const running = await broker.create({ provider: "openrouter", cwd: os.tmpdir(), text: "#slow" });
  assert.equal(running.status, "running", "the request returns while the agent works, not when it finishes");
  assert.equal(running.agentName, "OpenCode · OpenRouter", "named for what it is, not by its id");
  await until(running.id, (list) => list.some((e) => e.type === "turn" && e.status === "started"));
  await new Promise((r) => setTimeout(r, 150));
  usage.today = 3.4; // $2.40 spent since the turn began, over the $2 session limit
  const stopped = await until(running.id, (list, task) => task?.status === "stopped" && list.some((e) => e.type === "notice"));
  assert.match(stopped.find((e) => e.type === "notice" && /Stopped/.test(e.text)).text, /this session's limit of \$2\.00 \(\$2\.40 spent/);
});

test("switched off, the route refuses to start", async () => {
  const { route } = await setup();
  await assert.rejects(route.canStart(), /route is off/);
});
