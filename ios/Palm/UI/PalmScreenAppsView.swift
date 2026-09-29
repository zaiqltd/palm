import SwiftUI

// Apps from inside the live screen ("surely there's a way
// to just select apps easier ... open the bottom nav bar or open Spotlight").
// The Mac's Dock is tiny on a phone; this lists the running apps with their
// icons, everything installed, and the Mac's own shortcuts, one tap each.

/// A Mac shortcut sent as keys, as if pressed on the Mac's keyboard.
enum PalmMacShortcut: String, CaseIterable, Identifiable {
  case spotlight, lastApp, missionControl

  var id: String { rawValue }

  var title: String {
    switch self {
    case .spotlight: return "Spotlight"
    case .lastApp: return "Last app"
    case .missionControl: return "Mission Control"
    }
  }

  var icon: String {
    switch self {
    case .spotlight: return "magnifyingglass"
    case .lastApp: return "arrow.left.arrow.right"
    case .missionControl: return "rectangle.3.group"
    }
  }

  /// Where the view goes afterwards: Spotlight's search box, top centre, at
  /// a readable size (E2E, 23 September: zoomed elsewhere, the box being typed
  /// into was out of view). The others stay where they are.
  var focus: CGPoint? { self == .spotlight ? CGPoint(x: 0.5, y: 0) : nil }

  /// ⌘Space, ⌘Tab and ⌃↑: the Mac's standard shortcuts.
  var keys: (key: String, modifiers: [String]) {
    switch self {
    case .spotlight: return ("space", ["cmd"])
    case .lastApp: return ("tab", ["cmd"])
    case .missionControl: return ("up", ["ctrl"])
    }
  }
}

/// The Mac's Dock and menu bar ("a button that opens up
/// the Mac's bottom or top nav bar"). `focus` is what the view shows; `reveal`
/// is where the pointer goes so an auto-hidden bar slides out (the middle of
/// the edge, clear of hot corners).
enum PalmMacEdge: String, CaseIterable, Identifiable {
  case dock, menuBar

  var id: String { rawValue }
  var title: String { self == .dock ? "Dock" : "Menu bar" }
  var icon: String { self == .dock ? "dock.rectangle" : "menubar.rectangle" }
  var focus: CGPoint { self == .dock ? CGPoint(x: 0.5, y: 1) : CGPoint(x: 0, y: 0) }
  var reveal: CGPoint { self == .dock ? CGPoint(x: 0.5, y: 0.998) : CGPoint(x: 0.5, y: 0.001) }
}

/// One button in the screen controls: choose the Dock or the menu bar.
struct PalmMacEdgesMenu: View {
  var size: CGFloat = 44
  var id = "remote.edges"
  let show: (PalmMacEdge) -> Void

  var body: some View {
    Menu {
      ForEach(PalmMacEdge.allCases) { edge in
        Button { show(edge) } label: { Label(edge.title, systemImage: edge.icon) }
          .accessibilityIdentifier("edges.\(edge.rawValue)")
      }
    } label: {
      Image(systemName: "menubar.dock.rectangle").font(.system(size: 17, weight: .medium))
        .foregroundStyle(.white).frame(width: size, height: size)
    }
    .accessibilityLabel("Show the Dock or the menu bar")
    .accessibilityIdentifier(id)
  }
}

struct PalmInstalledApp: Decodable, Identifiable, Hashable, Sendable {
  var id: String { bundleId }
  let name: String
  let bundleId: String
  let icon: String
}

struct PalmScreenAppsSheet: View {
  @ObservedObject var connection: PalmConnection
  /// Bring a running app forward.
  let open: (PalmRemoteApp) async throws -> Void
  /// Open an app that is not running.
  let launch: (PalmInstalledApp) async throws -> Void
  let shortcut: (PalmMacShortcut) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var search = ""
  private var installed: [PalmInstalledApp] { connection.installedApps }
  @State private var error: String?
  @State private var busy: String?

  private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var running: [PalmRemoteApp] {
    connection.apps.filter { query.isEmpty || $0.name.localizedStandardContains(query) }
      .sorted { lhs, rhs in
        if lhs.active != rhs.active { return lhs.active }
        return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
      }
  }
  private var others: [PalmInstalledApp] {
    let open = Set(connection.apps.map(\.bundleId))
    return installed.filter { !open.contains($0.bundleId) && (query.isEmpty || $0.name.localizedStandardContains(query)) }
  }

