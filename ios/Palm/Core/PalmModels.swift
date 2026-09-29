import Foundation

// MARK: - Agents

struct PalmProvider: Decodable, Identifiable, Hashable, Sendable {
  let id: String
  let name: String
  let available: Bool
  let version: String?
  let signedIn: Bool?
  let plan: String?
  let detail: String?
  let modes: [String]?
  let models: [String]?
  let modelNames: [String: String]?
  let defaultModel: String?
  /// Reached through the Agent Client Protocol (any agent other than Claude Code and Codex).
  let acp: Bool?
  /// "api": paid per use through the user's OpenRouter key (the optional route).
  let billing: String?
}

/// The optional OpenRouter route: OpenCode on the Mac with the user's key.
struct PalmApiRoute: Decodable, Sendable {
  let enabled: Bool
  let model: String
  let dailyLimitUsd: Double
  let taskLimitUsd: Double
  let keySet: Bool
  let installed: Bool
  let usage: PalmVoiceStatus.Usage?
}

struct PalmRouteModel: Decodable, Identifiable, Hashable, Sendable {
  let id: String
  let name: String
  let inputPerMillion: Double?
  let outputPerMillion: Double?
}

struct PalmProject: Decodable, Identifiable, Hashable, Sendable {
  var id: String { path }
  let name: String
  let path: String
  let markers: [String]
  let scripts: [String]
  let packageName: String?
}

struct PalmTaskSummary: Decodable, Identifiable, Hashable, Sendable {
  let id: String
  let provider: String
  let title: String
  let cwd: String
  let status: String
  let access: String
  let model: String
  let screenControl: Bool
  let created: String
  let updated: String
  let preview: String
  let seq: Int
  let pendingApprovals: Int
  let archived: Bool
  let costUsd: Double?
  /// The agent's name as the Mac knows it (older hosts do not send it).
  let agentName: String?

  var providerName: String { agentName ?? (provider == "codex" ? "Codex" : "Claude Code") }
  var isWorking: Bool { status == "running" || status == "waiting" || status == "starting" }
  /// The folder's name, or "Home folder" for the Mac user's home.
  @MainActor var projectName: String {
    if let home = PalmPath.home, cwd == home { return "Home folder" }
    return (cwd as NSString).lastPathComponent
  }
}

struct PalmAttachmentRef: Decodable, Hashable, Sendable {
  let path: String
  let name: String
  let kind: String
  let size: Int64?
}

/// One durable entry in a task's transcript. Fields depend on `type`.
struct PalmTaskEvent: Decodable, Identifiable, Hashable, Sendable {
  var id: Int { seq }
  let seq: Int
  let at: String?
  let type: String
  let text: String?
  let itemId: String?
  let name: String?
  let title: String?
  let detail: String?
  let status: String?
  let output: String?
  let exitCode: Int?
  let approvalId: String?
  let options: [String]?
  let tool: String?
  let error: String?
  let durationMs: Double?
  let costUsd: Double?
  let model: String?
  let owner: String?
  let fromAgent: Bool?
  let attachments: [PalmAttachmentRef]?
  /// The files a turn made or named, as the Assistant's file cards.
  let files: [PalmAssistantCard]?
}

struct PalmLiveText: Decodable, Hashable, Sendable {
  let itemId: String
  let text: String
}

struct PalmTaskDetail: Decodable, Sendable {
  let task: PalmTaskSummary
  let events: [PalmTaskEvent]
  let live: [PalmLiveText]
}

// MARK: - Files

struct PalmFSItem: Decodable, Identifiable, Hashable, Sendable {
  var id: String { path }
  let name: String
  let path: String
  let kind: String
  let size: Int64?
  let modified: String?
  let hidden: Bool
  let symlink: Bool
  let sensitive: Bool
  let package: Bool

  var isFolder: Bool { kind == "folder" && !package }
  var isImage: Bool {
    ["jpg", "jpeg", "png", "gif", "heic", "heif", "webp", "tiff", "bmp"].contains(
      (name as NSString).pathExtension.lowercased())
  }
}

struct PalmFSListing: Decodable, Sendable {
  let path: String
  let name: String
  let parent: String?
  let items: [PalmFSItem]
  let hiddenCount: Int
  let truncated: Bool
}

