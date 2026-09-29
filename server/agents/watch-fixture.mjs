import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

// Sample agent sessions for the test host (PALM_SYNTHETIC=1), written into its
// throwaway home: a Claude desktop session running a command with an agent it
// launched, a finished Claude terminal session and a working Codex desktop
// thread. Never used on a real Mac.

const lines = (...events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

function testHostOnly() {
  if (process.env.PALM_SYNTHETIC !== "1") throw new Error("Sample agent sessions exist only on the test host.");
}

export async function writeWatchFixture(home, now = Date.now()) {
  testHostOnly();
  const at = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
  const site = path.join(home, "work/apps/sample-site");
  const projects = path.join(home, ".claude/projects/-sample-site");
  // Files are overwritten in place; nothing is removed.
  await mkdir(path.join(projects, "cli-ui-1/subagents"), { recursive: true });
  const desktop = path.join(home, "Library/Application Support/Claude/claude-code-sessions/ui/ui");
  await mkdir(desktop, { recursive: true });
  await writeFile(path.join(desktop, "local_ui-1.json"), JSON.stringify({
    sessionId: "local_ui-1", cliSessionId: "cli-ui-1", title: "Refactor the checkout", cwd: site, isArchived: false, lastActivityAt: now - 5000,
  }));
  await writeFile(path.join(projects, "cli-ui-1.jsonl"), lines(
    { type: "user", timestamp: at(40), message: { role: "user", content: "Refactor the checkout and run the tests" } },
    { type: "assistant", timestamp: at(20), message: { role: "assistant", content: [{ type: "tool_use", id: "ui-t1", name: "Bash", input: { command: "npm test" } }] } },
  ));
  await writeFile(path.join(projects, "cli-ui-1/subagents/agent-ui-a.jsonl"), lines(
    { type: "user", isSidechain: true, timestamp: at(30), message: { role: "user", content: "Check the tests" } },
    { type: "assistant", isSidechain: true, timestamp: at(10), message: { role: "assistant", content: [{ type: "tool_use", id: "ui-s1", name: "Grep", input: {} }] } },
  ));
  await writeFile(path.join(projects, "cli-ui-1/subagents/agent-ui-a.meta.json"), JSON.stringify({ agentType: "Explore", description: "Check the tests" }));
  await writeFile(path.join(projects, "cli-ui-2.jsonl"), lines(
    { type: "user", timestamp: at(900), message: { role: "user", content: "Summarise the logs" } },
    { type: "assistant", timestamp: at(800), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "The logs show two timeouts, both at 03:10." }] } },
  ));

  const day = path.join(home, ".codex/sessions/2026/09/23");
  await mkdir(day, { recursive: true });
  const rollout = path.join(day, "rollout-ui.jsonl");
  await writeFile(rollout, lines(
    { timestamp: at(60), type: "event_msg", payload: { type: "task_started" } },
    { timestamp: at(15), type: "response_item", payload: { type: "function_call", name: "shell", call_id: "ui-c1", arguments: JSON.stringify({ command: "npm run build" }) } },
  ));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(home, ".codex/state_5.sqlite"));
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, rollout_path TEXT, updated_at INTEGER, source TEXT, cwd TEXT, title TEXT,
      name TEXT, archived INTEGER, thread_source TEXT, agent_nickname TEXT, agent_role TEXT);
      CREATE TABLE IF NOT EXISTS thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);`);
    db.prepare("INSERT OR REPLACE INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("th-ui", rollout, Math.floor((now - 15000) / 1000), "vscode", site, "Build the pricing page", "", 0, "", null, null);
  } finally {
    db.close();
  }
}

/** The Claude desktop session finishes its turn. */
export async function finishWatchFixture(home, now = Date.now()) {
  testHostOnly();
  const at = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString();
  await appendFile(path.join(home, ".claude/projects/-sample-site/cli-ui-1.jsonl"), lines(
    { type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ui-t1", content: "42 passing" }] } },
    { type: "assistant", timestamp: at(1), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Checkout refactored; 42 tests pass." }] } },
  ));
}
