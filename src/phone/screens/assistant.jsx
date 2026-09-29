// The Assistant tab (PalmAssistantView): say what you need, get something you
// can use. Common requests are answered on the Mac without AI; anything else
// goes, on one tap, to your own agent as a session in Agents. The last 30
// exchanges are kept in this browser; results that come back later arrive here.
import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, CircleAlert, Trash2, Volume2, VolumeX } from "lucide-react";
import { friendly, get, post } from "../core/api.js";
import { connection } from "../core/connection.js";
import { events } from "../core/events.js";
import { KEYS, prefs, usePref } from "../core/prefs.js";
import { createStore, useStore } from "../core/store.js";
import { timings } from "../core/timings.js";
import { transfers } from "../core/transfers.js";
import { GlassButton, Icon, NavBar, Spinner } from "../ui/kit.jsx";
import { AssistantCard } from "./cards.jsx";
import { deviceSubtitle } from "./common.jsx";
import { SavedFileSheet } from "./files.jsx";
import { MicButton, SpeakingBar, VoicePill, voice } from "./voice.jsx";

const HISTORY = "palm.assistant.history";
const CONVERSATION = "palm.assistant.conversation";
const AUTOSAVED = "palm.assistant.autosaved";

export const assistant = {
  store: createStore({ exchanges: prefs.get(HISTORY, []) || [], autoSaved: null }),
  started: false,
  get conversation() {
    let id = prefs.get(CONVERSATION, null);
    if (!id) {
      id = crypto.randomUUID();
      prefs.set(CONVERSATION, id);
    }
    return id;
  },
  save(exchanges) {
    this.store.set({ exchanges });
    prefs.set(HISTORY, exchanges.slice(-30));
  },
  append(exchange) {
    this.save([...this.store.get().exchanges, exchange]);
  },
  clear() {
    this.save([]);
    prefs.set(CONVERSATION, crypto.randomUUID());
  },
  answer(id, result) {
    this.save(this.store.get().exchanges.map((e) => (e.id === id ? { ...e, ...result } : e)));
  },
  receive(followup, turn) {
    const list = this.store.get().exchanges;
    const exchange = list.find((e) => e.id === turn);
    if (!exchange || (exchange.followups || []).some((f) => f.id === followup.id)) return;
    this.save(list.map((e) => (e.id === turn ? { ...e, followups: [...(e.followups || []), followup] } : e)));
    this.deliver(followup.cards || []);
    if (exchange.spoken && prefs.get("palm.voice.speakReplies", true)) voice.speak(followup.reply);
  },
  /** Files asked for on the phone are saved as they arrive, each once. */
  deliver(cards) {
    const done = new Set(prefs.get(AUTOSAVED, []) || []);
    for (const card of cards) {
      if (card.type !== "file" || !card.autoSave || !card.path) continue;
      const mark = `${card.path}|${card.modified ?? ""}`;
      if (done.has(mark)) continue;
      done.add(mark);
      transfers.download(card.path).then((result) => result && this.store.set({ autoSaved: result }));
    }
    prefs.set(AUTOSAVED, [...done].slice(-200));
  },
  async sync() {
    try {
      const result = await get("/api/assistant/conversation", { id: this.conversation });
      for (const turn of result.turns || []) for (const f of turn.followups || []) this.receive(f, turn.id);
    } catch {}
  },
  start() {
    if (this.started) return;
    this.started = true;
    events.listen("assistant", (message) => {
      if (message.event === "assistant.followup" && message.conversation === this.conversation && message.turn && message.followup) this.receive(message.followup, message.turn);
    });
    events.whenConnected(() => this.sync());
    this.sync();
  },
};

const SUGGESTIONS = ["What needs my attention?", "Find my latest PDF", "Start Claude in my home folder", "Open my website preview"];

function Waiting() {
  const [long, setLong] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLong(true), 1200);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="assistant-waiting" data-id="assistant.waiting">
      <Spinner />
      {long && <span className="t-subheadline muted">Looking on your Mac</span>}
    </div>
  );
}

