import SwiftUI
import UIKit

// Every agent on the Mac, wherever it started ("see whats
// running ... get notifications as things finish ... no matter where the agent
// is from"): Palm's sessions, Claude Code in the desktop app or a terminal
// (with the agents it launches), Codex and OpenCode. The Mac reads their own
// files; the phone shows them, alerts when one finishes, needs you or stops
// with an error, and can open one in its app on the Mac. Palm never drives an
// agent it did not start.

/// The list, kept current while Palm is open. The Mac scans only while a phone
/// listens, so alerts for anything that changed while Palm was closed arrive
/// when it opens again.
@MainActor
final class PalmAgentWatch: ObservableObject {
  static let shared = PalmAgentWatch()

  @Published private(set) var sessions: [PalmWatchSession] = []
  @Published private(set) var loaded = false
  @Published var error: String?
  private var listener: UUID?
  private var reconnect: UUID?

  static let finishedKey = "palm.notify.finished"
  static let attentionKey = "palm.notify.attention"
  /// No alerts for repeating or scheduled agents (on unless turned off).
  static let muteRoutineKey = "palm.notify.muteRoutine"
  static let mutedTitlesKey = "palm.notify.mutedTitles"

  static var mutesRoutine: Bool { UserDefaults.standard.object(forKey: muteRoutineKey) as? Bool ?? true }
  private static func key(_ title: String) -> String {
    title.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }
  static func isMuted(_ title: String) -> Bool {
    (UserDefaults.standard.stringArray(forKey: mutedTitlesKey) ?? []).contains(key(title))
  }
  static func setMuted(_ title: String, _ muted: Bool) {
    var titles = UserDefaults.standard.stringArray(forKey: mutedTitlesKey) ?? []
    titles.removeAll { $0 == key(title) }
    if muted { titles.append(key(title)) }
    UserDefaults.standard.set(Array(titles.suffix(200)), forKey: mutedTitlesKey)
  }

  /// Agents Palm did not start.
  var others: [PalmWatchSession] { sessions.filter { $0.source != "palm" } }

  func start(_ connection: PalmConnection, events: PalmEvents) {
    guard listener == nil else { return }
    UserDefaults.standard.register(defaults: [Self.finishedKey: true, Self.attentionKey: true])
    listener = events.listen("watch") { [weak self] message in self?.receive(message) }
    reconnect = events.whenConnected { [weak self] in
      guard let self else { return }
      Task { await self.refresh(connection) }
    }
    Task { await refresh(connection) }
  }

  /// Another computer: its own agents.
  func computerChanged(_ connection: PalmConnection) {
    sessions = []
    loaded = false
    Task { await refresh(connection) }
  }

  func refresh(_ connection: PalmConnection) async {
    do {
      let result: PalmWatchResult = try await connection.get("/api/agents/watch")
      sessions = result.sessions
      loaded = true
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  func session(_ id: String) -> PalmWatchSession? { sessions.first { $0.id == id } }

  private func receive(_ message: [String: Any]) {
    switch message["event"] as? String {
    case "watch.updated":
      guard let raw = message["sessions"], let data = try? JSONSerialization.data(withJSONObject: raw),
        let list = try? JSONDecoder().decode([PalmWatchSession].self, from: data)
      else { return }
      sessions = list
      loaded = true
    case "watch.changed":
      // Only the sessions that changed arrive; the rest are kept.
      let removed = Set(message["removed"] as? [String] ?? [])
      var list = sessions.filter { !removed.contains($0.id) }
      if let raw = message["upserts"], let data = try? JSONSerialization.data(withJSONObject: raw),
        let upserts = try? JSONDecoder().decode([PalmWatchSession].self, from: data)
      {
        for session in upserts {
          if let index = list.firstIndex(where: { $0.id == session.id }) { list[index] = session } else { list.append(session) }
        }
      }
      sessions = list.sorted { a, b in
        let (ra, rb) = (Self.rank[a.status] ?? 9, Self.rank[b.status] ?? 9)
        return ra != rb ? ra < rb : (a.updatedDate ?? .distantPast) > (b.updatedDate ?? .distantPast)
      }
    case "watch.alerts":
      guard let raw = message["alerts"], let data = try? JSONSerialization.data(withJSONObject: raw),
        let alerts = try? JSONDecoder().decode([PalmWatchAlert].self, from: data)
      else { return }
      PalmWatchAlerts.shared.show(alerts)
    default: return
    }
  }

  static let rank = ["attention": 0, "error": 1, "working": 2, "quiet": 3, "finished": 4, "idle": 5, "unknown": 6]
}

/// The alert line on its own, so screens that show it (every tab, the live
/// screen) do not redraw whenever an agent's status moves.
@MainActor
final class PalmWatchAlerts: ObservableObject {
  static let shared = PalmWatchAlerts()
  @Published var banner: PalmWatchAlert?
  private var bannerTimer: Task<Void, Never>?
  /// True for the session open in front of you: it needs no alert.
  var isOnScreen: (PalmWatchAlert) -> Bool = { _ in false }

  /// One banner at a time: several changes at once become one line.
  func show(_ alerts: [PalmWatchAlert]) {
    // UI tests see alerts only when a test asks for them: sessions left by
    // earlier tests would otherwise pop up in the middle of another test.
    let environment = ProcessInfo.processInfo.environment
    if environment["PALM_UITEST_HOST"] != nil && environment["PALM_UITEST_ALERTS"] != "1" { return }
    let defaults = UserDefaults.standard
    let wanted = alerts.filter { alert in
      !isOnScreen(alert)
        && !(alert.routine == true && PalmAgentWatch.mutesRoutine)
        && !PalmAgentWatch.isMuted(alert.title)
        && (alert.kind == "finished"
          ? defaults.bool(forKey: PalmAgentWatch.finishedKey) : defaults.bool(forKey: PalmAgentWatch.attentionKey))
    }
    guard let last = wanted.last else { return }
    let needsYou = wanted.filter { $0.kind != "finished" }
    let alert: PalmWatchAlert
    if wanted.count == 1 {
      alert = last
    } else {
      let finished = wanted.count - needsYou.count
      let parts = [finished > 0 ? "\(finished) finished" : nil, needsYou.isEmpty ? nil : "\(needsYou.count) need you"].compactMap { $0 }
      let lead = needsYou.last ?? last
      alert = PalmWatchAlert(
        kind: needsYou.isEmpty ? "finished" : "attention", id: lead.id, title: lead.title, app: lead.app,
        source: lead.source, palmTaskId: lead.palmTaskId, text: "\(wanted.count) agents: " + parts.joined(separator: ", "),
        routine: false)
    }
    UINotificationFeedbackGenerator().notificationOccurred(alert.kind == "finished" ? .success : .warning)
    withAnimation(.snappy) { banner = alert }
    bannerTimer?.cancel()
    bannerTimer = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 7_000_000_000)
      guard !Task.isCancelled else { return }
      withAnimation(.snappy) { self?.banner = nil }
    }
  }

