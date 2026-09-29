// The live screen's sheets: Apps and Spotlight (PalmScreenAppsSheet), the Dock
// (PalmDockSheet), App controls and Session options (PalmRemoteView).
import React, { useEffect, useState } from "react";
import { ChevronRight, Folder, Hand, Maximize2, PanelBottom, RotateCw, Trash2, ZoomIn } from "lucide-react";
import { connection } from "../core/connection.js";
import { friendly, get, post } from "../core/api.js";
import { useStore } from "../core/store.js";
import { usePref, KEYS } from "../core/prefs.js";
import { AppIcon, ContentUnavailable, DoneButton, GlassButton, Icon, List, Notice, PickerRow, Row, SearchField, Section, SecondaryButton, Sheet, Spinner, ToggleRow } from "../ui/kit.jsx";
import { SHORTCUTS } from "./shortcuts.js";

export function AppsSheet({ onClose, open, launch, shortcut }) {
  const apps = useStore(connection.store, (s) => s.apps);
  const installed = useStore(connection.store, (s) => s.installedApps);
  const [search, setSearch] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const query = search.trim().toLowerCase();
  const running = apps
    .filter((a) => !query || a.name.toLowerCase().includes(query))
    .sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })));
  const openIds = new Set(apps.map((a) => a.bundleId));
  const others = installed.filter((a) => !openIds.has(a.bundleId) && (!query || a.name.toLowerCase().includes(query)));
  useEffect(() => {
    (async () => {
      try {
        await connection.refreshApps();
      } catch (err) {
        setError(friendly(err));
      }
      try {
        const result = await get("/api/apps/installed");
        connection.set({ installedApps: result.apps || [] });
      } catch (err) {
        if (!connection.state.installedApps.length) setError(friendly(err));
      }
    })();
  }, []);
  const row = (name, icon, detail, id, action, dataId) => (
    <Row
      key={id}
      id={dataId}
      disabled={busy !== null}
      onClick={async () => {
        if (busy !== null) return;
        setBusy(id);
        try {
          await action();
          onClose();
        } catch (err) {
          setError(friendly(err));
        } finally {
          setBusy(null);
        }
      }}
      leading={<AppIcon name={name} icon={icon} size={32} />}
      title={name}
      trailing={busy === id ? <Spinner /> : detail ? <span className="t-caption muted">{detail}</span> : null}
    />
  );
  return (
    <Sheet title="Apps" detent="medium" onClose={onClose} trailing={<DoneButton onClick={onClose} />} id="remote.appsSheet">
      <SearchField value={search} onChange={setSearch} placeholder="Find an app" id="apps.search" />
      <div className="shortcut-tiles">
        {SHORTCUTS.map((item) => (
          <button key={item.id} type="button" data-id={`apps.shortcut.${item.id}`} onClick={() => shortcut(item)}>
            <Icon as={item.icon} size={20} weight={2} />
            {item.title}
          </button>
        ))}
      </div>
      <List>
        {error && (
          <Section>
            <Row title={<span className="t-footnote warning">{error}</span>} />
          </Section>
        )}
        <Section header="Open on the Mac">
          {running.length === 0 && <Row title={<span className="muted">{query ? "None open match." : "No apps with windows are open."}</span>} />}
          {running.map((app) => row(app.name, app.icon, app.active ? "In front" : null, app.bundleId, () => open(app), "apps.running"))}
        </Section>
        <Section header="Other apps">
          {installed.length === 0 ? (
            <Row leading={<Spinner />} title={<span className="muted">Reading the Mac's apps</span>} />
          ) : others.length === 0 ? (
            <Row title={<span className="muted">None match.</span>} />
          ) : null}
          {others.map((app) => row(app.name, app.icon, null, app.bundleId, () => launch(app), "apps.installed"))}
        </Section>
      </List>
    </Sheet>
  );
}

/** The Mac's own Dock at a size a finger can use; a tap does what clicking it does. */
export function DockSheet({ onClose, showOnScreen }) {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    get("/api/dock")
      .then((list) => setItems(list.items || []))
      .catch((err) => setError(friendly(err)))
      .finally(() => setLoaded(true));
  }, []);
  return (
    <Sheet title="Dock" detent="medium" onClose={onClose} trailing={<DoneButton onClick={onClose} />} id="remote.dockSheet">
      <List>
        {(error || !loaded || (loaded && !items.length && !error)) && (
          <Section>
            {error && <Row title={<span className="t-footnote warning">{error}</span>} />}
            {!loaded && <Row leading={<Spinner />} title={<span className="muted">Reading the Dock</span>} />}
            {loaded && !items.length && !error && <Row title={<span className="muted">The Dock could not be read. Allow Accessibility for Palm on your Mac.</span>} />}
          </Section>
        )}
        <Section footer="Your Mac's Dock, in its order. A dot means the app is open.">
          {items.map((item) => (
            <Row
              key={item.id}
              id="dock.item"
              disabled={busy !== null}
              onClick={async () => {
                if (busy !== null) return;
                setBusy(item.id);
                try {
                  await post("/api/command", { op: "dockPress", index: item.id });
                  onClose();
                } catch (err) {
                  setError(friendly(err));
                } finally {
                  setBusy(null);
                }
              }}
              leading={
                item.kind === "trash" ? (
                  <span style={{ width: 32, display: "grid", placeItems: "center" }}><Icon as={Trash2} size={22} weight={1.8} /></span>
                ) : item.kind === "folder" && !item.icon ? (
                  <span style={{ width: 32, display: "grid", placeItems: "center" }}><Icon as={Folder} size={22} weight={1.8} /></span>
                ) : (
                  <AppIcon name={item.title} icon={item.icon} size={32} />
                )
              }
              title={item.title}
              trailing={busy === item.id ? <Spinner /> : item.running ? <span className="dock-dot" aria-label="Open" /> : null}
            />
          ))}
        </Section>
        <Section>
          <Row icon={PanelBottom} title="Show the Dock on the screen" id="dock.showOnScreen" onClick={() => {
            onClose();
            showOnScreen();
          }} />
        </Section>
      </List>
    </Sheet>
  );
}

