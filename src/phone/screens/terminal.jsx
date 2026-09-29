// More › Terminal (PalmTerminalsContent): opens straight into a shell on the
// Mac in the home folder; the shell keeps running when you leave and coming
// back reattaches with its screen intact. xterm.js draws it; a key bar above
// the keyboard adds the keys a phone keyboard lacks.
import React, { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronsRight, ClipboardPaste, Copy, Ellipsis, FolderPlus, Keyboard, KeyboardOff, Layers, Mic, Plus, SquareTerminal, CircleStop, X, AArrowUp, AArrowDown } from "lucide-react";
import { friendly, get, post } from "../core/api.js";
import { connection } from "../core/connection.js";
import { events } from "../core/events.js";
import { displayPath } from "../core/format.js";
import { navigate } from "../core/navigator.js";
import { usePref } from "../core/prefs.js";
import { useStore } from "../core/store.js";
import { BackButton, GlassButton, GlassTextButton, Icon, List, NavBar, Row, Section, Sheet, Spinner, PrimaryButton, cx, useMenu, useToast } from "../ui/kit.jsx";
import { useHome } from "./files.jsx";
import { VoicePill, voice } from "./voice.jsx";

/** Shell titles often read "user@host:~/path"; the phone shows the folder. */
export function shortTitle(raw) {
  const title = String(raw || "").trim();
  const colon = title.lastIndexOf(":");
  if (colon > 0 && title.slice(0, colon).includes("@")) {
    const path = title.slice(colon + 1).trim();
    if (!path || path === "~") return "~";
    return path.split("/").pop();
  }
  return title || "Shell";
}

export function TerminalScreen() {
  const home = useHome();
  const [terminals, setTerminals] = useState([]);
  const [error, setError] = useState(null);
  const [currentId, setCurrentId] = usePref("palm.terminal.current", "");
  const [chosenFolder, setChosenFolder] = usePref("palm.terminal.chosenFolder", "~");
  const [creating, setCreating] = useState(false);
  const [focusNext, setFocusNext] = useState(false);
  const starting = useRef(false);
  const menu = useMenu();
  const current = terminals.find((t) => t.id === currentId);
  const atHome = (t) => displayPath(t.cwd, home) === "~";

  async function refresh() {
    try {
      const list = (await get("/api/terminals")).terminals || [];
      setTerminals(list);
      setError(null);
      return list;
    } catch (e) {
      setError(friendly(e));
      return null;
    }
  }
  async function create(folder, command) {
    if (starting.current) return;
    starting.current = true;
    try {
      const body = { cwd: folder, cols: 60, rows: 30 };
      if (command) body.command = command;
      const terminal = await post("/api/terminals", body);
      await refresh();
      setFocusNext(true);
      setCurrentId(terminal.id);
      setError(null);
    } catch (e) {
      setError(friendly(e));
    } finally {
      starting.current = false;
    }
  }
  const newest = (list) => list.filter((t) => t.running && atHome(t)).sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : -1))[0];
  async function openDefault() {
    const list = await refresh();
    if (!list) return;
    if (list.find((t) => t.id === currentId)?.running) return;
    const running = newest(list);
    if (running) return setCurrentId(running.id);
    await create("~");
  }
  async function close(id) {
    try {
      await post(`/api/terminals/${id}/close`);
      const list = (await refresh()) || [];
      const next = newest(list);
      setFocusNext(false);
      if (next) setCurrentId(next.id);
      else await create("~");
    } catch (e) {
      setError(friendly(e));
    }
  }
  useEffect(() => {
    openDefault();
    return events.listen("terminals", (message) => message.terminals && setTerminals(message.terminals));
  }, []);

  const shellsMenu = (e) =>
    menu.open(
      e.currentTarget,
      [
        ...terminals.map((t) => ({
          label: `${shortTitle(t.title)} in ${displayPath(t.cwd, home)}`,
          checked: t.id === currentId,
          action: () => {
            setFocusNext(false);
            setCurrentId(t.id);
          },
        })),
        "divider",
        { label: "New shell", icon: Plus, action: () => create("~"), id: "terminal.new" },
        { label: "New shell in a folder", icon: FolderPlus, action: () => setCreating(true) },
        ...(current ? [{ label: "Close this shell", icon: X, destructive: true, action: () => close(current.id) }] : []),
      ],
      { align: "left" },
    );

  return (
    <div className="stack-screen terminal-screen">
      {current ? (
        <TerminalView
          key={current.id}
          terminal={current}
          focusOnOpen={focusNext}
          leading={
            <>
              <BackButton onClick={() => navigate.pop()} />
              <GlassButton icon={Layers} label="Shells" onClick={shellsMenu} id="terminal.sessions" />
            </>
          }
        />
      ) : (
        <>
          <NavBar inline title="Terminal" leading={<BackButton onClick={() => navigate.pop()} />} />
          <div className="placeholder">
            {error ? (
              <>
                <div className="warning t-title2">⚠︎</div>
                <p className="muted">{error}</p>
                <div style={{ width: 200 }}>
                  <PrimaryButton onClick={openDefault}>Try again</PrimaryButton>
                </div>
              </>
            ) : (
              <>
                <Spinner large />
                <p className="muted">Opening a shell on your Mac</p>
              </>
            )}
          </div>
        </>
      )}
      {creating && (
        <NewShellSheet
          folder={chosenFolder}
          onClose={() => setCreating(false)}
          onCreate={(folder, command) => {
            setCreating(false);
            setChosenFolder(folder);
            create(folder, command);
          }}
        />
      )}
    </div>
  );
}

