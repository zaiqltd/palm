import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Task list

@MainActor
final class PalmTaskList: ObservableObject {
  @Published private(set) var tasks: [PalmTaskSummary] = []
  @Published private(set) var providers: [PalmProvider] = []
  @Published private(set) var projects: [PalmProject] = []
  @Published var error: String?
  /// True once the first list has arrived, so the empty state never flashes.
  @Published private(set) var loaded = false
  /// Sessions working on the other paired computers, each marked with its computer.
  @Published private(set) var elsewhere: [(device: PalmDevice, task: PalmTaskSummary)] = []
  private var listener: UUID?

  func start(_ connection: PalmConnection, events: PalmEvents) {
    guard listener == nil else { return }
    listener = events.listen("tasks") { [weak self] message in
      guard let self, let raw = message["task"],
        let data = try? JSONSerialization.data(withJSONObject: raw),
        let task = try? JSONDecoder().decode(PalmTaskSummary.self, from: data)
      else { return }
      if let index = self.tasks.firstIndex(where: { $0.id == task.id }) {
        if task.archived { self.tasks.remove(at: index) } else { self.tasks[index] = task }
      } else if !task.archived { self.tasks.insert(task, at: 0) }
      self.tasks.sort { $0.updated > $1.updated }
    }
    Task { await refresh(connection) }
  }

  func refresh(_ connection: PalmConnection) async {
    struct Tasks: Decodable { let tasks: [PalmTaskSummary] }
    let device = connection.currentDeviceId
    do {
      let list = try await (connection.get("/api/tasks") as Tasks).tasks
      // A computer switched meanwhile: this list belongs to the old one.
      guard connection.currentDeviceId == device else { return }
      tasks = list
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
    loaded = true
    await lookElsewhere(connection)
  }

  /// Another computer was chosen: its own sessions, from scratch.
  func computerChanged(_ connection: PalmConnection) {
    tasks = []
    loaded = false
    Task { await refresh(connection) }
  }

  /// Working sessions on the other computers, read with their own pairings.
  func lookElsewhere(_ connection: PalmConnection) async {
    struct Tasks: Decodable { let tasks: [PalmTaskSummary] }
    var found: [(device: PalmDevice, task: PalmTaskSummary)] = []
    for device in connection.devices where device.id != connection.currentDeviceId {
      guard let result: Tasks = try? await connection.peek("/api/tasks", on: device.id) else { continue }
      found += result.tasks.filter { $0.isWorking || $0.pendingApprovals > 0 }.map { (device, $0) }
    }
    elsewhere = found
  }

  /// Takes a chat off the list at once; the Mac archives it (its log stays on
  /// the Mac) and stops it first if it is still working.
  func remove(_ id: String, _ connection: PalmConnection) async {
    let before = tasks
    withAnimation { tasks.removeAll { $0.id == id } }
    do { try await connection.send("/api/tasks/\(id)/archive", ["archived": true]) } catch {
      tasks = before
      self.error = connection.friendlyMessage(error)
    }
  }

  func loadChoices(_ connection: PalmConnection, refresh: Bool = false) async {
    struct Providers: Decodable { let providers: [PalmProvider] }
    struct Projects: Decodable { let projects: [PalmProject] }
    async let p: Providers = connection.get("/api/agents/providers", refresh ? ["refresh": "1"] : [:])
    async let q: Projects = connection.get("/api/projects", refresh ? ["refresh": "1"] : [:])
    do {
      providers = try await p.providers
      projects = try await q.projects
    } catch { self.error = connection.friendlyMessage(error) }
  }
}

/// The developer workspace: every agent session, reached directly (never
/// only through the assistant). A strip of named sessions sits at the top;
/// the most recent ones stay open, so switching keeps each conversation, its
/// scroll position and its running work.
struct PalmAgentsView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @ObservedObject var transfers: PalmTransfers
  @ObservedObject var navigator: PalmNavigator
  @StateObject private var list = PalmTaskList()
  @State private var creating = false
  @State private var confirmRemove: PalmTaskSummary?
  /// Sessions kept open behind the selected one, most recent last.
  @State private var open: [String] = []
  @State private var renaming: PalmTaskSummary?
  @State private var newName = ""
  @ObservedObject private var watch = PalmAgentWatch.shared
  @State private var showAllOthers = false

