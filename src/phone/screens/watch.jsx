// Every agent on the Mac, wherever it started (PalmAgentWatch): Palm's own,
// Claude Code, Codex and OpenCode. The list stays current while Palm is open;
// a line at the top says when one finishes, needs you or stops with an error.
import React, { useEffect, useState } from "react";
import { AppWindow, CircleCheck, Hand, SquareArrowOutUpRight, TriangleAlert, X } from "lucide-react";
import { friendly, get, post } from "../core/api.js";
import { events } from "../core/events.js";
import { displayPath, relative } from "../core/format.js";
import { nav, navigate } from "../core/navigator.js";
import { prefs } from "../core/prefs.js";
import { createStore, useStore } from "../core/store.js";
import { DoneButton, Icon, List, Row, Section, Sheet } from "../ui/kit.jsx";
import { useHome } from "./files.jsx";

const MUTED_TITLES = "palm.notify.mutedTitles";
const titleKey = (title) => String(title || "").toLowerCase().split(/\s+/).filter(Boolean).join(" ");
export const isMuted = (title) => (prefs.get(MUTED_TITLES, []) || []).includes(titleKey(title));
export function setMuted(title, muted) {
  const titles = (prefs.get(MUTED_TITLES, []) || []).filter((t) => t !== titleKey(title));
  if (muted) titles.push(titleKey(title));
  prefs.set(MUTED_TITLES, titles.slice(-200));
}

const RANK = { attention: 0, error: 1, working: 2, quiet: 3, finished: 4, idle: 5, unknown: 6 };
export const WATCH_STYLE = {
  attention: ["Needs you", "var(--orange)"],
  error: ["Error", "var(--red)"],
  working: ["Working", "var(--accent)"],
  quiet: ["Quiet", "var(--muted)"],
  finished: ["Finished", "var(--success)"],
  idle: ["Idle", "var(--muted)"],
};
export const watchStyle = (status) => WATCH_STYLE[status] ?? ["Unknown", "var(--muted)"];

export const watch = {
  store: createStore({ sessions: [], loaded: false, banner: null }),
  off: null,
  timer: null,
  /** The session open in front of you needs no alert. */
  isOnScreen: (alert) => alert.palmTaskId && nav.get().tab === "agents" && nav.get().agentTask === alert.palmTaskId,
  get others() {
    return this.store.get().sessions.filter((s) => s.source !== "palm");
  },
  session(id) {
    return this.store.get().sessions.find((s) => s.id === id);
  },
  start() {
    if (this.off) return;
    const offMessages = events.listen("watch", (message) => this.receive(message));
    const offConnected = events.whenConnected(() => this.refresh());
    this.off = () => {
      offMessages();
      offConnected();
    };
    this.refresh();
  },
  stop() {
    this.off?.();
    this.off = null;
  },
  async refresh() {
    try {
      const result = await get("/api/agents/watch");
      this.store.set({ sessions: result.sessions || [], loaded: true });
    } catch {}
  },
  receive(message) {
    if (message.event === "watch.updated") this.store.set({ sessions: message.sessions || [], loaded: true });
    else if (message.event === "watch.changed") {
      const removed = new Set(message.removed || []);
      const list = this.store.get().sessions.filter((s) => !removed.has(s.id));
      for (const session of message.upserts || []) {
        const index = list.findIndex((s) => s.id === session.id);
        if (index >= 0) list[index] = session;
        else list.push(session);
      }
      list.sort((a, b) => (RANK[a.status] ?? 9) - (RANK[b.status] ?? 9) || String(b.updated || "").localeCompare(String(a.updated || "")));
      this.store.set({ sessions: list });
    } else if (message.event === "watch.alerts") this.show(message.alerts || []);
  },
  /** One line at a time: several changes at once become one. */
  show(alerts) {
    const wanted = alerts.filter(
      (a) =>
        !this.isOnScreen(a) &&
        !(a.routine && prefs.get("palm.notify.muteRoutine", true)) &&
        !isMuted(a.title) &&
        (a.kind === "finished" ? prefs.get("palm.notify.finished", true) : prefs.get("palm.notify.attention", true)),
    );
    const last = wanted.at(-1);
    if (!last) return;
    const needsYou = wanted.filter((a) => a.kind !== "finished");
    let alert = last;
    if (wanted.length > 1) {
      const finished = wanted.length - needsYou.length;
      const parts = [finished > 0 ? `${finished} finished` : null, needsYou.length ? `${needsYou.length} need you` : null].filter(Boolean);
      const lead = needsYou.at(-1) ?? last;
      alert = { ...lead, kind: needsYou.length ? "attention" : "finished", text: `${wanted.length} agents: ${parts.join(", ")}` };
    }
    navigator.vibrate?.(alert.kind === "finished" ? 30 : [30, 60, 30]);
    this.store.set({ banner: alert });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.store.set({ banner: null }), 7000);
  },
  dismissBanner() {
    clearTimeout(this.timer);
    this.store.set({ banner: null });
  },
};

