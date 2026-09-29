// Pieces the Assistant and agent chats share: the agent badge, the status
// chip, and result cards (a file, a folder, a preview, an agent session, a
// hand-off to an agent, a choice), each with its actions (PalmAssistantCardView).
import React, { useEffect, useRef, useState } from "react";
import { Asterisk, CircleHelp, CodeXml, File, FileText, Film, Folder, Globe, Image as ImageIcon, MonitorPlay, MonitorOff, Sheet as SheetIcon, Presentation } from "lucide-react";
import { friendly, get, post } from "../core/api.js";
import { bytes, displayPath, relative } from "../core/format.js";
import { navigate } from "../core/navigator.js";
import { KEYS, usePref } from "../core/prefs.js";
import { transfers } from "../core/transfers.js";
import { Icon, cx, useDialog } from "../ui/kit.jsx";
import { SavedFileSheet, downloadFile, useHome } from "./files.jsx";
import { watchStyle } from "./watch.jsx";

export function ProviderBadge({ provider, name = "" }) {
  let content;
  if (provider === "codex") content = <Icon as={CodeXml} size={17} weight={2.6} />;
  else if (provider === "claude") content = <Icon as={Asterisk} size={19} weight={3} style={{ color: "#d97857" }} />;
  else content = <span style={{ fontSize: 15, fontWeight: 700 }}>{String(name || provider || "?").slice(0, 1).toUpperCase()}</span>;
  return (
    <span className="provider-badge" aria-label={name || (provider === "codex" ? "Codex" : "Claude Code")} role="img">
      {content}
    </span>
  );
}

export function statusStyle(status, approvals = 0) {
  if (approvals > 0) return ["Needs you", "var(--orange)"];
  switch (status) {
    case "running":
    case "starting":
      return ["Working", "var(--accent)"];
    case "waiting":
      return ["Needs you", "var(--orange)"];
    case "idle":
      return ["Done", "var(--muted)"];
    case "stopped":
      return ["Stopped", "var(--muted)"];
    case "interrupted":
      return ["Interrupted", "var(--orange)"];
    case "failed":
      return ["Failed", "var(--red)"];
    default:
      return [status ? status[0].toUpperCase() + status.slice(1) : "", "var(--muted)"];
  }
}

export function StatusChip({ status, approvals = 0 }) {
  const [label, color] = statusStyle(status, approvals);
  return (
    <span className="status-chip" style={{ color, background: `color-mix(in srgb, ${color} 15%, transparent)` }}>
      {label}
    </span>
  );
}

const ACCESS_SUMMARY = {
  full: "Full access: it will not ask before running commands or changing files",
  ask: "It asks before changes",
};
const accessSummary = (value) => ACCESS_SUMMARY[value] ?? "It edits the project and asks before commands";

const ext = (name) => (String(name || "").includes(".") ? String(name).split(".").pop().toLowerCase() : "");
function fileIcon(name) {
  const e = ext(name);
  if (["png", "jpg", "jpeg", "gif", "heic", "webp", "tiff", "bmp"].includes(e)) return ImageIcon;
  if (["mp4", "mov", "m4v", "avi"].includes(e)) return Film;
  if (e === "pdf") return FileText;
  if (["xls", "xlsx", "csv", "numbers"].includes(e)) return SheetIcon;
  if (["ppt", "pptx", "key"].includes(e)) return Presentation;
  return File;
}

function CardAction({ children, prominent, onClick, disabled, id }) {
  return (
    <button type="button" className={cx("card-action", prominent && "prominent")} onClick={onClick} disabled={disabled} data-id={id}>
      {children}
    </button>
  );
}

/**
 * One result. `conversation`: the Assistant conversation it belongs to (the
 * Mac hears which file was chosen); `ask` sends a choice's request;
 * `handedOver` / `followedUp` report an agent started from it.
 */