  private var selected: PalmTaskSummary? { list.tasks.first { $0.id == navigator.agentTask } }
  /// Oldest on the left, newest beside +, so the strip does not reshuffle as
  /// sessions work.
  private var stripTasks: [PalmTaskSummary] { list.tasks.sorted { $0.created < $1.created }.suffix(16) }

  var body: some View {
    NavigationStack {
      VStack(spacing: 0) {
        if !list.tasks.isEmpty { strip }
        ZStack {
          // A list kept behind a session would still reach VoiceOver; it is
          // rebuilt at once from memory instead.
          if selected == nil { sessionList }
          ForEach(open, id: \.self) { id in
            let active = id == selected?.id
            PalmTaskView(
              taskId: id, connection: connection, events: events, transfers: transfers, navigator: navigator,
              embedded: true, active: active)
              .opacity(active ? 1 : 0)
              .allowsHitTesting(active)
              .accessibilityHidden(!active)
          }
        }
      }
      .background(PalmStyle.background.ignoresSafeArea())
      .navigationTitle(selected?.providerName ?? "Agents")
      .navigationBarTitleDisplayMode(.inline)
      .palmDeviceSubtitle(connection)
      .palmComputerMenu(connection, navigator)
      .toolbar {
        if selected == nil {
          ToolbarItem(placement: .topBarTrailing) {
            Button { creating = true } label: { Label("New agent task", systemImage: "square.and.pencil") }
              .accessibilityIdentifier("agents.new")
          }
        }
      }
      .confirmationDialog("Stop \(confirmRemove?.providerName ?? "the agent") and remove this chat?",
        isPresented: Binding(get: { confirmRemove != nil }, set: { if !$0 { confirmRemove = nil } }),
        titleVisibility: .visible
      ) {
        Button("Stop and remove", role: .destructive) {
          if let task = confirmRemove { Task { await list.remove(task.id, connection) } }
        }
      } message: {
        Text("It is still working.")
      }
      .alert("Rename session", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
        TextField("Name", text: $newName).accessibilityIdentifier("agents.renameField")
        Button("Save") { if let task = renaming { Task { await rename(task.id) } } }
        Button("Cancel", role: .cancel) {}
      }
      .sheet(isPresented: $creating) {
        PalmNewTaskView(connection: connection, list: list, transfers: transfers) { id in
          creating = false
          navigator.agentTask = id
        }
      }
      .sheet(item: Binding(
        get: { navigator.watchSession.flatMap { watch.session($0) } },
        set: { if $0 == nil { navigator.watchSession = nil } })
      ) { session in
        PalmWatchDetailView(session: session, connection: connection, navigator: navigator)
      }
    }
    .onAppear {
      list.start(connection, events: events)
      keepOpen(navigator.agentTask)
    }
    .onChange(of: connection.deviceEpoch) { _, _ in
      // Sessions belong to their computer: none stay open from the last one.
      open = []
      list.computerChanged(connection)
    }
    .onChange(of: navigator.agentTask) { _, id in keepOpen(id) }
    .onChange(of: list.tasks.map(\.id)) { _, ids in
      // A removed session leaves the strip; its view closes.
      open.removeAll { !ids.contains($0) }
      if let id = navigator.agentTask, list.loaded, !ids.contains(id) { navigator.agentTask = nil }
    }
  }

  // MARK: Strip

