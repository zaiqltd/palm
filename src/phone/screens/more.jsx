// The More tab (PalmMoreView) and the screens under it that are not their
// own tabs: Preferences (with the paid agent route), Timings, Pairing and
// settings, Computers.
import React, { useEffect, useState } from "react";
import { Camera, Check, KeyRound, Laptop, MonitorSmartphone, Plus, Settings, SlidersHorizontal, SquareTerminal, Timer, Trash2, CircleDot, Hand, LogOut, RotateCw, CircleCheck } from "lucide-react";
import { access, friendly, get, post } from "../core/api.js";
import { connection } from "../core/connection.js";
import { displayPath } from "../core/format.js";
import { navigate } from "../core/navigator.js";
import { KEYS, usePref } from "../core/prefs.js";
import { useStore } from "../core/store.js";
import { TIMING_KINDS, timings } from "../core/timings.js";
import { Icon, List, NavBar, BackButton, PickerRow, Row, SearchField, Section, Spinner, ToggleRow, useDialog, useToast } from "../ui/kit.jsx";
import { deviceSubtitle } from "./common.jsx";

/** A pushed screen's inline title bar with the back button. */
export function PushedBar({ title, trailing, children }) {
  return (
    <NavBar inline title={title} leading={<BackButton onClick={() => navigate.pop()} />} trailing={trailing}>
      {children}
    </NavBar>
  );
}

export function MoreTab() {
  const s = useStore(connection.store, (s) => ({ hostStatus: s.hostStatus, connectionState: s.connectionState }));
  return (
    <div className="stack-screen">
      <NavBar title="More" subtitle={deviceSubtitle(s)} />
      <div className="scroll">
        <List>
          <Section>
            <Row icon={MonitorSmartphone} title="Computers" value="1" chevron onClick={() => navigate.push("computers")} id="more.computers" />
          </Section>
          <Section>
            <Row icon={SquareTerminal} title="Terminal" chevron onClick={() => navigate.push("terminal")} id="more.terminal" />
            <Row icon={Laptop} title="Mac" chevron onClick={() => navigate.push("mac")} id="more.mac" />
            <Row icon={Camera} title="Camera and mic" chevron onClick={() => navigate.push("media")} id="more.media" />
          </Section>
          <Section>
            <Row icon={SlidersHorizontal} title="Preferences" chevron onClick={() => navigate.push("preferences")} id="more.preferences" />
            <Row icon={Timer} title="Timings" chevron onClick={() => navigate.push("timings")} id="more.timings" />
            <Row icon={Settings} title="Pairing and settings" chevron onClick={() => navigate.push("settings")} id="more.settings" />
          </Section>
        </List>
      </div>
    </div>
  );
}

const ACCESS_CHOICES = [
  ["full", "Full access, no questions"],
  ["workspace", "Edit the project, ask for commands"],
  ["ask", "Ask before changes"],
];

const money = (value) => (value === null || value === undefined ? "unknown" : `$${Number(value).toFixed(2)}`);
export function spending(usage) {
  const limit = usage.limit !== null && usage.limit !== undefined ? `limit ${money(usage.limit)}, ${money(usage.remaining)} left` : "no spending limit set on this key";
  return `This key, all apps: today ${money(usage.today)}, this month ${money(usage.month)}; ${limit}.`;
}