  func dismissBanner() {
    bannerTimer?.cancel()
    withAnimation(.snappy) { banner = nil }
  }
}

// MARK: - Status

struct PalmWatchStatus: View {
  let status: String
  var body: some View {
    let (label, color) = Self.style(status)
    Text(label).font(.caption.weight(.semibold)).foregroundStyle(color)
      .padding(.horizontal, 7).padding(.vertical, 2)
      .background(color.opacity(0.15), in: Capsule())
  }

  static func style(_ status: String) -> (String, Color) {
    switch status {
    case "attention": return ("Needs you", .orange)
    case "error": return ("Error", .red)
    case "working": return ("Working", PalmStyle.accent)
    case "quiet": return ("Quiet", PalmStyle.muted)
    case "finished": return ("Finished", PalmStyle.success)
    case "idle": return ("Idle", PalmStyle.muted)
    default: return ("Unknown", PalmStyle.muted)
    }
  }
}

// MARK: - A row

struct PalmWatchRow: View {
  let session: PalmWatchSession
  @ObservedObject var connection: PalmConnection

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      PalmProviderBadge(provider: session.source, name: session.app)
      VStack(alignment: .leading, spacing: 4) {
        Text(session.title).font(.body.weight(.semibold)).foregroundStyle(.white).lineLimit(2)
        HStack(spacing: 6) {
          PalmWatchStatus(status: session.status)
          Text(session.activity).font(.caption).foregroundStyle(PalmStyle.muted).lineLimit(1)
        }
        Text(detail).font(.caption2).foregroundStyle(PalmStyle.muted).lineLimit(1)
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 2)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(session.title), \(session.app), \(PalmWatchStatus.style(session.status).0), \(session.activity)")
  }

  private var detail: String {
    var parts = [session.app]
    if !session.project.isEmpty { parts.append(session.project) }
    let when = PalmTime.relative(session.updated)
    if !when.isEmpty { parts.append(when) }
    if session.childrenWorking > 0 { parts.append("\(session.childrenWorking) agent\(session.childrenWorking == 1 ? "" : "s") working") }
    else if !session.children.isEmpty { parts.append("\(session.children.count) agent\(session.children.count == 1 ? "" : "s") launched") }
    return parts.joined(separator: " · ")
  }
}

// MARK: - Detail

/// What an agent is doing, what it last said and the agents it launched; open
/// it in its own app on the Mac, or watch the Mac's screen.
struct PalmWatchDetailView: View {
  let session: PalmWatchSession
  @ObservedObject var connection: PalmConnection
  @ObservedObject var navigator: PalmNavigator
  @Environment(\.dismiss) private var dismiss
  @State private var opening = false
  @State private var note: String?