export function AssistantCard({ card, conversation = "", ask = () => {}, handedOver = () => {}, followedUp = () => {} }) {
  const home = useHome();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(null);
  const [server, setServer] = useState(null);
  const [uploaded, setUploaded] = useState(null);
  const [agentScreen] = usePref("palm.agent.screen", true);
  const [agentAccess] = usePref(KEYS.agentAccess, "full");
  const dialog = useDialog();
  const photos = useRef();
  const files = useRef();

  // A preview card follows its dev server until it is up.
  useEffect(() => {
    if (!card.devId) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 90 && !cancelled; i++) {
        try {
          const list = await get("/api/dev");
          const found = (list.servers || []).find((s) => s.id === card.devId) ?? null;
          if (cancelled) return;
          setServer(found);
          if (!found || found.port != null || found.status === "exited") return;
        } catch {}
        await new Promise((r) => setTimeout(r, 1000));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [card.devId]);

  const run = (fn) => async () => {
    setWorking(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setWorking(false);
    }
  };
  const chose = () => card.path && conversation && post("/api/assistant/chosen", { conversation, path: card.path }).catch(() => {});
  async function save(confirm) {
    setSaved(await downloadFile({ path: card.path }, confirm));
    chose();
  }
  async function openPreview() {
    const tab = window.open("about:blank", "_blank");
    try {
      const ticket = await post("/api/dev/preview", { devId: card.devId });
      if (tab) tab.location.href = ticket.url;
      else location.assign(ticket.url);
    } catch (e) {
      tab?.close();
      throw e;
    }
  }
  async function handOff(provider) {
    const started = await post("/api/assistant/handoff", { conversation, proposal: card.proposalId, provider, screen: agentScreen, access: agentAccess });
    followedUp(started.followup);
  }
  async function handOver() {
    const task = await post("/api/tasks", { provider: card.provider, cwd: "~", text: card.text, access: agentAccess, model: "default", screenControl: agentScreen });
    handedOver({
      reply: `${task.providerName ?? "The agent"} is on it.`,
      cards: [{ type: "task", device: card.device, taskId: task.id, title: task.title, provider: task.provider, agentName: task.providerName, cwd: task.cwd, status: task.status, pendingApprovals: task.pendingApprovals }],
    });
  }
  async function upload(list, kind) {
    let count = 0;
    for (const f of list) if (await transfers.upload(f, card.path)) count++;
    setUploaded(`${count} ${kind}${count === 1 ? "" : "s"} sent to ${card.name ?? "the folder"}, checked.`);
  }

  const title =
    card.type === "task" || card.type === "agent"
      ? card.title ?? "Agent session"
      : card.type === "ask"
        ? `Ask ${card.agentName ?? "your agent"}`
        : card.type === "choice"
          ? card.title ?? "Which one?"
          : card.type === "handoff"
            ? "Hand it to an agent"
            : card.name ?? card.title ?? "Result";
  const parts = [];
  switch (card.type) {
    case "file":
      if (card.folder) parts.push(displayPath(card.folder, home));
      if (card.modified) parts.push(relative(card.modified));
      if (card.size != null) parts.push(bytes(card.size));
      break;
    case "task":
      parts.push(card.agentName ?? card.provider ?? "Agent", statusStyle(card.status, card.pendingApprovals ?? 0)[0]);
      if (card.cwd) parts.push(displayPath(card.cwd, home));
      break;
    case "preview":
      parts.push(server?.status === "running" ? (server.port != null ? `Running on port ${server.port}` : "Starting") : server?.status === "exited" ? "Stopped" : "Starting");
      if (card.cwd) parts.push(displayPath(card.cwd, home));
      break;
    case "folder":
      if (card.path) parts.push(displayPath(card.path, home));
      break;
    case "ask":
      parts.push(`“${card.text ?? ""}”`);
      break;
    case "agent":
      parts.push(card.agentName ?? "Agent", watchStyle(card.status ?? "")[0]);
      if (card.text) parts.push(card.text);
      break;
    case "handoff":
      if (card.cwd) parts.push(displayPath(card.cwd, home));
      break;
  }
  if (card.device && card.type !== "choice") parts.push(card.device);
  const detail = card.type === "choice" ? card.device ?? "" : parts.join(" · ");

  let icon;
  if (card.type === "task" || card.type === "ask") icon = <ProviderBadge provider={card.provider ?? "claude"} name={card.agentName ?? ""} />;
  else if (card.type === "agent") icon = <ProviderBadge provider={String(card.agentId ?? "claude").split(":")[0]} name={card.agentName ?? ""} />;
  else if (card.type === "handoff") icon = <ProviderBadge provider={card.agents?.[0]?.id ?? "claude"} name={card.agents?.[0]?.name ?? ""} />;
  else
    icon = (
      <span className="provider-badge">
        <Icon as={card.type === "choice" ? CircleHelp : card.type === "preview" ? Globe : card.type === "folder" ? Folder : fileIcon(card.name)} size={17} weight={2.3} fill={card.type === "folder" ? "currentColor" : "none"} />
      </span>
    );

  return (
    <div className="assistant-card" data-id={`assistant.card.${card.type}`}>
      {card.type !== "choice" && (
        <div className="card-head">
          {icon}
          <div className="card-text">
            <div className="w-semibold clamp-2">{title}</div>
            {detail && <div className="t-caption muted clamp-2">{detail}</div>}
          </div>
        </div>
      )}
      {card.type === "choice" ? (
        <div className="choices">
          {(card.options ?? []).map((option) => (
            <button key={option.request} type="button" className="choice" onClick={() => ask(option.request)} data-id="assistant.choice">
              <span className="t-subheadline w-semibold">{option.label}</span>
              {option.detail && <span className="t-caption muted">{option.detail}</span>}
            </button>
          ))}
        </div>
      ) : (
        <div className="card-actions">
          {card.type === "file" && (
            <>
              <CardAction
                prominent
                disabled={working}
                id="assistant.save"
                onClick={run(async () => {
                  if (card.sensitive) {
                    const ok = await dialog.confirm({ title: "This file may hold credentials. Save it to this phone?", confirmLabel: "Save to iPhone" });
                    if (ok) await save(true);
                  } else await save(false);
                })}
              >
                Save to iPhone
              </CardAction>
              {card.folder && (
                <CardAction
                  disabled={working}
                  id="assistant.showInFiles"
                  onClick={() => {
                    chose();
                    navigate.openFolder(card.folder);
                  }}
                >
                  Show in Files
                </CardAction>
              )}
            </>
          )}
          {card.type === "task" && card.taskId && (
            <CardAction prominent id="assistant.openAgent" onClick={() => navigate.openAgent(card.taskId)}>
              Open agent
            </CardAction>
          )}
          {card.type === "agent" && card.agentId && (
            <CardAction prominent id="assistant.showAgent" onClick={() => navigate.openWatch(card.agentId)}>
              Show
            </CardAction>
          )}
          {card.type === "handoff" &&
            (card.agents ?? []).slice(0, 2).map((agent, index) => (
              <CardAction key={agent.id} prominent={index === 0} disabled={working} id={index === 0 ? "assistant.handoff" : `assistant.handoff.${agent.id}`} onClick={run(() => handOff(agent.id))}>
                Ask {agent.name}
              </CardAction>
            ))}
          {card.type === "preview" && (
            <>
              <CardAction prominent disabled={working || server?.port == null} id="assistant.openPreview" onClick={run(openPreview)}>
                Open
              </CardAction>
              {card.devId && (
                <>
                  <CardAction disabled={working} onClick={run(async () => (await post(`/api/dev/${card.devId}/restart`), setServer(null)))}>
                    Restart
                  </CardAction>
                  <CardAction disabled={working} onClick={run(async () => (await post(`/api/dev/${card.devId}/stop`), setServer(null)))}>
                    Stop
                  </CardAction>
                </>
              )}
            </>
          )}
          {card.type === "folder" && (
            <>
              <input ref={photos} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => (upload([...e.target.files], "photo"), (e.target.value = ""))} />
              <input ref={files} type="file" multiple hidden onChange={(e) => (upload([...e.target.files], "item"), (e.target.value = ""))} />
              <CardAction prominent onClick={() => photos.current.click()} id="assistant.uploadPhotos">
                Photos here
              </CardAction>
              <CardAction onClick={() => files.current.click()}>Files here</CardAction>
              {card.path && <CardAction onClick={() => navigate.openFolder(card.path)}>Open in Files</CardAction>}
            </>
          )}
          {card.type === "ask" && (
            <CardAction prominent disabled={working} id="assistant.ask" onClick={run(handOver)}>
              Ask {card.agentName ?? "agent"}
            </CardAction>
          )}
        </div>
      )}
      {card.type === "handoff" && card.text && (
        <div className="brief" data-id="assistant.handoff.brief">
          <div className="t-caption w-semibold muted">{card.briefed ? `What ${card.agents?.[0]?.name ?? "the agent"} will be asked` : "What the agent will be asked"}</div>
          <div className="t-callout">{card.text}</div>
        </div>
      )}
      {(card.type === "handoff" || card.type === "ask") && (
        <div className="t-caption muted" data-id="assistant.handoff.screen" style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
          <Icon as={agentScreen ? MonitorPlay : MonitorOff} size={14} style={{ flex: "none", marginTop: 1 }} />
          {accessSummary(agentAccess) + (agentScreen ? "; it may use the Mac screen, which you can watch and take over" : "; it will not use the Mac screen")}
        </div>
      )}
      {error && <div className="t-caption warning">{error}</div>}
      {uploaded && <div className="t-caption" style={{ color: "var(--success)" }}>{uploaded}</div>}
      {saved && <SavedFileSheet file={saved} onClose={() => setSaved(null)} />}
    </div>
  );
}
