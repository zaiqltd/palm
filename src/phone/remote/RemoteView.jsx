// The live Mac screen, full size, with controls floating on top: the web
// version of PalmRemoteView (portrait bars, the landscape rail, the keyboard
// and key bar, Apps and Spotlight, the Dock and menu bar, app controls,
// session options, copy and paste).
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow, ArrowLeftRight, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Grid2x2, Hand, Keyboard, KeyboardOff, Layers,
  Maximize2, Mic, MousePointer2, PanelBottom, PanelLeft, PanelRight, PanelTop, RotateCw, Search, Settings, SlidersHorizontal, Square, X, ZoomIn,
} from "lucide-react";
import { connection } from "../core/connection.js";
import { friendly, get, post } from "../core/api.js";
import { useStore } from "../core/store.js";
import { usePref, KEYS } from "../core/prefs.js";
import { RemoteSurface, framingZoom } from "./surface.js";
import { KeyCatcher } from "./KeyCatcher.jsx";
import { AppsSheet, DockSheet, ActionsSheet, OptionsSheet } from "./RemoteSheets.jsx";
import { EDGES, SHORTCUTS } from "./shortcuts.js";
import { Icon, Spinner, PrimaryButton, useMenu, cx } from "../ui/kit.jsx";
import { voice, VoicePill } from "../screens/voice.jsx";
import "./remote.css";

/** The phone's safe-area insets, read from CSS env() (and the test override). */
function useSafeArea() {
  const [safe, setSafe] = useState({ top: 0, bottom: 0, left: 0, right: 0 });
  useLayoutEffect(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;padding:var(--sat) var(--sar) var(--sab) var(--sal)";
    document.body.appendChild(probe);
    const read = () => {
      const s = getComputedStyle(probe);
      setSafe({ top: parseFloat(s.paddingTop) || 0, right: parseFloat(s.paddingRight) || 0, bottom: parseFloat(s.paddingBottom) || 0, left: parseFloat(s.paddingLeft) || 0 });
    };
    read();
    addEventListener("resize", read);
    return () => {
      removeEventListener("resize", read);
      probe.remove();
    };
  }, []);
  return safe;
}

function useWindowSize() {
  const [size, setSize] = useState({ width: innerWidth, height: innerHeight });
  useEffect(() => {
    const update = () => setSize({ width: innerWidth, height: innerHeight });
    addEventListener("resize", update);
    addEventListener("orientationchange", update);
    return () => {
      removeEventListener("resize", update);
      removeEventListener("orientationchange", update);
    };
  }, []);
  return size;
}