  var body: some View {
    NavigationStack {
      List {
        Section {
          HStack(spacing: 8) {
            ForEach(PalmMacShortcut.allCases) { item in
              Button {
                dismiss()
                shortcut(item)
              } label: {
                VStack(spacing: 6) {
                  Image(systemName: item.icon).font(.system(size: 20, weight: .medium))
                  Text(item.title).font(.caption.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                }
                .frame(maxWidth: .infinity, minHeight: 64)
                .background(Color.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
              }
              .buttonStyle(.plain)
              .accessibilityIdentifier("apps.shortcut.\(item.rawValue)")
            }
          }
          .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
        }
        .listRowBackground(Color.clear)
        if let error {
          Section { Text(error).foregroundStyle(.orange).font(.footnote) }.listRowBackground(PalmStyle.panel)
        }
        Section("Open on the Mac") {
          if running.isEmpty {
            Text(query.isEmpty ? "No apps with windows are open." : "None open match.").foregroundStyle(PalmStyle.muted)
          }
          ForEach(running) { app in
            row(name: app.name, icon: app.icon, detail: app.active ? "In front" : nil, id: app.bundleId) {
              try await open(app)
            }
            .accessibilityIdentifier("apps.running")
          }
        }
        .listRowBackground(PalmStyle.panel)
        Section("Other apps") {
          if installed.isEmpty {
            HStack(spacing: 10) {
              ProgressView()
              Text("Reading the Mac's apps").foregroundStyle(PalmStyle.muted)
            }
          } else if others.isEmpty {
            Text("None match.").foregroundStyle(PalmStyle.muted)
          }
          ForEach(others) { app in
            row(name: app.name, icon: app.icon, detail: nil, id: app.bundleId) { try await launch(app) }
              .accessibilityIdentifier("apps.installed")
          }
        }
        .listRowBackground(PalmStyle.panel)
      }
      .scrollContentBackground(.hidden)
      .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find an app")
      .navigationTitle("Apps")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .palmScreen()
    }
    .palmPrivacyShield()
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .task { await load() }
  }

  private func row(name: String, icon: String, detail: String?, id: String, action: @escaping () async throws -> Void) -> some View {
    Button {
      guard busy == nil else { return }
      busy = id
      Task {
        defer { busy = nil }
        do {
          try await action()
          dismiss()
        } catch { self.error = connection.friendlyMessage(error) }
      }
    } label: {
      HStack(spacing: 12) {
        PalmAppIcon(name: name, icon: icon, size: 32)
        Text(name).foregroundStyle(.white)
        Spacer()
        if busy == id { ProgressView() } else if let detail {
          Text(detail).font(.caption).foregroundStyle(PalmStyle.muted)
        }
      }
    }
    .disabled(busy != nil)
  }

  private func load() async {
    do { try await connection.refreshApps() } catch { self.error = connection.friendlyMessage(error) }
    struct Installed: Decodable { let apps: [PalmInstalledApp] }
    do { connection.installedApps = (try await connection.get("/api/apps/installed") as Installed).apps } catch {
      if connection.installedApps.isEmpty { self.error = connection.friendlyMessage(error) }
    }
  }
}

/// One item in the Mac's Dock.
struct PalmDockItem: Decodable, Identifiable, Hashable, Sendable {
  let id: Int
  let title: String
  let kind: String
  let running: Bool
  let icon: String
}

/// The Mac's own Dock at a size a finger can use ("the
/// dock still is impossible to get to"). Items come from the Dock itself, in
/// its order; tapping one does what clicking it in the Dock does, hidden Dock
/// or not. "Show it on the screen" zooms to the real Dock instead.
struct PalmDockSheet: View {
  @ObservedObject var connection: PalmConnection
  let showOnScreen: () -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var items: [PalmDockItem] = []
  @State private var loaded = false
  @State private var error: String?
  @State private var busy: Int?

  var body: some View {
    NavigationStack {
      List {
        if let error { Text(error).foregroundStyle(.orange).font(.footnote).listRowBackground(PalmStyle.panel) }
        if !loaded { HStack { ProgressView(); Text("Reading the Dock").foregroundStyle(PalmStyle.muted) }.listRowBackground(PalmStyle.panel) }
        if loaded && items.isEmpty && error == nil {
          Text("The Dock could not be read. Allow Accessibility for Palm on your Mac.").foregroundStyle(PalmStyle.muted).listRowBackground(PalmStyle.panel)
        }
        Section {
          ForEach(items) { item in
            Button {
              guard busy == nil else { return }
              busy = item.id
              Task {
                defer { busy = nil }
                struct Done: Decodable { let ok: Bool }
                do {
                  let _: Done = try await connection.post("/api/command", ["op": "dockPress", "index": item.id])
                  dismiss()
                } catch { self.error = connection.friendlyMessage(error) }
              }
            } label: {
              HStack(spacing: 12) {
                if item.kind == "trash" {
                  Image(systemName: "trash").font(.system(size: 22)).frame(width: 32, height: 32).foregroundStyle(.white)
                } else if item.kind == "folder" && item.icon.isEmpty {
                  Image(systemName: "folder").font(.system(size: 22)).frame(width: 32, height: 32).foregroundStyle(.white)
                } else {
                  PalmAppIcon(name: item.title, icon: item.icon, size: 32)
                }
                Text(item.title).foregroundStyle(.white)
                Spacer()
                if busy == item.id { ProgressView() } else if item.running {
                  Circle().fill(Color.white.opacity(0.7)).frame(width: 6, height: 6).accessibilityLabel("Open")
                }
              }
            }
            .accessibilityIdentifier("dock.item")
          }
        } footer: {
          Text("Your Mac's Dock, in its order. A dot means the app is open.")
        }
        .listRowBackground(PalmStyle.panel)
        Section {
          Button {
            dismiss()
            showOnScreen()
          } label: { Label("Show the Dock on the screen", systemImage: "dock.rectangle") }
          .accessibilityIdentifier("dock.showOnScreen")
        }
        .listRowBackground(PalmStyle.panel)
      }
      .scrollContentBackground(.hidden)
      .navigationTitle("Dock")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .palmScreen()
    }
    .palmPrivacyShield()
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
    .task {
      struct List: Decodable { let items: [PalmDockItem] }
      do { items = (try await connection.get("/api/dock") as List).items } catch { self.error = connection.friendlyMessage(error) }
      loaded = true
    }
  }
}
