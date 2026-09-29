import PhotosUI
import SwiftUI
import UIKit

// MARK: - Transcript store

@MainActor
final class PalmTaskStore: ObservableObject {
  struct Row: Identifiable, Equatable {
    enum Kind: Equatable { case user, assistant, live, tool, approval, notice, agentNote, turn, error, screen, files }
    let id: String
    let kind: Kind
    var text: String = ""
    var title: String = ""
    var detail: String = ""
    var status: String = ""
    var output: String = ""
    var options: [String] = []
    var approvalId: String = ""
    var attachments: [PalmAttachmentRef] = []
    var files: [PalmAssistantCard] = []
    var at: String?
  }

  @Published private(set) var task: PalmTaskSummary?
  @Published private(set) var rows: [Row] = []
  @Published var error: String?
  private var events: [Int: PalmTaskEvent] = [:]
  private var live: [String: String] = [:]
  private var lastSeq = 0
  /// Streamed words are shown about 12 times a second, not per word: each
  /// redraw lays out the whole conversation.
  private var pendingRebuild: Task<Void, Never>?
  private var listener: UUID?
  private var summaryListener: UUID?
  private var reconnectHook: UUID?
  private let taskId: String

  init(taskId: String) { self.taskId = taskId }

  func start(_ connection: PalmConnection, events hub: PalmEvents) {
    guard listener == nil else { return }
    listener = hub.listen("task:\(taskId)") { [weak self] message in self?.receive(message) }
    // Status (working, needs you, done) arrives with the task list updates.
    summaryListener = hub.listen("tasks") { [weak self] message in
      guard let self, let raw = message["task"], let data = try? JSONSerialization.data(withJSONObject: raw),
        let summary = try? JSONDecoder().decode(PalmTaskSummary.self, from: data), summary.id == self.taskId
      else { return }
      self.task = summary
    }
    // Re-read anything missed while the phone was away or reconnecting.
    reconnectHook = hub.whenConnected { [weak self] in
      guard let self else { return }
      Task { await self.load(connection) }
    }
    Task { await load(connection) }
  }

  func stop(_ hub: PalmEvents) {
    if let listener { hub.stopListening(listener) }
    if let summaryListener { hub.stopListening(summaryListener) }
    if let reconnectHook { hub.cancelWhenConnected(reconnectHook) }
    listener = nil
    summaryListener = nil
    reconnectHook = nil
  }