export function RemoteView({ onClose }) {
  const s = useStore(connection.store, (s) => ({
    connectionState: s.connectionState, hostStatus: s.hostStatus, targetName: s.targetName, targetWindowID: s.targetWindowID,
    videoSize: s.videoSize, latency: s.latencyMilliseconds, screenOwner: s.screenOwner, isBusy: s.isBusy, errorMessage: s.errorMessage,
    displays: s.displays, displayID: s.displayID, hasPicture: s.hasPicture, windowLayout: s.windowLayout,
  }));
  const [modeName, setModeName] = usePref(KEYS.remoteMode, "Touch");
  const [railSide] = usePref(KEYS.railSide, "right");
  const [railCollapsed, setRailCollapsed] = usePref(KEYS.railCollapsed, false);
  const [typing, setTyping] = useState(false);
  const [framingOverride, setFramingOverride] = useState(null);
  const [reframeID, setReframeID] = useState(0);
  const [editAt, setEditAt] = useState(null);
  const [flash, setFlash] = useState(null);
  const [localError, setLocalError] = useState(null);
  const [sheet, setSheet] = useState(null); // apps, dock, actions, options
  const [actionBusy, setActionBusy] = useState(false);
  const voiceState = useStore(voice.store, (v) => ({ active: v.active && v.owner === "screen" }));
  const stageRef = useRef();
  const surfaceRef = useRef(null);
  const keysRef = useRef();
  const photoRef = useRef();
  const editHide = useRef();
  const menu = useMenu();
  const safe = useSafeArea();
  const size = useWindowSize();
  const landscape = size.width > size.height;
  const mode = modeName === "Trackpad" ? "trackpad" : "touch";
  const streaming = s.connectionState === "live";
  const starting = s.connectionState === "connecting" || s.connectionState === "reconnecting";
  const agentHasScreen = s.screenOwner?.kind === "agent";
  const canControl = streaming && s.hostStatus?.controlPermission === true && s.hasPicture && !s.isBusy && !agentHasScreen;
  const framing = framingOverride ?? (s.targetWindowID > 0 ? "fit" : "readable");
  const statusColor = !streaming ? "var(--muted)" : agentHasScreen ? "var(--orange)" : "var(--success)";
  const statusLine = starting ? "Connecting" : !streaming ? "Stopped" : agentHasScreen ? "Agent has control" : s.hostStatus?.controlPermission === false ? "View only" : "Live";
  const error = s.errorMessage ?? localError;

  // Twelve buttons down the rail, plus its status and gaps.
  const screenHeight = size.height;
  const railKey = Math.min(44, Math.max(28, Math.floor((screenHeight - 98) / 12)));
  const railEdge = (landscape ? (railSide === "left" ? safe.left : safe.right) : 0) > 20 ? (railSide === "left" ? safe.left : safe.right) + 4 : 10;
  // Ten buttons across, sized so they fit the narrowest iPhone.
  const barKey = Math.min(44, Math.floor((size.width - 70) / 10));

  // Where the floating controls cover the picture.
  const covered = useMemo(() => {
    if (landscape) {
      const rail = !railCollapsed ? railEdge + railKey + 14 + 8 : 0;
      return {
        top: safe.top, bottom: typing ? 0 : safe.bottom,
        left: railSide === "left" ? Math.max(safe.left, rail) : safe.left,
        right: railSide === "left" ? safe.right : Math.max(safe.right, rail),
      };
    }
    return { top: safe.top + 64, left: safe.left, bottom: typing ? 0 : safe.bottom + 64, right: safe.right };
  }, [landscape, railCollapsed, railEdge, railKey, safe, typing, railSide]);
  const layoutCovered = useMemo(() => {
    if (!landscape) return covered;
    const rail = railEdge + railKey + 14 + 8;
    return { ...covered, left: railSide === "left" ? Math.max(safe.left, rail) : safe.left, right: railSide === "left" ? safe.right : Math.max(safe.right, rail) };
  }, [landscape, covered, railEdge, railKey, railSide, safe]);
  const mapCorner = landscape
    ? { x: railSide !== "left" && !railCollapsed ? railEdge + railKey + 14 + 10 : 18, y: 18 }
    : typing
      ? { x: 16, y: safe.top + 64 }
      : { x: 18, y: 18 + safe.top };

  // The surface: created once, configured on every change.
  useLayoutEffect(() => {
    const surface = new RemoteSurface(stageRef.current, connection.video);
    surface.onPointer = (action, x, y) => connection.sendPointer(action, x, y);
    surface.onScroll = (dx, dy) => connection.sendScroll(dx, dy);
    surface.onZoom = (zoom) => connection.setStreamQuality(zoom);
    surface.onCancelSession = () => connection.stop();
    surfaceRef.current = surface;
    return () => {
      surface.destroy();
      surfaceRef.current = null;
    };
  }, []);
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    surface.onSelected = (point) => showEditBar(point);
    surface.configure({ size: s.videoSize, enabled: canControl, mode, framing, reframeID, typing, obscured: covered, mapCorner });
  });

  // The phone's shape for a phone-shaped Mac window (the space the controls leave).
  useEffect(() => {
    if (typing) return;
    connection.updateViewport({ width: size.width - layoutCovered.left - layoutCovered.right, height: size.height - layoutCovered.top - layoutCovered.bottom });
  }, [size, layoutCovered, typing]);

  useEffect(() => {
    if (!canControl) setTyping(false);
  }, [canControl]);
  useEffect(() => {
    showEditBar(null);
  }, [typing]);
  useEffect(() => {
    if (s.connectionState === "live") setLocalError(null);
  }, [s.connectionState]);
  useEffect(() => {
    setFramingOverride(null);
    setReframeID((n) => n + 1);
  }, [s.targetWindowID]);
  // Leaving the screen ends the session.
  useEffect(() => () => connection.stop(), []);

  const showEditBar = useCallback((point) => {
    clearTimeout(editHide.current);
    setEditAt(point);
    if (point) editHide.current = setTimeout(() => setEditAt(null), 6000);
  }, []);

  const showFlash = (text) => {
    setFlash(text);
    setTimeout(() => setFlash((f) => (f === text ? null : f)), 1300);
  };

  const close = () => {
    setTyping(false);
    connection.stop();
    onClose();
  };

  /** Must run in the tap: iOS shows the keyboard only for a focus inside it. */
  const startTyping = () => {
    if (!canControl) return;
    keysRef.current?.focus();
    setTyping(true);
  };
  const toggleTyping = () => {
    if (typing) {
      keysRef.current?.blur();
      setTyping(false);
    } else startTyping();
  };

  async function show(edge) {
    if (!connection.showsWholeScreen) {
      try {
        await connection.start(0, "Desktop");
      } catch (err) {
        setLocalError(friendly(err));
        return;
      }
    }
    if (!(await connection.waitUntilControllable())) return;
    surfaceRef.current?.focusEdge(EDGES[edge].focus);
    await connection.revealEdge(edge === "menuBar");
  }

  async function press(shortcut) {
    // Spotlight waits for words: the keyboard comes up in the same tap.
    if (shortcut.id === "spotlight") startTyping();
    if (!connection.showsWholeScreen) {
      try {
        await connection.start(0, "Desktop");
      } catch (err) {
        setLocalError(friendly(err));
        return;
      }
    }
    if (!(await connection.waitUntilControllable())) return;
    connection.sendKey(shortcut.key, shortcut.modifiers);
    if (shortcut.focus) surfaceRef.current?.focusEdge(shortcut.focus);
  }

  async function launch(app) {
    const result = await post("/api/command", { op: "launch", bundleId: app.bundleId });
    await connection.start(result.windowId, result.windowId > 0 ? app.name : "Desktop", result.windowId > 0 ? "fill" : "original");
  }

  // ---- Copy and paste between this phone and the Mac ----

  async function copyOnMac() {
    showEditBar(null);
    connection.sendKey("c", ["cmd"]);
    // Give the Mac app a moment to fill its clipboard, then bring it here too.
    const text = new Promise((resolve, reject) =>
      setTimeout(async () => {
        try {
          const value = await get("/api/clipboard");
          resolve(new Blob([value.text || ""], { type: "text/plain" }));
        } catch (err) {
          reject(err);
        }
      }, 350),
    );
    try {
      // The write starts inside the tap, as Safari requires; its content follows.
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
      showFlash("Copied");
    } catch (err) {
      setLocalError(err?.name === "NotAllowedError" ? "Copied on the Mac. Safari did not allow Palm to fill this iPhone's clipboard." : friendly(err));
    }
  }

  async function pasteOnMac() {
    showEditBar(null);
    try {
      const text = await navigator.clipboard.readText();
      if (text) await post("/api/clipboard", { text: text.slice(0, 200000) });
      connection.sendKey("v", ["cmd"]);
      showFlash("Pasted");
    } catch (err) {
      setLocalError(err?.name === "NotAllowedError" ? "Paste was not allowed. Tap Paste when Safari asks." : friendly(err));
    }
  }

  /** The key bar's Paste: this phone's copied text or picture, pasted on the Mac. */
  async function pasteFromPhone() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const image = item.types.find((t) => t.startsWith("image/"));
        if (image) {
          const png = await toPNGBase64(await item.getType(image));
          await connection.pasteOnMac({ pngBase64: png });
          return showFlash("Picture pasted on the Mac");
        }
        if (item.types.includes("text/plain")) {
          const text = await (await item.getType("text/plain")).text();
          if (text) {
            await connection.pasteOnMac({ text });
            return showFlash("Pasted on the Mac");
          }
        }
      }
      setLocalError("Nothing is copied on this iPhone.");
    } catch (err) {
      setLocalError(err?.name === "NotAllowedError" ? "Paste was not allowed. Tap Paste when Safari asks." : friendly(err));
    }
  }

  async function pastePhoto(file) {
    if (!file) return;
    try {
      await connection.pasteOnMac({ pngBase64: await toPNGBase64(file) });
      showFlash("Picture pasted on the Mac");
    } catch (err) {
      setLocalError(friendly(err));
    }
  }

  // ---- Voice: spoken words pasted at the Mac's cursor ----
  const startVoice = () => {
    keysRef.current?.blur();
    setTyping(false);
    voice.start("screen").catch((err) => setLocalError(friendly(err)));
  };
  const finishVoice = async (polish) => {
    const heard = await voice.finish(polish);
    if (!heard || !connection.canControlBase) return;
    try {
      await navigator.clipboard.writeText(heard).catch(() => {});
      await connection.pasteOnMac({ text: heard });
      showFlash("Pasted on the Mac and copied");
    } catch (err) {
      setLocalError(friendly(err));
    }
  };

  const displaysMenu = s.displays.length > 1
    ? (e) =>
        menu.open(
          e.currentTarget,
          s.displays.map((d) => ({
            label: d.name,
            checked: connection.currentDisplay?.id === d.id,
            action: () => connection.show(d).catch((err) => setLocalError(friendly(err))),
          })),
          { align: "left" },
        )
    : null;

  const edgesMenu = (e) =>
    menu.open(
      e.currentTarget,
      [
        { label: "Menu bar", icon: PanelTop, id: "edges.menuBar", action: () => show("menuBar") },
        { label: "Dock", icon: PanelBottom, id: "edges.dock", action: () => setSheet("dock") },
      ],
      { align: landscape ? (railSide === "left" ? "left" : "right") : "center", up: !landscape },
    );

  const barButton = (icon, label, id, action, disabled, key) => (
    <button type="button" aria-label={label} data-id={id} onClick={action} disabled={disabled} style={{ width: key, height: key }}>
      <Icon as={icon} size={17} weight={2} />
    </button>
  );
  const modeButtons = (key) => (
    <div className="mode-switch">
      {[["Touch", Hand, "touch"], ["Trackpad", MousePointer2, "mouse"]].map(([value, icon, id]) => (
        <button
          key={value}
          type="button"
          className={cx(modeName === value && "selected")}
          aria-label={`${value === "Touch" ? "Touch" : "Mouse"} mode`}
          aria-pressed={modeName === value}
          data-id={`remote.mode.${id}`}
          onClick={() => setModeName(value)}
          style={{ width: key, height: key }}
        >
          <Icon as={icon} size={16} weight={2.2} />
        </button>
      ))}
    </div>
  );
  const zoomButton = (key) =>
    barButton(framing === "fit" ? ZoomIn : Maximize2, framing === "fit" ? "Zoom in" : "Show all", "remote.zoom", () => {
      setFramingOverride(framing === "fit" ? "readable" : "fit");
      setReframeID((n) => n + 1);
    }, false, key);

  const statusCapsule = (
    <button type="button" className="remote-status video-glass" onClick={displaysMenu || undefined} data-id="remote.displays" aria-label={displaysMenu ? "Choose which Mac screen to show" : undefined} style={{ cursor: displaysMenu ? "pointer" : "default" }}>
      <span className="status-dot" style={{ background: statusColor }} />
      <span className="name">{s.targetName || "Desktop"}</span>
      <span className="status-line">{statusLine}</span>
      {streaming && s.latency !== null && <span className="latency">{s.latency} ms</span>}
      {s.displays.length > 1 && <Icon as={ChevronDown} size={12} weight={2.8} style={{ color: "var(--muted)" }} />}
    </button>
  );
  const errorBox = error && (
    <div className="remote-error video-glass" data-id="remote.error" role="alert">
      <Icon as={CircleAlert} size={16} style={{ color: "var(--orange)", marginTop: 1 }} />
      <span style={{ flex: 1 }}>{error}</span>
      <button type="button" aria-label="Dismiss" onClick={() => {
        connection.set({ errorMessage: null });
        setLocalError(null);
      }}>
        <Icon as={X} size={12} weight={3} />
      </button>
    </div>
  );

  return (
    <div className="remote" data-id="remote">
      <div className="remote-stage" ref={stageRef} data-id="remote.surface" />
      {!streaming && (
        <div className="remote-stopped">
          {starting ? (
            <>
              <Spinner large color="#fff" />
              <div className="t-headline">Opening on your Mac</div>
            </>
          ) : (
            <>
              <Icon as={AppWindow} size={38} weight={1.6} />
              <div className="t-title3 w-semibold">Session stopped</div>
              <div style={{ width: "100%" }}>
                <PrimaryButton
                  id="remote.start"
                  disabled={s.hostStatus?.screenPermission === false || s.isBusy}
                  onClick={() => connection.start(s.targetWindowID, s.targetName, s.windowLayout).catch((err) => setLocalError(friendly(err)))}
                >
                  Start again
                </PrimaryButton>
              </div>
            </>
          )}
        </div>
      )}

      {editAt && canControl && (
        <div className="edit-bar video-glass" style={{ left: Math.min(Math.max(editAt.x, 150), size.width - 150), top: editAt.y - 60 > 28 + safe.top ? editAt.y - 60 : editAt.y + 60 }}>
          <button type="button" data-id="remote.copy" onClick={copyOnMac}>Copy</button>
          <button type="button" data-id="remote.paste" onClick={pasteOnMac}>Paste</button>
          <button type="button" data-id="remote.selectAll" onClick={() => {
            showEditBar(null);
            connection.sendKey("a", ["cmd"]);
          }}>Select All</button>
        </div>
      )}
      {flash && <div className="remote-flash video-glass" style={{ bottom: landscape ? 24 : safe.bottom + 86 }}>{flash}</div>}

      {landscape ? (
        <>
          {railCollapsed ? (
            <button type="button" className="rail-tab video-glass" data-id="remote.showControls" aria-label="Show controls" onClick={() => setRailCollapsed(false)} style={{ [railSide === "left" ? "left" : "right"]: railEdge }}>
              <span className="status-dot" style={{ background: statusColor }} />
              <Icon as={railSide === "left" ? PanelLeft : PanelRight} size={16} />
            </button>
          ) : (
            <div className="control-rail video-glass" data-id="remote.rail" style={{ [railSide === "left" ? "left" : "right"]: railEdge }}>
              {barButton(railSide === "left" ? PanelLeft : PanelRight, "Hide controls", "remote.hideControls", () => setRailCollapsed(true), false, railKey)}
              {barButton(ChevronLeft, "Back", "remote.back", close, false, railKey)}
              <button type="button" className="rail-status" onClick={displaysMenu || undefined} aria-label={statusLine} style={{ width: railKey, height: 22 }}>
                <span className="status-dot" style={{ background: statusColor }} />
                {streaming && s.latency !== null ? <span>{s.latency}</span> : null}
              </button>
              <div className="rail-spacer" />
              {modeButtons(railKey)}
              {barButton(typing ? KeyboardOff : Keyboard, typing ? "Hide keyboard" : "Type on the Mac", "remote.keyboard", toggleTyping, !canControl, railKey)}
              {barButton(Mic, "Speak to type on the Mac", "remote.mic", startVoice, !canControl, railKey)}
              {barButton(Grid2x2, "Apps and Spotlight", "remote.apps", () => setSheet("apps"), !canControl, railKey)}
              {barButton(PanelBottom, "Show the Dock or the menu bar", "remote.edges", edgesMenu, !canControl, railKey)}
              {zoomButton(railKey)}
              {barButton(SlidersHorizontal, "App controls", "remote.controls", () => setSheet("actions"), false, railKey)}
              {barButton(Settings, "Session options", "remote.options", () => setSheet("options"), false, railKey)}
              <div className="rail-spacer" />
              <button type="button" className="stop-button" aria-label="Stop sharing" data-id="remote.stop" onClick={() => {
                setTyping(false);
                connection.stop();
              }} disabled={!streaming && !starting} style={{ width: railKey, height: railKey }}>
                <Icon as={Square} size={15} fill="currentColor" />
              </button>
            </div>
          )}
          <div style={{ position: "absolute", top: 8, left: railSide === "left" ? (railCollapsed ? 60 : railKey + 30) : 10, right: railSide === "left" ? 10 : railCollapsed ? 60 : railKey + 30, display: "flex", justifyContent: "center", zIndex: 11, pointerEvents: error ? "auto" : "none" }}>
            {errorBox}
          </div>
          {voiceState.active && <div style={{ position: "absolute", bottom: 16, left: 0, right: 0, display: "flex", justifyContent: "center", zIndex: 13 }}><VoicePill overVideo onFinish={finishVoice} /></div>}
        </>
      ) : (
        <>
          <div className="remote-top">
            <button type="button" className="remote-back video-glass" aria-label="Back" data-id="remote.back" onClick={close}>
              <Icon as={ChevronLeft} size={20} weight={2.4} />
            </button>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0, flex: 1, paddingRight: typing ? 0 : 60 }}>
              {statusCapsule}
              {errorBox}
            </div>
            {typing && (
              <button type="button" className="remote-done" data-id="remote.done" onClick={() => {
                keysRef.current?.blur();
                setTyping(false);
              }}>
                Done
              </button>
            )}
          </div>
          {voiceState.active ? (
            <div className="remote-bottom"><VoicePill overVideo onFinish={finishVoice} /></div>
          ) : (
            !typing && (
              <div className="remote-bottom">
                <div className="control-bar video-glass">
                  {modeButtons(barKey)}
                  {barButton(Keyboard, "Type on the Mac", "remote.keyboard", startTyping, !canControl, barKey)}
                  {barButton(Mic, "Speak to type on the Mac", "remote.mic", startVoice, !canControl, barKey)}
                  {barButton(Grid2x2, "Apps and Spotlight", "remote.apps", () => setSheet("apps"), !canControl, barKey)}
                  {barButton(PanelBottom, "Show the Dock or the menu bar", "remote.edges", edgesMenu, !canControl, barKey)}
                  {zoomButton(barKey)}
                  {barButton(SlidersHorizontal, "App controls", "remote.controls", () => setSheet("actions"), false, barKey)}
                  {barButton(Settings, "Session options", "remote.options", () => setSheet("options"), false, barKey)}
                  <button type="button" className="stop-button" aria-label="Stop sharing" data-id="remote.stop" onClick={() => {
                    setTyping(false);
                    connection.stop();
                  }} disabled={!streaming && !starting} style={{ width: barKey, height: barKey }}>
                    <Icon as={Square} size={15} fill="currentColor" />
                  </button>
                </div>
              </div>
            )
          )}
        </>
      )}

      <KeyCatcher
        ref={keysRef}
        active={typing}
        onDismiss={() => setTyping(false)}
        send={(stroke) => (stroke.text !== undefined ? connection.sendText(stroke.text) : connection.sendKey(stroke.key, stroke.modifiers))}
        onSpeak={startVoice}
        onPaste={pasteFromPhone}
        onPhoto={() => {
          keysRef.current?.blur();
          setTyping(false);
          photoRef.current?.click();
        }}
      />
      <input ref={photoRef} type="file" accept="image/*" hidden onChange={(e) => {
        pastePhoto(e.target.files?.[0]);
        e.target.value = "";
      }} />

      {sheet === "apps" && (
        <AppsSheet
          onClose={() => setSheet(null)}
          open={(app) => connection.open(app)}
          launch={launch}
          shortcut={(item) => {
            setSheet(null);
            press(item);
          }}
        />
      )}
      {sheet === "dock" && <DockSheet onClose={() => setSheet(null)} showOnScreen={() => show("dock")} />}
      {sheet === "actions" && <ActionsSheet onClose={() => setSheet(null)} canControl={canControl} busy={actionBusy} setBusy={setActionBusy} />}
      {sheet === "options" && (
        <OptionsSheet
          onClose={() => setSheet(null)}
          statusLine={statusLine}
          readable={() => {
            setFramingOverride("readable");
            setReframeID((n) => n + 1);
            setSheet(null);
          }}
          whole={() => {
            setFramingOverride("fit");
            setReframeID((n) => n + 1);
            setSheet(null);
          }}
          switchLayout={(layout) => {
            setSheet(null);
            connection.start(s.targetWindowID, s.targetName, layout).then(() => {
              setFramingOverride(null);
              setReframeID((n) => n + 1);
            }, (err) => setLocalError(friendly(err)));
          }}
        />
      )}
    </div>
  );
}

/** A picture made small enough to send (at most 2048 px on its longer side), as PNG base64. */
export async function toPNGBase64(blob, maxSide = 2048) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const bytes = new Uint8Array(await png.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
