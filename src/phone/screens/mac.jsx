// More › Mac (PalmMacContent): the connection path and power, dev servers and
// their previews and logs, the clipboard both ways, display and power controls.
import React, { useEffect, useRef, useState } from "react";
import { AlarmClock, ArrowDownToLine, ArrowUpFromLine, Copy, Lock, Monitor, Moon, MoonStar, Play, PlugZap, Power, RotateCw, Sun, SunDim, Radio, Snail, BatteryMedium, ChevronDown, ChevronRight } from "lucide-react";
import { friendly, get, post } from "../core/api.js";
import { connection } from "../core/connection.js";
import { events } from "../core/events.js";
import { displayPath, excerpt, lastPathComponent } from "../core/format.js";
import { useStore } from "../core/store.js";
import { DoneButton, GlassTextButton, Icon, List, Row, SearchField, Section, Sheet, Spinner, Toggle, cx, useDialog, useMenu, useToast } from "../ui/kit.jsx";
import { PushedBar } from "./more.jsx";
import { SavedFileSheet, downloadFile } from "./files.jsx";

const CONFIRM = {
  lock: ["Lock your Mac?", "Palm cannot unlock it again; you'll need the Mac itself or macOS Screen Sharing.", "Lock"],
  sleep: ["Put your Mac to sleep?", "Palm will be unreachable until the Mac wakes.", "Sleep"],
  restart: ["Restart your Mac?", "Palm comes back only after someone logs in on the Mac (FileVault).", "Restart"],
  shutdown: ["Shut down your Mac?", "Palm cannot turn the Mac back on.", "Shut Down"],
};
const SLEEP_CHOICES = [
  [15, "15 minutes"],
  [30, "30 minutes"],
  [60, "1 hour"],
  [120, "2 hours"],
  [180, "3 hours"],
];