  var body: some View {
    NavigationStack {
      List {
        Section {
          VStack(alignment: .leading, spacing: 8) {
            Text(session.title).font(.title3.weight(.semibold)).foregroundStyle(.white)
              .accessibilityAddTraits(.isHeader)
            HStack(spacing: 8) {
              PalmWatchStatus(status: session.status)
              Text(session.activity).font(.subheadline).foregroundStyle(PalmStyle.muted)
            }
            Text([session.app, PalmTime.relative(session.updated)].filter { !$0.isEmpty }.joined(separator: " · "))
              .font(.caption).foregroundStyle(PalmStyle.muted)
            if !session.cwd.isEmpty {
              Text(connection.displayPath(session.cwd)).font(.caption).foregroundStyle(PalmStyle.muted)
            }
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("watch.detail.header")
        }
        .listRowBackground(PalmStyle.panel)
        if !session.latestUser.isEmpty {
          Section("Asked") { Text(session.latestUser).font(.subheadline).textSelection(.enabled) }
            .listRowBackground(PalmStyle.panel)
        }
        if !session.latestMessage.isEmpty {
          Section("Latest from the agent") {
            Text(session.latestMessage).font(.subheadline).textSelection(.enabled)
              .accessibilityIdentifier("watch.detail.latest")
          }
          .listRowBackground(PalmStyle.panel)
        }
        if !session.children.isEmpty {
          Section("Agents it launched") {
            ForEach(session.children) { child in
              HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                  Text(child.title).font(.subheadline.weight(.semibold))
                  Text([child.kind, child.activity, PalmTime.relative(child.updated)].compactMap { $0 }.filter { !$0.isEmpty }
                    .joined(separator: " · ")).font(.caption).foregroundStyle(PalmStyle.muted)
                }
                Spacer(minLength: 4)
                PalmWatchStatus(status: child.status)
              }
              .accessibilityElement(children: .combine)
              .accessibilityIdentifier("watch.detail.child")
            }
          }
          .listRowBackground(PalmStyle.panel)
        }
        Section {
          if session.openable {
            Button {
              Task { await openOnMac(thenWatch: false) }
            } label: { Label("Open in \(appName) on the Mac", systemImage: "arrow.up.forward.app") }
            .accessibilityIdentifier("watch.open")
            Button {
              Task { await openOnMac(thenWatch: true) }
            } label: { Label("Open it and watch the screen", systemImage: "macwindow") }
            .accessibilityIdentifier("watch.openAndWatch")
          } else {
            Button {
              dismiss()
              navigator.tab = .screen
            } label: { Label("Watch the Mac's screen", systemImage: "macwindow") }
            .accessibilityIdentifier("watch.screen")
          }
          if let note { Text(note).font(.footnote).foregroundStyle(PalmStyle.muted) }
        } footer: {
          Text("\(session.evidence). Palm shows this agent; it keeps working in \(appName) on the Mac, and a finished turn is not proof the whole task is done.")
        }
        .listRowBackground(PalmStyle.panel)
      }
      .scrollContentBackground(.hidden)
      .background(PalmStyle.background.ignoresSafeArea())
      .navigationTitle(appName)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .disabled(opening)
    }
    .preferredColorScheme(.dark)
  }

  private var appName: String {
    switch session.source {
    case "codex": return "Codex"
    case "opencode": return "OpenCode"
    default: return "Claude"
    }
  }

  private func openOnMac(thenWatch: Bool) async {
    opening = true
    defer { opening = false }
    struct Opened: Decodable { let opened: Bool }
    do {
      let _: Opened = try await connection.post("/api/agents/watch/open", ["id": session.id])
      if thenWatch {
        dismiss()
        navigator.tab = .screen
      } else {
        note = "Opened in \(appName) on the Mac."
      }
    } catch { note = connection.friendlyMessage(error) }
  }
}

// MARK: - Banner

/// A floating line when an agent finishes, needs you or stops with an error;
/// tap to open it.
struct PalmWatchBanner: View {
  let alert: PalmWatchAlert
  var open: () -> Void
  var dismiss: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: symbol).font(.body.weight(.semibold)).foregroundStyle(color)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(alert.text).font(.subheadline.weight(.semibold)).foregroundStyle(.white).lineLimit(2)
        Text(alert.app).font(.caption).foregroundStyle(PalmStyle.muted).lineLimit(1)
      }
      Spacer(minLength: 4)
      Button(action: dismiss) {
        Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(.white).frame(width: 30, height: 30)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Dismiss")
    }
    .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 8)
    .contentShape(Rectangle())
    .onTapGesture(perform: open)
    .palmGlass(cornerRadius: 18)
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isButton)
    .accessibilityIdentifier("watch.banner")
  }

  private var symbol: String {
    switch alert.kind {
    case "finished": return "checkmark.circle.fill"
    case "error": return "exclamationmark.triangle.fill"
    default: return "hand.raised.fill"
    }
  }

  private var color: Color {
    switch alert.kind {
    case "finished": return PalmStyle.success
    case "error": return .red
    default: return .orange
    }
  }
}