  func load(_ connection: PalmConnection) async {
    do {
      let detail: PalmTaskDetail = try await connection.get("/api/tasks/\(taskId)", ["after": String(lastSeq)])
      task = detail.task
      for event in detail.events { events[event.seq] = event; lastSeq = max(lastSeq, event.seq) }
      live = Dictionary(uniqueKeysWithValues: detail.live.map { ($0.itemId, $0.text) })
      rebuild()
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func receive(_ message: [String: Any]) {
    switch message["event"] as? String {
    case "task.delta":
      guard let itemId = message["itemId"] as? String, let text = message["text"] as? String else { return }
      live[itemId, default: ""] += text
      guard pendingRebuild == nil else { return }
      pendingRebuild = Task { [weak self] in
        try? await Task.sleep(nanoseconds: 80_000_000)
        guard let self else { return }
        self.pendingRebuild = nil
        self.rebuild()
      }
    case "task.event":
      guard let raw = message["entry"], let data = try? JSONSerialization.data(withJSONObject: raw),
        let event = try? JSONDecoder().decode(PalmTaskEvent.self, from: data)
      else { return }
      events[event.seq] = event
      lastSeq = max(lastSeq, event.seq)
      if event.type == "assistant", let itemId = event.itemId { live[itemId] = nil }
      if event.type == "turn", event.status != "started" { live.removeAll() }
      rebuild()
    default: return
    }
  }

  func updateSummary(_ summary: PalmTaskSummary) { task = summary }

  private func rebuild() {
    pendingRebuild?.cancel()
    pendingRebuild = nil
    var out: [Row] = []
    var toolIndex: [String: Int] = [:]
    var approvalIndex: [String: Int] = [:]
    var finalItems = Set<String>()
    for event in events.values.sorted(by: { $0.seq < $1.seq }) {
      switch event.type {
      case "user":
        out.append(Row(id: "u\(event.seq)", kind: .user, text: event.text ?? "", attachments: event.attachments ?? [], at: event.at))
      case "assistant":
        if let item = event.itemId { finalItems.insert(item) }
        out.append(Row(id: "a\(event.seq)", kind: .assistant, text: event.text ?? "", at: event.at))
      case "reasoning":
        continue
      case "tool":
        guard let item = event.itemId else { continue }
        if let index = toolIndex[item] {
          if let status = event.status { out[index].status = status }
          if let output = event.output, !output.isEmpty { out[index].output = output }
          if let title = event.title, out[index].title.isEmpty { out[index].title = title }
          if let detail = event.detail, out[index].detail.isEmpty { out[index].detail = detail }
        } else {
          toolIndex[item] = out.count
          out.append(Row(id: "t\(item)", kind: .tool, title: event.title ?? event.name ?? "Tool", detail: event.detail ?? "",
            status: event.status ?? "running", output: event.output ?? ""))
        }
      case "approval":
        guard let approval = event.approvalId else { continue }
        if let index = approvalIndex[approval] { out[index].status = event.status ?? out[index].status }
        else {
          approvalIndex[approval] = out.count
          out.append(Row(id: "p\(approval)", kind: .approval, title: event.title ?? "Allow this?", detail: event.detail ?? "",
            status: event.status ?? "pending", options: event.options ?? ["allow", "deny"], approvalId: approval))
        }
      case "notice":
        out.append(Row(id: "n\(event.seq)", kind: event.fromAgent == true ? .agentNote : .notice, text: event.text ?? ""))
      case "screen":
        out.append(Row(id: "s\(event.seq)", kind: .screen, text: event.text ?? ""))
      case "error":
        out.append(Row(id: "e\(event.seq)", kind: .error, text: event.text ?? event.error ?? "Error"))
      case "files":
        // What the turn made (a PDF, a picture): saved or opened from here,
        // as from the Assistant.
        guard let files = event.files, !files.isEmpty else { continue }
        out.append(Row(id: "f\(event.seq)", kind: .files, files: files, at: event.at))
      case "turn":
        guard let status = event.status, status != "started" else { continue }
        var parts: [String] = []
        switch status {
        case "completed": parts.append("Finished")
        case "interrupted": parts.append("Stopped")
        default: parts.append("Failed")
        }
        if let ms = event.durationMs, ms > 0 { parts.append(ms >= 60000 ? "\(Int(ms / 60000))m \(Int(ms / 1000) % 60)s" : "\(Int(ms / 1000))s") }
        out.append(Row(id: "r\(event.seq)", kind: status == "completed" || status == "interrupted" ? .turn : .error,
          text: parts.joined(separator: " · ") + (event.error.map { "\n\($0)" } ?? ""), status: status))
      default:
        continue
      }
    }
    for (item, text) in live.sorted(by: { $0.key < $1.key }) where !finalItems.contains(item) && !text.isEmpty {
      out.append(Row(id: "l\(item)", kind: .live, text: text))
    }
    if out != rows { rows = out }
  }
}

// MARK: - Task view

struct PalmTaskView: View {
  let taskId: String
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @ObservedObject var transfers: PalmTransfers
  @ObservedObject var navigator: PalmNavigator
  @StateObject private var store: PalmTaskStore
  @State private var draft = ""
  @State private var attachments: [PalmPendingAttachment] = []
  @State private var sending = false
  @State private var showScreen = false
  @State private var fullScreen = false
  @State private var localError: String?
  @State private var shownRows = 200
  @AppStorage("palm.task.screenFraction") private var screenFraction = 0.42
  /// The screen beside the chat has the Screen tab's controls (
  /// "you can't even type on the screen ... where's that toolbar").
  @AppStorage("palm.remote.mode") private var screenModeName = PalmInputMode.touch.rawValue
  @State private var screenTyping = false
  @State private var showingApps = false
  @State private var screenListener: UUID?
  @State private var edgeFocus: CGPoint?
  @State private var edgeID = 0
  @State private var pickingPhoto = false
  @State private var photoItem: PhotosPickerItem?
  @State private var showingDock = false
  @State private var confirmingRemove = false
  /// The project's preview and a shell in the session's folder, one tap from
  /// the chat (shortcuts inside the task).
  @State private var previewing = false
  @State private var shell: PalmTerminalInfo?
  @State private var shellTyping = false
  @ObservedObject private var voice = PalmVoice.shared
  @FocusState private var composerFocused: Bool
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.dismiss) private var dismiss
  @Environment(\.verticalSizeClass) private var verticalSizeClass

  /// Shown inside the Agents strip (which owns the title) rather than pushed.
  var embedded = false
  /// The strip keeps recent sessions open; only the visible one adds buttons
  /// to the bar or uses the live screen.
  var active = true

  init(
    taskId: String, connection: PalmConnection, events: PalmEvents, transfers: PalmTransfers,
    navigator: PalmNavigator, embedded: Bool = false, active: Bool = true
  ) {
    self.taskId = taskId
    self.connection = connection
    self.events = events
    self.transfers = transfers
    self.navigator = navigator
    self.embedded = embedded
    self.active = active
    _store = StateObject(wrappedValue: PalmTaskStore(taskId: taskId))
  }

  private var task: PalmTaskSummary? { store.task }
  private var working: Bool { task?.isWorking == true }

  var body: some View {
    GeometryReader { geometry in
      // The phone's orientation, not the space left by the keyboard: in
      // portrait the keyboard leaves the chat wider than tall, and flipping to
      // the side-by-side layout rebuilt the screen and dropped the keyboard.
      let landscape = UIDevice.current.userInterfaceIdiom == .pad
        ? geometry.size.width > geometry.size.height : verticalSizeClass == .compact
      Group {
        if showScreen && landscape {
          HStack(spacing: 0) {
            screenPane.frame(width: geometry.size.width * 0.6)
            Divider().overlay(PalmStyle.line)
            chat
          }
        } else if showScreen {
          VStack(spacing: 0) {
            // Typing on the Mac, the picture takes the room the keyboard leaves.
            screenPane.frame(height: screenTyping ? max(180, geometry.size.height - 60) : max(180, geometry.size.height * screenFraction))
            dragHandle(height: geometry.size.height)
            chat
          }
        } else {
          chat
        }
      }
    }
    .background(PalmStyle.background.ignoresSafeArea())
    // The bar names the agent (always short); the task's title heads the chat.
    .modifier(PalmOptionalTitle(title: embedded ? nil : (task?.providerName ?? "Agent")))
    .toolbar { if active { toolbar } }
    .onChange(of: active) { _, isActive in
      // A session switched away from gives the live screen back.
      if !isActive && showScreen { showScreen = false }
      if !isActive { screenTyping = false }
    }
    .onAppear {
      store.start(connection, events: events)
      // Whether this session's agent is using the screen, watched or not.
      screenListener = events.listen("screen") { message in
        if let state = message["state"] as? [String: Any] { connection.noteScreenState(state) }
      }
      Task {
        if let state: PalmScreenState = try? await connection.get("/api/screen") { connection.noteScreenOwner(state.ownerValue) }
      }
    }
    .onDisappear {
      store.stop(events)
      if let screenListener { events.stopListening(screenListener) }
      screenListener = nil
      screenTyping = false
      if showScreen { connection.stop() }
    }
    .onChange(of: showScreen) { _, show in
      if show { startScreen() } else {
        screenTyping = false
        connection.stop()
      }
    }
    .fullScreenCover(isPresented: $fullScreen, onDismiss: { if showScreen { startScreen() } }) {
      PalmRemoteView(connection: connection)
    }
    .sheet(isPresented: $previewing) {
      if let task { PalmSessionPreviewSheet(cwd: task.cwd, connection: connection, events: events) }
    }
    .sheet(item: $shell) { terminal in
      NavigationStack {
        PalmTerminalScreen(
          terminalId: terminal.id, connection: connection, events: events, title: terminal.title,
          focusOnOpen: true, typing: $shellTyping)
          .toolbar {
            ToolbarItem(placement: .cancellationAction) {
              Button("Close") { shell = nil }.accessibilityIdentifier("task.terminal.close")
            }
          }
      }
      .preferredColorScheme(.dark)
    }
    .confirmationDialog(working ? "Stop the agent and remove this chat?" : "Remove this chat?",
      isPresented: $confirmingRemove, titleVisibility: .visible
    ) {
      Button(working ? "Stop and remove" : "Remove", role: .destructive) { Task { await remove() } }
    } message: {
      Text("It leaves the Agents list. The conversation stays saved on your Mac.")
    }
  }

  @ToolbarContentBuilder private var toolbar: some ToolbarContent {
    ToolbarItemGroup(placement: .topBarTrailing) {
      Button { showScreen.toggle() } label: {
        Image(systemName: showScreen ? "rectangle.slash" : "rectangle.inset.filled.and.person.filled")
          .frame(width: 40, height: 44)
      }
      .accessibilityLabel(showScreen ? "Hide Mac screen" : "Show Mac screen beside the chat")
      .accessibilityIdentifier("task.screen")
      if working {
        Button(role: .destructive) { Task { await stop() } } label: {
          Image(systemName: "stop.circle.fill").font(.title3).foregroundStyle(.red).frame(width: 40, height: 44)
        }
        .accessibilityLabel("Stop the agent")
        .accessibilityIdentifier("task.stop")
      }
      Menu {
        if let task {
          Toggle("Agent may use the screen", isOn: Binding(get: { task.screenControl }, set: { value in
            Task { await setScreenControl(value) }
          }))
          Button { previewing = true } label: { Label("Preview", systemImage: "safari") }
            .accessibilityIdentifier("task.preview")
          Button { Task { await openShell() } } label: { Label("Terminal here", systemImage: "terminal") }
            .accessibilityIdentifier("task.terminal")
          Button { UIPasteboard.general.string = task.cwd } label: { Label("Copy project path", systemImage: "doc.on.doc") }
          Button(role: .destructive) { confirmingRemove = true } label: { Label("Remove chat", systemImage: "trash") }
            .accessibilityIdentifier("task.remove")
        }
      } label: { Image(systemName: "slider.horizontal.3").frame(width: 40, height: 44) }
        .accessibilityLabel("Task options")
        .accessibilityIdentifier("task.options")
    }
  }

  private func dragHandle(height: CGFloat) -> some View {
    Capsule().fill(PalmStyle.line).frame(width: 44, height: 5)
      .frame(maxWidth: .infinity, minHeight: 18)
      .background(PalmStyle.panel)
      .gesture(DragGesture().onChanged { value in
        screenFraction = min(0.75, max(0.25, screenFraction + value.translation.height / height / 8))
      })
      .accessibilityLabel("Resize screen and chat")
  }

  // MARK: Chat column

  private var chat: some View {
    VStack(spacing: 0) {
      if let error = store.error ?? localError {
        Text(error).font(.caption).foregroundStyle(.orange).padding(8)
          .frame(maxWidth: .infinity, alignment: .leading).background(PalmStyle.panel)
      }
      if !showScreen, owner?.kind == "agent", owner?.taskId == taskId {
        // An agent opening something should be watchable.
        Button { showScreen = true } label: {
          HStack(spacing: 8) {
            Image(systemName: "sparkles").foregroundStyle(.orange)
            Text("\(task?.providerName ?? "The agent") is using the Mac screen").font(.footnote.weight(.semibold))
              .foregroundStyle(.white).lineLimit(1).minimumScaleFactor(0.85)
            Spacer(minLength: 6)
            Text("Watch").font(.footnote.weight(.bold)).foregroundStyle(PalmStyle.onAccent)
              .padding(.horizontal, 14).padding(.vertical, 6)
              .background(PalmStyle.accent, in: Capsule())
          }
          .padding(.horizontal, 12).padding(.vertical, 8)
          .frame(maxWidth: .infinity)
          .background(PalmStyle.panel)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("task.watchScreen")
      }
      ScrollViewReader { proxy in
        ScrollView {
          // A plain stack, not a lazy one: rows have exact heights, so the
          // bottom-anchored scroll view settles instead of re-measuring rows
          // in a loop (a lazy stack kept the phone at 100% CPU after a swipe).
          VStack(alignment: .leading, spacing: 10) {
            if store.rows.count > shownRows {
              Button("Show earlier messages") { shownRows += 200 }
                .font(.footnote.weight(.semibold))
                .frame(maxWidth: .infinity)
            }
            if let task {
              VStack(alignment: .leading, spacing: 8) {
                Text(task.title).font(.headline)
                  .accessibilityAddTraits(.isHeader)
                HStack(spacing: 8) {
                  PalmProviderBadge(provider: task.provider, name: task.providerName)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(task.projectName).font(.caption.weight(.semibold))
                    Text(PalmPath.display(task.cwd)).font(.caption2).foregroundStyle(PalmStyle.muted)
                  }
                  Spacer(minLength: 8)
                  PalmStatusChip(status: task.status, approvals: task.pendingApprovals)
                }
                if task.provider == "openrouter" {
                  Label("Paid per use through OpenRouter" + (task.costUsd.map { String(format: " · $%.2f so far", $0) } ?? ""),
                    systemImage: "creditcard")
                    .font(.caption).foregroundStyle(.orange)
                    .accessibilityIdentifier("task.paid")
                }
              }
              .padding(.bottom, 4)
            }
            ForEach(store.rows.suffix(shownRows)) { row in
              if row.kind == .files {
                VStack(alignment: .leading, spacing: 8) {
                  ForEach(row.files) { card in
                    PalmAssistantCardView(
                      card: card, connection: connection, events: events, transfers: transfers, navigator: navigator,
                      handedOver: { _ in })
                  }
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("task.files")
                .id(row.id)
              } else {
                PalmTaskRowView(row: row, answer: { decision in Task { await answer(row.approvalId, decision) } })
                  .equatable()
                  .id(row.id)
              }
            }
            if working && !store.rows.contains(where: { $0.kind == .live }) {
              HStack(spacing: 8) {
                // Waiting on the user is not progress: no spinner then.
                if (task?.pendingApprovals ?? 0) > 0 {
                  Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                  Text("Waiting for your answer").font(.footnote).foregroundStyle(PalmStyle.muted)
                } else {
                  ProgressView().controlSize(.small)
                  Text("Working on your Mac").font(.footnote).foregroundStyle(PalmStyle.muted)
                }
              }
              .id("working")
            }
            Color.clear.frame(height: 1).id("bottom")
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: store.rows) { _, _ in
          withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
      }
      composer
    }
  }

  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if !attachments.isEmpty || composerFocused {
        PalmAttachmentBar(attachments: $attachments).padding(.horizontal, 12)
      }
      if let error = voice.error, voice.owner == nil, active {
        Text(error).font(.footnote).foregroundStyle(.orange).padding(.horizontal, 14)
          .onTapGesture { voice.error = nil }
      }
      if voice.isActive(for: voiceOwner) {
        // Dictated words go into the message, to read before sending.
        PalmVoicePill { polish in
          Task {
            guard let heard = await voice.finish(connection, polish: polish) else { return }
            UIPasteboard.general.string = heard
            let current = draft.trimmingCharacters(in: .whitespacesAndNewlines)
            draft = current.isEmpty ? heard : current + " " + heard
          }
        }
        .padding(.horizontal, 10)
      } else {
        typedComposer
      }
    }
    .padding(.vertical, 8)
  }

  private var voiceOwner: String { "task:\(taskId)" }

  private var typedComposer: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .bottom, spacing: 8) {
        TextField(working ? "Add to the queue" : "Message the agent", text: $draft, axis: .vertical)
          .lineLimit(1...6)
          .focused($composerFocused)
          .padding(.horizontal, 14).padding(.vertical, 11)
          .palmGlass(cornerRadius: 22, interactive: true)
          .accessibilityIdentifier("task.composer")
        if composerFocused {
          // The keyboard could not be put away on this page.
          Button { composerFocused = false } label: {
            Image(systemName: "keyboard.chevron.compact.down").font(.system(size: 18, weight: .medium))
              .foregroundStyle(.white).frame(width: 36, height: 36)
          }
          .accessibilityLabel("Hide keyboard")
          .accessibilityIdentifier("task.hideKeyboard")
        }
        if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty && !sending {
          PalmMicButton(owner: voiceOwner, size: 36, label: "Speak a message", id: "task.mic")
        } else {
          Button { Task { await sendMessage() } } label: {
            Image(systemName: sending ? "hourglass" : "arrow.up.circle.fill").font(.system(size: 34))
              .foregroundStyle(canSend ? PalmStyle.accent : PalmStyle.muted)
          }
          .disabled(!canSend)
          .accessibilityLabel("Send")
          .accessibilityIdentifier("task.send")
        }
      }
      .padding(.horizontal, 10)
    }
  }

  private var canSend: Bool {
    !sending && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  // MARK: Screen pane

  private var owner: PalmScreenOwner? { connection.screenOwner }
  private var agentHasScreen: Bool { owner?.agentHasScreen == true }
  private var screenMode: PalmInputMode { screenModeName == PalmInputMode.trackpad.rawValue ? .trackpad : .touch }
  private var canControlScreen: Bool {
    connection.isStreaming && !agentHasScreen && connection.hostStatus?.controlPermission == true
  }
  private var screenVoiceOwner: String { "taskScreen:\(taskId)" }

  private var screenPane: some View {
    ZStack(alignment: .top) {
      Color.black
      if connection.isStreaming || connection.connectionState == .connecting || connection.connectionState == .reconnecting {
        PalmRemoteSurface(
          displayLayer: connection.video.displayLayer, videoSize: connection.videoSize,
          enabled: canControlScreen,
          mode: screenMode,
          pointer: { connection.sendPointer(action: $0, x: $1, y: $2) },
          scroll: { connection.sendScroll(dx: $0, dy: $1) },
          framing: .fit,
          typing: screenTyping,
          zoomChanged: { connection.setStreamQuality(zoom: $0) },
          edgeFocus: edgeFocus, edgeID: edgeID)
        if !connection.isStreaming {
          ProgressView("Connecting to your Mac").tint(PalmStyle.accent).foregroundStyle(.white)
        }
      } else {
        VStack(spacing: 10) {
          Text("The Mac screen is not showing.").foregroundStyle(PalmStyle.muted)
          Button("Show screen") { startScreen() }.buttonStyle(.borderedProminent).foregroundStyle(PalmStyle.onAccent)
        }
        .frame(maxHeight: .infinity)
      }
      screenBar
      VStack {
        Spacer(minLength: 0)
        if voice.isActive(for: screenVoiceOwner) {
          // Spoken words are pasted at the Mac's cursor and stay on both
          // clipboards; Return is never pressed.
          PalmVoicePill(overVideo: true) { polish in
            Task {
              guard let heard = await voice.finish(connection, polish: polish), canControlScreen else { return }
              UIPasteboard.general.string = heard
              do { try await connection.pasteOnMac(text: heard, image: nil) } catch { localError = connection.friendlyMessage(error) }
            }
          }
          .frame(maxWidth: 440)
          .padding(8)
        } else if connection.isStreaming {
          screenControls
        }
      }
      PalmKeyCatcher(active: $screenTyping, speak: { startScreenVoice() }, paste: { text, image in
        Task {
          do { try await connection.pasteOnMac(text: text, image: image) } catch { localError = connection.friendlyMessage(error) }
        }
      }, photo: {
        screenTyping = false
        pickingPhoto = true
      }) { stroke in
        switch stroke {
        case .text(let text): connection.sendText(text)
        case .key(let key, let modifiers): connection.sendKey(key, modifiers: modifiers)
        }
      }
      .frame(width: 1, height: 1)
      .opacity(0.02)
      .accessibilityHidden(true)
    }
    .clipped()
    .onChange(of: canControlScreen) { _, can in if !can { screenTyping = false } }
    .sheet(isPresented: $showingDock) { PalmDockSheet(connection: connection) { reveal(.dock) } }
    .photosPicker(isPresented: $pickingPhoto, selection: $photoItem, matching: .images)
    .onChange(of: photoItem) { _, item in
      guard let item else { return }
      photoItem = nil
      Task {
        guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else { return }
        do { try await connection.pasteOnMac(text: nil, image: image) } catch { localError = connection.friendlyMessage(error) }
      }
    }
    .sheet(isPresented: $showingApps) {
      // The pane shows the whole screen, so an app is brought forward in place.
      PalmScreenAppsSheet(connection: connection,
        open: { app in try await command("activate", app.bundleId) },
        launch: { app in try await command("launch", app.bundleId) },
        shortcut: { item in
          Task {
            guard await connection.waitUntilControllable() else { return }
            connection.sendKey(item.keys.key, modifiers: item.keys.modifiers)
            if let focus = item.focus {
              edgeFocus = focus
              edgeID += 1
            }
            if item == .spotlight { screenTyping = true }
          }
        })
    }
  }

  /// Touch or mouse, the keyboard (with the key bar), the microphone and apps.
  private var screenControls: some View {
    HStack(spacing: 2) {
      paneButton(screenMode == .touch ? "hand.tap" : "cursorarrow",
        label: screenMode == .touch ? "Touch mode. Tap for mouse mode" : "Mouse mode. Tap for touch mode", id: "task.screen.mode") {
        screenModeName = (screenMode == .touch ? PalmInputMode.trackpad : PalmInputMode.touch).rawValue
        UISelectionFeedbackGenerator().selectionChanged()
      }
      paneButton(screenTyping ? "keyboard.chevron.compact.down" : "keyboard",
        label: screenTyping ? "Hide keyboard" : "Type on the Mac", id: "task.screen.keyboard") {
        composerFocused = false
        screenTyping.toggle()
      }
      paneButton("mic.fill", label: "Speak to type on the Mac", id: "task.screen.mic") { startScreenVoice() }
      paneButton("square.grid.2x2", label: "Apps and Spotlight", id: "task.screen.apps") { showingApps = true }
      PalmMacEdgesMenu(size: 40, id: "task.screen.edges") { edge in
        if edge == .dock { showingDock = true } else { reveal(edge) }
      }
    }
    .padding(3)
    .palmVideoGlass(Capsule(), interactive: true)
    .disabled(!canControlScreen)
    .opacity(canControlScreen ? 1 : 0.55)
    .padding(8)
  }

  /// The pane shows the whole screen: the pointer to that edge (a hidden bar
  /// slides out) and the view zoomed onto it.
  private func reveal(_ edge: PalmMacEdge) {
    edgeFocus = edge.focus
    edgeID += 1
    Task { await connection.revealEdge(edge == .menuBar) }
  }

  private func paneButton(_ icon: String, label: String, id: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: icon).font(.system(size: 16, weight: .medium)).foregroundStyle(.white)
        .frame(width: 42, height: 40)
    }
    .accessibilityLabel(label)
    .accessibilityIdentifier(id)
  }

  private func startScreenVoice() {
    screenTyping = false
    Task {
      if !(await voice.start(for: screenVoiceOwner)), let error = voice.error { localError = error }
    }
  }

  /// Brings an app forward on the Mac, or opens it; the pane keeps showing the whole screen.
  private func command(_ op: String, _ bundleId: String) async throws {
    struct Done: Decodable { let ok: Bool }
    let _: Done = try await connection.post("/api/command", ["op": op, "bundleId": bundleId])
  }

  private var screenBar: some View {
    HStack(spacing: 8) {
      Label(ownerLine, systemImage: agentHasScreen ? "sparkles" : owner?.held == true ? "hand.raised.fill" : "hand.point.up.left")
        .font(.caption.weight(.semibold))
        .lineLimit(1)
        .padding(.horizontal, 12).padding(.vertical, 8)
        .palmGlassCapsule()
      Spacer(minLength: 4)
      if task?.screenControl == false {
        // Off, the agent cannot see or use the screen (its reply says so).
        Button { Task { await setScreenControl(true) } } label: {
          Label("Let the agent use it", systemImage: "sparkles").font(.caption.weight(.bold))
        }
        .palmGlassButton(prominent: true).tint(PalmStyle.accent)
        .accessibilityIdentifier("task.screen.allow")
      } else if agentHasScreen {
        Button { Task { await takeOver() } } label: {
          Label("Take over", systemImage: "hand.raised.fill").font(.caption.weight(.bold))
        }
        .palmGlassButton(prominent: true).tint(.orange)
        .accessibilityIdentifier("task.takeover")
      } else if owner?.held == true {
        Button { Task { await handBack() } } label: {
          Label("Hand back", systemImage: "arrow.uturn.left").font(.caption.weight(.bold))
        }
        .palmGlassButton(prominent: true).tint(PalmStyle.accent)
        .accessibilityIdentifier("task.handback")
      } else if task?.screenControl == true && working {
        Button { Task { await takeOver() } } label: { Label("Hold screen", systemImage: "hand.raised").font(.caption) }
          .palmGlassButton()
      }
      if connection.displays.count > 1 {
        // Several monitors: which Mac screen this pane shows.
        Menu {
          ForEach(connection.displays) { display in
            Button {
              Task {
                do { try await connection.show(display: display) } catch { localError = connection.friendlyMessage(error) }
              }
            } label: {
              if connection.currentDisplay == display { Label(display.name, systemImage: "checkmark") } else { Text(display.name) }
            }
          }
        } label: {
          Image(systemName: "display.2").frame(width: 30, height: 30)
        }
        .palmGlassButton()
        .accessibilityLabel("Choose which Mac screen to show")
        .accessibilityIdentifier("task.screen.displays")
      }
      Button { fullScreen = true } label: {
        Image(systemName: "arrow.up.left.and.arrow.down.right").frame(width: 30, height: 30)
      }
      .palmGlassButton()
      .accessibilityLabel("Open the Mac screen full size")
    }
    .padding(8)
  }

  private var ownerLine: String {
    if agentHasScreen { return owner?.taskId == taskId ? "Agent is using the screen" : "Another agent has the screen" }
    if owner?.held == true { return "You have control" }
    if owner?.kind == "human" { return "You're controlling" }
    if task?.screenControl == true { return connection.isStreaming ? "Live · the agent may use it" : "Screen" }
    return connection.isStreaming ? "Live" : "Screen"
  }

  // MARK: Actions

  private func startScreen() {
    guard scenePhase == .active, !connection.isStreaming else { return }
    Task {
      do { try await connection.start(windowID: 0, name: "Desktop") } catch {
        localError = connection.friendlyMessage(error)
      }
    }
  }

  private func sendMessage() async {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    sending = true
    defer { sending = false }
    do {
      let paths = try await PalmPendingAttachment.upload(attachments, transfers: transfers, connection: connection)
      let summary: PalmTaskSummary = try await connection.post("/api/tasks/\(taskId)/messages", ["text": text, "attachments": paths])
      store.updateSummary(summary)
      draft = ""
      attachments = []
      localError = nil
    } catch { localError = connection.friendlyMessage(error) }
  }

  private func stop() async {
    do {
      let summary: PalmTaskSummary = try await connection.post("/api/tasks/\(taskId)/stop")
      store.updateSummary(summary)
    } catch { localError = connection.friendlyMessage(error) }
  }

  private func answer(_ approvalId: String, _ decision: String) async {
    do { try await connection.send("/api/tasks/\(taskId)/approvals", ["approvalId": approvalId, "decision": decision]) }
    catch { localError = connection.friendlyMessage(error) }
  }

  private func setScreenControl(_ allowed: Bool) async {
    do {
      let summary: PalmTaskSummary = try await connection.post("/api/tasks/\(taskId)/screen", ["allowed": allowed])
      store.updateSummary(summary)
    } catch { localError = connection.friendlyMessage(error) }
  }

  private func takeOver() async {
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    do { let _: PalmScreenState = try await connection.post("/api/screen/takeover") }
    catch { localError = connection.friendlyMessage(error) }
  }

  private func handBack() async {
    do {
      let _: PalmScreenState = try await connection.post("/api/screen/handback", ["taskId": taskId, "continue": true])
    } catch { localError = connection.friendlyMessage(error) }
  }

  private func remove() async {
    do {
      try await connection.send("/api/tasks/\(taskId)/archive", ["archived": true])
      dismiss()
    } catch { localError = connection.friendlyMessage(error) }
  }

  /// A shell in the session's folder: the one already running there, or a new
  /// one. It stays on the Mac and is listed under More › Terminal › Shells;
  /// More › Terminal itself keeps opening its own shell (home by default).
  private func openShell() async {
    guard let task else { return }
    struct Response: Decodable { let terminals: [PalmTerminalInfo] }
    do {
      let running = try await (connection.get("/api/terminals") as Response).terminals
        .filter { $0.running && $0.cwd == task.cwd }
        .max { $0.lastActivity < $1.lastActivity }
      let terminal: PalmTerminalInfo
      if let running {
        terminal = running
      } else {
        terminal = try await connection.post("/api/terminals", ["cwd": task.cwd, "cols": 60, "rows": 30])
      }
      shell = terminal
    } catch { localError = connection.friendlyMessage(error) }
  }
}