/** A slider (SwiftUI Slider): calls onCommit when the finger lifts. */
function Slider({ value, onChange, onCommit, label, id }) {
  return (
    <input
      type="range"
      className="slider"
      min={0}
      max={1}
      step={0.01}
      value={value}
      aria-label={label}
      data-id={id}
      style={{ "--fill": `${value * 100}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={(e) => onCommit(Number(e.currentTarget.value))}
      onKeyUp={(e) => onCommit(Number(e.currentTarget.value))}
    />
  );
}

/** A small capsule button inside a row (SwiftUI .bordered). */
export function Capsule({ children, onClick, disabled, prominent, destructive, id }) {
  return (
    <button type="button" className={cx("capsule-button", prominent && "prominent", destructive && "destructive")} onClick={onClick} disabled={disabled} data-id={id}>
      {children}
    </button>
  );
}

export function MacScreen() {
  const host = useStore(connection.store, (s) => s.hostStatus?.name);
  const [system, setSystem] = useState(null);
  const [dev, setDev] = useState(null);
  const [brightness, setBrightness] = useState(0.5);
  const [keyboardLevel, setKeyboardLevel] = useState(0.5);
  const [clipboard, setClipboard] = useState(null);
  const [starting, setStarting] = useState(false);
  const [logs, setLogs] = useState(null);
  const [othersOpen, setOthersOpen] = useState(false);
  const [capsOpen, setCapsOpen] = useState(false);
  const [savedFile, setSavedFile] = useState(null);
  const editing = useRef({ brightness: false, keyboard: false });
  const toast = useToast();
  const dialog = useDialog();
  const menu = useMenu();
  const fail = (e) => toast(friendly(e), { warning: true });

  async function loadSystem() {
    try {
      const value = await get("/api/system");
      setSystem(value);
      if (!editing.current.brightness && value.display?.brightness != null) setBrightness(value.display.brightness);
      if (!editing.current.keyboard && value.display?.keyboardLight?.level != null) setKeyboardLevel(value.display.keyboardLight.level);
    } catch (e) {
      fail(e);
    }
  }
  async function loadDev() {
    try {
      setDev(await get("/api/dev"));
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => {
    loadSystem();
    loadDev();
    const offDev = events.listen("dev", () => loadDev());
    const offSystem = events.listen("system", () => loadSystem());
    return () => {
      offDev();
      offSystem();
    };
  }, []);

  async function perform(action, options = {}) {
    try {
      const result = await post("/api/system/action", { ...options, action });
      if (result?.detail) toast(result.detail);
      await loadSystem();
    } catch (e) {
      fail(e);
    }
  }
  async function confirmThen(action) {
    const [title, message, label] = CONFIRM[action];
    if (await dialog.confirm({ title, message, confirmLabel: label, destructive: true })) perform(action, { confirm: true });
  }
  async function devAction(id, action) {
    try {
      await post(`/api/dev/${id}/${action}`);
      await loadDev();
    } catch (e) {
      fail(e);
    }
  }
  async function openPreview(devId, port) {
    // A new tab for the preview: its own address on the tailnet, opened with a single-use ticket.
    const tab = window.open("about:blank", "_blank");
    try {
      const ticket = await post("/api/dev/preview", devId ? { devId } : { port });
      if (tab) tab.location.href = ticket.url;
      else location.assign(ticket.url);
    } catch (e) {
      tab?.close();
      fail(e);
    }
  }
  async function fetchMacClipboard() {
    try {
      const value = await get("/api/clipboard");
      setClipboard(value);
      if (value.imagePNG) {
        const blob = await (await fetch(`data:image/png;base64,${value.imagePNG}`)).blob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).catch(() => {});
      } else if (value.text != null) await navigator.clipboard.writeText(value.text).catch(() => {});
      if (!value.kinds?.length) toast("The Mac's clipboard is empty or holds a format Palm does not carry.");
    } catch (e) {
      fail(e);
    }
  }
  async function sendPhoneClipboard() {
    try {
      let sent = false;
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith("image/"));
          if (imageType) {
            const png = await toPNGBase64(await item.getType(imageType));
            await post("/api/clipboard", { imagePNG: png });
            toast("Image placed on the Mac's clipboard.");
            sent = true;
            break;
          }
          if (item.types.includes("text/plain")) {
            const text = await (await item.getType("text/plain")).text();
            await post("/api/clipboard", { text });
            toast(`Text placed on the Mac's clipboard (${text.length} characters).`);
            sent = true;
            break;
          }
        }
      } else {
        const text = await navigator.clipboard.readText();
        await post("/api/clipboard", { text });
        toast(`Text placed on the Mac's clipboard (${text.length} characters).`);
        sent = true;
      }
      if (!sent) toast("Nothing to paste.", { warning: true });
    } catch (e) {
      if (e?.name === "NotAllowedError") toast("Allow Paste to send this phone's clipboard.", { warning: true });
      else fail(e);
    }
  }

  const path = system?.network?.path;
  const power = system?.power;
  const sleepAt = system?.sleepAt ? new Date(system.sleepAt) : null;
  const others = (dev?.ports ?? []).filter((p) => p.devId == null);
  const login = system?.loginItem;
  return (
    <div className="stack-screen">
      <PushedBar title={host || "Mac"} />
      <div className="scroll">
        <List>
          <Section header={host || "This Mac"}>
            {path && (
              <Row
                icon={path.direct ? Radio : Snail}
                title={<span style={{ color: path.direct ? "var(--accent)" : "var(--orange)" }}>{path.direct ? "Direct connection" : "Relayed connection (slow)"}</span>}
                value={path.milliseconds != null ? `${Math.round(path.milliseconds)} ms` : undefined}
              />
            )}
            {path && !path.direct && (
              <>
                <Row title={<span className="t-caption muted">Traffic is going through Tailscale's relay, which makes the screen slow. Repair restarts Tailscale on the Mac; Palm reconnects by itself.</span>} />
                <Row title="Repair network path" accent onClick={() => perform("repairNetwork")} />
              </>
            )}
            {(system?.network?.health ?? []).map((line) => (
              <Row key={line} title={<span className="t-caption warning">{line}</span>} />
            ))}
            {power && (
              <Row
                icon={power.source === "ac" ? PlugZap : BatteryMedium}
                title={power.source === "ac" ? "On power" : "On battery"}
                value={
                  power.batteryPercent != null ? (
                    <span style={{ color: power.batteryPercent < 20 && power.source !== "ac" ? "var(--orange)" : undefined }}>
                      {`${power.batteryPercent}%${power.remaining ? (power.source === "ac" ? ` · full in ${power.remaining}` : ` · ${power.remaining} left`) : ""}`}
                    </span>
                  ) : undefined
                }
              />
            )}
            {!system && <Row title={<Spinner />} />}
          </Section>

          <Section header="Dev servers" footer="Builds run on the Mac. Previews open privately on your phone over Tailscale, at the phone's own screen size, with hot reload.">
            {(dev?.servers ?? []).map((server) => (
              <div className="row dev-server" key={server.id}>
                <div className="dev-head">
                  <span className="dot" style={{ background: server.status === "running" ? (server.port != null ? "var(--accent)" : "#ffd60a") : "var(--muted)" }} />
                  <span className="w-medium">{server.name}</span>
                  {server.port != null && <span className="mono t-caption muted" style={{ marginLeft: "auto" }}>:{server.port}</span>}
                </div>
                <div className="mono t-caption muted">{server.command}</div>
                <div className="dev-actions">
                  {server.status === "running" ? (
                    <>
                      <Capsule prominent disabled={server.port == null} onClick={() => openPreview(server.id, server.port)} id={`dev.preview.${server.id}`}>
                        Open preview
                      </Capsule>
                      <Capsule onClick={() => setLogs(server)}>Logs</Capsule>
                      <Capsule destructive onClick={() => devAction(server.id, "stop")}>
                        Stop
                      </Capsule>
                    </>
                  ) : (
                    <>
                      <span className="t-caption warning">{server.status === "failed" ? `Failed (exit ${server.exitCode ?? -1})` : "Stopped"}</span>
                      <Capsule onClick={() => setLogs(server)}>Logs</Capsule>
                      <Capsule onClick={() => devAction(server.id, "restart")}>Restart</Capsule>
                      <Capsule onClick={() => devAction(server.id, "remove")}>Remove</Capsule>
                    </>
                  )}
                </div>
              </div>
            ))}
            <Row icon={Play} title="Start a dev server" accent onClick={() => setStarting(true)} id="dev.start" />
            {others.length > 0 && (
              <Row
                title={`Already running on this Mac (${others.length})`}
                onClick={() => setOthersOpen((o) => !o)}
                trailing={<Icon as={othersOpen ? ChevronDown : ChevronRight} size={17} style={{ color: "var(--accent)" }} />}
              />
            )}
            {othersOpen &&
              others.map((port) => (
                <Row
                  key={port.port}
                  title={<span className="t-subheadline w-medium">{port.name ?? port.title ?? port.project ?? port.process}</span>}
                  detail={<span className="t-caption">{[port.framework, `:${port.port}`, port.cwd].filter(Boolean).join(" · ")}</span>}
                  trailing={<Capsule onClick={() => openPreview(null, port.port)}>Open</Capsule>}
                />
              ))}
          </Section>

          <Section header="Clipboard" footer="Send puts what this phone copied, text or an image, on the Mac's clipboard. Get copies the Mac's clipboard to this phone.">
            <Row icon={ArrowUpFromLine} title="Send this phone's clipboard" trailing={<Capsule onClick={sendPhoneClipboard} id="clipboard.send">Paste</Capsule>} />
            <Row icon={ArrowDownToLine} title="Get the Mac's clipboard" accent onClick={fetchMacClipboard} id="clipboard.get" />
            {clipboard?.text != null && (clipboard.kinds?.[0] === "text" || !clipboard.imagePNG) && (
              <Row
                title={<span className="mono t-caption muted" style={{ whiteSpace: "pre-wrap" }}>{excerpt(clipboard.text, 300)}</span>}
                detail={<span className="t-caption" style={{ color: "var(--accent)" }}>Copied to this phone.</span>}
              />
            )}
            {clipboard?.imagePNG && (
              <Row
                title={<img src={`data:image/png;base64,${clipboard.imagePNG}`} alt="The Mac's clipboard" style={{ maxHeight: 160, maxWidth: "100%", objectFit: "contain" }} />}
                detail={<span className="t-caption" style={{ color: "var(--accent)" }}>{`Image copied to this phone (${clipboard.imageWidth ?? 0}×${clipboard.imageHeight ?? 0}).`}</span>}
              />
            )}
            {(clipboard?.files ?? []).map((file) => (
              <Row key={file} icon={ArrowDownToLine} title={`Download ${lastPathComponent(file)}`} accent onClick={() => downloadFile({ path: file, name: lastPathComponent(file) }).then(setSavedFile, fail)} />
            ))}
          </Section>

          <Section header="Display">
            {system?.display?.builtIn && (
              <div className="row slider-row" aria-label="Display brightness">
                <Icon as={SunDim} size={18} />
                <Slider
                  value={brightness}
                  label="Display brightness"
                  onChange={(v) => {
                    editing.current.brightness = true;
                    setBrightness(v);
                  }}
                  onCommit={(v) => {
                    editing.current.brightness = false;
                    perform("brightness", { value: v });
                  }}
                />
                <Icon as={Sun} size={20} />
              </div>
            )}
            {system?.display?.keyboardLight && (
              <>
                <div className="row slider-row column">
                  <span className="t-subheadline">Keyboard light</span>
                  <div className="slider-line">
                    <Icon as={SunDim} size={16} />
                    <Slider
                      value={keyboardLevel}
                      label="Keyboard light"
                      id="mac.keyboardLight"
                      onChange={(v) => {
                        editing.current.keyboard = true;
                        setKeyboardLevel(v);
                      }}
                      onCommit={(v) => {
                        editing.current.keyboard = false;
                        perform("keyboardLight", { value: v });
                      }}
                    />
                    <Icon as={Sun} size={18} />
                  </div>
                </div>
                {system.display.keyboardLight.auto != null && (
                  <Row
                    title="Adjust keyboard light in low light"
                    detail={<span className="t-caption">macOS may change the level you set when this is on.</span>}
                    trailing={<Toggle checked={system.display.keyboardLight.auto} onChange={(v) => perform("keyboardLight", { auto: v })} label="Adjust keyboard light in low light" />}
                  />
                )}
              </>
            )}
            <Row
              title="Privacy screen"
              detail={<span className="t-caption">The Mac's own display goes black; you keep seeing and controlling it here.</span>}
              trailing={<Toggle checked={system?.display?.curtain === true} onChange={(v) => perform("curtain", { on: v })} label="Privacy screen" />}
            />
            <Row icon={Monitor} title="Turn the display off now" accent onClick={() => perform("displaySleep")} />
          </Section>

          <Section header="Power">
            <Row
              title="Keep the Mac awake"
              detail={<span className="t-caption">{system?.keepAwake?.reason === "agents" ? "On while an agent is working." : "Stops idle sleep; the display can still turn off."}</span>}
              trailing={<Toggle checked={system?.keepAwake?.on === true} onChange={(v) => perform("keepAwake", { on: v })} label="Keep the Mac awake" />}
            />
            {login && login.status !== "unavailable" && (
              <Row
                title="Open Palm at login"
                detail={
                  <span className="t-caption" style={{ color: login.status === "requiresApproval" ? "var(--orange)" : undefined }}>
                    {login.status === "requiresApproval" ? "Approve Palm in System Settings › General › Login Items on the Mac." : "After a restart, Palm is back as soon as you log in."}
                  </span>
                }
                trailing={<Toggle checked={login.status === "enabled" || login.status === "requiresApproval"} onChange={(v) => perform("loginItem", { on: v })} label="Open Palm at login" id="mac.loginItem" />}
              />
            )}
            <Row icon={Lock} title="Lock" accent onClick={() => confirmThen("lock")} />
            <Row icon={Moon} title="Sleep" accent onClick={() => confirmThen("sleep")} />
            {sleepAt ? (
              <Row
                icon={MoonStar}
                title={`Sleeps at ${sleepAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}
                trailing={<Capsule onClick={() => perform("cancelSleep")} id="mac.cancelSleep">Cancel</Capsule>}
              />
            ) : (
              <Row
                icon={MoonStar}
                title="Sleep later"
                accent
                id="mac.sleepLater"
                onClick={(e) =>
                  menu.open(
                    e.currentTarget,
                    SLEEP_CHOICES.map(([minutes, title]) => ({ label: title, action: () => perform("sleepIn", { minutes, confirm: true }) })),
                    { align: "left" },
                  )
                }
              />
            )}
            <Row icon={RotateCw} title="Restart" accent onClick={() => confirmThen("restart")} />
            <Row icon={Power} title="Shut down" destructive onClick={() => confirmThen("shutdown")} />
            {system?.capabilities && (
              <Row
                title="What each control can and cannot do"
                onClick={() => setCapsOpen((o) => !o)}
                trailing={<Icon as={capsOpen ? ChevronDown : ChevronRight} size={17} style={{ color: "var(--accent)" }} />}
              />
            )}
            {capsOpen &&
              (system?.capabilities ?? []).map((cap) => (
                <Row
                  key={cap.id ?? cap.title}
                  title={<span className="t-footnote w-semibold">{cap.title + (cap.state === "unavailable" ? " — not possible" : "")}</span>}
                  detail={<span className="t-caption">{cap.detail}</span>}
                />
              ))}
          </Section>
        </List>
      </div>
      {starting && (
        <StartDevSheet
          onClose={(started) => {
            setStarting(false);
            if (started) loadDev();
          }}
        />
      )}
      {logs && <DevLogsSheet server={logs} onClose={() => setLogs(null)} />}
      {savedFile && <SavedFileSheet file={savedFile} onClose={() => setSavedFile(null)} />}
    </div>
  );
}

async function toPNGBase64(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0);
  const url = canvas.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
}

function StartDevSheet({ onClose }) {
  const [projects, setProjects] = useState([]);
  const [search, setSearch] = useState("");
  const [custom, setCustom] = useState("");
  const [chosen, setChosen] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    get("/api/projects")
      .then((r) => setProjects(r.projects || []))
      .catch(() => {});
  }, []);
  async function start(project, script, command) {
    try {
      await post("/api/dev", { cwd: project.path, ...(script ? { script } : { command }) });
      onClose(true);
    } catch (e) {
      setError(friendly(e));
    }
  }
  const q = search.trim().toLowerCase();
  const shown = projects.filter((p) => (!q || p.path.toLowerCase().includes(q)) && (p.markers || []).some((m) => ["node", "static", "python"].includes(m)));
  return (
    <Sheet title="Start dev server" onClose={() => onClose(false)} leading={<GlassTextButton onClick={() => onClose(false)}>Cancel</GlassTextButton>}>
      <SearchField value={search} onChange={setSearch} placeholder="Search projects" />
      <List>
        {error && (
          <Section>
            <Row title={<span className="warning">{error}</span>} />
          </Section>
        )}
        {chosen && (
          <Section header={`Run in ${chosen.name}`}>
            {(chosen.scripts || [])
              .filter((s) => ["dev", "start", "preview", "serve", "watch", "build"].includes(s) || s.startsWith("dev"))
              .map((script) => (
                <Row key={script} icon={Play} title={<span className="mono">{`npm run ${script}`}</span>} accent onClick={() => start(chosen, script)} />
              ))}
            <div className="row">
              <input className="row-input mono" placeholder="Other command" value={custom} autoCapitalize="none" autoCorrect="off" onChange={(e) => setCustom(e.target.value)} />
              <Capsule disabled={!custom} onClick={() => start(chosen, null, custom)}>
                Run
              </Capsule>
            </div>
          </Section>
        )}
        <Section header="Projects">
          {shown.map((p) => (
            <Row key={p.path} title={p.name} detail={<span className="t-caption">{displayPath(p.path)}</span>} onClick={() => setChosen(p)} />
          ))}
        </Section>
      </List>
    </Sheet>
  );
}

function DevLogsSheet({ server, onClose }) {
  const [lines, setLines] = useState([]);
  const bottom = useRef();
  useEffect(() => {
    let known = new Set();
    get(`/api/dev/${server.id}/logs`)
      .then((r) => {
        known = new Set((r.lines || []).map((l) => l.n));
        setLines(r.lines || []);
      })
      .catch(() => {});
    return events.listen(`dev:${server.id}`, (message) => {
      const more = (message.lines || []).filter((l) => !known.has(l.n));
      for (const l of more) known.add(l.n);
      if (more.length) setLines((current) => [...current, ...more].slice(-3000));
    });
  }, [server.id]);
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [lines.length]);
  return (
    <Sheet
      title={server.name}
      onClose={onClose}
      leading={
        <GlassTextButton onClick={() => navigator.clipboard.writeText(lines.map((l) => l.text).join("\n")).catch(() => {})} aria-label="Copy the logs">
          <Icon as={Copy} size={18} />
        </GlassTextButton>
      }
      trailing={<DoneButton onClick={onClose} />}
    >
      <div className="log-view">
        {lines.map((l) => (
          <div key={l.n}>{l.text}</div>
        ))}
        <div ref={bottom} />
      </div>
    </Sheet>
  );
}