function Exchange({ exchange, send }) {
  const conversation = assistant.conversation;
  const cardProps = {
    conversation,
    ask: (text) => send(text),
    handedOver: (reply) => assistant.answer(exchange.id, { reply }),
    followedUp: (followup) => assistant.receive(followup, exchange.id),
  };
  return (
    <div className="exchange">
      <div className="request">{exchange.text}</div>
      {exchange.reply ? (
        <>
          <div className="reply selectable" data-id="assistant.reply">
            {exchange.reply.reply}
          </div>
          {(exchange.reply.cards || []).map((card, i) => (
            <AssistantCard key={i} card={card} {...cardProps} />
          ))}
          {(exchange.followups || []).map((f) => (
            <React.Fragment key={f.id}>
              <div className="reply selectable" data-id="assistant.followup" style={{ paddingTop: 4 }}>
                {f.reply}
              </div>
              {(f.cards || []).map((card, i) => (
                <AssistantCard key={i} card={card} {...cardProps} />
              ))}
            </React.Fragment>
          ))}
        </>
      ) : exchange.error ? (
        <div className="t-subheadline warning" style={{ display: "flex", gap: 6 }}>
          <Icon as={CircleAlert} size={17} style={{ flex: "none", marginTop: 1 }} /> {exchange.error}
        </div>
      ) : (
        <Waiting />
      )}
    </div>
  );
}

export function AssistantTab() {
  const s = useStore(connection.store, (s) => ({ hostStatus: s.hostStatus, connectionState: s.connectionState }));
  const a = useStore(assistant.store);
  const v = useStore(voice.store);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [speakReplies, setSpeakReplies] = usePref("palm.voice.speakReplies", true);
  const [agentScreen] = usePref("palm.agent.screen", true);
  const [agentAccess] = usePref(KEYS.agentAccess, "full");
  const scroller = useRef();
  const input = useRef();
  useEffect(() => assistant.start(), []);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [a.exchanges.length, a.exchanges.reduce((n, e) => n + (e.followups?.length || 0) + (e.reply ? 1 : 0), 0)]);

  async function send(text, spoken = false) {
    const request = String(text || "").trim();
    if (!request || busy) return;
    setDraft("");
    input.current?.blur();
    setBusy(true);
    const exchange = { id: crypto.randomUUID(), text: request, spoken };
    assistant.append(exchange);
    const asked = performance.now();
    try {
      const reply = await post(
        "/api/assistant",
        { text: request, conversation: assistant.conversation, turn: exchange.id, devices: [], screen: agentScreen, access: agentAccess },
        { timeout: 60000 },
      );
      timings.record("assistantReply", performance.now() - asked);
      assistant.answer(exchange.id, { reply });
      assistant.deliver(reply.cards || []);
      if (spoken && speakReplies) voice.speak(reply.reply);
    } catch (e) {
      assistant.answer(exchange.id, { error: friendly(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-screen assistant-screen">
      <NavBar
        title="Assistant"
        subtitle={deviceSubtitle(s)}
        trailing={
          <>
            {a.exchanges.length > 0 && <GlassButton icon={Trash2} label="Clear" onClick={() => assistant.clear()} id="assistant.clear" />}
            <GlassButton
              icon={speakReplies ? Volume2 : VolumeX}
              label={speakReplies ? "Spoken replies on" : "Spoken replies off"}
              onClick={() => {
                setSpeakReplies(!speakReplies);
                if (speakReplies) voice.stopSpeaking();
              }}
              id="assistant.speak"
            />
          </>
        }
      />
      <div className="scroll assistant-scroll" ref={scroller}>
        {a.exchanges.length === 0 && (
          <div className="intro">
            <p className="t-subheadline muted">Ask for a file, an agent in a folder, a preview of a project, or what needs you.</p>
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} type="button" className="suggestion t-subheadline w-medium" onClick={() => send(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        )}
        {a.exchanges.map((exchange) => (
          <Exchange key={exchange.id} exchange={exchange} send={send} />
        ))}
      </div>
      <div className="assistant-composer">
        {v.error && !v.owner && (
          <button type="button" className="t-footnote warning voice-error" onClick={() => voice.set({ error: null })}>
            {v.error}
          </button>
        )}
        <SpeakingBar />
        {voice.isActive("assistant") ? (
          <VoicePill
            onFinish={async (polish) => {
              const heard = await voice.finish(polish);
              if (heard) send(heard, true);
            }}
          />
        ) : (
          <form
            className="composer-row"
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
          >
            <textarea
              ref={input}
              className="composer-input"
              rows={1}
              placeholder="Ask Palm"
              value={draft}
              enterKeyHint="send"
              data-id="assistant.input"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
            />
            {!draft.trim() && !busy ? (
              <MicButton owner="assistant" label="Speak to Palm" id="assistant.mic" onError={(message) => voice.set({ error: message })} />
            ) : (
              <button type="submit" className="send-button" disabled={busy || !draft.trim()} aria-label="Send" data-id="assistant.send">
                {busy ? <Spinner color="var(--on-accent)" /> : <Icon as={ArrowUp} size={19} weight={3} />}
              </button>
            )}
          </form>
        )}
      </div>
      {a.autoSaved && <SavedFileSheet file={a.autoSaved} onClose={() => assistant.store.set({ autoSaved: null })} />}
    </div>
  );
}