struct PalmPlace: Decodable, Identifiable, Hashable, Sendable {
  var id: String { path }
  let name: String
  let path: String
  let symbol: String
}

struct PalmPlaces: Decodable, Sendable {
  let places: [PalmPlace]
  let home: String
  let inbox: String
}

struct PalmUploadResult: Decodable, Sendable {
  let path: String
  let name: String
  let size: Int64
  let sha256: String
  let verified: Bool
  let replaced: Bool
}

struct PalmHash: Decodable, Sendable {
  let path: String
  let size: Int64
  let sha256: String
}

struct PalmTextPreview: Decodable, Sendable {
  let path: String
  let size: Int64
  let truncated: Bool
  let binary: Bool
  let text: String?
}

// MARK: - Terminal

struct PalmTerminalInfo: Decodable, Identifiable, Hashable, Sendable {
  let id: String
  let title: String
  let cwd: String
  let command: String
  let cols: Int
  let rows: Int
  let created: String
  let lastActivity: String
  let running: Bool
  let exitCode: Int?
  let attached: Int
}

// MARK: - Dev servers

struct PalmDevServer: Decodable, Identifiable, Hashable, Sendable {
  let id: String
  let name: String
  let cwd: String
  let command: String
  let status: String
  let pid: Int?
  let port: Int?
  let urls: [String]
  let started: String
  let exitCode: Int?
  let lines: Int
}

struct PalmListeningPort: Decodable, Identifiable, Hashable, Sendable {
  var id: Int { port }
  let port: Int
  let pid: Int?
  let process: String
  let host: String
  let devId: String?
  let name: String?
  let title: String?
  let project: String?
  let cwd: String?
  let framework: String?

  var displayName: String { name ?? title ?? project ?? process }
  var detail: String {
    [framework, ":\(port)", cwd].compactMap { $0 }.joined(separator: " · ")
  }
}

struct PalmPreviewSlot: Decodable, Hashable, Sendable {
  struct Target: Decodable, Hashable, Sendable {
    let port: Int
    let label: String?
    let devId: String?
  }
  let slot: Int
  let publicPort: Int
  let localPort: Int
  let listening: Bool
  let error: String?
  let origin: String?
  let target: Target?
}

struct PalmDevState: Decodable, Sendable {
  let servers: [PalmDevServer]
  let ports: [PalmListeningPort]
  let previews: [PalmPreviewSlot]
}

struct PalmDevLogLine: Decodable, Identifiable, Hashable, Sendable {
  var id: Int { n }
  let n: Int
  let t: Double
  let text: String
}

struct PalmDevLogs: Decodable, Sendable {
  let id: String
  let lines: [PalmDevLogLine]
  let last: Int
}

struct PalmPreviewTicket: Decodable, Sendable {
  let slot: Int
  let origin: String
  let url: String
  let expiresInSeconds: Double
}

// MARK: - Clipboard and system

struct PalmClipboard: Decodable, Sendable {
  let kinds: [String]
  let text: String?
  let textTruncated: Bool?
  let imagePNG: String?
  let imageWidth: Int?
  let imageHeight: Int?
  let imageTooLarge: Bool?
  let files: [String]?
}

struct PalmSystemStatus: Decodable, Sendable {
  struct Power: Decodable, Sendable {
    struct Wake: Decodable, Sendable {
      let ac: Bool
      let battery: Bool
    }
    let source: String
    let batteryPercent: Int?
    let batteryState: String?
    let remaining: String?
    let sleepMinutes: Int?
    let displaySleepMinutes: Int?
    let wakeForNetwork: Wake?
    let sleepPrevented: Bool?
    let fileVault: Bool?
    let lidClosed: Bool?
  }
  struct Display: Decodable, Sendable {
    struct KeyboardLight: Decodable, Sendable {
      let level: Double
      let auto: Bool?
    }
    let brightness: Double?
    let curtain: Bool?
    let builtIn: Bool?
    let displays: Int?
    var keyboardLight: KeyboardLight? = nil
  }
  struct Network: Decodable, Sendable {
    struct Path: Decodable, Sendable {
      let device: String?
      let direct: Bool
      let via: String
      let milliseconds: Double?
    }
    let available: Bool
    let health: [String]?
    let path: Path?
  }
  struct KeepAwake: Decodable, Sendable {
    let on: Bool
    let reason: String?
  }
  struct Capability: Decodable, Identifiable, Sendable {
    let id: String
    let title: String
    let state: String
    let detail: String
  }
  struct LoginItem: Decodable, Sendable {
    /// enabled, off, requiresApproval, notFound or unavailable (development run).
    let status: String
    let error: String?
  }
  let power: Power?
  let display: Display?
  let network: Network?
  let keepAwake: KeepAwake
  let capabilities: [Capability]
  var loginItem: LoginItem? = nil
  /// When a "Sleep later" timer will put the Mac to sleep.
  var sleepAt: String? = nil
}

