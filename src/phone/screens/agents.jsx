// The Agents tab (PalmAgentsView, PalmTaskView, PalmNewTaskView): every agent
// session, a strip of recent ones at the top (the last four stay open, so
// switching keeps each chat), the chat with its tools and approvals, and a
// new task. Agents started outside Palm are listed under "Also on this Mac".
import React, { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  BellOff,
  Bell,
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleStop,
  CircleX,
  Copy,
  CreditCard,
  FileText,
  Folder,
  Hand,
  Home,
  Image as ImageIcon,
  Info,
  KeyboardOff,
  MessageSquareText,
  Monitor,
  MonitorPlay,
  Paperclip,
  Pencil,
  Plus,
  SlidersHorizontal,
  SquarePen,
  SquareTerminal,
  Globe,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { friendly, get, post } from "../core/api.js";
import { connection } from "../core/connection.js";
import { events } from "../core/events.js";
import { displayPath, excerpt, relative } from "../core/format.js";
import { nav, navigate } from "../core/navigator.js";
import { KEYS, prefs, usePref } from "../core/prefs.js";
import { createStore, useStore } from "../core/store.js";
import { transfers } from "../core/transfers.js";
import { ContentUnavailable, GlassButton, GlassTextButton, Icon, List, NavBar, PickerRow, Row, SearchField, Section, Sheet, Spinner, ToggleRow, cx, useDialog, useMenu, useToast } from "../ui/kit.jsx";
import { AssistantCard, ProviderBadge, StatusChip } from "./cards.jsx";
import { deviceSubtitle, showDesktop } from "./common.jsx";
import { useHome } from "./files.jsx";
import { MicButton, VoicePill, voice } from "./voice.jsx";
import { WatchDetailSheet, WatchStatus, isMuted, setMuted, watch } from "./watch.jsx";

const isWorking = (t) => ["running", "waiting", "starting"].includes(t?.status);
const providerName = (t) => t?.agentName ?? (t?.provider === "codex" ? "Codex" : "Claude Code");
const projectName = (t, home) => (home && t.cwd === home ? "Home folder" : String(t.cwd || "").split("/").filter(Boolean).pop() || "Home folder");

// ---- The list of sessions ----

export const taskList = {
  store: createStore({ tasks: [], providers: [], projects: [], loaded: false, error: null }),
  started: false,
  start() {
    if (this.started) return;
    this.started = true;
    events.listen("tasks", (message) => {
      const task = message.task;
      if (!task) return;
      let tasks = this.store.get().tasks.filter((t) => t.id !== task.id || !task.archived);
      const index = tasks.findIndex((t) => t.id === task.id);
      if (index >= 0) tasks[index] = task;
      else if (!task.archived) tasks = [task, ...tasks];
      tasks.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
      this.store.set({ tasks });
    });
    events.whenConnected(() => this.refresh());
    this.refresh();
  },
  async refresh() {
    try {
      this.store.set({ tasks: (await get("/api/tasks")).tasks || [], error: null, loaded: true });
    } catch (e) {
      this.store.set({ error: friendly(e), loaded: true });
    }
  },
  async remove(id) {
    const before = this.store.get().tasks;
    this.store.set({ tasks: before.filter((t) => t.id !== id) });
    try {
      await post(`/api/tasks/${id}/archive`, { archived: true });
    } catch (e) {
      this.store.set({ tasks: before, error: friendly(e) });
    }
  },
  async loadChoices(refresh = false) {
    const query = refresh ? { refresh: "1" } : undefined;
    try {
      const [p, q] = await Promise.all([get("/api/agents/providers", query), get("/api/projects", query)]);
      this.store.set({ providers: p.providers || [], projects: q.projects || [] });
    } catch (e) {
      this.store.set({ error: friendly(e) });
    }
  },
};

function dotColor(t) {
  if (t.pendingApprovals > 0 || ["waiting", "failed", "interrupted"].includes(t.status)) return "var(--orange)";
  return isWorking(t) ? "var(--success)" : "var(--muted)";
}

export function AgentsTab() {
  const s = useStore(connection.store, (s) => ({ hostStatus: s.hostStatus, connectionState: s.connectionState }));
  const list = useStore(taskList.store);
  const selectedId = useStore(nav, (n) => n.agentTask);
  const watchId = useStore(nav, (n) => n.watchSession);
  const w = useStore(watch.store);
  const [open, setOpen] = useState([]);
  const [creating, setCreating] = useState(false);
  const [showAllOthers, setShowAllOthers] = useState(false);
  const dialog = useDialog();
  const menu = useMenu();
  const stripRef = useRef();
  const selected = list.tasks.find((t) => t.id === selectedId);
  const stripTasks = [...list.tasks].sort((a, b) => String(a.created).localeCompare(String(b.created))).slice(-16);
  const others = w.sessions.filter((x) => x.source !== "palm");
  const recentOthers = others.filter((x) => ["attention", "error", "working", "quiet"].includes(x.status) || (x.updated && Date.now() - new Date(x.updated) < 12 * 3600e3));
  const shownOthers = showAllOthers ? others : recentOthers;

  useEffect(() => {
    taskList.start();
  }, []);
  useEffect(() => {
    if (!selectedId) return;
    setOpen((list) => [...list.filter((id) => id !== selectedId), selectedId].slice(-4));
    setTimeout(() => stripRef.current?.querySelector(`[data-task="${selectedId}"]`)?.scrollIntoView({ inline: "center", behavior: "smooth", block: "nearest" }), 30);
  }, [selectedId]);
  useEffect(() => {
    const ids = new Set(list.tasks.map((t) => t.id));
    setOpen((o) => o.filter((id) => ids.has(id)));
    if (selectedId && list.loaded && !ids.has(selectedId)) nav.set({ agentTask: null });
  }, [list.tasks, list.loaded]);

  async function rename(task) {
    const title = await dialog.prompt({ title: "Rename session", value: task.title, placeholder: "Name", confirmLabel: "Save", fields: [{ value: task.title, placeholder: "Name", id: "agents.renameField" }] });
    if (!title?.[0]) return;
    try {
      await post(`/api/tasks/${task.id}/rename`, { title: title[0] });
      taskList.refresh();
    } catch (e) {
      taskList.store.set({ error: friendly(e) });
    }
  }
  async function requestRemove(task) {
    if (isWorking(task)) {
      const ok = await dialog.confirm({ title: `Stop ${providerName(task)} and remove this chat?`, message: "It is still working.", confirmLabel: "Stop and remove", destructive: true });
      if (!ok) return;
    }
    taskList.remove(task.id);
  }
  const taskMenu = (e, task) =>
    menu.open(e.currentTarget, [
      { label: "Rename", icon: Pencil, action: () => rename(task) },
      { label: "Remove chat", icon: Trash2, destructive: true, action: () => requestRemove(task) },
    ]);

  return (
    <div className="stack-screen agents-screen">
      <NavBar
        inline
        title={selected ? providerName(selected) : "Agents"}
        subtitle={deviceSubtitle(s)}
        trailing={!selected && <GlassButton icon={SquarePen} label="New agent task" onClick={() => setCreating(true)} id="agents.new" />}
      />
      {list.tasks.length > 0 && (
        <div className="strip">
          <button type="button" className={cx("chip", !selected && "selected")} onClick={() => nav.set({ agentTask: null })} aria-label="All sessions" data-id="agents.strip.all">
            All
          </button>
          <div className="strip-scroll" ref={stripRef}>
            {stripTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                data-task={task.id}
                className={cx("chip", task.id === selectedId && "selected")}
                onClick={() => nav.set({ agentTask: task.id })}
                onContextMenu={(e) => {
                  e.preventDefault();
                  taskMenu(e, task);
                }}
                data-id="agents.strip.chip"
              >
                <span className="dot" style={{ background: dotColor(task) }} />
                <span className="chip-title">{task.title}</span>
              </button>
            ))}
          </div>
          <button type="button" className="chip plus" onClick={() => setCreating(true)} aria-label="New session" data-id="agents.strip.new">
            <Icon as={Plus} size={16} weight={3} />
          </button>
        </div>
      )}
      <div className="agents-body">
        {!selected && (
          <div className="scroll">
            <List>
              {list.error && (
                <div className="notice warning">
                  <Icon as={TriangleAlert} size={17} />
                  <span>{list.error}</span>
                </div>
              )}
              {list.tasks.length > 0 && (
                <Section header={others.length ? "In Palm" : undefined}>
                  {list.tasks.map((task) => (
                    <TaskRow key={task.id} task={task} onOpen={() => nav.set({ agentTask: task.id })} onMenu={(e) => taskMenu(e, task)} />
                  ))}
                </Section>
              )}
              {others.length > 0 && (
                <Section
                  header="Also on this Mac"
                  footer="Claude Code, Codex and OpenCode sessions started outside Palm, including the agents they launch. Palm shows them and can open them on the Mac."
                >
                  {shownOthers.map((session) => (
                    <WatchRow
                      key={session.id}
                      session={session}
                      onOpen={() => nav.set({ watchSession: session.id })}
                      onMenu={(e) => {
                        const muted = isMuted(session.title);
                        menu.open(e.currentTarget, [{ label: muted ? "Alert me about this again" : "No alerts for this", icon: muted ? Bell : BellOff, action: () => setMuted(session.title, !muted) }]);
                      }}
                    />
                  ))}
                  {others.length > shownOthers.length && <Row title={`Show ${others.length - shownOthers.length} earlier`} accent onClick={() => setShowAllOthers(true)} id="agents.watch.more" />}
                </Section>
              )}
              {list.loaded && !list.tasks.length && !others.length && (
                <ContentUnavailable title="No agent sessions yet" description="Start Claude Code, Codex or another agent on your Mac. Sessions keep running after you close Palm.">
                  <GlassTextButton prominent onClick={() => setCreating(true)} id="agents.empty.new">
                    New session
                  </GlassTextButton>
                </ContentUnavailable>
              )}
            </List>
          </div>
        )}
        {open.map((id) => (
          <div key={id} className="task-holder" style={{ display: id === selectedId ? "flex" : "none" }}>
            <TaskView taskId={id} active={id === selectedId} />
          </div>
        ))}
      </div>
      {creating && (
        <NewTaskSheet
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            nav.set({ agentTask: id });
            taskList.refresh();
          }}
        />
      )}
      {watchId && <WatchDetailSheet id={watchId} onClose={() => nav.set({ watchSession: null })} />}
    </div>
  );
}

