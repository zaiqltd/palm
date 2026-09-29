import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, stat, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Priority 2: the Assistant remembers a conversation's results and hands work
// to an agent (after asking), then brings the agent's verified result back.
// The whole file runs in a throwaway home: the test host's scripted agent may
// write only there.
const home = await mkdtemp(path.join(os.tmpdir(), "palm-context-home-"));
process.env.HOME = home;
const { WorkMemory } = await import("../server/memory/memory.mjs");
const { Assistant } = await import("../server/assistant/assistant.mjs");
const { Conversations } = await import("../server/assistant/conversations.mjs");
const { FsPolicy } = await import("../server/files/fs-api.mjs");
const { AgentBroker } = await import("../server/agents/broker.mjs");
const { EventHub } = await import("../server/platform/events.mjs");

const conversation = "c0ffee00-1111-4222-8333-444455556666";
let turns = 0;
const turn = () => `t${String(++turns).padStart(8, "0")}`;

async function setup({ brain = null } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "palm-context-state-"));
  await mkdir(path.join(home, "Documents"), { recursive: true });
  const day = 24 * 3600 * 1000;
  for (const [name, age] of [["Documents/notes.txt", 2], ["Documents/Proposal - Acme.docx", 1], ["Documents/Proposal - Old.docx", 30]]) {
    const file = path.join(home, name);
    await writeFile(file, "sample");
    const when = new Date(Date.now() - age * day);
    await utimes(file, when, when);
  }
  const policy = new FsPolicy({ stateDir });
  const memory = new WorkMemory({ stateDir, policy, home });
  const screen = { allow() {}, ownerTask: () => null, releaseAgent: async () => {}, state: () => ({}) };
  const broker = new AgentBroker({ stateDir, hub: new EventHub(), screen, native: null, system: null, mcpScript: "", apiOrigin: "", scripted: true });
  await broker.open();
  const published = [];
  const dev = { projects: async () => [], start: async () => ({ id: "dev1", status: "running", port: null }) };
  const assistant = new Assistant({
    memory, broker, dev, policy, home, deviceName: () => "Test Mac", search: async () => null, brain,
    conversations: new Conversations({ stateDir }), publish: (payload) => published.push(payload),
  });
  const followup = async (turnId, predicate = () => true) => {
    for (let i = 0; i < 200; i++) {
      const found = published.find((p) => p.turn === turnId && predicate(p.followup));
      if (found) return found.followup;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`No follow-up for ${turnId}: ${JSON.stringify(published.map((p) => [p.turn, p.followup.reply]))}`);
  };
  return { stateDir, assistant, broker, published, followup };
}