  /// All on the left and + on the right stay put; the sessions scroll
  /// between them.
  private var strip: some View {
    HStack(spacing: 6) {
      Button { navigator.agentTask = nil } label: {
        chipLabel("All", selected: selected == nil, dot: nil)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("All sessions")
      .accessibilityIdentifier("agents.strip.all")
      ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 6) {
            ForEach(stripTasks) { task in
              Button { navigator.agentTask = task.id } label: {
                chipLabel(task.title, selected: task.id == selected?.id, dot: dotColor(task))
              }
              .buttonStyle(.plain)
              .contextMenu {
                Text("\(task.title)\n\(task.providerName) · \(connection.hostStatus?.name ?? "Mac")")
                Button {
                  newName = task.title
                  renaming = task
                } label: { Label("Rename", systemImage: "pencil") }
                Button(role: .destructive) { requestRemove(task) } label: { Label("Remove", systemImage: "trash") }
              }
              .accessibilityLabel("\(task.title), \(task.providerName), on \(connection.hostStatus?.name ?? "Mac"), \(statusWord(task))")
              .accessibilityIdentifier("agents.strip.chip")
              .id(task.id)
            }
          }
        }
        .onChange(of: navigator.agentTask) { _, id in
          if let id { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(id, anchor: .center) } }
        }
      }
      Button { creating = true } label: {
        Image(systemName: "plus").font(.subheadline.weight(.bold)).foregroundStyle(.white)
          .frame(width: 38, height: 32).background(PalmStyle.raised, in: Capsule())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("New session")
      .accessibilityIdentifier("agents.strip.new")
    }
    .padding(.horizontal, 12).padding(.vertical, 6)
  }

  private func chipLabel(_ title: String, selected: Bool, dot: Color?) -> some View {
    HStack(spacing: 6) {
      if let dot { Circle().fill(dot).frame(width: 7, height: 7) }
      Text(title).lineLimit(1).frame(maxWidth: 150, alignment: .leading).fixedSize(horizontal: true, vertical: false)
    }
    .font(.subheadline.weight(.semibold))
    .foregroundStyle(selected ? PalmStyle.onAccent : .white)
    .padding(.horizontal, 12).frame(height: 32)
    .background(selected ? PalmStyle.accent : PalmStyle.raised, in: Capsule())
  }

  private func dotColor(_ task: PalmTaskSummary) -> Color {
    if task.pendingApprovals > 0 || ["waiting", "failed", "interrupted"].contains(task.status) { return .orange }
    return task.isWorking ? PalmStyle.success : PalmStyle.muted
  }

  private func statusWord(_ task: PalmTaskSummary) -> String {
    if task.pendingApprovals > 0 || task.status == "waiting" { return "needs you" }
    switch task.status {
    case "running", "starting": return "working"
    case "idle": return "ready"
    default: return task.status
    }
  }

  // MARK: All sessions

  private var sessionList: some View {
    List {
      if !events.connected {
        PalmLiveBanner(events: events).listRowBackground(Color.clear)
      }
      if let error = list.error {
        PalmNotice(symbol: "exclamationmark.circle", text: error, warning: true)
          .listRowBackground(Color.clear)
      }
      Section {
      ForEach(list.tasks) { task in
        Button { navigator.agentTask = task.id } label: { PalmTaskRow(task: task).contentShape(Rectangle()) }
          .buttonStyle(.plain)
          .listRowBackground(PalmStyle.panel)
          .accessibilityIdentifier("agents.task")
          .swipeActions(edge: .trailing, allowsFullSwipe: !task.isWorking) {
            Button { requestRemove(task) } label: { Label("Remove", systemImage: "trash") }
              .tint(.red)
          }
          .contextMenu {
            Button {
              newName = task.title
              renaming = task
            } label: { Label("Rename", systemImage: "pencil") }
            Button(role: .destructive) { requestRemove(task) } label: { Label("Remove chat", systemImage: "trash") }
          }
      }
      } header: {
        if !watch.others.isEmpty && !list.tasks.isEmpty { Text("In Palm") }
      }
      if !watch.others.isEmpty { othersSection }
      if !list.elsewhere.isEmpty { elsewhereSection }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .refreshable {
      await list.refresh(connection)
      await watch.refresh(connection)
    }
    .overlay {
      if list.tasks.isEmpty && list.loaded && watch.others.isEmpty {
        ContentUnavailableView {
          Label("No agent sessions yet", systemImage: "chevron.left.forwardslash.chevron.right")
        } description: {
          Text("Start Claude Code, Codex or another agent on your Mac. Sessions keep running after you close Palm.")
        } actions: {
          Button("New session") { creating = true }
            .palmGlassButton(prominent: true)
            .accessibilityIdentifier("agents.empty.new")
        }
      }
    }
  }

  // MARK: Other computers

  /// Sessions working on the other paired computers: shown with their
  /// computer; opening one switches to that computer first.
  private var elsewhereSection: some View {
    Section {
      ForEach(list.elsewhere, id: \.task.id) { item in
        Button {
          Task {
            await connection.switchTo(item.device.id)
            navigator.openAgent(item.task.id)
          }
        } label: {
          VStack(alignment: .leading, spacing: 3) {
            Text(item.task.title).font(.body.weight(.semibold)).foregroundStyle(.white).lineLimit(2)
            HStack(spacing: 6) {
              PalmStatusChip(status: item.task.status, approvals: item.task.pendingApprovals)
              Text("\(item.task.providerName) on \(item.device.name)").font(.caption).foregroundStyle(PalmStyle.muted)
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(PalmStyle.panel)
        .accessibilityIdentifier("agents.elsewhere.row")
      }
    } header: {
      Text("On other computers")
    } footer: {
      Text("Opening one switches Palm to that computer; nothing moves between computers.")
    }
  }

  // MARK: Every other agent on the Mac

  /// Working, waiting or recent first; the rest behind one row.
  private var shownOthers: [PalmWatchSession] {
    let recent = watch.others.filter { $0.isActive || ($0.updatedDate.map { -$0.timeIntervalSinceNow < 12 * 3600 } ?? false) }
    return showAllOthers ? watch.others : recent
  }

  private var othersSection: some View {
    Section {
      ForEach(shownOthers) { session in
        Button { navigator.watchSession = session.id } label: {
          PalmWatchRow(session: session, connection: connection).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
          let muted = PalmAgentWatch.isMuted(session.title)
          Button { PalmAgentWatch.setMuted(session.title, !muted) } label: {
            Label(muted ? "Alert me about this again" : "No alerts for this", systemImage: muted ? "bell" : "bell.slash")
          }
        }
        .listRowBackground(PalmStyle.panel)
        .accessibilityIdentifier("agents.watch.row")
      }
      let hidden = watch.others.count - shownOthers.count
      if hidden > 0 {
        Button("Show \(hidden) earlier") { showAllOthers = true }
          .listRowBackground(PalmStyle.panel)
          .accessibilityIdentifier("agents.watch.more")
      }
    } header: {
      Text("Also on this Mac")
    } footer: {
      Text("Claude Code, Codex and OpenCode sessions started outside Palm, including the agents they launch. Palm shows them and can open them on the Mac.")
    }
  }

  private func keepOpen(_ id: String?) {
    guard let id else { return }
    open.removeAll { $0 == id }
    open.append(id)
    if open.count > 4 { open.removeFirst(open.count - 4) }
  }

  private func rename(_ id: String) async {
    do {
      let _: PalmTaskSummary = try await connection.post("/api/tasks/\(id)/rename", ["title": newName])
      await list.refresh(connection)
    } catch { list.error = connection.friendlyMessage(error) }
  }

  /// A finished chat goes at once; a working one asks first.
  private func requestRemove(_ task: PalmTaskSummary) {
    if task.isWorking { confirmRemove = task } else { Task { await list.remove(task.id, connection) } }
  }
}

/// Shown only while live updates are down, with the actual reason.
struct PalmLiveBanner: View {
  @ObservedObject var events: PalmEvents
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      ProgressView().controlSize(.small).tint(.orange)
      VStack(alignment: .leading, spacing: 3) {
        Text("Reconnecting live updates").font(.subheadline.weight(.semibold))
        if let error = events.lastError { Text(error).font(.caption).foregroundStyle(PalmStyle.muted) }
      }
      Spacer(minLength: 8)
      Button("Retry") { events.reconnect() }.font(.subheadline.weight(.semibold))
    }
    .padding(12)
    .background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 14))
    .accessibilityElement(children: .combine)
  }
}

