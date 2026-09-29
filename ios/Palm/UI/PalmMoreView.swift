import SwiftUI

/// Everything that is not a daily destination: the terminal, the Mac's
/// controls, what Palm remembers and settings.
struct PalmMoreView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @ObservedObject var transfers: PalmTransfers
  @ObservedObject var navigator: PalmNavigator

  var body: some View {
    NavigationStack {
      List {
        Section {
          NavigationLink { PalmComputersView(connection: connection, navigator: navigator) } label: {
            LabeledContent {
              Text("\(connection.devices.count)")
            } label: {
              Label("Computers", systemImage: "laptopcomputer.and.iphone")
            }
          }
          .accessibilityIdentifier("more.computers")
        }
        .listRowBackground(PalmStyle.panel)
        Section {
          NavigationLink { PalmTerminalsContent(connection: connection, events: events) } label: {
            Label("Terminal", systemImage: "terminal")
          }
          .accessibilityIdentifier("more.terminal")
          NavigationLink { PalmMacContent(connection: connection, events: events, transfers: transfers) } label: {
            Label("Mac", systemImage: "laptopcomputer")
          }
          .accessibilityIdentifier("more.mac")
          NavigationLink { PalmMediaView(connection: connection) } label: {
            Label("Camera and mic", systemImage: "camera")
          }
          .accessibilityIdentifier("more.media")
        }
        .listRowBackground(PalmStyle.panel)
        Section {
          NavigationLink { PalmPreferencesView(connection: connection) } label: {
            Label("Preferences", systemImage: "slider.horizontal.3")
          }
          .accessibilityIdentifier("more.preferences")
          NavigationLink { PalmTimingsView(connection: connection) } label: {
            Label("Timings", systemImage: "stopwatch")
          }
          .accessibilityIdentifier("more.timings")
          NavigationLink { PalmSettingsView(connection: connection) } label: {
            Label("Pairing and settings", systemImage: "gearshape")
          }
        }
        .listRowBackground(PalmStyle.panel)
      }
      .scrollContentBackground(.hidden)
      .navigationTitle("More")
      .palmRootTitle()
      .palmDeviceSubtitle(connection)
      .palmComputerMenu(connection, navigator)
      .palmScreen()
    }
  }
}

/// What Palm remembers about this computer: the default agent, folder names
/// such as "normal work folder", and workspaces. The assistant uses them; they
/// are kept on the Mac they describe.
struct PalmPreferencesView: View {
  @ObservedObject var connection: PalmConnection
  @State private var memory: PalmMemorySnapshot?
  @State private var providers: [PalmProvider] = []
  @State private var error: String?
  @State private var adding: String?  // "alias" or "workspace"
  @State private var name = ""
  @State private var folder = "~/"
  @State private var voiceStatus: PalmVoiceStatus?
  @State private var enteringKey = false
  @State private var keyText = ""
  @State private var savingKey = false
  @AppStorage("palm.voice.speakReplies") private var speakReplies = true
  @AppStorage(PalmAgentWatch.finishedKey) private var notifyFinished = true
  @AppStorage(PalmAgentWatch.attentionKey) private var notifyAttention = true
  @AppStorage(PalmConnection.invertScrollKey) private var invertScroll = false
  @AppStorage(PalmAgentWatch.muteRoutineKey) private var muteRoutine = true
  @AppStorage(PalmAssistantAccess.key) private var assistantAccess = PalmAssistantAccess.full