function NewShellSheet({ folder: start, onClose, onCreate }) {
  const [folder, setFolder] = useState(start);
  const [command, setCommand] = useState("");
  return (
    <Sheet
      title="New shell"
      onClose={onClose}
      leading={<GlassTextButton onClick={onClose}>Cancel</GlassTextButton>}
      trailing={
        <GlassTextButton prominent onClick={() => onCreate(folder || "~", command || null)} id="newshell.open">
          Open
        </GlassTextButton>
      }
    >
      <List>
        <Section header="Folder on your Mac" footer="~ is your home folder, for example ~/projects/website.">
          <div className="row">
            <input className="row-input mono" value={folder} placeholder="~" autoCapitalize="none" autoCorrect="off" onChange={(e) => setFolder(e.target.value)} data-id="newshell.folder" />
          </div>
        </Section>
        <Section header="Start with a command" footer="The shell stays open after the command, so you can keep working in it.">
          <div className="row">
            <input className="row-input mono" value={command} placeholder="Optional, such as claude or npm run dev" autoCapitalize="none" autoCorrect="off" onChange={(e) => setCommand(e.target.value)} />
          </div>
          {["claude", "codex", "npm run dev", "git status", "npm test"].map((s) => (
            <Row key={s} title={<span className="mono">{s}</span>} accent onClick={() => setCommand(s)} />
          ))}
        </Section>
      </List>
    </Sheet>
  );
}

const SAVED_COMMANDS = "claude\ncodex\nnpm run dev\ngit status\ngit diff\nclear";