/// An agent session's project, previewed: its dev server is reused or started
/// on the Mac, and the page opens as soon as it answers. A URL alone is not a
/// working preview.
struct PalmSessionPreviewSheet: View {
  let cwd: String
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @State private var target: PalmPreviewTarget?
  @State private var message = "Starting the preview"
  @State private var failed = false
  @State private var server: PalmDevServer?
  @State private var logs: PalmDevServer?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    if let target {
      PalmPreviewView(connection: connection, target: target)
    } else {
      NavigationStack {
        VStack(spacing: 14) {
          if failed {
            Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(.orange)
          } else {
            ProgressView().controlSize(.large)
          }
          Text(message).multilineTextAlignment(.center).foregroundStyle(PalmStyle.muted)
            .accessibilityIdentifier("task.preview.status")
          if let server { Button("Logs") { logs = server }.palmGlassButton() }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(PalmStyle.background.ignoresSafeArea())
        .navigationTitle("Preview")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
      }
      .preferredColorScheme(.dark)
      .sheet(item: $logs) { server in PalmDevLogsView(connection: connection, events: events, server: server) }
      .task { await start() }
    }
  }

  private func start() async {
    struct DevList: Decodable { let servers: [PalmDevServer] }
    do {
      let reply: PalmAssistantReply = try await connection.post("/api/assistant/preview", ["cwd": cwd])
      message = reply.reply
      guard let devId = reply.cards.first?.devId else {
        failed = true
        return
      }
      for _ in 0..<90 {
        if let list: DevList = try? await connection.get("/api/dev") {
          server = list.servers.first { $0.id == devId }
          if let port = server?.port {
            let ticket: PalmPreviewTicket = try await connection.post("/api/dev/preview", ["devId": devId])
            target = PalmPreviewTarget(ticket: ticket, devId: devId, port: port)
            return
          }
          if server == nil || server?.status == "exited" {
            failed = true
            message = "The dev server stopped before it opened a port. Its logs say why."
            return
          }
        }
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        if Task.isCancelled { return }
      }
      failed = true
      message = "The dev server has not opened a port after 90 seconds. Its logs say why."
    } catch {
      failed = true
      message = connection.friendlyMessage(error)
    }
  }
}