function TaskRow({ task, onOpen, onMenu }) {
  const home = useHome();
  return (
    <button
      type="button"
      className="row task-row"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
      data-id="agents.task"
    >
      <ProviderBadge provider={task.provider} name={providerName(task)} />
      <span className="task-main">
        <span className="task-top">
          <span className="w-semibold task-title">{task.title}</span>
          <span className="t-caption muted">{relative(task.updated)}</span>
        </span>
        <span className="task-meta">
          <StatusChip status={task.status} approvals={task.pendingApprovals} />
          <span className="t-caption muted">{projectName(task, home)}</span>
        </span>
        {task.preview && <span className="t-subheadline muted">{excerpt(task.preview, 110)}</span>}
      </span>
      <span
        role="button"
        tabIndex={0}
        className="row-trailing-button"
        aria-label={`More for ${task.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onMenu(e);
        }}
      >
        <Icon as={SlidersHorizontal} size={16} />
      </span>
    </button>
  );
}

function WatchRow({ session, onOpen, onMenu }) {
  const parts = [session.app];
  if (session.project) parts.push(session.project);
  const when = relative(session.updated);
  if (when) parts.push(when);
  if (session.childrenWorking > 0) parts.push(`${session.childrenWorking} agent${session.childrenWorking === 1 ? "" : "s"} working`);
  else if (session.children?.length) parts.push(`${session.children.length} agent${session.children.length === 1 ? "" : "s"} launched`);
  return (
    <button
      type="button"
      className="row task-row"
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e);
      }}
      data-id="agents.watch.row"
    >
      <ProviderBadge provider={session.source} name={session.app} />
      <span className="task-main">
        <span className="w-semibold clamp-2">{session.title}</span>
        <span className="task-meta">
          <WatchStatus status={session.status} />
          <span className="t-caption muted clamp-1">{session.activity}</span>
        </span>
        <span className="t-caption2 muted clamp-1">{parts.join(" · ")}</span>
      </span>
    </button>
  );
}

// ---- One session's chat ----

/** The conversation built from the session's events (PalmTaskStore.rebuild). */
function buildRows(eventsBySeq, live) {
  const out = [];
  const toolIndex = new Map();
  const approvalIndex = new Map();
  const finalItems = new Set();
  for (const event of [...eventsBySeq.values()].sort((a, b) => a.seq - b.seq)) {
    switch (event.type) {
      case "user":
        out.push({ id: `u${event.seq}`, kind: "user", text: event.text ?? "", attachments: event.attachments ?? [] });
        break;
      case "assistant":
        if (event.itemId) finalItems.add(event.itemId);
        out.push({ id: `a${event.seq}`, kind: "assistant", text: event.text ?? "" });
        break;
      case "tool": {
        if (!event.itemId) break;
        const index = toolIndex.get(event.itemId);
        if (index !== undefined) {
          const row = out[index];
          if (event.status) row.status = event.status;
          if (event.output) row.output = event.output;
          if (event.title && !row.title) row.title = event.title;
          if (event.detail && !row.detail) row.detail = event.detail;
        } else {
          toolIndex.set(event.itemId, out.length);
          out.push({ id: `t${event.itemId}`, kind: "tool", title: event.title ?? event.name ?? "Tool", detail: event.detail ?? "", status: event.status ?? "running", output: event.output ?? "" });
        }
        break;
      }
      case "approval": {
        if (!event.approvalId) break;
        const index = approvalIndex.get(event.approvalId);
        if (index !== undefined) out[index].status = event.status ?? out[index].status;
        else {
          approvalIndex.set(event.approvalId, out.length);
          out.push({ id: `p${event.approvalId}`, kind: "approval", title: event.title ?? "Allow this?", detail: event.detail ?? "", status: event.status ?? "pending", options: event.options ?? ["allow", "deny"], approvalId: event.approvalId });
        }
        break;
      }
      case "notice":
        out.push({ id: `n${event.seq}`, kind: event.fromAgent ? "agentNote" : "notice", text: event.text ?? "" });
        break;
      case "screen":
        out.push({ id: `s${event.seq}`, kind: "screen", text: event.text ?? "" });
        break;
      case "error":
        out.push({ id: `e${event.seq}`, kind: "error", text: event.text ?? event.error ?? "Error" });
        break;
      case "files":
        if (event.files?.length) out.push({ id: `f${event.seq}`, kind: "files", files: event.files });
        break;
      case "turn": {
        if (!event.status || event.status === "started") break;
        const parts = [event.status === "completed" ? "Finished" : event.status === "interrupted" ? "Stopped" : "Failed"];
        const ms = event.durationMs;
        if (ms > 0) parts.push(ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s` : `${Math.floor(ms / 1000)}s`);
        out.push({ id: `r${event.seq}`, kind: event.status === "completed" || event.status === "interrupted" ? "turn" : "error", text: parts.join(" · ") + (event.error ? `\n${event.error}` : ""), status: event.status });
        break;
      }
    }
  }
  for (const [item, text] of [...live.entries()].sort()) if (!finalItems.has(item) && text) out.push({ id: `l${item}`, kind: "live", text });
  return out;
}