function TerminalView({ terminal, focusOnOpen, leading }) {
  const host = useRef();
  const xterm = useRef();
  const fit = useRef();
  const textarea = useRef();
  const [title, setTitle] = useState(null);
  const [status, setStatus] = useState(null);
  const [focused, setFocused] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [fontSize, setFontSize] = usePref("palm.terminal.fontSize", 12);
  const [shortcutText] = usePref("palm.terminal.shortcuts", SAVED_COMMANDS);
  const sticky = useRef({ ctrl: false, alt: false });
  sticky.current = { ctrl, alt };
  const v = useStore(voice.store);
  const owner = `terminal:${terminal.id}`;
  const menu = useMenu();
  const toast = useToast();

  const sendText = (data) => events.send({ op: "terminal.input", id: terminal.id, data });
  const sendKeys = (data) => {
    xterm.current?.focus();
    sendText(data);
  };

  useEffect(() => {
    const term = new XTerm({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize,
      cursorBlink: false,
      cursorStyle: "block",
      scrollback: 5000,
      allowProposedApi: true,
      macOptionIsMeta: true,
      theme: { background: "#161618", foreground: "#ebebeb", cursor: "#ebebeb", selectionBackground: "rgba(255,255,255,0.28)" },
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(host.current);
    xterm.current = term;
    fit.current = addon;
    textarea.current = host.current.querySelector("textarea");
    textarea.current?.setAttribute("autocapitalize", "none");
    textarea.current?.setAttribute("autocorrect", "off");
    textarea.current?.setAttribute("spellcheck", "false");
    try {
      addon.fit();
    } catch {}
    const attach = () => events.send({ op: "terminal.attach", id: terminal.id, cols: term.cols, rows: term.rows });
    const disposers = [
      term.onData((data) => {
        let out = data;
        const s = sticky.current;
        if (s.ctrl && out.length === 1) {
          const code = out.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) out = String.fromCharCode(code - 64);
          setCtrl(false);
        }
        if (s.alt) {
          out = "\u001b" + out;
          setAlt(false);
        }
        sendText(out);
      }),
      term.onResize(({ cols, rows }) => events.send({ op: "terminal.resize", id: terminal.id, cols, rows })),
      term.onTitleChange((t) => setTitle(t ? t.slice(0, 80) : null)),
    ];
    const offMessages = events.listen(`terminal:${terminal.id}`, (message) => {
      switch (message.event) {
        case "terminal.snapshot":
          term.reset();
          term.write("\u001b[2J\u001b[H");
          if (message.data) term.write(message.data);
          setStatus(message.running === false ? "This shell has ended. Open a new one from Shells." : null);
          break;
        case "terminal.output":
          if (message.data) term.write(message.data);
          break;
        case "terminal.exit":
          setStatus(`The shell ended (exit ${message.exitCode ?? 0}). Open a new one from Shells.`);
          break;
        case "terminal.closed":
          setStatus("This shell was closed on the Mac.");
          break;
        case "terminal.resync":
          attach();
          break;
      }
    });
    const offConnected = events.whenConnected(attach);
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    textarea.current?.addEventListener("focus", onFocus);
    textarea.current?.addEventListener("blur", onBlur);
    const resize = new ResizeObserver(() => {
      try {
        addon.fit();
      } catch {}
    });
    resize.observe(host.current);
    if (focusOnOpen) setTimeout(() => term.focus(), 50);
    return () => {
      events.send({ op: "terminal.detach", id: terminal.id });
      offMessages();
      offConnected();
      disposers.forEach((d) => d.dispose());
      resize.disconnect();
      textarea.current?.removeEventListener("focus", onFocus);
      textarea.current?.removeEventListener("blur", onBlur);
      term.dispose();
    };
  }, [terminal.id]);

  useEffect(() => {
    if (!xterm.current) return;
    xterm.current.options.fontSize = fontSize;
    try {
      fit.current.fit();
    } catch {}
  }, [fontSize]);

  // The key bar rides on top of the phone's keyboard.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setKeyboardInset(Math.max(0, innerHeight - vv.height - vv.offsetTop));
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  const arrow = (final) => {
    const application = xterm.current?.modes?.applicationCursorKeysMode;
    sendKeys(`\u001b${application ? "O" : "["}${final}`);
  };
  const repeat = useRef();
  const holdKey = (action) => ({
    onPointerDown: (e) => {
      e.preventDefault();
      action();
      clearInterval(repeat.current);
      const started = Date.now();
      repeat.current = setInterval(() => Date.now() - started > 400 && action(), 70);
    },
    onPointerUp: () => clearInterval(repeat.current),
    onPointerLeave: () => clearInterval(repeat.current),
    onPointerCancel: () => clearInterval(repeat.current),
  });
  const tap = (action) => ({
    onPointerDown: (e) => e.preventDefault(),
    onClick: action,
  });
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendKeys(text);
    } catch {
      toast("Allow Paste to send what this phone copied.", { warning: true });
    }
  };
  const copyScreen = async () => {
    const term = xterm.current;
    if (!term) return;
    const buffer = term.buffer.active;
    const lines = [];
    for (let row = 0; row < term.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "");
    await navigator.clipboard.writeText(lines.join("\n").trim()).catch(() => {});
    toast("Copied the screen text.");
  };
  const shortcuts = shortcutText.split("\n").filter(Boolean);

  return (
    <>
      <NavBar
        inline
        title={shortTitle(title ?? terminal.title)}
        leading={leading}
        trailing={
          <>
            {focused && (
              <GlassTextButton onClick={() => xterm.current?.blur()} id="terminal.done">
                Done
              </GlassTextButton>
            )}
            <GlassButton
              icon={Ellipsis}
              label="Terminal options"
              id="terminal.options"
              onClick={(e) =>
                menu.open(e.currentTarget, [
                  { label: "Show keyboard", icon: Keyboard, action: () => xterm.current?.focus() },
                  { label: "Paste from iPhone", icon: ClipboardPaste, action: paste },
                  { label: "Copy screen text", icon: Copy, action: copyScreen },
                  { label: "Interrupt (Ctrl-C)", icon: CircleStop, action: () => events.send({ op: "terminal.signal", id: terminal.id, signal: "SIGINT" }) },
                  "divider",
                  { label: "Larger text", icon: AArrowUp, action: () => setFontSize(Math.min(22, fontSize + 1)) },
                  { label: "Smaller text", icon: AArrowDown, action: () => setFontSize(Math.max(8, fontSize - 1)) },
                ])
              }
            />
          </>
        }
      />
      {status && <div className="terminal-status t-footnote warning">{status}</div>}
      <div className="terminal-host" ref={host} data-id="terminal.view" style={{ paddingBottom: focused ? keyboardInset + 50 : "calc(var(--sab) + 8px)" }} />
      {focused && (
        <div className="term-keybar" style={{ bottom: keyboardInset }} onPointerDown={(e) => e.preventDefault()}>
          <div className="keys">
            <button type="button" {...tap(() => sendKeys("\u001b"))} data-id="termbar.esc" aria-label="Escape">
              esc
            </button>
            <button type="button" {...tap(() => sendKeys("\t"))} aria-label="Tab">
              tab
            </button>
            <button type="button" className={cx(ctrl && "latched")} {...tap(() => setCtrl((c) => !c))} data-id="termbar.ctrl" aria-label="Control">
              ⌃
            </button>
            <button type="button" {...holdKey(() => arrow("A"))} aria-label="Up arrow">
              <Icon as={ArrowUp} size={17} />
            </button>
            <button type="button" {...holdKey(() => arrow("B"))} aria-label="Down arrow">
              <Icon as={ArrowDown} size={17} />
            </button>
            <button type="button" {...holdKey(() => arrow("D"))} aria-label="Left arrow">
              <Icon as={ArrowLeft} size={17} />
            </button>
            <button type="button" {...holdKey(() => arrow("C"))} aria-label="Right arrow">
              <Icon as={ArrowRight} size={17} />
            </button>
            <button type="button" {...tap(() => sendKeys("\u0003"))} data-id="termbar.interrupt" aria-label="Interrupt, Control C">
              ⌃C
            </button>
            <button
              type="button"
              {...tap((e) =>
                menu.open(
                  e.currentTarget,
                  shortcuts.map((command) => ({ label: command, icon: SquareTerminal, action: () => sendKeys(command + "\r") })),
                  { up: true, align: "left" },
                ),
              )}
              data-id="termbar.commands"
              aria-label="Saved commands"
            >
              <Icon as={ChevronsRight} size={17} />
            </button>
            <button type="button" className={cx(alt && "latched")} {...tap(() => setAlt((a) => !a))} aria-label="Option">
              ⌥
            </button>
            {["~", "|", "/", "-", "*", "$"].map((symbol) => (
              <button key={symbol} type="button" {...tap(() => sendKeys(symbol))} aria-label={symbol}>
                {symbol}
              </button>
            ))}
            <button type="button" {...tap(paste)} aria-label="Paste from iPhone">
              <Icon as={ClipboardPaste} size={17} />
            </button>
          </div>
          <button
            type="button"
            className="fixed"
            {...tap(() => {
              xterm.current?.blur();
              voice.start(owner).catch((e) => toast(e.message, { warning: true }));
            })}
            data-id="termbar.mic"
            aria-label="Speak instead of typing"
          >
            <Icon as={Mic} size={17} fill="currentColor" />
          </button>
          <button type="button" className="fixed" {...tap(() => xterm.current?.blur())} data-id="termbar.hide" aria-label="Hide keyboard">
            <Icon as={KeyboardOff} size={17} />
          </button>
        </div>
      )}
      {voice.isActive(owner) && (
        <div className="voice-dock">
          <VoicePill
            onFinish={async (polish) => {
              const heard = await voice.finish(polish);
              if (!heard) return;
              sendText(heard);
              navigator.clipboard.writeText(heard).catch(() => {});
              post("/api/clipboard", { text: heard }).catch(() => {});
            }}
          />
        </div>
      )}
      {!voice.isActive(owner) && v.error && !v.owner && (
        <div className="voice-dock">
          <button type="button" className="t-footnote warning voice-error" onClick={() => voice.set({ error: null })}>
            {v.error}
          </button>
        </div>
      )}
    </>
  );
}
