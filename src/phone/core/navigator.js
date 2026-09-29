// Where the app is (PalmNavigator): the tab, the session open in Agents, a
// folder Files should open, each tab's pushed screens, and sheets.
import { createStore } from "./store.js";

export const nav = createStore({
  tab: "assistant",
  /** The session shown in Agents; null shows the list of every session. */
  agentTask: null,
  /** A folder for Files to open next. */
  filesFolder: null,
  /** An agent Palm did not start, shown in Agents. */
  watchSession: null,
  /** Each tab's navigation stack (screens pushed on top of its root). */
  stacks: { assistant: [], agents: [], files: [], screen: [], more: [] },
  /** The live screen, full screen over everything. */
  remote: false,
  addingComputer: false,
  managingComputers: false,
});

export const navigate = {
  tab(tab) {
    const s = nav.get();
    // Tapping the selected tab again returns to its root, as on iOS.
    if (s.tab === tab && s.stacks[tab].length) nav.set({ stacks: { ...s.stacks, [tab]: [] } });
    else nav.set({ tab });
  },
  push(screen, props = {}) {
    const s = nav.get();
    nav.set({ stacks: { ...s.stacks, [s.tab]: [...s.stacks[s.tab], { screen, props, key: crypto.randomUUID() }] } });
  },
  pop() {
    const s = nav.get();
    nav.set({ stacks: { ...s.stacks, [s.tab]: s.stacks[s.tab].slice(0, -1) } });
  },
  popToRoot(tab = nav.get().tab) {
    const s = nav.get();
    nav.set({ stacks: { ...s.stacks, [tab]: [] } });
  },
  openAgent(id) {
    nav.set({ agentTask: id, tab: "agents" });
  },
  /** Any agent on the Mac: Palm's own open in the strip, others in their sheet. */
  openWatch(id, palmTaskId) {
    if (palmTaskId) return this.openAgent(palmTaskId);
    nav.set({ agentTask: null, watchSession: id, tab: "agents" });
  },
  openFolder(path) {
    const s = nav.get();
    nav.set({ filesFolder: path, tab: "files", stacks: { ...s.stacks, files: [] } });
  },
};
