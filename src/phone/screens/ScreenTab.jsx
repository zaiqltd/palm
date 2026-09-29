// The Screen tab (PalmAppsView): the whole Mac screen, and every open app with
// its windows. Opening one starts the live screen (RemoteView) over the tabs.
import React, { useState } from "react";
import { CircleDot, Hand, RotateCw, WifiOff } from "lucide-react";
import { connection } from "../core/connection.js";
import { friendly } from "../core/api.js";
import { nav } from "../core/navigator.js";
import { useStore } from "../core/store.js";
import { AppIcon, GlassButton, NavBar, Row, SearchField, Section, Symbol, List, useToast } from "../ui/kit.jsx";
import { deviceSubtitle } from "./common.jsx";

const windowTitle = (w) => (w.title || "").trim() || "Untitled window";

export function ScreenTab({ opening, showDesktop, openApp, openWindow }) {
  const s = useStore(connection.store, (s) => ({ apps: s.apps, hostStatus: s.hostStatus, connectionState: s.connectionState, isBusy: s.isBusy }));
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();
  const query = search.trim().toLowerCase();
  const busy = opening || s.isBusy;
  const filtered = s.apps
    .filter((app) => !query || app.name.toLowerCase().includes(query) || app.windows.some((w) => windowTitle(w).toLowerCase().includes(query)))
    .sort((a, b) => (a.active !== b.active ? (a.active ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })));
  const visibleWindows = (app) => (!query || app.name.toLowerCase().includes(query) ? app.windows : app.windows.filter((w) => windowTitle(w).toLowerCase().includes(query)));
  async function refresh() {
    if (refreshing || busy) return;
    setRefreshing(true);
    try {
      await connection.refresh();
    } catch (error) {
      toast(friendly(error), { warning: true });
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <div className="stack-screen">
      <NavBar
        title="Screen"
        subtitle={deviceSubtitle(s)}
        trailing={<GlassButton symbol="arrow.clockwise" label="Refresh apps and windows" onClick={refresh} disabled={busy || refreshing} id="screen.refresh" />}
      >
        <SearchField value={search} onChange={setSearch} placeholder="Search apps and windows" id="screen.search" />
      </NavBar>
      <div className="scroll">
        <List>
          {s.connectionState === "offline" && (
            <Section>
              <Row
                icon={WifiOff}
                title={<span className="warning">Your Mac is unreachable. Check that it is awake, Palm is running and Tailscale is connected on both devices.</span>}
              />
              <Row icon={RotateCw} title="Check connection" onClick={() => connection.retry()} disabled={busy} accent id="screen.retry" />
            </Section>
          )}
          {(s.hostStatus?.screenPermission === false || s.hostStatus?.controlPermission === false) && (
            <Section>
              {s.hostStatus?.screenPermission === false && (
                <Row icon={CircleDot} title={<span className="warning">Allow Palm in Screen & System Audio Recording on your Mac, then restart Palm.</span>} />
              )}
              {s.hostStatus?.controlPermission === false && (
                <Row icon={Hand} title={<span className="warning">Viewing only. Allow Palm in Accessibility on your Mac to control apps.</span>} />
              )}
            </Section>
          )}
          {!query && (
            <Section>
              <Row
                onClick={showDesktop}
                disabled={busy}
                id="screen.desktop"
                label="Open the full Mac desktop"
                leading={
                  <span className="tile">
                    <Symbol name="desktopcomputer" />
                  </span>
                }
                inset={74}
                title={<span className="w-semibold">Whole Mac screen</span>}
                detail="See and control everything on the Mac"
                chevron="spaced"
              />
            </Section>
          )}
          <Section header={query ? "Matches" : "Open apps"}>
            {filtered.map((app) => (
              <React.Fragment key={app.bundleId}>
                <Row
                  onClick={() => openApp(app)}
                  disabled={busy}
                  id={`apps.open.${app.bundleId}`}
                  label={`Open ${app.name} on your Mac`}
                  leading={<AppIcon name={app.name} icon={app.icon} size={40} />}
                  inset={app.icon ? 74 : 34}
                  title={<span className="w-semibold">{app.name}</span>}
                  detail={app.active ? "In front on your Mac" : undefined}
                  chevron="spaced"
                />
                {visibleWindows(app).map((w) => (
                  <Row
                    key={w.id}
                    onClick={() => openWindow(app, w)}
                    disabled={busy}
                    id={`apps.window.${w.id}`}
                    label={`Open ${windowTitle(w)} in ${app.name}`}
                    leading={
                      <span className="window-glyph">
                        <Symbol name="macwindow" />
                      </span>
                    }
                    inset={72}
                    className="window-row"
                    title={windowTitle(w)}
                    titleClassName="t-subheadline"
                  />
                ))}
              </React.Fragment>
            ))}
            {filtered.length === 0 && <Row title={<span className="muted">{query ? "No app or window matches." : "No open apps were listed. Tap Refresh to check again."}</span>} />}
          </Section>
        </List>
      </div>
    </div>
  );
}