export function PreferencesScreen() {
  const host = useStore(connection.store, (s) => s.hostStatus?.name || "the Mac");
  const [memory, setMemory] = useState(null);
  const [providers, setProviders] = useState([]);
  const [voiceStatus, setVoiceStatus] = useState(null);
  const [error, setError] = useState(null);
  const [savingKey, setSavingKey] = useState(false);
  const [speakReplies, setSpeakReplies] = usePref("palm.voice.speakReplies", true);
  const [notifyFinished, setNotifyFinished] = usePref("palm.notify.finished", true);
  const [notifyAttention, setNotifyAttention] = usePref("palm.notify.attention", true);
  const [muteRoutine, setMuteRoutine] = usePref("palm.notify.muteRoutine", true);
  const [invertScroll, setInvertScroll] = usePref(KEYS.invertScroll, false);
  const [assistantAccess, setAssistantAccess] = usePref(KEYS.agentAccess, "full");
  const dialog = useDialog();

  async function load() {
    try {
      setMemory(await get("/api/memory"));
      get("/api/agents/providers").then((r) => setProviders(r.providers || [])).catch(() => {});
      get("/api/voice", { usage: "1" }).then(setVoiceStatus).catch(() => {});
      setError(null);
    } catch (e) {
      setError(friendly(e));
    }
  }
  useEffect(() => {
    load();
  }, []);
  const run = async (fn) => {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(friendly(e));
    }
  };
  async function addPlace(kind) {
    const answer = await dialog.prompt({
      title: kind === "alias" ? "Name a folder" : "Add a workspace",
      message: `The folder must exist on ${host}. ~ is the home folder.`,
      fields: [
        { placeholder: kind === "alias" ? "normal work folder" : "Website", id: "prefs.name" },
        { placeholder: "~/work", value: "~/", id: "prefs.folder", plain: true },
      ],
      confirmLabel: "Save",
    });
    if (!answer) return;
    run(async () => setMemory(await post(`/api/memory/${kind}`, { name: answer[0], path: answer[1] })));
  }
  async function saveKey(key) {
    setSavingKey(true);
    try {
      setVoiceStatus(await post("/api/voice/key", { key }));
      setVoiceStatus(await get("/api/voice", { usage: "1" }).catch(() => null));
      setError(null);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setSavingKey(false);
    }
  }
  async function enterKey() {
    const key = await dialog.prompt({ title: "OpenRouter key", message: `It is kept on ${host} and sent only to OpenRouter.`, placeholder: "sk-or-…", secure: true, confirmLabel: "Save" });
    if (key) saveKey(key);
  }
  const places = (title, kind, items, footer) => (
    <Section header={title} footer={footer}>
      {items.map((item) => (
        <Row
          key={item.id}
          title={<span className="w-semibold">{item.name}</span>}
          detail={
            <span className="t-caption" style={{ display: "inline-flex", gap: 6 }}>
              {displayPath(item.path)}
              {!item.exists && <span className="warning w-semibold">Missing</span>}
            </span>
          }
          trailing={
            <button type="button" className="row-trailing-button" aria-label={`Remove ${item.name}`} onClick={() => run(async () => setMemory(await post("/api/memory/remove", { kind, id: item.id })))}>
              <Icon as={Trash2} size={18} />
            </button>
          }
        />
      ))}
      <Row icon={Plus} title={kind === "alias" ? "Name a folder" : "Add a workspace"} accent onClick={() => addPlace(kind)} id={`prefs.add.${kind}`} />
    </Section>
  );
  return (
    <div className="stack-screen">
      <PushedBar title="Preferences" />
      <div className="scroll">
        <List>
          <Section footer="The default agent is used when you ask the assistant to start one without naming it. Full access is Claude Code's bypass permissions and Codex's full access: the agent runs commands and changes files without asking. Sessions you start in Agents › New use the access you choose there.">
            <PickerRow
              title="Default agent"
              value={memory?.preferences?.defaultAgent ?? ""}
              options={[{ value: "", label: "First available" }, ...providers.filter((p) => p.available).map((p) => ({ value: p.id, label: p.name }))]}
              onChange={(value) => run(async () => setMemory(await post("/api/memory/preferences", { defaultAgent: value || null })))}
              id="prefs.defaultAgent"
            />
            <PickerRow title="Sessions it starts" value={assistantAccess} options={ACCESS_CHOICES.map(([value, label]) => ({ value, label }))} onChange={setAssistantAccess} id="prefs.assistantAccess" />
          </Section>
          {places("Folder names", "alias", memory?.aliases ?? [], "Your names for folders, such as “normal work folder”. Say them to the assistant.")}
          {places("Workspaces", "workspace", memory?.workspaces ?? [], "A project or a documents folder with a friendly name, such as “Website”.")}
          <Section
            header="Voice"
            footer="Tap the microphone in the Assistant, an agent chat, the Screen or the Terminal. Your Mac sends the recording to OpenRouter: MAI-Transcribe-2 writes it down, GPT-6 Luna tidies it when you tap Polish, and Qwen reads spoken requests' replies aloud. With Use AI on, requests Palm cannot place at once go to GPT-6 Luna, which searches and lists your files, checks agents, starts an agent or opens a preview for you; it sees file names, folders and dates, never contents. Nothing is saved."
          >
            <Row
              icon={KeyRound}
              title="OpenRouter key"
              trailing={
                savingKey ? (
                  <Spinner />
                ) : (
                  <span className="row-value" data-id="prefs.voice.state" style={{ color: voiceStatus?.configured ? "var(--success)" : undefined }}>
                    {voiceStatus?.configured ? `Set ${voiceStatus?.keyHint ?? ""}` : "Not set"}
                  </span>
                )
              }
            />
            {voiceStatus?.usage && <Row title={<span className="t-footnote muted">{spending(voiceStatus.usage)}</span>} />}
            <Row title={voiceStatus?.configured ? "Change key" : "Add key"} accent onClick={enterKey} id="prefs.voice.key" />
            {voiceStatus?.configured && voiceStatus?.keyHint && <Row title="Remove key" destructive onClick={() => saveKey(null)} />}
            <ToggleRow title="Speak replies" checked={speakReplies} onChange={setSpeakReplies} id="prefs.voice.speak" />
            <ToggleRow
              title="Use AI for everything else"
              checked={memory?.preferences?.answerQuestions ?? true}
              onChange={(on) => run(async () => setMemory(await post("/api/memory/preferences", { answerQuestions: on })))}
              id="prefs.voice.answers"
            />
          </Section>
          <Section header="Screen" footer="Reverses the direction a finger (Touch) or two fingers (Mouse) scroll the Mac. Also in the screen's options.">
            <ToggleRow title="Invert scrolling" checked={invertScroll} onChange={setInvertScroll} id="prefs.invertScroll" />
          </Section>
          <ApiRouteSection host={host} />
          <Section
            header="Alerts"
            footer="Repeating and scheduled means Codex runs started by a script or tool, and any session with the same title as another. Every agent on the Mac counts: Palm's, Claude Code's (and the agents it launches), Codex's and OpenCode's. While Palm is open, a line at the top says what changed; anything that changed while it was closed shows when you open it."
          >
            <ToggleRow title="When an agent finishes" checked={notifyFinished} onChange={setNotifyFinished} id="prefs.notify.finished" />
            <ToggleRow title="When an agent needs me or fails" checked={notifyAttention} onChange={setNotifyAttention} id="prefs.notify.attention" />
            <ToggleRow title="Mute repeating and scheduled agents" checked={muteRoutine} onChange={setMuteRoutine} id="prefs.notify.muteRoutine" />
          </Section>
          {error && (
            <Section>
              <Row title={<span className="warning">{error}</span>} />
            </Section>
          )}
        </List>
      </div>
    </div>
  );
}

