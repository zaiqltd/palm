import SwiftUI

enum PalmTab: Hashable { case assistant, agents, files, screen, more }

/// Where the app is: the tab, the session open in Agents and a folder Files
/// should show. The assistant uses it to hand results over ("Open agent"
/// opens that same session in Agents, never a copy).
@MainActor
final class PalmNavigator: ObservableObject {
  @Published var tab = PalmTab.assistant
  /// The session shown in Agents; nil shows the list of every session.
  @Published var agentTask: String?
  /// A folder for Files to open next.
  @Published var filesFolder: String?
  /// An agent Palm did not start, shown in Agents (Claude Code, Codex, OpenCode).
  @Published var watchSession: String?
  /// Pairing another computer, or the list of computers.
  @Published var addingComputer = false
  @Published var managingComputers = false

  /// Another computer was chosen: nothing open belongs to it.
  func computerChanged() {
    agentTask = nil
    watchSession = nil
    filesFolder = nil
  }

  func openAgent(_ id: String) {
    agentTask = id
    tab = .agents
  }

  /// Any agent on the Mac: Palm's own open in the strip, others in their sheet.
  func openWatch(_ id: String, palmTaskId: String? = nil) {
    if let palmTaskId { return openAgent(palmTaskId) }
    agentTask = nil
    watchSession = id
    tab = .agents
  }

  func openFolder(_ path: String) {
    filesFolder = path
    tab = .files
  }
}
