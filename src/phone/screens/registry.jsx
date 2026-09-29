// Every screen the tabs show: each tab's root, and the screens pushed on top.
import { AgentsTab } from "./agents.jsx";
import { AssistantTab } from "./assistant.jsx";
import { FilesTab, FolderScreen } from "./files.jsx";
import { MacScreen } from "./mac.jsx";
import { MediaScreen } from "./media.jsx";
import { ComputersScreen, MoreTab, PreferencesScreen, RouteModelsScreen, SettingsScreen, TimingsScreen } from "./more.jsx";
import { TerminalScreen } from "./terminal.jsx";

export const ROOTS = {
  assistant: AssistantTab,
  agents: AgentsTab,
  files: FilesTab,
  more: MoreTab,
};

export const SCREENS = {
  folder: FolderScreen,
  computers: ComputersScreen,
  terminal: TerminalScreen,
  mac: MacScreen,
  media: MediaScreen,
  preferences: PreferencesScreen,
  timings: TimingsScreen,
  settings: SettingsScreen,
  routeModels: RouteModelsScreen,
};