// MARK: - Rows

struct PalmTaskRowView: View, Equatable {
  let row: PalmTaskStore.Row
  var answer: (String) -> Void
  @State private var expanded = false

  // Only a changed row is redrawn (the answer closure is recreated each time).
  static func == (lhs: PalmTaskRowView, rhs: PalmTaskRowView) -> Bool { lhs.row == rhs.row }

  var body: some View {
    switch row.kind {
    case .user:
      VStack(alignment: .trailing, spacing: 6) {
        Text(row.text).textSelection(.enabled)
          .padding(.horizontal, 14).padding(.vertical, 10)
          .foregroundStyle(.white)
          .background(PalmStyle.raised, in: RoundedRectangle(cornerRadius: 18))
        ForEach(row.attachments, id: \.path) { a in
          Label(a.name, systemImage: a.kind == "image" ? "photo" : "doc").font(.caption).foregroundStyle(PalmStyle.muted)
        }
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    case .assistant, .live:
      PalmMarkdownText(text: row.text)
        .opacity(row.kind == .live ? 0.92 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu { Button { UIPasteboard.general.string = row.text } label: { Label("Copy", systemImage: "doc.on.doc") } }
    case .tool:
      VStack(alignment: .leading, spacing: 6) {
        Button { withAnimation(.easeOut(duration: 0.15)) { expanded.toggle() } } label: {
          HStack(alignment: .top, spacing: 8) {
            toolIcon.frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
              Text(row.title).font(.footnote.weight(.semibold)).foregroundStyle(.white)
              if !row.detail.isEmpty {
                Text(expanded ? row.detail : PalmText.excerpt(row.detail, max: 140)).font(.caption.monospaced())
                  .foregroundStyle(PalmStyle.muted).multilineTextAlignment(.leading)
              }
            }
            Spacer(minLength: 0)
            if !row.output.isEmpty {
              Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.caption).foregroundStyle(PalmStyle.muted)
            }
          }
        }
        .buttonStyle(.plain)
        if expanded && !row.output.isEmpty {
          ScrollView(.horizontal) {
            Text(row.output).font(.caption2.monospaced()).foregroundStyle(PalmStyle.muted).textSelection(.enabled)
              .padding(8)
          }
          .frame(maxHeight: 220)
          .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
        }
      }
      .padding(.horizontal, 10).padding(.vertical, 8)
      .background(expanded ? PalmStyle.panel : Color.clear, in: RoundedRectangle(cornerRadius: 12))
    case .approval:
      VStack(alignment: .leading, spacing: 10) {
        Label(row.title, systemImage: "hand.raised").font(.subheadline.weight(.semibold))
          .foregroundStyle(row.status == "pending" ? .orange : PalmStyle.muted)
        if !row.detail.isEmpty {
          Text(row.detail).font(.caption.monospaced()).foregroundStyle(.white).textSelection(.enabled)
            .padding(8).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
        }
        if row.status == "pending" {
          // Standard buttons: glass inside a scrolling card keeps re-rendering.
          HStack(spacing: 8) {
            Button("Allow") { answer("allow") }
              .buttonStyle(.borderedProminent).tint(PalmStyle.accent).foregroundStyle(PalmStyle.onAccent)
              .accessibilityIdentifier("approval.allow")
            if row.options.contains("allowSession") {
              Button("Always") { answer("allowSession") }.buttonStyle(.bordered).tint(PalmStyle.accent)
            }
            Button("Deny", role: .destructive) { answer("deny") }.buttonStyle(.bordered)
              .accessibilityIdentifier("approval.deny")
          }
          .buttonBorderShape(.capsule)
        } else {
          Text(row.status == "allowed" ? "Allowed" : row.status == "denied" ? "Denied" : "No longer waiting")
            .font(.caption).foregroundStyle(PalmStyle.muted)
        }
      }
      .padding(12)
      .background(PalmStyle.raised, in: RoundedRectangle(cornerRadius: 14))
      .overlay(RoundedRectangle(cornerRadius: 14).stroke(row.status == "pending" ? Color.orange : .clear, lineWidth: 1))
    case .notice, .screen:
      Label(row.text, systemImage: row.kind == .screen ? "hand.raised" : "info.circle")
        .font(.caption).foregroundStyle(PalmStyle.muted)
    case .agentNote:
      Label(row.text, systemImage: "text.bubble").font(.footnote).foregroundStyle(.white)
        .padding(10).background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 12))
    case .turn:
      HStack {
        Rectangle().fill(PalmStyle.line).frame(height: 1)
        Text(row.text).font(.caption2).foregroundStyle(PalmStyle.muted).fixedSize()
        Rectangle().fill(PalmStyle.line).frame(height: 1)
      }
    case .error:
      Label(row.text, systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
        .textSelection(.enabled)
    case .files:
      EmptyView()  // Drawn by the chat itself: its cards need the connection.
    }
  }

  @ViewBuilder private var toolIcon: some View {
    switch row.status {
    case "running": ProgressView().controlSize(.mini)
    case "failed", "declined": Image(systemName: "xmark.circle.fill").foregroundStyle(.orange)
    default: Image(systemName: "checkmark.circle.fill").foregroundStyle(PalmStyle.accent)
    }
  }
}