  var body: some View {
    List {
      Section {
        Picker("Default agent", selection: Binding(
          get: { memory?.preferences.defaultAgent ?? "" },
          set: { value in Task { await setDefault(value) } })
        ) {
          Text("First available").tag("")
          ForEach(providers.filter(\.available)) { p in Text(p.name).tag(p.id) }
        }
        .accessibilityIdentifier("prefs.defaultAgent")
        Picker("Sessions it starts", selection: $assistantAccess) {
          ForEach(PalmAssistantAccess.choices, id: \.0) { choice in Text(choice.1).tag(choice.0) }
        }
        .accessibilityIdentifier("prefs.assistantAccess")
      } footer: {
        Text("The default agent is used when you ask the assistant to start one without naming it. Full access is Claude Code's bypass permissions and Codex's full access: the agent runs commands and changes files without asking. Sessions you start in Agents › New use the access you choose there.")
      }
      .listRowBackground(PalmStyle.panel)
      places("Folder names", kind: "alias", items: memory?.aliases ?? [],
        footer: "Your names for folders, such as “normal work folder”. Say them to the assistant.")
      places("Workspaces", kind: "workspace", items: memory?.workspaces ?? [],
        footer: "A project or a documents folder with a friendly name, such as “Website”.")
      voiceSection
      Section {
        Toggle("Invert scrolling", isOn: $invertScroll).accessibilityIdentifier("prefs.invertScroll")
      } header: {
        Text("Screen")
      } footer: {
        Text("Reverses the direction a finger (Touch) or two fingers (Mouse) scroll the Mac. Also in the screen's options.")
      }
      .listRowBackground(PalmStyle.panel)
      PalmApiRouteSection(connection: connection)
      Section {
        Toggle("When an agent finishes", isOn: $notifyFinished).accessibilityIdentifier("prefs.notify.finished")
        Toggle("When an agent needs me or fails", isOn: $notifyAttention).accessibilityIdentifier("prefs.notify.attention")
        Toggle("Mute repeating and scheduled agents", isOn: $muteRoutine).accessibilityIdentifier("prefs.notify.muteRoutine")
      } header: {
        Text("Alerts")
      } footer: {
        Text("Repeating and scheduled means Codex runs started by a script or tool, and any session with the same title as another; hold a session in Agents › Also on this Mac to mute just that one. Every agent on the Mac counts: Palm's, Claude Code's (and the agents it launches), Codex's and OpenCode's. While Palm is open, a line at the top says what changed; anything that changed while it was closed shows when you open it. Alerts on a locked phone need Apple's push service, which needs the paid developer membership.")
      }
      .listRowBackground(PalmStyle.panel)
      if let error {
        Section { Text(error).foregroundStyle(.orange) }.listRowBackground(PalmStyle.panel)
      }
    }
    .scrollContentBackground(.hidden)
    .navigationTitle("Preferences")
    .navigationBarTitleDisplayMode(.inline)
    .palmScreen()
    .task { await load() }
    .refreshable { await load() }
    .alert(adding == "alias" ? "Name a folder" : "Add a workspace", isPresented: Binding(
      get: { adding != nil }, set: { if !$0 { adding = nil } })
    ) {
      TextField(adding == "alias" ? "normal work folder" : "Website", text: $name)
        .accessibilityIdentifier("prefs.name")
      TextField("~/work", text: $folder)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
        .accessibilityIdentifier("prefs.folder")
      // Read now: closing the alert clears `adding` before the task runs.
      Button("Save") {
        let kind = adding
        Task { await add(kind) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("The folder must exist on \(connection.hostStatus?.name ?? "the Mac"). ~ is the home folder.")
    }
    .alert("OpenRouter key", isPresented: $enteringKey) {
      SecureField("sk-or-…", text: $keyText)
        .textInputAutocapitalization(.never).autocorrectionDisabled()
      Button("Save") {
        let key = keyText
        keyText = ""
        Task { await saveKey(key) }
      }
      Button("Cancel", role: .cancel) { keyText = "" }
    } message: {
      Text("It is kept on \(connection.hostStatus?.name ?? "the Mac") and sent only to OpenRouter.")
    }
  }

  private var voiceSection: some View {
    Section {
      HStack {
        Label("OpenRouter key", systemImage: "key")
        Spacer()
        if savingKey { ProgressView() } else {
          Text(voiceStatus?.configured == true ? "Set \(voiceStatus?.keyHint ?? "")" : "Not set")
            .foregroundStyle(voiceStatus?.configured == true ? PalmStyle.success : PalmStyle.muted)
            .accessibilityIdentifier("prefs.voice.state")
        }
      }
      if let usage = voiceStatus?.usage { Text(Self.spending(usage)).font(.footnote).foregroundStyle(PalmStyle.muted) }
      Button(voiceStatus?.configured == true ? "Change key" : "Add key") { enteringKey = true }
        .accessibilityIdentifier("prefs.voice.key")
      if voiceStatus?.configured == true && voiceStatus?.keyHint != nil {
        Button("Remove key", role: .destructive) { Task { await saveKey(nil) } }
      }
      Toggle("Speak replies", isOn: $speakReplies)
        .accessibilityIdentifier("prefs.voice.speak")
      Toggle("Use AI for everything else", isOn: Binding(
        get: { memory?.preferences.answerQuestions ?? true },
        set: { value in Task { await setAnswers(value) } }))
        .accessibilityIdentifier("prefs.voice.answers")
    } header: {
      Text("Voice")
    } footer: {
      Text("Tap the microphone in the Assistant, an agent chat, the Screen or the Terminal. Your Mac sends the recording to OpenRouter: MAI-Transcribe-2 writes it down, GPT-6 Luna tidies it when you tap Polish, and Qwen reads spoken requests' replies aloud. With Use AI on, requests Palm cannot place at once go to GPT-6 Luna, which searches and lists your files, checks agents, starts an agent or opens a preview for you; it sees file names, folders and dates, never contents. Nothing is saved.")
    }
    .listRowBackground(PalmStyle.panel)
  }

  static func spending(_ usage: PalmVoiceStatus.Usage) -> String {
    func money(_ value: Double?) -> String { value.map { String(format: "$%.2f", $0) } ?? "unknown" }
    let limit = usage.limit.map { "limit \(money($0)), \(money(usage.remaining)) left" } ?? "no spending limit set on this key"
    return "This key, all apps: today \(money(usage.today)), this month \(money(usage.month)); \(limit)."
  }

  private func saveKey(_ key: String?) async {
    savingKey = true
    defer { savingKey = false }
    do {
      voiceStatus = try await connection.post("/api/voice/key", ["key": key.map { $0 as Any } ?? NSNull()])
      voiceStatus = (try? await connection.get("/api/voice", ["usage": "1"])) ?? voiceStatus
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func setAnswers(_ on: Bool) async {
    do { memory = try await connection.post("/api/memory/preferences", ["answerQuestions": on]) } catch {
      self.error = connection.friendlyMessage(error)
    }
  }

  private func places(_ title: String, kind: String, items: [PalmMemorySnapshot.Place], footer: String) -> some View {
    Section {
      ForEach(items) { item in
        VStack(alignment: .leading, spacing: 3) {
          Text(item.name).font(.body.weight(.semibold))
          HStack(spacing: 6) {
            Text(PalmPath.display(item.path)).font(.caption).foregroundStyle(PalmStyle.muted)
            if !item.exists { Text("Missing").font(.caption.weight(.semibold)).foregroundStyle(.orange) }
          }
        }
        .swipeActions {
          Button(role: .destructive) { Task { await remove(kind, item.id) } } label: { Label("Remove", systemImage: "trash") }
        }
      }
      Button {
        name = ""
        folder = "~/"
        adding = kind
      } label: { Label(kind == "alias" ? "Name a folder" : "Add a workspace", systemImage: "plus") }
      .accessibilityIdentifier("prefs.add.\(kind)")
    } header: {
      Text(title)
    } footer: {
      Text(footer)
    }
    .listRowBackground(PalmStyle.panel)
  }

  private func load() async {
    struct Providers: Decodable { let providers: [PalmProvider] }
    do {
      memory = try await connection.get("/api/memory")
      providers = (try? await connection.get("/api/agents/providers") as Providers)?.providers ?? providers
      voiceStatus = try? await connection.get("/api/voice", ["usage": "1"])
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func add(_ kind: String?) async {
    guard let kind else { return }
    do {
      memory = try await connection.post("/api/memory/\(kind)", ["name": name, "path": folder])
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func remove(_ kind: String, _ id: String) async {
    do { memory = try await connection.post("/api/memory/remove", ["kind": kind, "id": id]) } catch {
      self.error = connection.friendlyMessage(error)
    }
  }

  private func setDefault(_ id: String) async {
    do {
      memory = try await connection.post("/api/memory/preferences", ["defaultAgent": id.isEmpty ? NSNull() : id])
    } catch { self.error = connection.friendlyMessage(error) }
  }
}
