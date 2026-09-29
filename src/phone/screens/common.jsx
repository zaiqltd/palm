// Pieces several screens share.
import { friendly } from "../core/api.js";
import { connection } from "../core/connection.js";
import { nav } from "../core/navigator.js";

/** The navigation subtitle every tab shows: the Mac's name (· offline). */
export function deviceSubtitle(s) {
  const name = s.hostStatus?.name || "Mac";
  return name + (s.connectionState === "offline" ? " · offline" : "");
}

/** The whole Mac screen, live, over everything (the Screen tab's first row). */
export function showDesktop() {
  nav.set({ remote: true });
  if (connection.isStreaming && connection.state.targetWindowID === 0) return;
  connection.start(0, "Desktop").catch((err) => connection.set({ errorMessage: friendly(err) }));
}