/// Prose with inline Markdown, and fenced code blocks shown as scrollable code.
struct PalmMarkdownText: View {
  let text: String

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        if block.code {
          ScrollView(.horizontal, showsIndicators: false) {
            Text(block.text).font(.caption.monospaced()).padding(10).textSelection(.enabled)
          }
          .background(Color.black.opacity(0.4), in: RoundedRectangle(cornerRadius: 10))
        } else {
          Text(attributed(block.text)).font(.body).textSelection(.enabled)
        }
      }
    }
  }

  private var blocks: [(code: Bool, text: String)] {
    var out: [(Bool, String)] = []
    let parts = text.components(separatedBy: "```")
    for (index, part) in parts.enumerated() {
      if index % 2 == 1 {
        var lines = part.components(separatedBy: "\n")
        if let first = lines.first, !first.contains(" "), first.count < 20 { lines.removeFirst() }
        out.append((true, lines.joined(separator: "\n").trimmingCharacters(in: .newlines)))
      } else {
        let trimmed = part.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { out.append((false, trimmed)) }
      }
    }
    return out
  }

  private func attributed(_ value: String) -> AttributedString {
    (try? AttributedString(markdown: value, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
      ?? AttributedString(value)
  }
}

/// A navigation title only when the view owns its bar.
private struct PalmOptionalTitle: ViewModifier {
  let title: String?
  func body(content: Content) -> some View {
    if let title {
      content.navigationTitle(title).navigationBarTitleDisplayMode(.inline)
    } else {
      content
    }
  }
}