export function ActionsSheet({ onClose, canControl, busy, setBusy }) {
  const actions = useStore(connection.store, (s) => s.actions);
  const [error, setError] = useState(null);
  const refresh = async () => {
    if (!canControl || busy) return;
    setBusy(true);
    try {
      await connection.refreshActions();
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    refresh();
  }, []);
  return (
    <Sheet
      title="App controls"
      detent="medium"
      passthrough
      onClose={onClose}
      leading={<GlassButton icon={RotateCw} label="Refresh app controls" onClick={refresh} disabled={busy || !canControl} size={18} />}
      trailing={<DoneButton onClick={onClose} />}
      id="remote.actionsSheet"
    >
      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="t-subheadline muted">Buttons exposed by the selected Mac app.</div>
        {error && <Notice warning>{error}</Notice>}
        {actions.map((action) => (
          <SecondaryButton
            key={action.id}
            disabled={!canControl || busy}
            onClick={async () => {
              if (!canControl || busy) return;
              setBusy(true);
              try {
                await connection.performAction(action.id);
              } catch (err) {
                setError(friendly(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <span style={{ flex: 1, textAlign: "left" }}>{action.title}</span>
            <Icon as={ChevronRight} size={13} weight={2.6} />
          </SecondaryButton>
        ))}
        {busy && (
          <div style={{ display: "grid", placeItems: "center", padding: 8 }}>
            <Spinner />
          </div>
        )}
        {!actions.length && !busy && <ContentUnavailable icon={Hand} title="No app controls available" description="Use the live view to interact with this app." />}
      </div>
    </Sheet>
  );
}

export function OptionsSheet({ onClose, statusLine, readable, whole, switchLayout }) {
  const s = useStore(connection.store, (s) => ({
    targetName: s.targetName, targetWindowID: s.targetWindowID, windowLayout: s.windowLayout, phoneLayout: s.phoneLayout,
    fps: s.fps, latency: s.latencyMilliseconds, hostStatus: s.hostStatus, isBusy: s.isBusy,
  }));
  const [invertScroll, setInvertScroll] = usePref(KEYS.invertScroll, false);
  const [railSide, setRailSide] = usePref(KEYS.railSide, "right");
  const layoutNote =
    s.windowLayout === "original"
      ? "The window keeps its size on the Mac."
      : !s.phoneLayout?.applied
        ? s.phoneLayout?.reason || "This app keeps its size."
        : s.windowLayout === "fill"
          ? "The window fills your Mac screen while you view it here. Its previous size comes back when you leave, unless you change it on the Mac."
          : "The window takes the phone's shape while you view it here. Its previous size comes back when you leave, unless you change it on the Mac.";
  return (
    <Sheet title="Session options" detent="medium" onClose={onClose} trailing={<DoneButton onClick={onClose} />} id="remote.optionsSheet">
      <List>
        <Section header="View">
          <Row title="App" value={s.targetName} />
          <Row title={<span className="t-footnote muted">{statusLine}</span>} />
          <Row icon={ZoomIn} title="Readable view" onClick={readable} accent />
          <Row icon={Maximize2} title="Whole window" onClick={whole} accent />
          <ToggleRow title="Invert scrolling" checked={invertScroll} onChange={setInvertScroll} id="remote.invertScroll" />
          <PickerRow
            title="Controls in landscape"
            value={railSide}
            onChange={setRailSide}
            id="remote.railSide"
            options={[
              { value: "right", label: "Right side" },
              { value: "left", label: "Left side" },
            ]}
          />
        </Section>
        {s.targetWindowID > 0 && (
          <Section header="Window layout" footer={layoutNote}>
            <PickerRow
              title="Window size"
              value={s.windowLayout}
              onChange={(layout) => layout !== s.windowLayout && switchLayout(layout)}
              disabled={s.isBusy}
              id="remote.windowLayout"
              options={[
                { value: "fill", label: "Fill the Mac screen" },
                { value: "phone", label: "Phone shaped" },
                { value: "original", label: "As it was" },
              ]}
            />
          </Section>
        )}
        <Section header="Using the live view">
          <Row title="Touch: tap to click, double-tap to open, drag one finger to scroll, hold to right-click, hold then move to drag. Pinch or use two fingers to zoom and move the view." />
          <Row title="Mouse: slide one finger to move the pointer, tap to click, two fingers to scroll, hold then move to drag." />
          <Row title="Keyboard: keys go to the Mac as you type. ⌘ ⌥ ⌃ ⇧ in the key bar apply to the next key." />
        </Section>
        <Section header="Connection">
          <Row title="Received frames" value={`${s.fps} fps`} />
          {s.latency !== null && <Row title="Network round trip" value={`${s.latency} ms`} />}
          <Row title={<span className="t-footnote muted">Network round trip does not measure the delay before a change appears on screen.</span>} />
          {s.hostStatus?.controlPermission === false && <Row title="View only. Enable Palm in Accessibility on your Mac to control apps." />}
        </Section>
      </List>
    </Sheet>
  );
}