const dollars = (value) => (value === Math.round(value) ? `$${value.toFixed(0)}` : `$${value.toFixed(2)}`);
const choices = (usual, current) => (usual.includes(current) ? usual : [...usual, current].sort((a, b) => a - b));

/** The optional OpenRouter route for agents (PalmApiRouteSection). */
function ApiRouteSection({ host }) {
  const [route, setRoute] = useState(null);
  const [error, setError] = useState(null);
  async function load() {
    try {
      setRoute(await get("/api/agents/api-route"));
      setError(null);
    } catch (e) {
      setError(friendly(e));
    }
  }
  async function update(patch) {
    try {
      await post("/api/agents/api-route", patch);
      await load();
    } catch (e) {
      setError(friendly(e));
    }
  }
  useEffect(() => {
    load();
    const refresh = () => load();
    addEventListener("palm:route-model", refresh);
    return () => removeEventListener("palm:route-model", refresh);
  }, []);
  return (
    <Section
      header="Paid agent route"
      footer="When on, “OpenCode · OpenRouter” is one of the agents you can start, marked paid per use. It runs only when you choose it; Claude Code and Codex never switch to it. OpenCode works on the Mac with your OpenRouter key, which stays on the Mac and goes only to that agent. Nothing starts once today's limit is reached, and a session is stopped when it passes its own limit."
    >
      <ToggleRow title="Agents through OpenRouter" checked={route?.enabled ?? false} disabled={!route} onChange={(on) => update({ enabled: on })} id="prefs.route.enabled" />
      {route?.enabled && (
        <>
          <Row title="Model" value={route.model} chevron onClick={() => navigate.push("routeModels", { selected: route.model })} id="prefs.route.model" />
          <PickerRow
            title="Daily limit"
            value={route.dailyLimitUsd}
            options={choices([1, 2, 5, 10, 20, 50, 100], route.dailyLimitUsd).map((v) => ({ value: v, label: dollars(v) }))}
            onChange={(v) => update({ dailyLimitUsd: v })}
            id="prefs.route.daily"
          />
          <PickerRow
            title="Each session"
            value={route.taskLimitUsd}
            options={choices([0.5, 1, 2, 5, 10, 20], route.taskLimitUsd).map((v) => ({ value: v, label: dollars(v) }))}
            onChange={(v) => update({ taskLimitUsd: v })}
            id="prefs.route.session"
          />
          {route.usage && <Row title={<span className="t-footnote muted">{spending(route.usage)}</span>} id="prefs.route.usage" />}
          {!route.keySet && <Row title={<span className="t-footnote warning">Add your OpenRouter key under Voice first.</span>} />}
          {!route.installed && <Row title={<span className="t-footnote warning">OpenCode is not installed on {host}. Install it there (npm i -g opencode-ai) to use this route.</span>} />}
        </>
      )}
      {error && <Row title={<span className="t-footnote warning">{error}</span>} />}
    </Section>
  );
}

