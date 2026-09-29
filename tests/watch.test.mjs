import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentWatch, alertsBetween } from "../server/agents/watch.mjs";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();
const lines = (...events) => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

const user = (text, ago) => ({ type: "user", timestamp: at(ago), message: { role: "user", content: text } });
const toolUse = (id, name, ago, input = {}) => ({ type: "assistant", timestamp: at(ago), message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const reply = (text, ago) => ({ type: "assistant", timestamp: at(ago), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } });

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "palm-watch-"));
  const projects = path.join(home, ".claude/projects/-work-site");
  await mkdir(projects, { recursive: true });
  const desktop = path.join(home, "Library/Application Support/Claude/claude-code-sessions/g1/g2");
  await mkdir(desktop, { recursive: true });
  const meta = (id, cli, title, extra = {}) =>
    writeFile(path.join(desktop, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: cli, title, cwd: "/work/site", isArchived: false, lastActivityAt: NOW - 60_000, ...extra }));

  // A: working, a command running, with a subagent it launched.
  await meta("a", "cli-a", "Fix the login");
  await writeFile(path.join(projects, "cli-a.jsonl"), lines(user("fix the login", 40), toolUse("t1", "Bash", 30, { command: "npm test" })));
  await mkdir(path.join(projects, "cli-a/subagents"), { recursive: true });
  await writeFile(path.join(projects, "cli-a/subagents/agent-x1.jsonl"), lines(
    { ...user("check the tests", 20), isSidechain: true },
    { ...toolUse("s1", "Grep", 10), isSidechain: true },
  ));
  await writeFile(path.join(projects, "cli-a/subagents/agent-x1.meta.json"), JSON.stringify({ agentType: "Explore", description: "Check the tests" }));
  // B: finished its turn; then a hook says it asks for permission.
  await meta("b", "cli-b", "Write the brief");
  await writeFile(path.join(projects, "cli-b.jsonl"), lines(user("write it", 300), reply("Done. The brief is in docs.", 200)));
  const hooks = path.join(home, "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(path.join(hooks, "cli-b.json"), JSON.stringify({ event: "PermissionRequest", timestamp: at(5) }));
  // C: a terminal session asking a question.
  await writeFile(path.join(projects, "cli-c.jsonl"), lines(user("plan the move", 100), toolUse("q1", "AskUserQuestion", 90)));
  // D: archived; E: Palm's own session.
  await meta("d", "cli-d", "Old archived", { isArchived: true });
  await writeFile(path.join(projects, "cli-d.jsonl"), lines(reply("x", 50)));
  await meta("e", "cli-palm", "Palm's own");
  await writeFile(path.join(projects, "cli-palm.jsonl"), lines(toolUse("p1", "Bash", 10)));
  // Q: working but silent for five minutes.
  await writeFile(path.join(projects, "cli-q.jsonl"), lines(user("long job", 400), { type: "assistant", timestamp: at(300), message: { role: "assistant", content: [{ type: "text", text: "Starting." }] } }));

  // Codex, primary account.
  const codex = path.join(home, ".codex");
  const day = path.join(codex, "sessions/2026/09/23");
  await mkdir(day, { recursive: true });
  const rollout = (name, ...events) => writeFile(path.join(day, name), lines(...events));
  const ev = (type, ago, payload) => ({ timestamp: at(ago), type, payload });
  await rollout("rollout-1.jsonl",
    ev("event_msg", 60, { type: "task_started" }),
    ev("response_item", 50, { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: "npm run build" }) }));
  await rollout("rollout-2.jsonl",
    ev("event_msg", 600, { type: "task_started" }),
    ev("event_msg", 500, { type: "item_completed", item: { type: "AgentMessage", content: [{ type: "text", text: "All checks pass." }], phase: "final_answer" } }),
    ev("event_msg", 499, { type: "task_complete", last_agent_message: "All checks pass." }));
  await rollout("rollout-child.jsonl", ev("event_msg", 20, { type: "task_started" }));
  // A row that points outside this account's own session files.
  await mkdir(path.join(home, ".other-codex/sessions"), { recursive: true });
  await writeFile(path.join(home, ".other-codex/sessions/other.jsonl"), lines(ev("event_msg", 10, { type: "task_started" })));
  const db = new DatabaseSync(path.join(codex, "state_5.sqlite"));
  db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, updated_at INTEGER, source TEXT, cwd TEXT, title TEXT, name TEXT,
    archived INTEGER, thread_source TEXT, agent_nickname TEXT, agent_role TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);`);
  const insert = db.prepare("INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  const secs = (ago) => Math.floor((NOW - ago * 1000) / 1000);
  insert.run("th-1", path.join(day, "rollout-1.jsonl"), secs(50), "vscode", "/work/site", "Build the site", "", 0, "", null, null);
  insert.run("th-2", path.join(day, "rollout-2.jsonl"), secs(499), "cli", "/work/app", "Run the checks", "", 0, "", null, null);
  insert.run("th-child", path.join(day, "rollout-child.jsonl"), secs(20), '{"subagent":{}}', "/work/site", "", "", 0, "subagent", "Beauvoir", "default");
  insert.run("th-other", path.join(home, ".other-codex/sessions/other.jsonl"), secs(10), "vscode", "/x", "Another account", "", 0, "", null, null);
  insert.run("th-palm", path.join(day, "rollout-1.jsonl"), secs(50), "exec", "/work/site", "Palm's Codex task", "", 0, "", null, null);
  db.prepare("INSERT INTO thread_spawn_edges VALUES (?, ?)").run("th-1", "th-child");
  db.close();

  const palmTasks = [{ id: "task-1", title: "Palm task", cwd: "/work/site", status: "running", pendingApprovals: 0, updated: at(5), agentName: "Claude Code" }];
  const watch = new AgentWatch({
    home, now: () => NOW, hookFolders: [hooks],
    palm: () => ({ tasks: palmTasks, sessionIds: new Set(["cli-palm", "th-palm"]) }),
  });
  return { home, projects, day, watch, palmTasks };
}

test("every agent on the Mac, with its status, wherever it started", async () => {
  const { watch } = await fixture();
  const { sessions, issues } = await watch.scan();
  assert.deepEqual(issues, []);
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));

  assert.equal(byId["claude:local_a"].status, "working");
  assert.equal(byId["claude:local_a"].activity, "Running checks");
  assert.equal(byId["claude:local_a"].app, "Claude desktop");
  assert.equal(byId["claude:local_a"].link, "claude://code/continue?session=local_a");
  assert.deepEqual(byId["claude:local_a"].children.map((c) => [c.title, c.status]), [["Check the tests", "working"]], "the agent it launched");
  assert.equal(byId["claude:local_a"].childrenWorking, 1);

  assert.equal(byId["claude:local_b"].status, "attention", "the permission hook is newer than the finished turn");
  assert.equal(byId["claude:cli-c"].status, "attention", "a question waits for the user");
  assert.equal(byId["claude:cli-c"].app, "Claude Code in a terminal");
  assert.equal(byId["claude:cli-q"].status, "quiet", "five silent minutes are quiet, not working");

  assert.equal(byId["codex:th-1"].status, "working");
  assert.equal(byId["codex:th-1"].activity, "Building and checking the project");
  assert.equal(byId["codex:th-1"].app, "Codex desktop");
  assert.deepEqual(byId["codex:th-1"].children.map((c) => [c.title, c.status]), [["Beauvoir", "working"]]);
  assert.equal(byId["codex:th-2"].status, "finished");
  assert.equal(byId["codex:th-2"].latestMessage, "All checks pass.");
  assert.equal(byId["codex:th-2"].app, "Codex in a terminal");

  assert.equal(byId["palm:task-1"].status, "working");
  assert.equal(byId["palm:task-1"].palmTaskId, "task-1");

  for (const hidden of ["claude:local_d", "claude:local_e", "claude:cli-palm", "codex:th-palm", "codex:th-other", "codex:th-child"])
    assert.equal(byId[hidden], undefined, `${hidden} is not listed`);
  // Needs you first.
  assert.deepEqual(sessions.slice(0, 2).map((s) => s.status), ["attention", "attention"]);
});

test("a session's new lines are read, and a finish or a question becomes an alert", async () => {
  const { watch, projects, day, palmTasks } = await fixture();
  const first = await watch.scan();
  assert.deepEqual(alertsBetween(null, first), [], "nothing on the first look");
  await appendFile(path.join(projects, "cli-a.jsonl"), lines({ type: "user", timestamp: at(8), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }, reply("Login fixed and tested.", 5)));
  await appendFile(path.join(day, "rollout-1.jsonl"), lines({ timestamp: at(3), type: "event_msg", payload: { type: "error", message: "stream failed" } }));
  palmTasks[0].status = "waiting";
  const second = await watch.scan();
  const alerts = alertsBetween(first, second);
  const byId = Object.fromEntries(alerts.map((a) => [a.id, a]));
  assert.equal(byId["claude:local_a"].kind, "finished");
  assert.equal(byId["claude:local_a"].text, "Fix the login finished");
  assert.equal(byId["codex:th-1"].kind, "error");
  assert.equal(byId["palm:task-1"].kind, "attention");
  assert.equal(byId["palm:task-1"].palmTaskId, "task-1");
  const a = second.sessions.find((s) => s.id === "claude:local_a");
  assert.equal(a.latestMessage, "Login fixed and tested.");
  assert.deepEqual(alertsBetween(second, await watch.scan()), [], "no repeat alerts");
});

test("scheduled and repeating agents are marked, so the phone can keep them quiet", () => {
  const session = (id, title, status, app = "Claude desktop") => ({ id, title, status, app, source: "claude" });
  const before = { sessions: [session("a", "Daily report", "working"), session("b", "Daily  report", "finished"), session("c", "Fix the login", "working"), session("d", "nightly sync", "working", "Codex run by a tool")] };
  const after = { sessions: [session("a", "Daily report", "finished"), session("b", "Daily  report", "finished"), session("c", "Fix the login", "finished"), session("d", "nightly sync", "finished", "Codex run by a tool")] };
  const byId = Object.fromEntries(alertsBetween(before, after).map((a) => [a.id, a]));
  assert.equal(byId.a.routine, true, "the same title as another session: a repeat");
  assert.equal(byId.c.routine, false, "a one-off");
  assert.equal(byId.d.routine, true, "started by a script or tool");
});