struct PalmTaskRow: View {
  let task: PalmTaskSummary
  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      PalmProviderBadge(provider: task.provider, name: task.providerName)
      VStack(alignment: .leading, spacing: 4) {
        HStack(alignment: .top, spacing: 8) {
          Text(task.title).font(.body.weight(.semibold))
            .frame(maxWidth: .infinity, alignment: .leading)
          Text(PalmTime.relative(task.updated)).font(.caption).foregroundStyle(PalmStyle.muted)
            .layoutPriority(1)
            .padding(.top, 2)
        }
        HStack(spacing: 6) {
          PalmStatusChip(status: task.status, approvals: task.pendingApprovals)
          Text(task.projectName).font(.caption).foregroundStyle(PalmStyle.muted)
        }
        if !task.preview.isEmpty {
          Text(PalmText.excerpt(task.preview, max: 110)).font(.subheadline).foregroundStyle(PalmStyle.muted)
        }
      }
    }
    .padding(.vertical, 4)
  }
}

struct PalmProviderBadge: View {
  let provider: String
  var name = ""
  var body: some View {
    Group {
      switch provider {
      case "codex": Image(systemName: "chevron.left.forwardslash.chevron.right").foregroundStyle(Color.white)
      case "claude": Image(systemName: "asterisk").foregroundStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
      // Any other agent: its initial.
      default: Text(String((name.isEmpty ? provider : name).prefix(1)).uppercased()).foregroundStyle(Color.white)
      }
    }
    .font(.system(size: 15, weight: .bold))
    .frame(width: 34, height: 34)
    .background(PalmStyle.raised, in: RoundedRectangle(cornerRadius: 10))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(name.isEmpty ? (provider == "codex" ? "Codex" : "Claude Code") : name)
  }
}