function useTaskStore(taskId) {
  const [task, setTask] = useState(null);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);
  const state = useRef({ events: new Map(), live: new Map(), lastSeq: 0, timer: null });
  useEffect(() => {
    const st = state.current;
    const rebuild = () => {
      clearTimeout(st.timer);
      st.timer = null;
      setRows(buildRows(st.events, st.live));
    };
    async function load() {
      try {
        const detail = await get(`/api/tasks/${taskId}`, { after: String(st.lastSeq) });
        setTask(detail.task);
        for (const event of detail.events || []) {
          st.events.set(event.seq, event);
          st.lastSeq = Math.max(st.lastSeq, event.seq);
        }
        st.live = new Map((detail.live || []).map((l) => [l.itemId, l.text]));
        rebuild();
        setError(null);
      } catch (e) {
        setError(friendly(e));
      }
    }
    const offTask = events.listen(`task:${taskId}`, (message) => {
      if (message.event === "task.delta" && message.itemId && typeof message.text === "string") {
        st.live.set(message.itemId, (st.live.get(message.itemId) || "") + message.text);
        if (!st.timer) st.timer = setTimeout(rebuild, 80);
      } else if (message.event === "task.event" && message.entry) {
        const event = message.entry;
        st.events.set(event.seq, event);
        st.lastSeq = Math.max(st.lastSeq, event.seq);
        if (event.type === "assistant" && event.itemId) st.live.delete(event.itemId);
        if (event.type === "turn" && event.status !== "started") st.live.clear();
        rebuild();
      }
    });
    const offSummary = events.listen("tasks", (message) => message.task?.id === taskId && setTask(message.task));
    const offConnected = events.whenConnected(load);
    load();
    return () => {
      offTask();
      offSummary();
      offConnected();
      clearTimeout(st.timer);
    };
  }, [taskId]);
  return { task, setTask, rows, error };
}