struct PalmWakeInfo: Codable, Sendable {
  struct Interface: Codable, Sendable {
    let name: String?
    let device: String
    let mac: String
    let address: String
    let broadcast: String
  }
  let interfaces: [Interface]
}

struct PalmActionResult: Decodable, Sendable {
  let ok: Bool?
  let detail: String?
  let brightness: Double?
  let curtain: Bool?
  let on: Bool?
}

struct PalmScreenState: Decodable, Sendable {
  struct Owner: Decodable, Sendable {
    let kind: String
    let taskId: String?
  }
  let phase: String
  let owner: Owner?
  let held: Bool
  let heldFrom: String?

  var ownerValue: PalmScreenOwner { PalmScreenOwner(kind: owner?.kind, taskId: owner?.taskId, held: held) }
}

extension Int64 {
  var palmBytes: String { ByteCountFormatter.string(fromByteCount: self, countStyle: .file) }
}

enum PalmTime {
  static let iso: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  static func date(_ value: String?) -> Date? {
    guard let value else { return nil }
    return iso.date(from: value) ?? ISO8601DateFormatter().date(from: value)
  }
  /// "now" for the last minute (and for Mac clocks a moment ahead of the
  /// phone's), then "5 min. ago", "2 hr. ago" and so on.
  static func relative(_ value: String?) -> String {
    guard let date = date(value) else { return "" }
    if date.timeIntervalSinceNow > -60 { return "now" }
    return relativeFormatter.localizedString(for: date, relativeTo: Date())
  }
  private static let relativeFormatter: RelativeDateTimeFormatter = {
    let f = RelativeDateTimeFormatter()
    f.unitsStyle = .short
    return f
  }()
}

/// Mac paths as the phone shows them: the Mac user's home folder reads as "~".
enum PalmPath {
  /// Set from the Mac's status; used by views that have no connection.
  @MainActor static var home: String?

  @MainActor static func display(_ path: String) -> String { display(path, home: home) }

  static func display(_ path: String, home: String?) -> String {
    guard let home, !home.isEmpty, home != "/" else { return path }
    if path == home { return "~" }
    if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
    return path
  }
}

extension PalmConnection {
  /// The Mac user's home folder, once the Mac has reported it.
  var macHome: String? { hostStatus?.home }
  func displayPath(_ path: String) -> String { PalmPath.display(path, home: macHome) }
}

enum PalmText {
  /// A short version that ends on a whole word, with no "…": Palm shows no
  /// truncation marks.
  static func excerpt(_ text: String, max: Int) -> String {
    let clean = text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard clean.count > max else { return clean }
    let cut = clean.prefix(max)
    if let space = cut.lastIndex(of: " "), cut.distance(from: cut.startIndex, to: space) > max / 2 {
      return String(cut[..<space]).trimmingCharacters(in: CharacterSet(charactersIn: " ,;:-"))
    }
    return String(cut)
  }
}

// MARK: - Assistant and what Palm remembers

/// One answer from the assistant: a short reply and results to act on.
struct PalmAssistantReply: Codable, Hashable, Sendable {
  let reply: String
  let cards: [PalmAssistantCard]
}

