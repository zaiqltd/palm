import SwiftUI

struct PalmRootView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @ObservedObject var transfers: PalmTransfers
  @StateObject private var navigator = PalmNavigator()
  @State private var incomingFiles: [URL] = []
  @State private var showingRemote = false
  @State private var pendingLink: URL?
  @State private var pairingSheet = false
  @State private var localError: String?
  @State private var opening = false
  @State private var keyboardShowing = false
  @ObservedObject private var alerts = PalmWatchAlerts.shared

  private var error: String? { localError ?? connection.errorMessage }

  var body: some View {
    Group {
      if connection.isPaired {
        // Assistant for everyday requests, Agents as the developer workspace:
        // two tabs sharing one set of tasks.
        TabView(selection: $navigator.tab) {
          PalmAssistantView(connection: connection, events: events, transfers: transfers, navigator: navigator)
            .tabItem { Label("Assistant", systemImage: "sparkles") }.tag(PalmTab.assistant)
          PalmAgentsView(connection: connection, events: events, transfers: transfers, navigator: navigator)
            .tabItem { Label("Agents", systemImage: "chevron.left.forwardslash.chevron.right") }.tag(PalmTab.agents)
          PalmMacFilesView(connection: connection, transfers: transfers, navigator: navigator)
            .tabItem { Label("Files", systemImage: "folder") }.tag(PalmTab.files)
          NavigationStack {
            PalmAppsView(
              connection: connection, opening: opening, showDesktop: showRemote,
              openApp: openApp, openWindow: openWindow)
            .palmDeviceSubtitle(connection)
            .palmComputerMenu(connection, navigator)
          }
          .tabItem { Label("Screen", systemImage: "macwindow") }.tag(PalmTab.screen)
          PalmMoreView(connection: connection, events: events, transfers: transfers, navigator: navigator)
            .tabItem { Label("More", systemImage: "ellipsis") }.tag(PalmTab.more)
        }
      } else {
        PalmPairingView(connection: connection, incomingURL: pendingLink)
      }
    }
    // An agent finished, needs you or stopped: a line at the top, from any tab.
    .overlay(alignment: .top) {
      if let alert = alerts.banner, connection.isPaired, !showingRemote {
        PalmWatchBanner(alert: alert) {
          alerts.dismissBanner()
          navigator.openWatch(alert.id, palmTaskId: alert.palmTaskId)
        } dismiss: {
          alerts.dismissBanner()
        }
        .padding(.horizontal, 12)
        // Below the title bar: notices never cover a title or its buttons.
        .padding(.top, 58)
        .transition(.move(edge: .top).combined(with: .opacity))
      }
    }
    // Notices float over the content, never over a screen's title bar.
    .overlay {
      if opening && !showingRemote {
        HStack(spacing: 10) {
          ProgressView().tint(PalmStyle.accent)
          Text("Opening on your Mac").font(.subheadline.weight(.medium))
        }
        .padding(.horizontal, 18).padding(.vertical, 12)
        .palmGlassCapsule()
      }
    }
    .overlay(alignment: .bottom) {
      VStack(spacing: 8) {
        if let error, !showingRemote {
          HStack(alignment: .center, spacing: 10) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.orange).accessibilityHidden(true)
            Text(error).font(.subheadline).frame(maxWidth: .infinity, alignment: .leading)
              .fixedSize(horizontal: false, vertical: true)
            Button {
              localError = nil
              connection.errorMessage = nil
            } label: {
              Image(systemName: "xmark").font(.subheadline.weight(.semibold)).frame(width: 36, height: 36)
            }
            .accessibilityLabel("Dismiss error")
          }
          .foregroundStyle(.white)
          .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 6)
          .palmGlass(cornerRadius: 18)
          .accessibilityElement(children: .contain)
          .accessibilityIdentifier("root.error")
        }
        if connection.hostStatus?.synthetic == true && connection.hostStatus?.demo != true && !showingRemote {
          Text("Test host · simulated Mac")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(PalmStyle.onAccent)
            .padding(.horizontal, 10).padding(.vertical, 4)
            .background(Color.orange, in: Capsule())
            .allowsHitTesting(false)
            .accessibilityIdentifier("root.testHost")
        }
      }
      .padding(.horizontal, 16)
      // Clear of the floating tab bar.
      .padding(.bottom, connection.isPaired ? 70 : 12)
    }
    .fullScreenCover(isPresented: $showingRemote) {
      PalmRemoteView(connection: connection)
    }
    .sheet(isPresented: $pairingSheet) {
      PalmPairingView(connection: connection, incomingURL: pendingLink, adding: true) { pairingSheet = false }
    }
    .sheet(isPresented: $navigator.addingComputer) {
      PalmPairingView(connection: connection, adding: true) { navigator.addingComputer = false }
    }
    .sheet(isPresented: $navigator.managingComputers) {
      NavigationStack {
        PalmComputersView(connection: connection, navigator: navigator)
          .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { navigator.managingComputers = false } } }
      }
      .preferredColorScheme(.dark)
    }
    // Another computer chosen: every tab starts over for it; nothing moves.
    .onChange(of: connection.deviceEpoch) { _, _ in
      showingRemote = false
      navigator.computerChanged()
      events.switchComputer()
      PalmAssistantStore.shared.computerChanged(connection.currentDeviceId)
      PalmAgentWatch.shared.computerChanged(connection)
    }
    .onChange(of: connection.isPaired) { _, paired in
      if !paired { showingRemote = false } else {
        pairingSheet = false
        PalmAgentWatch.shared.start(connection, events: events)
      }
    }
    .onAppear {
      // The session open in front of you needs no alert.
      let navigator = navigator
      alerts.isOnScreen = { alert in
        navigator.tab == .agents
          && ((alert.palmTaskId != nil && alert.palmTaskId == navigator.agentTask) || navigator.watchSession == alert.id)
      }
      if connection.isPaired { PalmAgentWatch.shared.start(connection, events: events) }
    }
    .onOpenURL { url in
      // Files shared into Palm from other apps arrive as file URLs.
      if url.isFileURL {
        incomingFiles.append(url)
        return
      }
      pendingLink = url
      if connection.isPaired { pairingSheet = true }
    }
    .sheet(isPresented: Binding(get: { !incomingFiles.isEmpty && connection.isPaired }, set: { if !$0 { incomingFiles = [] } })) {
      PalmSendToMacView(connection: connection, transfers: transfers, files: incomingFiles) { incomingFiles = [] }
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
      keyboardShowing = true
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
      keyboardShowing = false
    }
    .background {
      GeometryReader { geometry in
        Color.clear
          .onAppear { prepareViewport(geometry.size) }
          .onChange(of: geometry.size) { _, size in prepareViewport(size) }
          .onChange(of: showingRemote) { _, remote in
            if !remote { prepareViewport(geometry.size) }
          }
      }
    }
  }

  private func prepareViewport(_ size: CGSize) {
    guard !showingRemote, !keyboardShowing else { return }
    // The space the live screen's floating controls leave: the landscape rail,
    // or the portrait top and bottom bars.
    let stage = size.width > size.height
      ? CGSize(width: size.width - 72, height: size.height)
      : CGSize(width: size.width, height: size.height - 128)
    connection.prepareViewport(stage)
  }

  private func showRemote() {
    guard !opening else { return }
    localError = nil
    showingRemote = true
    if connection.isStreaming && connection.targetWindowID == 0 { return }
    opening = true
    Task {
      defer { opening = false }
      do { try await connection.start(windowID: 0, name: "Desktop") } catch {
        connection.errorMessage = error.localizedDescription
      }
    }
  }

  private func openApp(_ app: PalmRemoteApp) {
    guard !opening else { return }
    localError = nil
    opening = true
    Task {
      defer { opening = false }
      do {
        try await connection.open(app: app)
        showingRemote = true
      } catch { localError = error.localizedDescription }
    }
  }

  private func openWindow(_ app: PalmRemoteApp, _ window: PalmRemoteWindow) {
    guard !opening else { return }
    localError = nil
    opening = true
    Task {
      defer { opening = false }
      do {
        try await connection.open(app: app, windowID: window.id)
        showingRemote = true
      } catch { localError = error.localizedDescription }
    }
  }
}