export function RouteModelsScreen({ selected }) {
  const [models, setModels] = useState([]);
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    get("/api/agents/api-route/models")
      .then((r) => setModels(r.models || []))
      .catch((e) => setError(friendly(e)))
      .finally(() => setLoaded(true));
  }, []);
  const q = query.trim().toLowerCase();
  const shown = q ? models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : models;
  const price = (m) => {
    if (m.inputPerMillion == null || m.outputPerMillion == null) return "price not listed";
    if (m.inputPerMillion === 0 && m.outputPerMillion === 0) return "free";
    return `$${m.inputPerMillion.toFixed(2)} in, $${m.outputPerMillion.toFixed(2)} out`;
  };
  return (
    <div className="stack-screen">
      <PushedBar title="Model">
        <SearchField value={query} onChange={setQuery} placeholder="Search models" />
      </PushedBar>
      <div className="scroll">
        <List>
          <Section footer="Models that can use tools, which an agent needs. Prices are OpenRouter's, per million tokens.">
            {!loaded && <Row title={<Spinner />} />}
            {error && <Row title={<span className="warning">{error}</span>} />}
            {loaded && !models.length && !error && <Row title={<span className="muted">OpenRouter's list of models could not be read. Try again later.</span>} />}
            {shown.map((m) => (
              <Row
                key={m.id}
                title={m.name}
                detail={<span className="t-caption">{`${m.id} · ${price(m)}`}</span>}
                trailing={m.id === selected ? <Icon as={Check} size={18} style={{ color: "var(--accent)" }} aria-label="Selected" /> : null}
                onClick={async () => {
                  try {
                    await post("/api/agents/api-route", { model: m.id });
                  } catch {}
                  dispatchEvent(new Event("palm:route-model"));
                  navigate.pop();
                }}
                id="route.model"
              />
            ))}
          </Section>
        </List>
      </div>
    </div>
  );
}

export function TimingsScreen() {
  const host = useStore(connection.store, (s) => s.hostStatus?.name || "Not connected");
  useStore(timings.store);
  const [path, setPath] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    get("/api/system")
      .then((status) => {
        const p = status.network?.path;
        if (p) setPath(p.direct ? "Direct" : `Relayed through ${p.via}`);
      })
      .catch(() => {});
  }, []);
  const networks = timings.networks();
  return (
    <div className="stack-screen">
      <PushedBar title="Timings" />
      <div className="scroll">
        <List>
          <Section footer="Use Palm normally (the live screen, typing, the Assistant, Files); each action is timed here, on this phone. Direct is fastest; Relayed goes through Tailscale's relay.">
            <Row title="Mac" value={host} />
            <Row title="Connection" value={path ?? "Unknown"} />
            <Row title="This phone" value={timings.network} />
          </Section>
          {TIMING_KINDS.map(([kind, title, explanation]) => {
            const measured = networks.filter((n) => timings.summary(kind, n));
            return (
              <Section key={kind} header={title} footer={explanation}>
                {!measured.length && <Row title={<span className="muted">Not measured yet</span>} />}
                {measured.map((n) => {
                  const s = timings.summary(kind, n);
                  return <Row key={n} title={n} value={<span className="t-subheadline" style={{ fontVariantNumeric: "tabular-nums" }}>{`median ${s.median} ms · 90% ${s.p90} ms · ${s.count}`}</span>} id={`timings.${kind}`} />;
                })}
              </Section>
            );
          })}
          <Section>
            <Row
              title={copied ? "Copied" : "Copy as text"}
              accent
              id="timings.copy"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(timings.report(host, path));
                  setCopied(true);
                } catch {}
              }}
            />
            <Row title="Clear" destructive onClick={() => timings.clear()} />
          </Section>
        </List>
      </div>
    </div>
  );
}