/** A floating line when an agent finishes, needs you or stops; tap to open it. */
export function WatchBanner() {
  const alert = useStore(watch.store, (s) => s.banner);
  if (!alert) return null;
  const [icon, color] = alert.kind === "finished" ? [CircleCheck, "var(--success)"] : alert.kind === "error" ? [TriangleAlert, "var(--red)"] : [Hand, "var(--orange)"];
  return (
    <div className="watch-banner glass" data-id="watch.banner" role="status" onClick={() => {
      watch.dismissBanner();
      navigate.openWatch(alert.id, alert.palmTaskId);
    }}>
      <Icon as={icon} size={19} style={{ color }} />
      <span className="text">
        <span className="t-subheadline w-semibold">{alert.text}</span>
        <span className="t-caption muted">{alert.app}</span>
      </span>
      <button
        type="button"
        aria-label="Dismiss"
        className="dismiss"
        onClick={(e) => {
          e.stopPropagation();
          watch.dismissBanner();
        }}
      >
        <Icon as={X} size={14} weight={2.8} />
      </button>
    </div>
  );
}

export function WatchStatus({ status }) {
  const [label, color] = watchStyle(status);
  return (
    <span className="status-chip" style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
      {label}
    </span>
  );
}

const appName = (source) => (source === "codex" ? "Codex" : source === "opencode" ? "OpenCode" : "Claude");

/** One agent Palm did not start: what it was asked, its latest words, and open it on the Mac. */
export function WatchDetailSheet({ id, onClose }) {
  const session = useStore(watch.store, (s) => s.sessions.find((x) => x.id === id));
  const home = useHome();
  const [note, setNote] = useState(null);
  const [opening, setOpening] = useState(false);
  if (!session) return null;
  const app = appName(session.source);
  async function openOnMac(thenWatch) {
    setOpening(true);
    try {
      await post("/api/agents/watch/open", { id: session.id });
      if (thenWatch) {
        onClose();
        navigate.tab("screen");
      } else setNote(`Opened in ${app} on the Mac.`);
    } catch (e) {
      setNote(friendly(e));
    } finally {
      setOpening(false);
    }
  }
  return (
    <Sheet title={app} onClose={onClose} trailing={<DoneButton onClick={onClose} />} id="watch.detail">
      <List>
        <Section>
          <div className="row column" data-id="watch.detail.header">
            <span className="t-title3 w-semibold">{session.title}</span>
            <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <WatchStatus status={session.status} />
              <span className="t-subheadline muted">{session.activity}</span>
            </span>
            <span className="t-caption muted">{[session.app, relative(session.updated)].filter(Boolean).join(" · ")}</span>
            {session.cwd && <span className="t-caption muted">{displayPath(session.cwd, home)}</span>}
          </div>
        </Section>
        {session.latestUser && (
          <Section header="Asked">
            <Row title={<span className="t-subheadline selectable">{session.latestUser}</span>} />
          </Section>
        )}
        {session.latestMessage && (
          <Section header="Latest from the agent">
            <Row title={<span className="t-subheadline selectable" data-id="watch.detail.latest">{session.latestMessage}</span>} />
          </Section>
        )}
        {session.children?.length > 0 && (
          <Section header="Agents it launched">
            {session.children.map((child) => (
              <Row
                key={child.id}
                title={<span className="t-subheadline w-semibold">{child.title}</span>}
                detail={<span className="t-caption">{[child.kind, child.activity, relative(child.updated)].filter(Boolean).join(" · ")}</span>}
                trailing={<WatchStatus status={child.status} />}
              />
            ))}
          </Section>
        )}
        <Section footer={`${session.evidence ?? ""}. Palm shows this agent; it keeps working in ${app} on the Mac, and a finished turn is not proof the whole task is done.`}>
          {session.openable ? (
            <>
              <Row icon={SquareArrowOutUpRight} title={`Open in ${app} on the Mac`} accent disabled={opening} onClick={() => openOnMac(false)} id="watch.open" />
              <Row icon={AppWindow} title="Open it and watch the screen" accent disabled={opening} onClick={() => openOnMac(true)} id="watch.openAndWatch" />
            </>
          ) : (
            <Row
              icon={AppWindow}
              title="Watch the Mac's screen"
              accent
              onClick={() => {
                onClose();
                navigate.tab("screen");
              }}
              id="watch.screen"
            />
          )}
          {note && <Row title={<span className="t-footnote muted">{note}</span>} />}
        </Section>
      </List>
    </Sheet>
  );
}