/** Prose with inline Markdown, and fenced code blocks as scrollable code. */
function MarkdownText({ text }) {
  const blocks = [];
  String(text || "")
    .split("```")
    .forEach((part, index) => {
      if (index % 2 === 1) {
        const lines = part.split("\n");
        if (lines.length && !lines[0].includes(" ") && lines[0].length < 20) lines.shift();
        blocks.push({ code: true, text: lines.join("\n").replace(/^\n+|\n+$/g, "") });
      } else if (part.trim()) blocks.push({ code: false, text: part.trim() });
    });
  return (
    <div className="markdown">
      {blocks.map((b, i) => (b.code ? <pre key={i} className="code-block selectable">{b.text}</pre> : <p key={i} className="selectable" dangerouslySetInnerHTML={{ __html: inlineMarkdown(b.text) }} />))}
    </div>
  );
}

function inlineMarkdown(text) {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escape(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function ChatRow({ row, answer }) {
  const [expanded, setExpanded] = useState(false);
  const menu = useMenu();
  switch (row.kind) {
    case "user":
      return (
        <div className="bubble-line">
          <div className="bubble selectable">{row.text}</div>
          {row.attachments.map((a) => (
            <span key={a.path} className="t-caption muted attachment-line">
              <Icon as={a.kind === "image" ? ImageIcon : FileText} size={13} /> {a.name}
            </span>
          ))}
        </div>
      );
    case "assistant":
    case "live":
      return (
        <div
          style={{ opacity: row.kind === "live" ? 0.92 : 1 }}
          onContextMenu={(e) => {
            e.preventDefault();
            menu.open(e.currentTarget, [{ label: "Copy", icon: Copy, action: () => navigator.clipboard.writeText(row.text).catch(() => {}) }], { align: "left" });
          }}
        >
          <MarkdownText text={row.text} />
        </div>
      );
    case "tool":
      return (
        <div className={cx("tool-row", expanded && "expanded")}>
          <button type="button" className="tool-head" onClick={() => setExpanded((e) => !e)}>
            <span className="tool-icon">
              {row.status === "running" ? <Spinner /> : row.status === "failed" || row.status === "declined" ? <Icon as={CircleX} size={16} style={{ color: "var(--orange)" }} /> : <Icon as={CircleCheck} size={16} style={{ color: "var(--accent)" }} />}
            </span>
            <span className="tool-text">
              <span className="t-footnote w-semibold">{row.title}</span>
              {row.detail && <span className="t-caption mono muted">{expanded ? row.detail : excerpt(row.detail, 140)}</span>}
            </span>
            {row.output && <Icon as={expanded ? ChevronUp : ChevronDown} size={14} style={{ color: "var(--muted)", flex: "none" }} />}
          </button>
          {expanded && row.output && <pre className="tool-output selectable">{row.output}</pre>}
        </div>
      );
    case "approval":
      return (
        <div className={cx("approval", row.status === "pending" && "pending")}>
          <div className="t-subheadline w-semibold" style={{ display: "flex", gap: 6, color: row.status === "pending" ? "var(--orange)" : "var(--muted)" }}>
            <Icon as={Hand} size={17} /> {row.title}
          </div>
          {row.detail && <pre className="approval-detail selectable">{row.detail}</pre>}
          {row.status === "pending" ? (
            <div className="approval-buttons">
              <button type="button" className="card-action prominent" onClick={() => answer("allow")} data-id="approval.allow">
                Allow
              </button>
              {row.options.includes("allowSession") && (
                <button type="button" className="card-action" onClick={() => answer("allowSession")}>
                  Always
                </button>
              )}
              <button type="button" className="card-action destructive" onClick={() => answer("deny")} data-id="approval.deny">
                Deny
              </button>
            </div>
          ) : (
            <div className="t-caption muted">{row.status === "allowed" ? "Allowed" : row.status === "denied" ? "Denied" : "No longer waiting"}</div>
          )}
        </div>
      );
    case "notice":
    case "screen":
      return (
        <div className="t-caption muted notice-line">
          <Icon as={row.kind === "screen" ? Hand : Info} size={14} /> {row.text}
        </div>
      );
    case "agentNote":
      return (
        <div className="agent-note t-footnote">
          <Icon as={MessageSquareText} size={15} /> {row.text}
        </div>
      );
    case "turn":
      return (
        <div className="turn-line">
          <span />
          <span className="t-caption2 muted">{row.text}</span>
          <span />
        </div>
      );
    case "error":
      return (
        <div className="t-footnote warning notice-line selectable">
          <Icon as={TriangleAlert} size={15} /> {row.text}
        </div>
      );
    default:
      return null;
  }
}

function TaskView({ taskId, active }) {
  const home = useHome();
  const { task, setTask, rows, error } = useTaskStore(taskId);
  const owner = useStore(connection.store, (s) => s.screenOwner);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [shown, setShown] = useState(200);
  const [focused, setFocused] = useState(false);
  const bottom = useRef();
  const input = useRef();
  const dialog = useDialog();
  const menu = useMenu();
  const v = useStore(voice.store);
  const working = isWorking(task);
  const voiceOwner = `task:${taskId}`;
  useEffect(() => {
    if (active) bottom.current?.scrollIntoView({ block: "end" });
  }, [rows, active]);

  const fail = (e) => setLocalError(friendly(e));
  async function send() {
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try {
      const paths = await uploadAttachments(attachments);
      setTask(await post(`/api/tasks/${taskId}/messages`, { text, attachments: paths }));
      setDraft("");
      setAttachments([]);
      setLocalError(null);
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  }
  async function openShell() {
    try {
      const running = ((await get("/api/terminals")).terminals || []).filter((t) => t.running && t.cwd === task.cwd).sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1))[0];
      const terminal = running ?? (await post("/api/terminals", { cwd: task.cwd, cols: 60, rows: 30 }));
      // More › Terminal shows the shell it last had open.
      prefs.set("palm.terminal.current", terminal.id);
      navigate.tab("more");
      navigate.popToRoot("more");
      navigate.push("terminal");
    } catch (e) {
      fail(e);
    }
  }
  async function openPreview() {
    const tab = window.open("about:blank", "_blank");
    try {
      const reply = await post("/api/assistant/preview", { cwd: task.cwd });
      const devId = reply.cards?.[0]?.devId;
      if (!devId) throw new Error(reply.reply || "No preview for this project.");
      for (let i = 0; i < 90; i++) {
        const server = ((await get("/api/dev")).servers || []).find((s) => s.id === devId);
        if (server?.port != null) {
          const ticket = await post("/api/dev/preview", { devId });
          if (tab) tab.location.href = ticket.url;
          return;
        }
        if (!server || server.status === "exited") throw new Error("The dev server stopped before it opened a port. Its logs are under More › Mac.");
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("The dev server has not opened a port after 90 seconds. Its logs are under More › Mac.");
    } catch (e) {
      tab?.close();
      fail(e);
    }
  }
  const options = (e) =>
    task &&
    menu.open(e.currentTarget, [
      { label: "Agent may use the screen", checked: task.screenControl, action: () => post(`/api/tasks/${taskId}/screen`, { allowed: !task.screenControl }).then(setTask, fail) },
      { label: "Preview", icon: Globe, action: openPreview, id: "task.preview" },
      { label: "Terminal here", icon: SquareTerminal, action: openShell, id: "task.terminal" },
      { label: "Copy project path", icon: Copy, action: () => navigator.clipboard.writeText(task.cwd).catch(() => {}) },
      {
        label: "Remove chat",
        icon: Trash2,
        destructive: true,
        id: "task.remove",
        action: async () => {
          const ok = await dialog.confirm({
            title: working ? "Stop the agent and remove this chat?" : "Remove this chat?",
            message: "It leaves the Agents list. The conversation stays saved on your Mac.",
            confirmLabel: working ? "Stop and remove" : "Remove",
            destructive: true,
          });
          if (ok) taskList.remove(taskId).then(() => nav.set({ agentTask: null }));
        },
      },
    ]);
  const agentOnScreen = owner?.kind === "agent" && owner?.taskId === taskId;

  return (
    <div className="task-view">
      {active && (
        <div className="task-toolbar">
          <GlassButton icon={Monitor} label="Show the Mac screen" onClick={showDesktop} id="task.screen" />
          {working && <GlassButton icon={CircleStop} label="Stop the agent" onClick={() => post(`/api/tasks/${taskId}/stop`).then(setTask, fail)} id="task.stop" className="stop" />}
          <GlassButton icon={SlidersHorizontal} label="Task options" onClick={options} id="task.options" />
        </div>
      )}
      {(error || localError) && <div className="task-error t-caption warning">{error || localError}</div>}
      {agentOnScreen && (
        <button type="button" className="watch-screen" onClick={showDesktop} data-id="task.watchScreen">
          <span className="t-footnote w-semibold">{providerName(task)} is using the Mac screen</span>
          <span className="watch-pill">Watch</span>
        </button>
      )}
      <div className="chat scroll">
        {rows.length > shown && (
          <button type="button" className="plain-link t-footnote w-semibold" onClick={() => setShown((n) => n + 200)}>
            Show earlier messages
          </button>
        )}
        {task && (
          <div className="task-header">
            <div className="t-headline" role="heading" aria-level={2}>
              {task.title}
            </div>
            <div className="task-meta-line">
              <ProviderBadge provider={task.provider} name={providerName(task)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="t-caption w-semibold">{projectName(task, home)}</div>
                <div className="t-caption2 muted">{displayPath(task.cwd, home)}</div>
              </div>
              <StatusChip status={task.status} approvals={task.pendingApprovals} />
            </div>
            {task.provider === "openrouter" && (
              <div className="t-caption warning" data-id="task.paid" style={{ display: "flex", gap: 6 }}>
                <Icon as={CreditCard} size={14} /> Paid per use through OpenRouter{task.costUsd != null ? ` · $${task.costUsd.toFixed(2)} so far` : ""}
              </div>
            )}
          </div>
        )}
        {rows.slice(-shown).map((row) =>
          row.kind === "files" ? (
            <div key={row.id} className="files-row" data-id="task.files">
              {row.files.map((card, i) => (
                <AssistantCard key={i} card={card} />
              ))}
            </div>
          ) : (
            <ChatRow key={row.id} row={row} answer={(decision) => post(`/api/tasks/${taskId}/approvals`, { approvalId: row.approvalId, decision }).catch(fail)} />
          ),
        )}
        {working && !rows.some((r) => r.kind === "live") && (
          <div className="working-line t-footnote muted">
            {task?.pendingApprovals > 0 ? (
              <>
                <Icon as={Hand} size={15} style={{ color: "var(--orange)" }} /> Waiting for your answer
              </>
            ) : (
              <>
                <Spinner /> Working on your Mac
              </>
            )}
          </div>
        )}
        <div ref={bottom} style={{ height: 1 }} />
      </div>
      <div className="composer">
        {(attachments.length > 0 || focused) && <AttachmentBar attachments={attachments} setAttachments={setAttachments} />}
        {v.error && !v.owner && active && (
          <button type="button" className="t-footnote warning voice-error" onClick={() => voice.set({ error: null })}>
            {v.error}
          </button>
        )}
        {voice.isActive(voiceOwner) ? (
          <VoicePill
            onFinish={async (polish) => {
              const heard = await voice.finish(polish);
              if (!heard) return;
              navigator.clipboard.writeText(heard).catch(() => {});
              setDraft((d) => (d.trim() ? `${d.trim()} ${heard}` : heard));
            }}
          />
        ) : (
          <div className="composer-row">
            <textarea
              ref={input}
              className="composer-input glass"
              rows={1}
              placeholder={working ? "Add to the queue" : "Message the agent"}
              value={draft}
              data-id="task.composer"
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
              }}
            />
            {focused && (
              <button type="button" className="icon-button" aria-label="Hide keyboard" data-id="task.hideKeyboard" onPointerDown={(e) => e.preventDefault()} onClick={() => input.current?.blur()}>
                <Icon as={KeyboardOff} size={19} />
              </button>
            )}
            {!draft.trim() && !attachments.length && !sending ? (
              <MicButton owner={voiceOwner} size={36} label="Speak a message" id="task.mic" onError={(message) => voice.set({ error: message })} />
            ) : (
              <button type="button" className="send-button" disabled={sending || !draft.trim()} aria-label="Send" data-id="task.send" onPointerDown={(e) => e.preventDefault()} onClick={send}>
                {sending ? <Spinner color="var(--on-accent)" /> : <Icon as={ArrowUp} size={19} weight={3} />}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Attachments picked on the phone ----

async function uploadAttachments(items) {
  if (!items.length) return [];
  const places = await get("/api/fs/places");
  const paths = [];
  for (const item of items) {
    const result = await transfers.upload(item.file, places.inbox);
    if (!result) throw new Error(`${item.file.name} did not reach the Mac intact. Nothing was sent.`);
    paths.push(result.path);
  }
  return paths;
}

function AttachmentBar({ attachments, setAttachments }) {
  const photos = useRef();
  const files = useRef();
  const add = (list) => setAttachments((a) => [...a, ...list.map((file) => ({ id: crypto.randomUUID(), file }))]);
  return (
    <div className="attachment-bar">
      {attachments.length > 0 && (
        <div className="attachment-chips">
          {attachments.map((a) => (
            <span key={a.id} className="attachment-chip t-caption">
              <Icon as={a.file.type.startsWith("image/") ? ImageIcon : FileText} size={13} />
              {a.file.name}
              <button type="button" aria-label={`Remove ${a.file.name}`} onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}>
                <Icon as={X} size={12} weight={3} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="attachment-buttons t-subheadline">
        <input ref={photos} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => (add([...e.target.files]), (e.target.value = ""))} />
        <input ref={files} type="file" multiple hidden onChange={(e) => (add([...e.target.files]), (e.target.value = ""))} />
        <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => photos.current.click()} data-id="attach.photos">
          <Icon as={ImageIcon} size={16} /> Photos
        </button>
        <button type="button" onPointerDown={(e) => e.preventDefault()} onClick={() => files.current.click()}>
          <Icon as={Paperclip} size={16} /> Files
        </button>
      </div>
    </div>
  );
}

// ---- New task ----

const ACCESS_LABELS = { ask: "Ask before changes", workspace: "Edit this project", full: "Full access", plan: "Plan only" };

function NewTaskSheet({ onClose, onCreated }) {
  const list = useStore(taskList.store);
  const home = useHome();
  const [provider, setProvider] = usePref("palm.agent.provider", "claude");
  const [projectPath, setProjectPath] = usePref("palm.agent.folder", "");
  const [access, setAccess] = usePref("palm.agent.access", "workspace");
  const [screenControl, setScreenControl] = usePref("palm.agent.screen", true);
  const [model, setModel] = useState("default");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [choosingProject, setChoosingProject] = useState(false);
  const selected = list.providers.find((p) => p.id === provider);
  const modes = selected?.modes ?? ["ask", "workspace", "full", "plan"];
  useEffect(() => {
    taskList.loadChoices().then(() => {
      const { providers } = taskList.store.get();
      if (!providers.some((p) => p.id === provider && p.available)) {
        const first = providers.find((p) => p.available);
        if (first) setProvider(first.id);
      }
    });
  }, []);
  useEffect(() => {
    setModel("default");
    if (!modes.includes(access)) setAccess("workspace");
  }, [provider]);
  const providerLine = (p) => {
    if (!p.available) return p.detail ?? "Not installed on the Mac.";
    if (p.billing === "api") return `${p.detail ?? "Paid per use through OpenRouter"} · within your limits`;
    const parts = [p.version ? `Version ${p.version}` : null];
    if (p.signedIn !== undefined && p.signedIn !== null) parts.push(p.signedIn ? `Signed in${p.plan ? ` · ${p.plan}` : ""}` : "Not signed in on the Mac");
    if (p.acp) parts.push("Uses its own sign-in on the Mac");
    return parts.filter(Boolean).join(" · ");
  };
  const accessLabel = (mode) => (mode === "auto" ? `Auto (${selected?.name ?? "the agent"} decides)` : ACCESS_LABELS[mode] ?? mode[0].toUpperCase() + mode.slice(1));
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const paths = await uploadAttachments(attachments);
      const task = await post("/api/tasks", { provider, cwd: projectPath || "~", text, access, model, screenControl, attachments: paths });
      onCreated(task.id);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  const providerOptions = list.providers.length
    ? list.providers.map((p) => ({ value: p.id, label: p.available ? p.name : `${p.name} (not installed)` }))
    : [
        { value: "claude", label: "Claude Code" },
        { value: "codex", label: "Codex" },
      ];
  return (
    <Sheet
      title="New task"
      onClose={onClose}
      leading={<GlassTextButton onClick={onClose}>Cancel</GlassTextButton>}
      trailing={
        <GlassTextButton prominent disabled={busy || !text.trim()} onClick={start} id="newtask.start">
          {busy ? "Starting" : "Start"}
        </GlassTextButton>
      }
      id="newtask.sheet"
    >
      <List>
        <Section header="Agent" footer="Other coding agents, such as Gemini CLI, GitHub Copilot, Cursor and OpenCode, appear here once they are installed on your Mac. Each uses its own sign-in.">
          <PickerRow title="Agent" value={provider} options={providerOptions} onChange={setProvider} id="newtask.provider" />
          {selected && <Row title={<span className="t-caption muted">{providerLine(selected)}</span>} />}
          <Row icon={Folder} title="Folder" value={projectPath ? displayPath(projectPath, home) : "Home folder"} onClick={() => setChoosingProject(true)} id="newtask.project" />
          <PickerRow title="Access" value={access} options={modes.map((m) => ({ value: m, label: accessLabel(m) }))} onChange={setAccess} />
          {selected?.models?.length > 1 && (
            <PickerRow
              title="Model"
              value={model}
              options={selected.models.map((m) => ({ value: m, label: m === "default" ? `Default${selected.defaultModel ? ` (${selected.defaultModel})` : ""}` : selected.modelNames?.[m] ?? m }))}
              onChange={setModel}
            />
          )}
          <ToggleRow title="Let it use the Mac screen" checked={screenControl} onChange={setScreenControl} />
        </Section>
        <Section header="Task" footer="The agent runs on your Mac with the access above and keeps working if you leave Palm.">
          <div className="row">
            <textarea className="row-textarea" rows={4} placeholder="What should it do?" value={text} autoFocus onChange={(e) => setText(e.target.value)} data-id="newtask.message" />
          </div>
          {voice.isActive("newtask") ? (
            <div className="row">
              <VoicePill
                onFinish={async (polish) => {
                  const heard = await voice.finish(polish);
                  if (!heard) return;
                  navigator.clipboard.writeText(heard).catch(() => {});
                  setText((t) => (t.trim() ? `${t.trim()} ${heard}` : heard));
                }}
              />
            </div>
          ) : (
            <Row title={<span className="t-footnote muted">Or say it</span>} trailing={<MicButton owner="newtask" size={34} label="Speak the task" id="newtask.mic" onError={setError} />} />
          )}
          <div className="row">
            <AttachmentBar attachments={attachments} setAttachments={setAttachments} />
          </div>
        </Section>
        {error && (
          <Section>
            <Row title={<span className="warning">{error}</span>} />
          </Section>
        )}
      </List>
      {choosingProject && <ProjectPicker projects={list.projects} selection={projectPath} onChoose={(path) => setProjectPath(path)} onClose={() => setChoosingProject(false)} />}
    </Sheet>
  );
}

function ProjectPicker({ projects, selection, onChoose, onClose }) {
  const home = useHome();
  const [search, setSearch] = useState("");
  const [custom, setCustom] = useState(selection ? displayPath(selection, home) : "~");
  const choose = (path) => {
    onChoose(path);
    onClose();
  };
  const q = search.trim().toLowerCase();
  return (
    <Sheet title="Project" onClose={onClose} leading={<GlassTextButton onClick={onClose}>Done</GlassTextButton>}>
      <SearchField value={search} onChange={setSearch} placeholder="Search projects" />
      <List>
        <Section>
          <Row icon={selection ? Home : Check} title="Home folder" accent onClick={() => choose("")} id="project.home" />
        </Section>
        <Section header="Folder path" footer="~ is your home folder on the Mac.">
          <div className="row">
            <input className="row-input mono" value={custom} placeholder="~/work/my-project" autoCapitalize="none" autoCorrect="off" onChange={(e) => setCustom(e.target.value)} />
            <button type="button" className="capsule-button" disabled={!(custom.startsWith("/") || custom.startsWith("~"))} onClick={() => choose(custom === "~" ? "" : custom)}>
              Use
            </button>
          </div>
        </Section>
        <Section header="Projects on your Mac">
          {projects
            .filter((p) => !q || p.path.toLowerCase().includes(q))
            .map((p) => (
              <Row
                key={p.path}
                title={
                  <span className="w-medium" style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    {p.name}
                    {p.path === selection && <Icon as={Check} size={15} style={{ color: "var(--accent)" }} />}
                  </span>
                }
                detail={<span className="t-caption">{displayPath(p.path, home)}</span>}
                onClick={() => choose(p.path)}
              />
            ))}
        </Section>
      </List>
    </Sheet>
  );
}