export function SettingsScreen() {
  const s = useStore(connection.store, (s) => ({ hostStatus: s.hostStatus, latency: s.latencyMilliseconds, fps: s.fps, live: s.connectionState === "live" }));
  const a = useStore(access);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState(null);
  const dialog = useDialog();
  const toast = useToast();
  const permission = (granted) => (granted === true ? "Allowed" : granted === false ? "Needs setup" : "Unknown");
  return (
    <div className="stack-screen">
      <PushedBar title="Settings" />
      <div className="scroll">
        <List>
          <Section header="Paired Mac">
            <Row title="Mac" value={s.hostStatus?.name || "Your Mac"} />
            <Row title={<span className="t-subheadline muted">Address</span>} detail={<span className="mono" style={{ color: "#fff", userSelect: "text" }}>{location.origin}</span>} />
            {a.expires > 0 && <Row title="Pairing valid until" value={new Date(a.expires).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} />}
            <Row
              icon={checked ? CircleCheck : RotateCw}
              accent
              disabled={checking}
              title={checking ? "Checking your Mac" : checked ? "Mac is reachable" : "Check connection"}
              trailing={checking ? <Spinner /> : null}
              onClick={async () => {
                setChecking(true);
                setChecked(false);
                setError(null);
                try {
                  await connection.refresh();
                  setChecked(true);
                } catch (e) {
                  setError(friendly(e));
                } finally {
                  setChecking(false);
                }
              }}
            />
            {error && <Row title={<span className="t-footnote warning">{error}</span>} />}
          </Section>
          <Section header="Mac permissions" footer="Change these in System Settings › Privacy & Security on the Mac. Palm never changes them itself.">
            <Row icon={CircleDot} title="Screen recording" value={<span style={{ color: s.hostStatus?.screenPermission === false ? "var(--orange)" : undefined }}>{permission(s.hostStatus?.screenPermission)}</span>} />
            <Row icon={Hand} title="Accessibility (touch and typing)" value={<span style={{ color: s.hostStatus?.controlPermission === false ? "var(--orange)" : undefined }}>{permission(s.hostStatus?.controlPermission)}</span>} />
          </Section>
          <Section header="Connection" footer="This browser's pairing is kept on the Mac, and opens only with Face ID on this phone. You can revoke it from Palm's setup page on the Mac.">
            <Row title="Network" value="Your private Tailscale network" />
            <Row title="Transport" value="HTTPS and secure WebSocket" />
            <Row title="Video" value="H.264" />
            {s.live && s.latency !== null && <Row title="Round trip now" value={`${s.latency} ms`} />}
            {s.live && <Row title="Frames received" value={`${s.fps} per second`} />}
          </Section>
          <Section>
            <Row
              icon={LogOut}
              destructive
              title="Remove this phone's pairing"
              onClick={async () => {
                const ok = await dialog.confirm({
                  title: "Remove this phone's pairing?",
                  message: "This ends the session and removes this browser's access. You'll need a new code from the Mac to connect again.",
                  confirmLabel: "Remove pairing",
                  destructive: true,
                });
                if (!ok) return;
                try {
                  await connection.disconnect();
                } catch (e) {
                  toast(friendly(e), { warning: true });
                }
              }}
            />
          </Section>
          <Section>
            <Row title="Palm on the web" value={__PALM_VERSION__} />
            {s.hostStatus?.version && <Row title="Palm on the Mac" value={s.hostStatus.version} />}
          </Section>
        </List>
      </div>
    </div>
  );
}

/** More › Computers. A browser is paired with the one Mac whose address it opened. */
export function ComputersScreen() {
  const s = useStore(connection.store, (s) => ({ hostStatus: s.hostStatus }));
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    get("/api/tasks")
      .then((r) => {
        const working = (r.tasks || []).filter((t) => ["running", "waiting", "starting"].includes(t.status)).length;
        setSummary(working > 0 ? `${working} session${working === 1 ? "" : "s"} working` : "Nothing running");
      })
      .catch(() => setSummary("Not reachable now"));
  }, []);
  return (
    <div className="stack-screen">
      <PushedBar title="Computers" />
      <div className="scroll">
        <List>
          <Section footer="In a browser, Palm is paired with the Mac whose address you opened. To use another Mac, open Palm's address on that Mac's tailnet name and pair there; each keeps its own sessions, files and screen.">
            <Row
              icon={Laptop}
              title={<span className="w-semibold">{s.hostStatus?.name || "This Mac"}</span>}
              detail={<span className="t-caption">{summary ?? location.host}</span>}
              trailing={<Icon as={Check} size={18} style={{ color: "var(--accent)" }} aria-label="Selected" />}
              id="computers.device"
            />
          </Section>
        </List>
      </div>
    </div>
  );
}