struct PalmStatusChip: View {
  let status: String
  var approvals = 0
  var body: some View {
    let (label, color): (String, Color) = {
      if approvals > 0 { return ("Needs you", .orange) }
      switch status {
      case "running", "starting": return ("Working", PalmStyle.accent)
      case "waiting": return ("Needs you", .orange)
      case "idle": return ("Done", PalmStyle.muted)
      case "stopped": return ("Stopped", PalmStyle.muted)
      case "interrupted": return ("Interrupted", .orange)
      case "failed": return ("Failed", .red)
      default: return (status.capitalized, PalmStyle.muted)
      }
    }()
    Text(label).font(.caption.weight(.semibold)).foregroundStyle(color)
      .padding(.horizontal, 7).padding(.vertical, 2)
      .background(color.opacity(0.15), in: Capsule())
  }
}

// MARK: - New task

struct PalmNewTaskView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var list: PalmTaskList
  @ObservedObject var transfers: PalmTransfers
  var created: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @AppStorage("palm.agent.provider") private var provider = "claude"
  /// "" is the Mac user's home folder. (A new key: early builds stored a fixed folder here.)
  @AppStorage("palm.agent.folder") private var projectPath = ""
  @AppStorage("palm.agent.access") private var access = "workspace"
  @AppStorage("palm.agent.screen") private var screenControl = true
  @State private var model = "default"
  @State private var text = ""
  @State private var attachments: [PalmPendingAttachment] = []
  @ObservedObject private var voice = PalmVoice.shared
  @State private var busy = false
  @State private var error: String?
  @State private var projectSearch = ""
  @State private var choosingProject = false
  @FocusState private var focused: Bool

  private var selectedProvider: PalmProvider? { list.providers.first { $0.id == provider } }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Agent", selection: $provider) {
            ForEach(list.providers.isEmpty ? [] : list.providers) { p in
              Text(p.available ? p.name : "\(p.name) (not installed)").tag(p.id)
            }
            if list.providers.isEmpty {
              Text("Claude Code").tag("claude")
              Text("Codex").tag("codex")
            }
          }
          .accessibilityIdentifier("newtask.provider")
          if let p = selectedProvider {
            Text(providerLine(p)).font(.caption).foregroundStyle(PalmStyle.muted)
          }
          Button { choosingProject = true } label: {
            HStack {
              Label("Folder", systemImage: "folder")
              Spacer()
              Text(projectPath.isEmpty ? "Home folder" : PalmPath.display(projectPath))
                .foregroundStyle(PalmStyle.muted).multilineTextAlignment(.trailing)
            }
          }
          .accessibilityIdentifier("newtask.project")
          Picker("Access", selection: $access) {
            ForEach(accessModes, id: \.self) { mode in Text(accessLabel(mode)).tag(mode) }
          }
          if let models = selectedProvider?.models, models.count > 1 {
            Picker("Model", selection: $model) {
              ForEach(models, id: \.self) { m in
                Text(m == "default" ? "Default\(selectedProvider?.defaultModel.map { " (\($0))" } ?? "")" : (selectedProvider?.modelNames?[m] ?? m)).tag(m)
              }
            }
          }
          Toggle("Let it use the Mac screen", isOn: $screenControl).tint(PalmStyle.switchTint)
        } header: {
          Text("Agent")
        } footer: {
          Text("Other coding agents, such as Gemini CLI, GitHub Copilot, Cursor and OpenCode, appear here once they are installed on your Mac. Each uses its own sign-in.")
        }
        Section {
          TextField("What should it do?", text: $text, axis: .vertical)
            .lineLimit(4...12)
            .focused($focused)
            .accessibilityIdentifier("newtask.message")
          // Speak the task instead of typing it.
          if voice.isActive(for: "newtask") {
            PalmVoicePill { polish in
              Task {
                guard let heard = await voice.finish(connection, polish: polish) else { return }
                UIPasteboard.general.string = heard
                let current = text.trimmingCharacters(in: .whitespacesAndNewlines)
                text = current.isEmpty ? heard : current + " " + heard
              }
            }
          } else {
            HStack {
              Text("Or say it").font(.footnote).foregroundStyle(PalmStyle.muted)
              Spacer()
              PalmMicButton(owner: "newtask", size: 34, label: "Speak the task", id: "newtask.mic")
            }
          }
          PalmAttachmentBar(attachments: $attachments)
        } header: {
          Text("Task")
        } footer: {
          Text("The agent runs on your Mac with the access above and keeps working if you leave Palm.")
        }
        if let error {
          Section { Text(error).foregroundStyle(.orange) }
        }
      }
      .scrollContentBackground(.hidden)
      .background(PalmStyle.background)
      .navigationTitle("New task")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(busy ? "Starting" : "Start") { Task { await start() } }
            .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("newtask.start")
        }
      }
      .sheet(isPresented: $choosingProject) {
        PalmProjectPicker(projects: list.projects, selection: $projectPath)
      }
      .task {
        await list.loadChoices(connection)
        // The last agent used may no longer be installed.
        if !list.providers.contains(where: { $0.id == provider && $0.available }),
          let first = list.providers.first(where: \.available)
        {
          provider = first.id
        }
        focused = true
      }
      .onChange(of: provider) { _, _ in
        model = "default"
        if !accessModes.contains(access) { access = "workspace" }
      }
    }
    .preferredColorScheme(.dark)
  }

  private func providerLine(_ p: PalmProvider) -> String {
    guard p.available else { return p.detail ?? "Not installed on the Mac." }
    if p.billing == "api" { return (p.detail ?? "Paid per use through OpenRouter") + " · within your limits" }
    var parts = [p.version.map { "Version \($0)" }]
    if let signedIn = p.signedIn { parts.append(signedIn ? "Signed in\(p.plan.map { " · \($0)" } ?? "")" : "Not signed in on the Mac") }
    if p.acp == true { parts.append("Uses its own sign-in on the Mac") }
    return parts.compactMap { $0 }.joined(separator: " · ")
  }

  private var accessModes: [String] { selectedProvider?.modes ?? ["ask", "workspace", "full", "plan"] }

  private func accessLabel(_ mode: String) -> String {
    switch mode {
    case "ask": return "Ask before changes"
    case "workspace": return "Edit this project"
    case "auto": return "Auto (\(selectedProvider?.name ?? "the agent") decides)"
    case "full": return "Full access"
    case "plan": return "Plan only"
    default: return mode.capitalized
    }
  }

  private func start() async {
    busy = true
    defer { busy = false }
    error = nil
    do {
      let paths = try await PalmPendingAttachment.upload(attachments, transfers: transfers, connection: connection)
      let task: PalmTaskSummary = try await connection.post("/api/tasks", [
        "provider": provider, "cwd": projectPath.isEmpty ? "~" : projectPath, "text": text, "access": access, "model": model,
        "screenControl": screenControl, "attachments": paths,
      ])
      created(task.id)
    } catch { self.error = connection.friendlyMessage(error) }
  }
}

