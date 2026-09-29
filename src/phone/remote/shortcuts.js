// The Mac's Dock and menu bar, and its standard shortcuts (PalmMacEdge,
// PalmMacShortcut): what the live screen's Apps sheet and edges menu send.
import { ArrowLeftRight, Layers, PanelBottom, PanelTop, Search } from "lucide-react";

export const EDGES = {
  dock: { title: "Dock", icon: PanelBottom, focus: { x: 0.5, y: 1 } },
  menuBar: { title: "Menu bar", icon: PanelTop, focus: { x: 0, y: 0 } },
};
export const SHORTCUTS = [
  { id: "spotlight", title: "Spotlight", icon: Search, key: "space", modifiers: ["cmd"], focus: { x: 0.5, y: 0 } },
  { id: "lastApp", title: "Last app", icon: ArrowLeftRight, key: "tab", modifiers: ["cmd"] },
  { id: "missionControl", title: "Mission Control", icon: Layers, key: "up", modifiers: ["ctrl"] },
];