function scriptedBrain(steps) {
  const seen = [];
  return {
    seen,
    enabled: async () => true,
    complete: async (messages) => {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const step = steps[seen.length - 1];
      if (!step) throw new Error("The model is unavailable.");
      if (typeof step === "string") return { role: "assistant", content: step };
      return { role: "assistant", content: null, tool_calls: step.map(([name, args], i) => ({ id: `c${seen.length}-${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) };
    },
  };
}

test("that file, that agent, is it done: the conversation's actual results", async () => {
  const { stateDir, assistant, broker, followup } = await setup();
  const ask = (text) => {
    const id = turn();
    return assistant.handle(text, { conversation, turn: id }).then((result) => ({ ...result, id }));
  };
  let result = await ask("Find my notes");
  assert.equal(result.cards[0].name, "notes.txt");

  result = await ask("send me that file");
  assert.deepEqual(result.cards.map((c) => [c.name, c.autoSave]), [["notes.txt", true]], "the file found before, saved to the phone");

  result = await ask("Start Claude in ~/Documents");
  const taskId = result.cards[0].taskId;
  assert.ok(taskId);

  result = await ask("tell it to list the files");
  assert.match(result.reply, /Sent to Claude Code/);
  assert.equal(result.cards[0].taskId, taskId, "the same session, not a new one");
  const answer = await followup(result.id);
  assert.match(answer.reply, /You said: "list the files"/, "its answer came back to the conversation");

  result = await ask("is it done?");
  assert.match(result.reply, /finished its turn/);
  assert.equal(broker.list().length, 1, "one session throughout");

  // "that project" and "there" mean the folder this conversation is about.
  result = await ask("start codex there");
  const second = broker.list().find((t) => t.provider === "codex");
  assert.equal(second?.cwd, path.join(home, "Documents"));

  // Remembered on the Mac: a fresh store reads the same turns.
  const again = new Conversations({ stateDir });
  const ctx = await again.context(conversation);
  assert.equal(ctx.files[0].name, "notes.txt");
});

test("that file is the one the person saved; a file named with the words comes first", async () => {
  // E2E, 23 September: "find my Palm E2E notes" listed a newer document that
  // only quoted the name first, the notes were saved from the second card, and
  // "send me that file" sent the first.
  const { stateDir, assistant } = await setup();
  const notes = path.join(home, "Documents/Palm E2E notes.txt");
  const prompt = path.join(home, "Documents/E2E-PHONE-TEST-PROMPT.md");
  await writeFile(notes, "notes");
  await writeFile(prompt, "Save Palm E2E notes.txt to the phone.");
  const older = new Date(Date.now() - 3 * 3600 * 1000);
  await utimes(notes, older, older);
  // Spotlight matches names and contents: the newer prompt comes back first.
  assistant.search = async () => [prompt, notes];
  const ask = (text) => {
    const id = turn();
    return assistant.handle(text, { conversation, turn: id });
  };
  let result = await ask("find my Palm E2E notes");
  assert.deepEqual(result.cards.map((c) => c.name), ["Palm E2E notes.txt", "E2E-PHONE-TEST-PROMPT.md"]);
  assert.match(result.reply, /best matches/);

  // The person saves the second card instead: that one is "that file".
  assert.equal(await assistant.conversations.choose(conversation, prompt), true);
  result = await ask("send me that file");
  assert.deepEqual(result.cards.map((c) => [c.name, c.autoSave]), [["E2E-PHONE-TEST-PROMPT.md", true]]);
  // Remembered on the Mac.
  assert.equal((await new Conversations({ stateDir }).context(conversation)).files[0].name, "E2E-PHONE-TEST-PROMPT.md");

  // Newer results replace the choice; a file this conversation never listed cannot be chosen.
  result = await ask("find my notes");
  assert.equal(result.cards[0].name, "Palm E2E notes.txt");
  assert.equal((await assistant.conversations.context(conversation)).files[0].name, "Palm E2E notes.txt");
  assert.equal(await assistant.conversations.choose(conversation, path.join(home, "Documents/Proposal - Old.docx")), false);
  assistant.search = async () => null;
});

test("always the model: it sends the conversation's file, shows a folder and talks to its agent", async () => {
  const brain = scriptedBrain([
    [["search_files", { query: "notes" }]],
    [["show_files", { refs: ["f1", "f2"], message: "Here are your notes." }]],
    [["send_to_phone", { paths: ["~/Documents/notes.txt"], message: "Saving your notes to the phone." }]],
    [["show_folder", { folder: "~/Documents", message: "Put them in Documents." }]],
    [["start_agent", { agent: "claude", folder: "~/Documents", instruction: "List the files here" }]],
    [["message_agent", { message: "Now count them.", reply: "I asked it to count them." }]],
  ]);
  const { assistant, broker } = await setup({ brain });
  const ask = (text) => assistant.handle(text, { conversation, turn: turn() });
  let result = await ask("find my notes");
  assert.equal(result.reply, "Here are your notes.");
  assert.ok(result.cards.some((c) => c.name === "notes.txt"));

  result = await ask("send me that file");
  assert.equal(result.reply, "Saving your notes to the phone.");
  assert.deepEqual(result.cards.map((c) => [c.name, c.autoSave]), [["notes.txt", true]]);
  assert.match(brain.seen.at(-1).find((m) => m.role === "system" && m.content.startsWith("The file meant by")).content, /~\/Documents\/notes\.txt/,
    "the model is told which file \"that file\" is");

  result = await ask("where can I put my photos");
  assert.deepEqual(result.cards.map((c) => [c.type, c.path]), [["folder", path.join(home, "Documents")]]);

  result = await ask("get claude to list the files in my documents");
  const taskId = result.cards[0].taskId;
  assert.ok(taskId);
  assert.match(result.reply, /I'll bring the result here/, "briefed and followed, as when asked directly");

  result = await ask("tell it to count them");
  assert.equal(result.reply, "I asked it to count them.");
  // Sent after the running turn, as a queued message.
  let said = [];
  for (let i = 0; i < 100 && !said.includes("Now count them."); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    said = (await broker.log(taskId).readAll()).filter((e) => e.type === "user").map((e) => e.text);
  }
  assert.ok(said.includes("Now count them."), "the message reached its session");
  assert.equal(broker.list().length, 1, "one session throughout");
});

test("find my latest proposal, export it as a PDF and bring it to my phone", async () => {
  const brain = scriptedBrain([
    [["search_files", { query: "proposal" }]],
    [["ask_agent", { instruction: "Export ~/Documents/Proposal - Acme.docx as a PDF next to it", deliver: true }]],
  ]);
  const { assistant, broker, followup } = await setup({ brain });
  const id = turn();
  const offered = await assistant.handle("find my latest proposal, export it as a PDF and bring it to my phone", { conversation, turn: id });
  const card = offered.cards[0];
  assert.equal(card.type, "handoff", "it asks before any agent starts");
  assert.match(offered.reply, /Shall I ask Claude Code/);
  assert.deepEqual(card.agents.map((a) => a.id), ["claude", "codex", "grok"]);
  assert.equal(broker.list().length, 0, "nothing started yet");
  const toolReply = JSON.parse(brain.seen[1].at(-1).content);
  assert.equal(toolReply.results[0].name, "Proposal - Acme.docx", "the latest proposal first");

  const started = await assistant.startHandoff({ conversation, proposal: card.proposalId, provider: "claude", screen: true });
  assert.equal(started.turn, id);
  assert.match(started.followup.reply, /Claude Code is on it in Documents/);
  const task = broker.list()[0];
  assert.equal(task.cwd, path.join(home, "Documents"));
  assert.equal(task.screenControl, true, "the phone's choice: it may use the screen");
  assert.equal(task.access, "full", "full access: no approvals to sit through");
  const done = await followup(id, (f) => f.cards?.some((c) => c.type === "file"));
  const pdf = done.cards.find((c) => c.type === "file");
  assert.equal(pdf.name, "Proposal - Acme.pdf");
  assert.equal(pdf.autoSave, true, "brought to the phone, as asked");
  assert.ok((await stat(pdf.path)).size > 0, "the file really exists");
  assert.equal(done.cards.find((c) => c.type === "task").taskId, task.id, "the same session as in Agents");
  assert.equal(broker.list().length, 1);
  await assert.rejects(assistant.startHandoff({ conversation, proposal: "nope", provider: "claude" }), /expired/);
});

test("nothing found and no model: it asks whether an agent should look", async () => {
  const { assistant, broker, followup } = await setup();
  const id = turn();
  const offered = await assistant.handle("find my tax certificate", { conversation, turn: id });
  assert.equal(offered.cards[0].type, "handoff");
  assert.match(offered.reply, /nothing matching.*Shall I ask Claude Code/s);
  await assert.rejects(assistant.startHandoff({ conversation, proposal: offered.cards[0].proposalId, provider: "cursor" }), /not installed/);
  await assistant.startHandoff({ conversation, proposal: offered.cards[0].proposalId, provider: "codex" });
  const answer = await followup(id, (f) => /found nothing/.test(f.reply));
  assert.match(answer.reply, /found nothing like that/, "the agent's answer, even when it is not a file");
  assert.equal(broker.list()[0].provider, "codex");
});

test("a hand-off asks the agent in an agent's terms, not in the words said to the Assistant", async () => {
  const briefs = [];
  const brain = scriptedBrain([
    [["ask_agent", { instruction: "yeah so can you like turn that proposal thing into a pdf", deliver: true }]],
  ]);
  brain.brief = async (context) => {
    briefs.push(context);
    return "Export ~/Documents/Proposal - Acme.docx to PDF next to it.\nCheck that the PDF opens.";
  };
  const { assistant, broker } = await setup({ brain });
  const id = turn();
  const offered = await assistant.handle("yeah so can you like turn that proposal thing into a pdf", { conversation, turn: id });
  const card = offered.cards.find((c) => c.type === "handoff");
  assert.equal(card.briefed, true);
  assert.match(card.text, /^Export ~\/Documents\/Proposal - Acme\.docx to PDF/, "the card shows what the agent will be asked");
  assert.equal(briefs[0].request, "yeah so can you like turn that proposal thing into a pdf", "the brief starts from what was said");
  await assistant.startHandoff({ conversation, proposal: card.proposalId, provider: "claude" });
  const task = broker.list()[0];
  const sent = (await broker.get(task.id)).events.find((e) => e.type === "user").text;
  assert.match(sent, /^Export ~\/Documents\/Proposal - Acme\.docx to PDF next to it\.\nCheck that the PDF opens\./, "the agent gets the brief");
  assert.doesNotMatch(sent, /yeah so can you like/, "not the words said to the Assistant");
});

test("asked for an agent, it starts that agent at once: no question which", async () => {
  const { assistant, broker } = await setup();
  let result = await assistant.handle("can you spawn a codex sub agent to tidy up my notes", { conversation, turn: turn() });
  assert.equal(result.cards[0].type, "task", "a session, not a question");
  assert.match(result.reply, /^Codex is on it/);
  const codex = broker.list().find((t) => t.provider === "codex");
  assert.ok(codex, "Codex, as asked");
  assert.equal(codex.access, "full", "and it does not stop to ask permission");
  result = await assistant.handle("get Claude to check whether the tests pass", { conversation, turn: turn() });
  assert.match(result.reply, /^Claude Code is on it/);
  result = await assistant.handle("spawn an agent to count the files in Documents", { conversation, turn: turn() });
  assert.match(result.reply, /is on it/, "no agent named: the default one, still no question");
  result = await assistant.handle("start Claude in my home folder", { conversation, turn: turn() });
  assert.match(result.reply, /ready/, "a bare start opens a ready session, as before");
});