struct PalmProjectPicker: View {
  let projects: [PalmProject]
  @Binding var selection: String
  @Environment(\.dismiss) private var dismiss
  @State private var search = ""
  @State private var custom = ""

  var body: some View {
    NavigationStack {
      List {
        Section {
          Button {
            selection = ""
            dismiss()
          } label: {
            Label("Home folder", systemImage: selection.isEmpty ? "checkmark.circle.fill" : "house")
          }
          .accessibilityIdentifier("project.home")
        }
        Section {
          HStack {
            TextField("~/work/my-project", text: $custom).textInputAutocapitalization(.never).autocorrectionDisabled()
              .font(.body.monospaced())
            Button("Use") {
              selection = custom == "~" ? "" : custom
              dismiss()
            }.disabled(!(custom.hasPrefix("/") || custom.hasPrefix("~")))
          }
        } header: {
          Text("Folder path")
        } footer: {
          Text("~ is your home folder on the Mac.")
        }
        Section("Projects on your Mac") {
          ForEach(projects.filter { search.isEmpty || $0.path.localizedCaseInsensitiveContains(search) }) { project in
            Button {
              selection = project.path
              dismiss()
            } label: {
              VStack(alignment: .leading, spacing: 3) {
                HStack {
                  Text(project.name).font(.body.weight(.medium)).foregroundStyle(.white)
                  if project.path == selection { Image(systemName: "checkmark").foregroundStyle(PalmStyle.accent) }
                }
                Text(PalmPath.display(project.path)).font(.caption).foregroundStyle(PalmStyle.muted)
              }
            }
          }
        }
      }
      .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search projects")
      .navigationTitle("Project")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
      .onAppear { custom = selection.isEmpty ? "~" : PalmPath.display(selection) }
    }
    .preferredColorScheme(.dark)
  }
}