/// A result the phone can act on: a file, an agent session, a preview, a
/// destination folder, or a request to hand to the user's own agent.
struct PalmAssistantCard: Codable, Hashable, Sendable, Identifiable {
  let type: String
  var name: String?
  var path: String?
  var folder: String?
  var modified: String?
  var size: Int64?
  var sensitive: Bool?
  var device: String?
  var taskId: String?
  var title: String?
  var provider: String?
  var agentName: String?
  var cwd: String?
  var status: String?
  var pendingApprovals: Int?
  var devId: String?
  var port: Int?
  var text: String?
  /// An agent Palm did not start (Claude Code, Codex, OpenCode), from the watch.
  var agentId: String?
  /// Choices when a name fits several things, or none: each sends an exact request.
  var options: [Option]?
  /// An offer to hand the request to an agent: one tap starts it.
  var proposalId: String?
  /// A hand-off's text is the brief the agent will get (rewritten from what was said).
  var briefed: Bool?
  var agents: [Agent]?
  /// A file the user asked to have on the phone: saved once, by itself.
  var autoSave: Bool?

  struct Option: Codable, Hashable, Sendable {
    let label: String
    let detail: String?
    let request: String
  }

  struct Agent: Codable, Hashable, Sendable {
    let id: String
    let name: String
  }

  var id: String { [type, path, taskId, devId, agentId, proposalId, title, text].compactMap { $0 }.joined(separator: "|") }
}

/// What came back later to an Assistant request: an agent's result, a
/// question it asks, or the session it started.
struct PalmAssistantFollowup: Codable, Hashable, Sendable, Identifiable {
  let id: String
  let reply: String
  let cards: [PalmAssistantCard]
}

// MARK: - Paired computers

/// A computer this phone is paired with. Each has its own pairing (token) in
/// the Keychain; tasks, files and screens belong to the computer they are on.
struct PalmDevice: Identifiable, Hashable, Sendable {
  let id: String
  let host: String
  var name: String
  let expires: Double

  /// "my-mac" from "https://my-mac.tail1234.ts.net:8443".
  static func label(for host: String) -> String {
    URL(string: host)?.host?.split(separator: ".").first.map(String.init) ?? host
  }
}

// MARK: - Every agent on the Mac

/// An agent session on the Mac, wherever it started: Palm, Claude Code (the
/// desktop app or a terminal), Codex or OpenCode. Read from the apps' own
/// files on the Mac; Palm shows it and can open it there, never drives it.
struct PalmWatchSession: Decodable, Identifiable, Hashable, Sendable {
  struct Child: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String
    let kind: String?
    let status: String
    let activity: String
    let updated: String
  }
  let id: String
  let source: String
  let app: String
  let title: String
  let cwd: String
  let project: String
  let status: String
  let activity: String
  let latestMessage: String
  let latestUser: String
  let updated: String
  let children: [Child]
  let childrenWorking: Int
  let openable: Bool
  let evidence: String
  let palmTaskId: String?

  var isActive: Bool { ["attention", "error", "working", "quiet"].contains(status) }
  var updatedDate: Date? { PalmTime.date(updated) }
}

struct PalmWatchResult: Decodable, Sendable {
  let sessions: [PalmWatchSession]
  let issues: [String]
  let at: String
}

/// A session that just finished its turn, needs you, or stopped with an error.
struct PalmWatchAlert: Decodable, Hashable, Sendable {
  let kind: String
  let id: String
  let title: String
  let app: String
  let source: String
  let palmTaskId: String?
  let text: String
  /// Scheduled or repeating work: a Codex run started by a tool, or a title seen before.
  let routine: Bool?
}

/// One of the Mac's screens (a Mac with several monitors).
struct PalmDisplay: Decodable, Identifiable, Hashable, Sendable {
  let id: Int
  let name: String
  let width: Double
  let height: Double
  let main: Bool
}

struct PalmMemorySnapshot: Decodable, Sendable {
  struct Place: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String
    let path: String
    let exists: Bool
  }
  struct Preferences: Decodable, Sendable {
    let defaultAgent: String?
    let answerQuestions: Bool?
  }
  let aliases: [Place]
  let workspaces: [Place]
  let preferences: Preferences
}

/// Voice on the Mac: whether an OpenRouter key is set (it stays on the Mac)
/// and what that key has spent, as OpenRouter reports it.
struct PalmVoiceStatus: Decodable, Sendable {
  struct Usage: Decodable, Sendable {
    let today: Double?
    let month: Double?
    let total: Double?
    let limit: Double?
    let remaining: Double?
  }
  let configured: Bool
  let keyHint: String?
  let usage: Usage?
}
