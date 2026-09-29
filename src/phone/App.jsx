// Palm on the web: the iPhone app's structure (PalmApp / PalmRootView).
// Pairing, then Face ID, then five tabs (Assistant, Agents, Files, Screen,
// More) with the live screen over them, and the same notices.
import React, { useEffect, useState } from "react";
import { CircleAlert, WifiOff, X } from "lucide-react";
import { access, friendly, readAccess } from "./core/api.js";
import { connection } from "./core/connection.js";
import { nav, navigate } from "./core/navigator.js";
import { useStore } from "./core/store.js";
import { OverlayHost, Icon, PalmMark, PrimaryButton, PrivacyShield, Spinner, Symbol, cx, useToast } from "./ui/kit.jsx";
import { PairingView, FaceIDSetupView, UnlockView } from "./screens/Pairing.jsx";
import { ScreenTab } from "./screens/ScreenTab.jsx";
import { RemoteView } from "./remote/RemoteView.jsx";
import { SCREENS, ROOTS } from "./screens/registry.jsx";
import { WatchBanner, watch } from "./screens/watch.jsx";
import "./phone.css";

// [id, label, glyph, size]: the tab bar draws its glyphs at 23 pt.
const TABS = [
  ["assistant", "Assistant", "sparkles"],
  ["agents", "Agents", "chevron.left.forwardslash.chevron.right"],
  ["files", "Files", "folder.fill"],
  ["screen", "Screen", "macwindow", 23.07],
  ["more", "More", "ellipsis"],
];

function Loading() {
  return (
    <div className="stack-screen" style={{ alignItems: "center", justifyContent: "center", gap: 15 }}>
      <PalmMark size={58} />
      <div className="t-subheadline muted">Opening Palm</div>
    </div>
  );
}

function Unreachable() {
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack-screen" style={{ alignItems: "center", justifyContent: "center", padding: 24, textAlign: "center", gap: 14 }}>
      <Icon as={WifiOff} size={40} weight={1.6} />
      <div className="t-title3 w-semibold">Your Mac is unreachable</div>
      <div className="t-subheadline muted" style={{ maxWidth: 320 }}>
        Check that it is awake, Palm is running and Tailscale is connected on both devices.
      </div>
      <div style={{ width: 260 }}>
        <PrimaryButton
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await readAccess().catch(() => {});
            setBusy(false);
          }}
        >
          {busy ? <Spinner /> : null} Check connection
        </PrimaryButton>
      </div>
    </div>
  );
}

function TabBar({ tab }) {
  return (
    <nav className="tabbar glass" aria-label="Palm">
      {TABS.map(([id, label, glyph, pt]) => (
        <button key={id} type="button" className={cx(tab === id && "selected")} aria-label={label} aria-current={tab === id ? "page" : undefined} data-id={`tab.${id}`} onClick={() => navigate.tab(id)}>
          <span className="tab-glyph">
            <Symbol name={glyph} pt={pt} />
          </span>
          <span className="tab-label">{label}</span>
        </button>
      ))}
    </nav>
  );
}

function TabPage({ id, root, stack }) {
  const Root = root;
  return (
    <div className={cx("tab-page", nav.get().tab === id && "selected")} data-tab={id}>
      <Root />
      {stack.map((entry, index) => {
        const Screen = SCREENS[entry.screen];
        return (
          <div key={entry.key} className="stack-screen pushed" style={{ zIndex: index + 2, display: index === stack.length - 1 ? "flex" : "none" }}>
            <Screen {...entry.props} />
          </div>
        );
      })}
    </div>
  );
}

function Tabs() {
  const n = useStore(nav);
  const s = useStore(connection.store, (s) => ({ errorMessage: s.errorMessage, hostStatus: s.hostStatus }));
  const [opening, setOpening] = useState(false);
  const [localError, setLocalError] = useState(null);
  const error = localError ?? s.errorMessage;
  useEffect(() => {
    connection.refresh().catch((err) => setLocalError(friendly(err)));
    watch.start();
    return () => watch.stop();
  }, []);

  const showRemote = () => {
    if (opening) return;
    setLocalError(null);
    nav.set({ remote: true });
    if (connection.isStreaming && connection.state.targetWindowID === 0) return;
    setOpening(true);
    connection
      .start(0, "Desktop")
      .catch((err) => connection.set({ errorMessage: friendly(err) }))
      .finally(() => setOpening(false));
  };
  const openApp = (app, window = null) => {
    if (opening) return;
    setLocalError(null);
    setOpening(true);
    connection
      .open(app, window?.id ?? null)
      .then(() => nav.set({ remote: true }), (err) => setLocalError(friendly(err)))
      .finally(() => setOpening(false));
  };

  const screenRoot = () => <ScreenTab opening={opening} showDesktop={showRemote} openApp={(app) => openApp(app)} openWindow={(app, w) => openApp(app, w)} />;
  return (
    <div className="app">
      {TABS.map(([id]) => (
        <TabPage key={id} id={id} root={id === "screen" ? screenRoot : ROOTS[id]} stack={n.stacks[id]} />
      ))}
      <TabBar tab={n.tab} />
      {!n.remote && <WatchBanner />}
      {opening && !n.remote && (
        <div className="floating-notice glass">
          <Spinner /> Opening on your Mac
        </div>
      )}
      {!n.remote && (error || (s.hostStatus?.synthetic && !s.hostStatus?.demo)) && (
        <div className="toast-layer" style={{ bottom: "calc(var(--sab) + 70px)" }}>
          {error && (
            <div className="toast glass" data-id="root.error" role="alert">
              <Icon as={CircleAlert} size={18} style={{ color: "var(--orange)" }} />
              <span className="toast-text">{error}</span>
              <button type="button" className="dismiss" aria-label="Dismiss error" onClick={() => {
                setLocalError(null);
                connection.set({ errorMessage: null });
              }}>
                <Icon as={X} size={15} weight={2.6} />
              </button>
            </div>
          )}
          {s.hostStatus?.synthetic && !s.hostStatus?.demo && (
            <div className="test-host-label" data-id="root.testHost">
              Test host · simulated Mac
            </div>
          )}
        </div>
      )}
      {n.remote && <RemoteView onClose={() => nav.set({ remote: false })} />}
    </div>
  );
}

/** The phone keyboard's height as --kb, and .keyboard-open while it shows (composers ride on it, the tab bar steps aside). */
function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const root = document.documentElement;
  const update = () => {
    const inset = Math.max(0, innerHeight - vv.height - vv.offsetTop);
    const open = inset > 120;
    root.style.setProperty("--kb", `${open ? inset : 0}px`);
    root.classList.toggle("keyboard-open", open);
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  update();
  return () => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
  };
}

// ?debug exposes the connection to test tools (tests/web-screen-bench.mjs).
if (new URLSearchParams(location.search).has("debug")) window.__palm = { connection };

export function PhoneApp() {
  const state = useStore(access, (s) => s.state);
  useEffect(trackKeyboard, []);
  useEffect(() => {
    readAccess().catch(() => {});
    // Coming back to Palm: the Mac may have locked it meanwhile.
    const onVisible = () => document.visibilityState === "visible" && readAccess().catch(() => {});
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
  let content;
  if (state === "unknown") content = <Loading />;
  else if (state === "offline") content = <Unreachable />;
  else if (state === "unpaired") content = <PairingView />;
  else if (state === "setup") content = <FaceIDSetupView />;
  else if (state === "locked") content = <UnlockView />;
  else content = <Tabs />;
  return (
    <OverlayHost>
      {content}
      <PrivacyShield />
    </OverlayHost>
  );
}