struct PalmAppsView: View {
  @ObservedObject var connection: PalmConnection
  var opening = false
  var showDesktop: () -> Void
  var openApp: (PalmRemoteApp) -> Void
  var openWindow: (PalmRemoteApp, PalmRemoteWindow) -> Void
  @State private var search = ""
  @State private var error: String?
  @State private var refreshing = false

  private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }
  private var busy: Bool { opening || connection.isBusy }
  private var filtered: [PalmRemoteApp] {
    connection.apps.filter { app in
      query.isEmpty || app.name.localizedStandardContains(query)
        || app.windows.contains { windowTitle($0).localizedStandardContains(query) }
    }.sorted { lhs, rhs in
      if lhs.active != rhs.active { return lhs.active }
      return lhs.name.localizedStandardCompare(rhs.name) == .orderedAscending
    }
  }

  var body: some View {
    List {
      if connection.connectionState == .offline {
        Section {
          Label("Your Mac is unreachable. Check that it is awake, Palm is running and Tailscale is connected on both devices.",
            systemImage: "wifi.exclamationmark")
            .foregroundStyle(.orange)
          Button {
            Task { await connection.retry() }
          } label: { Label("Check connection", systemImage: "arrow.clockwise") }
            .disabled(busy)
        }
        .listRowBackground(PalmStyle.panel)
      }
      if connection.hostStatus?.screenPermission == false || connection.hostStatus?.controlPermission == false {
        Section {
          if connection.hostStatus?.screenPermission == false {
            Label("Allow Palm in Screen & System Audio Recording on your Mac, then restart Palm.", systemImage: "record.circle")
          }
          if connection.hostStatus?.controlPermission == false {
            Label("Viewing only. Allow Palm in Accessibility on your Mac to control apps.", systemImage: "hand.raised")
          }
        }
        .foregroundStyle(.orange)
        .listRowBackground(PalmStyle.panel)
      }
      if query.isEmpty {
        Section {
          Button(action: showDesktop) {
            HStack(spacing: 14) {
              Image(systemName: "desktopcomputer").font(.title2).frame(width: 40, height: 40)
                .background(PalmStyle.raised, in: RoundedRectangle(cornerRadius: 10))
              VStack(alignment: .leading, spacing: 3) {
                Text("Whole Mac screen").font(.body.weight(.semibold))
                Text("See and control everything on the Mac").font(.subheadline).foregroundStyle(PalmStyle.muted)
              }
              Spacer(minLength: 8)
              Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(PalmStyle.muted)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(busy)
          .accessibilityLabel("Open the full Mac desktop")
          .accessibilityIdentifier("screen.desktop")
        }
        .listRowBackground(PalmStyle.panel)
      }
      Section {
        ForEach(filtered) { app in
          appRow(app)
          ForEach(visibleWindows(in: app)) { window in
            windowRow(app, window)
          }
        }
        if filtered.isEmpty {
          Text(query.isEmpty ? "No open apps were listed. Pull down to refresh." : "No app or window matches.")
            .foregroundStyle(PalmStyle.muted)
        }
      } header: {
        Text(query.isEmpty ? "Open apps" : "Matches")
      }
      .listRowBackground(PalmStyle.panel)
    }
    .scrollContentBackground(.hidden)
    .navigationTitle("Screen")
    .palmRootTitle()
    .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Search apps and windows")
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await refreshApps() }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          Task { await refreshApps() }
        } label: { Label("Refresh apps and windows", systemImage: "arrow.clockwise") }
          .disabled(busy || refreshing)
      }
    }
    .palmToast($error, warning: true)
    .palmScreen()
  }

  private func appRow(_ app: PalmRemoteApp) -> some View {
    Button {
      openApp(app)
    } label: {
      HStack(spacing: 14) {
        PalmAppIcon(app: app, size: 40)
        VStack(alignment: .leading, spacing: 3) {
          Text(app.name).font(.body.weight(.semibold)).foregroundStyle(.white)
          if app.active {
            Text("In front on your Mac").font(.subheadline).foregroundStyle(PalmStyle.muted)
          }
        }
        Spacer(minLength: 8)
        Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(PalmStyle.muted)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(busy)
    .accessibilityLabel("Open \(app.name) on your Mac")
    .accessibilityIdentifier("apps.open.\(app.id)")
  }

  private func windowRow(_ app: PalmRemoteApp, _ window: PalmRemoteWindow) -> some View {
    Button {
      openWindow(app, window)
    } label: {
      HStack(spacing: 12) {
        Image(systemName: "macwindow").foregroundStyle(PalmStyle.muted).frame(width: 40)
        Text(windowTitle(window)).font(.subheadline).foregroundStyle(.white)
          .multilineTextAlignment(.leading)
        Spacer(minLength: 8)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(busy)
    .accessibilityLabel("Open \(windowTitle(window)) in \(app.name)")
    .accessibilityIdentifier("apps.window.\(window.id)")
  }

  private func visibleWindows(in app: PalmRemoteApp) -> [PalmRemoteWindow] {
    if query.isEmpty || app.name.localizedStandardContains(query) { return app.windows }
    return app.windows.filter { windowTitle($0).localizedStandardContains(query) }
  }

  private func windowTitle(_ window: PalmRemoteWindow) -> String {
    let title = window.title.trimmingCharacters(in: .whitespacesAndNewlines)
    return title.isEmpty ? "Untitled window" : title
  }

  private func refreshApps() async {
    guard !refreshing, !busy else { return }
    refreshing = true
    defer { refreshing = false }
    do { try await connection.refresh() } catch { self.error = connection.friendlyMessage(error) }
  }
}


/// Files arriving from the iOS share sheet ("Open in Palm" / "Copy to Palm"):
/// choose where on the Mac they go, then upload with verification.
struct PalmSendToMacView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var transfers: PalmTransfers
  let files: [URL]
  var done: () -> Void
  @AppStorage("palm.send.lastFolder") private var destination = ""
  @State private var choosing = false
  @State private var sending = false
  @State private var results: [String: Bool] = [:]

  var body: some View {
    NavigationStack {
      List {
        Section("Files") {
          ForEach(files, id: \.path) { file in
            HStack {
              Image(systemName: "doc")
              Text(file.lastPathComponent)
              Spacer()
              if let ok = results[file.path] {
                Image(systemName: ok ? "checkmark.seal.fill" : "exclamationmark.triangle.fill")
                  .foregroundStyle(ok ? PalmStyle.accent : .orange)
              }
            }
          }
        }
        Section("Destination on your Mac") {
          Button { choosing = true } label: {
            HStack {
              Label(destination.isEmpty ? "Choose folder" : (destination as NSString).lastPathComponent, systemImage: "folder")
              Spacer()
              Text(PalmPath.display(destination)).font(.caption).foregroundStyle(PalmStyle.muted)
                .multilineTextAlignment(.trailing)
            }
          }
        }
      }
      .navigationTitle("Send to Mac")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button(results.isEmpty ? "Cancel" : "Done") { cleanup(); done() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(sending ? "Sending" : "Send") { Task { await send() } }
            .disabled(sending || destination.isEmpty || !results.isEmpty)
        }
      }
      .sheet(isPresented: $choosing) {
        PalmFolderPicker(connection: connection, title: "Send to", start: destination.isEmpty ? (connection.hostStatus?.inbox ?? "~") : destination) { folder in
          destination = folder
        }
      }
      .task {
        if destination.isEmpty, let places: PalmPlaces = try? await connection.get("/api/fs/places") { destination = places.inbox }
      }
    }
    .preferredColorScheme(.dark)
  }

  private func send() async {
    sending = true
    defer { sending = false }
    for file in files {
      let access = file.startAccessingSecurityScopedResource()
      let result = await transfers.upload(PalmMedia.jpegIfNeeded(file), to: destination)
      if access { file.stopAccessingSecurityScopedResource() }
      results[file.path] = result != nil
    }
  }

  private func cleanup() {
    // Shared copies live in Palm's Documents/Inbox; remove them once handled.
    for file in files where file.path.contains("/Documents/Inbox/") { try? FileManager.default.removeItem(at: file) }
  }
}
