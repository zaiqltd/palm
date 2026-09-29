// Types straight into the Mac as you press keys: no text box, no Send button
// (PalmKeyCatcher). Letters go as text, Return, Backspace, arrows and
// shortcuts as keys; sticky ⌘ ⌥ ⌃ ⇧ apply to the next key. The key bar rides
// just above the iPhone keyboard (the visual viewport tells where it is).
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Image as ImageIcon, KeyboardOff, Mic } from "lucide-react";
import { Icon, cx } from "../ui/kit.jsx";

const SENTINEL = "  ";
const HARDWARE_KEYS = {
  Escape: "escape", Tab: "tab", ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
  Backspace: "backspace", Delete: "forwarddelete", Enter: "enter", Home: "home", End: "end", PageUp: "pageup", PageDown: "pagedown",
};

export const KeyCatcher = forwardRef(function KeyCatcher({ active, onDismiss, send, onSpeak, onPaste, onPhoto }, ref) {
  const input = useRef();
  const pending = useRef("");
  const flushTimer = useRef();
  const [modifiers, setModifiers] = useState([]);
  const mods = useRef([]);
  mods.current = modifiers;
  const [keyboardInset, setKeyboardInset] = useState(0);

  const flush = () => {
    clearTimeout(flushTimer.current);
    if (!pending.current) return;
    const text = pending.current;
    pending.current = "";
    send({ text });
  };
  const press = (key) => {
    flush();
    send({ key, modifiers: [...mods.current].sort() });
    if (mods.current.length) setModifiers([]);
  };
  const shortcut = (key, list) => {
    flush();
    send({ key, modifiers: list });
  };
  const toggle = (name) => setModifiers((list) => (list.includes(name) ? list.filter((m) => m !== name) : [...list, name]));

  useImperativeHandle(ref, () => ({
    /** Must run inside the tap that asked for the keyboard (iOS shows it only then). */
    focus() {
      const el = input.current;
      if (!el) return;
      el.value = SENTINEL;
      el.focus({ preventScroll: true });
      el.setSelectionRange(SENTINEL.length, SENTINEL.length);
    },
    blur() {
      flush();
      input.current?.blur();
    },
    flush,
  }));

  useEffect(() => {
    if (!active) input.current?.blur();
  }, [active]);

  // Where the keyboard is: the key bar sits on it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setKeyboardInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  const onBeforeInput = (e) => {
    const type = e.inputType;
    e.preventDefault();
    if (type === "insertText" || type === "insertReplacementText" || type === "insertFromPaste" || type === "insertFromDrop") {
      const data = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
      if (!data) return;
      if (mods.current.length) {
        flush();
        for (const character of data.toLowerCase()) press(character);
        return;
      }
      // Coalesce fast typing into small chunks; each still arrives in order.
      pending.current += data;
      clearTimeout(flushTimer.current);
      if (pending.current.length >= 24) flush();
      else flushTimer.current = setTimeout(flush, 30);
      return;
    }
    if (type === "insertLineBreak" || type === "insertParagraph") return press("enter");
    if (type === "deleteContentBackward" || type === "deleteWordBackward" || type === "deleteSoftLineBackward") return press("backspace");
    if (type === "deleteContentForward") return press("forwarddelete");
  };

  const onKeyDown = (e) => {
    // Hardware keyboards (iPad, a Bluetooth keyboard) and keys the software
    // keyboard sends without an input event.
    const named = HARDWARE_KEYS[e.key];
    const held = [e.metaKey && "cmd", e.altKey && "opt", e.ctrlKey && "ctrl", e.shiftKey && named && "shift"].filter(Boolean);
    if (named) {
      e.preventDefault();
      flush();
      send({ key: named, modifiers: [...new Set([...held, ...mods.current])].sort() });
      if (mods.current.length) setModifiers([]);
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.length === 1) {
      e.preventDefault();
      flush();
      send({ key: e.key.toLowerCase(), modifiers: held.filter((m) => m !== "shift").concat(e.shiftKey ? ["shift"] : []).sort() });
    }
  };

  const keep = (e) => e.preventDefault(); // a key tap never takes the keyboard's focus away
  const repeatTimer = useRef();
  const startRepeat = (key) => {
    press(key);
    clearTimeout(repeatTimer.current);
    repeatTimer.current = setTimeout(function again() {
      press(key);
      repeatTimer.current = setTimeout(again, 70);
    }, 400);
  };
  const stopRepeat = () => clearTimeout(repeatTimer.current);
  useEffect(() => stopRepeat, []);

  const key = (content, label, action, { id, latched, repeats } = {}) => (
    <button
      type="button"
      className={cx("key", latched && "latched")}
      aria-label={label}
      aria-pressed={latched === undefined ? undefined : latched}
      data-id={id}
      onPointerDown={(e) => {
        keep(e);
        if (repeats) startRepeat(repeats);
      }}
      onPointerUp={repeats ? stopRepeat : undefined}
      onPointerCancel={repeats ? stopRepeat : undefined}
      onPointerLeave={repeats ? stopRepeat : undefined}
      onClick={repeats ? undefined : action}
    >
      {content}
    </button>
  );

  return (
    <>
      <textarea
        ref={input}
        className="key-catcher"
        defaultValue={SENTINEL}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
        enterKeyHint="enter"
        aria-hidden="true"
        tabIndex={-1}
        onBeforeInput={onBeforeInput}
        onInput={(e) => {
          // Anything that slipped past beforeinput (composition): send it, reset.
          const value = e.currentTarget.value;
          if (value !== SENTINEL) {
            const extra = value.startsWith(SENTINEL) ? value.slice(SENTINEL.length) : "";
            if (extra) send({ text: extra });
            e.currentTarget.value = SENTINEL;
          }
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          flush();
          onDismiss();
        }}
      />
      {active && (
        <div className="keybar" style={{ bottom: keyboardInset }} role="toolbar" aria-label="Keys for the Mac">
          <div className="keybar-scroll">
            {key(<Icon as={ClipboardPaste} size={17} weight={2.2} />, "Paste from this iPhone on the Mac", () => {
              flush();
              onPaste?.();
            }, { id: "keybar.paste" })}
            {key(<Icon as={ImageIcon} size={17} weight={2.2} />, "Paste a photo from this iPhone on the Mac", () => {
              flush();
              onPhoto?.();
            }, { id: "keybar.photo" })}
            {key("esc", "Escape", () => press("escape"))}
            {key("tab", "Tab", () => press("tab"))}
            {[["⌘", "cmd", "Command"], ["⌥", "opt", "Option"], ["⌃", "ctrl", "Control"], ["⇧", "shift", "Shift"]].map(([symbol, name, label]) => (
              <React.Fragment key={name}>{key(symbol, label, () => toggle(name), { id: `keybar.${name}`, latched: modifiers.includes(name) })}</React.Fragment>
            ))}
            {key(<Icon as={ArrowLeft} size={16} weight={2.4} />, "Left arrow", null, { repeats: "left" })}
            {key(<Icon as={ArrowUp} size={16} weight={2.4} />, "Up arrow", null, { repeats: "up" })}
            {key(<Icon as={ArrowDown} size={16} weight={2.4} />, "Down arrow", null, { repeats: "down" })}
            {key(<Icon as={ArrowRight} size={16} weight={2.4} />, "Right arrow", null, { repeats: "right" })}
            {key("⌘C", "Copy on the Mac", () => shortcut("c", ["cmd"]))}
            {key("⌘V", "Paste on the Mac", () => shortcut("v", ["cmd"]))}
            {key("⌘Z", "Undo on the Mac", () => shortcut("z", ["cmd"]))}
            {key("⌘A", "Select all on the Mac", () => shortcut("a", ["cmd"]))}
            {key("⌘S", "Save on the Mac", () => shortcut("s", ["cmd"]))}
          </div>
          <div className="keybar-fixed">
            {key(<Icon as={Mic} size={17} weight={2.2} />, "Speak instead of typing", () => {
              flush();
              onSpeak?.();
            }, { id: "keybar.mic" })}
            {key(<Icon as={KeyboardOff} size={18} weight={2} />, "Hide keyboard", () => input.current?.blur(), { id: "keybar.hide" })}
          </div>
        </div>
      )}
    </>
  );
});