// MARK: - Attachments picked on the phone

struct PalmPendingAttachment: Identifiable, Equatable {
  let id = UUID()
  let name: String
  let file: URL
  let isImage: Bool

  /// Upload to the Mac inbox, verified, and return Mac paths for the agent.
  static func upload(_ items: [PalmPendingAttachment], transfers: PalmTransfers, connection: PalmConnection) async throws -> [String] {
    guard !items.isEmpty else { return [] }
    let places: PalmPlaces = try await connection.get("/api/fs/places")
    var paths: [String] = []
    for item in items {
      guard let result = await transfers.upload(item.file, name: item.name, to: places.inbox) else {
        throw PalmFailure.message("\(item.name) did not reach the Mac intact. Nothing was sent.")
      }
      paths.append(result.path)
    }
    return paths
  }
}

struct PalmPickedMedia: Transferable {
  let url: URL
  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .image) { received in try PalmPickedMedia(copying: received.file) }
    FileRepresentation(importedContentType: .movie) { received in try PalmPickedMedia(copying: received.file) }
  }
  init(copying source: URL) throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("palm-picked-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let target = folder.appendingPathComponent(source.lastPathComponent)
    try FileManager.default.copyItem(at: source, to: target)
    url = target
  }
}

enum PalmMedia {
  /// Photos arrive as HEIC; JPEG is what web projects and most tools use.
  static func jpegIfNeeded(_ url: URL) -> URL {
    let ext = url.pathExtension.lowercased()
    guard ["heic", "heif"].contains(ext), let image = UIImage(contentsOfFile: url.path),
      let data = image.jpegData(compressionQuality: 0.9)
    else { return url }
    // Always write the converted copy inside Palm's own temporary folder,
    // never next to a file shared from another app.
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("palm-jpeg-\(UUID().uuidString)")
    let target = folder.appendingPathComponent(url.deletingPathExtension().lastPathComponent).appendingPathExtension("jpg")
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try data.write(to: target)
      return target
    } catch { return url }
  }
}

struct PalmAttachmentBar: View {
  @Binding var attachments: [PalmPendingAttachment]
  @State private var photos: [PhotosPickerItem] = []
  @State private var importing = false
  @State private var loading = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !attachments.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack {
            ForEach(attachments) { item in
              HStack(spacing: 6) {
                Image(systemName: item.isImage ? "photo" : "doc")
                Text(item.name).font(.caption).fixedSize()
                Button { attachments.removeAll { $0.id == item.id } } label: { Image(systemName: "xmark.circle.fill") }
                  .accessibilityLabel("Remove \(item.name)")
              }
              .padding(.horizontal, 10).padding(.vertical, 6)
              .background(PalmStyle.raised, in: Capsule())
            }
          }
        }
      }
      HStack(spacing: 14) {
        PhotosPicker(selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .videos])) {
          Label("Photos", systemImage: "photo.on.rectangle")
        }
        .accessibilityIdentifier("attach.photos")
        Button { importing = true } label: { Label("Files", systemImage: "doc.badge.plus") }
        if loading { ProgressView() }
      }
      .font(.subheadline)
    }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      guard case .success(let urls) = result else { return }
      for url in urls {
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("palm-files-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent(url.lastPathComponent)
        if (try? FileManager.default.copyItem(at: url, to: target)) != nil {
          attachments.append(PalmPendingAttachment(name: url.lastPathComponent, file: target,
            isImage: UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true))
        }
      }
    }
    .onChange(of: photos) { _, items in
      guard !items.isEmpty else { return }
      loading = true
      Task {
        for item in items {
          if let media = try? await item.loadTransferable(type: PalmPickedMedia.self) {
            let file = PalmMedia.jpegIfNeeded(media.url)
            attachments.append(PalmPendingAttachment(name: file.lastPathComponent, file: file,
              isImage: UTType(filenameExtension: file.pathExtension)?.conforms(to: .image) == true))
          }
        }
        photos = []
        loading = false
      }
    }
  }
}
