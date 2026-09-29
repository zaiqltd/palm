import Network
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

/// The Mac's controls, shown under More: status, dev servers and previews,
/// the clipboard, display and power.
struct PalmMacContent: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @ObservedObject var transfers: PalmTransfers
  @State private var system: PalmSystemStatus?
  @State private var dev: PalmDevState?
  @State private var error: String?
  @State private var notice: String?
  @State private var brightness = 0.5
  @State private var editingBrightness = false
  @State private var keyboardLevel = 0.5
  @State private var editingKeyboard = false
  @State private var choosingSleep = false
  static let sleepChoices: [(minutes: Int, title: String)] = [
    (15, "15 minutes"), (30, "30 minutes"), (60, "1 hour"), (120, "2 hours"), (180, "3 hours"),
  ]
  @State private var confirm: String?
  @State private var preview: PalmPreviewTarget?
  @State private var logs: PalmDevServer?
  @State private var starting = false
  @State private var clipboard: PalmClipboard?
  @State private var listeners: [UUID] = []
  @AppStorage("palm.wakeInfo") private var wakeInfoData = Data()

  var body: some View {
      List {
        statusSection
        devSection
        clipboardSection
        displaySection
        powerSection
      }
      .scrollContentBackground(.hidden)
      .navigationTitle(connection.hostStatus?.name ?? "Mac")
      .navigationBarTitleDisplayMode(.inline)
      .refreshable { await load() }
      .task { await load() }
      .onAppear(perform: subscribe)
      .onDisappear { for id in listeners { events.stopListening(id) }; listeners = [] }
      .sheet(item: $preview) { target in PalmPreviewView(connection: connection, target: target) }
      .sheet(item: $logs) { server in PalmDevLogsView(connection: connection, events: events, server: server) }
      .sheet(isPresented: $starting) {
        PalmStartDevView(connection: connection) { started in
          starting = false
          if started { Task { await load() } }
        }
      }
      .confirmationDialog(confirmTitle, isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }), titleVisibility: .visible) {
        if let action = confirm {
          Button(confirmButton(action), role: .destructive) { Task { await perform(action, ["confirm": true]) } }
            .accessibilityIdentifier("confirm.action")
        }
      } message: { Text(confirmMessage) }
      .palmToast($notice)
      .palmToast($error, warning: true)
      .palmScreen()
  }

  // MARK: Sections

  private var statusSection: some View {
    Section {
      if let path = system?.network?.path {
        HStack {
          Label(path.direct ? "Direct connection" : "Relayed connection (slow)", systemImage: path.direct ? "antenna.radiowaves.left.and.right" : "tortoise.fill")
            .foregroundStyle(path.direct ? PalmStyle.accent : .orange)
          Spacer()
          if let ms = path.milliseconds { Text(verbatim: "\(Int(ms)) ms").foregroundStyle(PalmStyle.muted).font(.callout.monospacedDigit()) }
        }
        if !path.direct {
          Text("Traffic is going through Tailscale's relay, which makes the screen slow. Repair restarts Tailscale on the Mac; Palm reconnects by itself.")
            .font(.caption).foregroundStyle(PalmStyle.muted)
          Button("Repair network path") { Task { await perform("repairNetwork") } }
        }
      }
      if let health = system?.network?.health, !health.isEmpty {
        ForEach(health, id: \.self) { Text($0).font(.caption).foregroundStyle(.orange) }
      }
      if let power = system?.power {
        HStack {
          Label(power.source == "ac" ? "On power" : "On battery", systemImage: power.source == "ac" ? "powerplug.fill" : "battery.50")
          Spacer()
          if let percent = power.batteryPercent {
            let charging = power.source == "ac"
            Text("\(percent)%\(power.remaining.map { charging ? " · full in \($0)" : " · \($0) left" } ?? "")")
              .foregroundStyle(percent < 20 && !charging ? .orange : PalmStyle.muted)
          }
        }
      }
    } header: { Text(connection.hostStatus?.name ?? "This Mac") }
    .listRowBackground(PalmStyle.panel)
  }

  private var devSection: some View {
    Section {
      ForEach(dev?.servers ?? []) { server in
        VStack(alignment: .leading, spacing: 8) {
          HStack {
            Circle().fill(server.status == "running" ? (server.port != nil ? PalmStyle.accent : .yellow) : PalmStyle.muted).frame(width: 8, height: 8)
            Text(server.name).font(.body.weight(.medium))
            Spacer()
            if let port = server.port { Text(verbatim: ":\(port)").font(.caption.monospaced()).foregroundStyle(PalmStyle.muted) }
          }
          Text(server.command).font(.caption.monospaced()).foregroundStyle(PalmStyle.muted)
          HStack(spacing: 8) {
            if server.status == "running" {
              Button("Open preview") { Task { await openPreview(devId: server.id, port: server.port) } }
                .buttonStyle(.borderedProminent).tint(PalmStyle.accent).foregroundStyle(PalmStyle.onAccent)
                .disabled(server.port == nil)
                .accessibilityIdentifier("dev.preview.\(server.id)")
              Button("Logs") { logs = server }.buttonStyle(.bordered)
              Button("Stop", role: .destructive) { Task { await devAction(server.id, "stop") } }.buttonStyle(.bordered)
            } else {
              Text(server.status == "failed" ? "Failed (exit \(server.exitCode ?? -1))" : "Stopped").font(.caption).foregroundStyle(.orange)
              Button("Logs") { logs = server }.buttonStyle(.bordered)
              Button("Restart") { Task { await devAction(server.id, "restart") } }.buttonStyle(.bordered)
              Button("Remove") { Task { await devAction(server.id, "remove") } }.buttonStyle(.bordered)
            }
          }
          .font(.footnote)
        }
        .padding(.vertical, 4)
      }
      Button { starting = true } label: { Label("Start a dev server", systemImage: "play.circle") }
        .accessibilityIdentifier("dev.start")
      let others = (dev?.ports ?? []).filter { $0.devId == nil }
      if !others.isEmpty {
        DisclosureGroup("Already running on this Mac (\(others.count))") {
          ForEach(others) { port in
            HStack(alignment: .center, spacing: 10) {
              VStack(alignment: .leading, spacing: 3) {
                Text(port.displayName).font(.subheadline.weight(.medium))
                Text(port.detail).font(.caption).foregroundStyle(PalmStyle.muted)
              }
              Spacer(minLength: 6)
              Button("Open") { Task { await openPreview(devId: nil, port: port.port) } }
                .buttonStyle(.bordered).buttonBorderShape(.capsule)
                .font(.footnote.weight(.semibold))
            }
            .padding(.vertical, 2)
          }
        }
      }
    } header: { Text("Dev servers") } footer: {
      Text("Builds run on the Mac. Previews open privately on your phone over Tailscale, at the phone's own screen size, with hot reload.")
    }
    .listRowBackground(PalmStyle.panel)
  }

  private var clipboardSection: some View {
    Section {
      HStack {
        Label("Send this iPhone's clipboard", systemImage: "arrow.up.doc")
        Spacer(minLength: 8)
        PasteButton(supportedContentTypes: [.image, .plainText, .url, .text]) { providers in
          Task { await sendPhoneClipboard(providers) }
        }
        .buttonBorderShape(.capsule)
        .labelStyle(.titleOnly)
        .accessibilityIdentifier("clipboard.send")
      }
      Button { Task { await fetchMacClipboard() } } label: { Label("Get the Mac's clipboard", systemImage: "arrow.down.doc") }
        .accessibilityIdentifier("clipboard.get")
      if let clipboard {
        if let text = clipboard.text, clipboard.kinds.first == "text" || clipboard.imagePNG == nil {
          Text(PalmText.excerpt(text, max: 300)).font(.caption.monospaced()).foregroundStyle(PalmStyle.muted)
          Text("Copied to this iPhone.").font(.caption).foregroundStyle(PalmStyle.accent)
        }
        if let png = clipboard.imagePNG, let data = Data(base64Encoded: png), let image = UIImage(data: data) {
          Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 160)
          Text(verbatim: "Image copied to this iPhone (\(clipboard.imageWidth ?? 0)×\(clipboard.imageHeight ?? 0)).").font(.caption).foregroundStyle(PalmStyle.accent)
        }
        if let files = clipboard.files, !files.isEmpty {
          ForEach(files, id: \.self) { file in
            Button { Task { _ = await transfers.download(file) } } label: {
              Label("Download \((file as NSString).lastPathComponent)", systemImage: "arrow.down.circle")
            }
          }
        }
      }
    } header: { Text("Clipboard") } footer: {
      Text("Paste puts what this iPhone copied, text or an image, on the Mac's clipboard. Get copies the Mac's clipboard to this iPhone.")
    }
    .listRowBackground(PalmStyle.panel)
  }

  private var displaySection: some View {
    Section("Display") {
      if system?.display?.builtIn == true {
        HStack {
          Image(systemName: "sun.min")
          Slider(value: $brightness, in: 0...1) { editing in
            editingBrightness = editing
            if !editing { Task { await perform("brightness", ["value": brightness]) } }
          }
          Image(systemName: "sun.max.fill")
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Display brightness")
      }
      if let keyboard = system?.display?.keyboardLight {
        VStack(alignment: .leading, spacing: 6) {
          Text("Keyboard light").font(.subheadline)
          HStack {
            Image(systemName: "light.min")
            Slider(value: $keyboardLevel, in: 0...1) { editing in
              editingKeyboard = editing
              if !editing { Task { await perform("keyboardLight", ["value": keyboardLevel]) } }
            }
            .accessibilityLabel("Keyboard light")
            .accessibilityIdentifier("mac.keyboardLight")
            Image(systemName: "light.max")
          }
        }
        if let auto = keyboard.auto {
          Toggle(isOn: Binding(get: { auto }, set: { value in Task { await perform("keyboardLight", ["auto": value]) } })) {
            VStack(alignment: .leading, spacing: 2) {
              Text("Adjust keyboard light in low light")
              Text("macOS may change the level you set when this is on.").font(.caption).foregroundStyle(PalmStyle.muted)
            }
          }
          .tint(PalmStyle.switchTint)
        }
      }
      Toggle(isOn: Binding(get: { system?.display?.curtain == true }, set: { value in Task { await perform("curtain", ["on": value]) } })) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Privacy screen")
          Text("The Mac's own display goes black; you keep seeing and controlling it here.").font(.caption).foregroundStyle(PalmStyle.muted)
        }
      }
      .tint(PalmStyle.switchTint)
      Button { Task { await perform("displaySleep") } } label: { Label("Turn the display off now", systemImage: "display") }
    }
    .listRowBackground(PalmStyle.panel)
  }

  private var powerSection: some View {
    Section {
      Toggle(isOn: Binding(get: { system?.keepAwake.on == true }, set: { value in Task { await perform("keepAwake", ["on": value]) } })) {
        VStack(alignment: .leading, spacing: 2) {
          Text("Keep the Mac awake")
          Text(system?.keepAwake.reason == "agents" ? "On while an agent is working." : "Stops idle sleep; the display can still turn off.")
            .font(.caption).foregroundStyle(PalmStyle.muted)
        }
      }
      .tint(PalmStyle.switchTint)
      if let login = system?.loginItem, login.status != "unavailable" {
        Toggle(isOn: Binding(get: { login.status == "enabled" || login.status == "requiresApproval" },
          set: { value in Task { await perform("loginItem", ["on": value]) } })) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Open Palm at login")
            Text(login.status == "requiresApproval"
              ? "Approve Palm in System Settings › General › Login Items on the Mac."
              : "After a restart, Palm is back as soon as you log in.")
              .font(.caption).foregroundStyle(login.status == "requiresApproval" ? Color.orange : PalmStyle.muted)
          }
        }
        .tint(PalmStyle.switchTint)
        .accessibilityIdentifier("mac.loginItem")
      }
      Button { confirm = "lock" } label: { Label("Lock", systemImage: "lock") }
      Button { confirm = "sleep" } label: { Label("Sleep", systemImage: "moon") }
      if let sleepAt = system?.sleepAt.flatMap({ PalmTime.date($0) }) {
        HStack {
          Label {
            VStack(alignment: .leading, spacing: 2) {
              Text("Sleeps at \(sleepAt.formatted(date: .omitted, time: .shortened))")
              Text(sleepAt, style: .relative).font(.caption).foregroundStyle(PalmStyle.muted)
            }
          } icon: { Image(systemName: "moon.zzz") }
          Spacer()
          Button("Cancel") { Task { await perform("cancelSleep") } }
            .buttonStyle(.bordered).buttonBorderShape(.capsule)
            .accessibilityIdentifier("mac.cancelSleep")
        }
      } else {
        Button { choosingSleep = true } label: { Label("Sleep later", systemImage: "moon.zzz") }
          .accessibilityIdentifier("mac.sleepLater")
          .confirmationDialog("Put your Mac to sleep in", isPresented: $choosingSleep, titleVisibility: .visible) {
            ForEach(PalmMacContent.sleepChoices, id: \.minutes) { choice in
              Button(choice.title) { Task { await perform("sleepIn", ["minutes": choice.minutes, "confirm": true]) } }
            }
          } message: {
            Text("Palm will be unreachable while the Mac sleeps. You can cancel the timer until then.")
          }
      }
      Button { confirm = "restart" } label: { Label("Restart", systemImage: "arrow.clockwise") }
      Button(role: .destructive) { confirm = "shutdown" } label: { Label("Shut down", systemImage: "power") }
      Button { Task { await wake() } } label: { Label("Wake (same Wi-Fi only)", systemImage: "alarm") }
      if let caps = system?.capabilities {
        DisclosureGroup("What each control can and cannot do") {
          ForEach(caps) { cap in
            VStack(alignment: .leading, spacing: 2) {
              Text(cap.title + (cap.state == "unavailable" ? " — not possible" : "")).font(.footnote.weight(.semibold))
              Text(cap.detail).font(.caption).foregroundStyle(PalmStyle.muted)
            }
            .padding(.vertical, 2)
          }
        }
      }
    } header: { Text("Power") }
    .listRowBackground(PalmStyle.panel)
  }

  // MARK: Data

  private func subscribe() {
    guard listeners.isEmpty else { return }
    listeners.append(events.listen("dev") { _ in Task { await loadDev() } })
    listeners.append(events.listen("system") { _ in Task { await loadSystem() } })
  }

  private func load() async {
    await loadSystem()
    await loadDev()
    if let info: PalmWakeInfo = try? await connection.post("/api/system/action", ["action": "wakeInfo"]),
      let data = try? JSONEncoder().encode(info)
    {
      wakeInfoData = data
    }
  }

  private func loadSystem() async {
    do {
      system = try await connection.get("/api/system")
      if !editingBrightness, let value = system?.display?.brightness { brightness = value }
      if !editingKeyboard, let value = system?.display?.keyboardLight?.level { keyboardLevel = value }
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func loadDev() async {
    do { dev = try await connection.get("/api/dev") } catch { self.error = connection.friendlyMessage(error) }
  }

  private func perform(_ action: String, _ options: [String: Any] = [:]) async {
    do {
      var body = options
      body["action"] = action
      let result: PalmActionResult = try await connection.post("/api/system/action", body)
      notice = result.detail
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      await loadSystem()
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func devAction(_ id: String, _ action: String) async {
    do {
      try await connection.send("/api/dev/\(id)/\(action)")
      await loadDev()
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func openPreview(devId: String?, port: Int?) async {
    do {
      var body: [String: Any] = [:]
      if let devId { body["devId"] = devId } else if let port { body["port"] = port }
      let ticket: PalmPreviewTicket = try await connection.post("/api/dev/preview", body)
      preview = PalmPreviewTarget(ticket: ticket, devId: devId, port: port)
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func fetchMacClipboard() async {
    do {
      let value: PalmClipboard = try await connection.get("/api/clipboard")
      clipboard = value
      if let png = value.imagePNG, let data = Data(base64Encoded: png), let image = UIImage(data: data) {
        UIPasteboard.general.image = image
      } else if let text = value.text {
        UIPasteboard.general.string = text
      }
      if value.kinds.isEmpty { notice = "The Mac's clipboard is empty or holds a format Palm does not carry." }
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func sendPhoneClipboard(_ providers: [NSItemProvider]) async {
    guard let provider = providers.first else { return }
    do {
      if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
        let data = try await loadData(provider, type: .image)
        guard let image = UIImage(data: data), let png = image.pngData() else { throw PalmFailure.message("That image could not be read.") }
        try await connection.send("/api/clipboard", ["imagePNG": png.base64EncodedString()])
        notice = "Image placed on the Mac's clipboard."
      } else {
        let data = try await loadData(provider, type: provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) ? .url : .plainText)
        let text = String(decoding: data, as: UTF8.self)
        try await connection.send("/api/clipboard", ["text": text])
        notice = "Text placed on the Mac's clipboard (\(text.count) characters)."
      }
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func loadData(_ provider: NSItemProvider, type: UTType) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      _ = provider.loadDataRepresentation(for: type) { data, error in
        if let data { continuation.resume(returning: data) }
        else { continuation.resume(throwing: error ?? PalmFailure.message("Nothing to paste.")) }
      }
    }
  }

  private func wake() async {
    guard let info = try? JSONDecoder().decode(PalmWakeInfo.self, from: wakeInfoData), !info.interfaces.isEmpty else {
      error = "Palm needs to see the Mac awake once to learn how to wake it."
      return
    }
    for interface in info.interfaces { PalmWakeOnLAN.send(mac: interface.mac, address: interface.address) }
    notice = "Wake request sent to the Mac on this Wi-Fi. It works only when both are on the same Wi-Fi and the Mac is on power; it has not yet been confirmed on this Mac."
  }

  // MARK: Confirmation text

  private var confirmTitle: String {
    switch confirm {
    case "lock": return "Lock your Mac?"
    case "sleep": return "Put your Mac to sleep?"
    case "restart": return "Restart your Mac?"
    case "shutdown": return "Shut down your Mac?"
    default: return ""
    }
  }
  private var confirmMessage: String {
    switch confirm {
    case "lock": return "Palm cannot unlock it again; you'll need the Mac itself or macOS Screen Sharing."
    case "sleep": return "Palm will be unreachable until the Mac wakes."
    case "restart": return "Palm comes back only after someone logs in on the Mac (FileVault)."
    case "shutdown": return "Palm cannot turn the Mac back on."
    default: return ""
    }
  }
  private func confirmButton(_ action: String) -> String {
    ["lock": "Lock", "sleep": "Sleep", "restart": "Restart", "shutdown": "Shut Down"][action] ?? "Continue"
  }
}

enum PalmWakeOnLAN {
  /// A standard magic packet: 6 × 0xFF followed by the MAC address 16 times.
  /// iOS allows broadcast only with Apple's multicast entitlement, so the
  /// packet goes unicast to the Mac's last known LAN address (Local Network
  /// permission). A sleep proxy on the LAN may or may not pass it on.
  static func send(mac: String, address: String) {
    let bytes = mac.split(separator: ":").compactMap { UInt8($0, radix: 16) }
    guard bytes.count == 6 else { return }
    var packet = Data(repeating: 0xFF, count: 6)
    for _ in 0..<16 { packet.append(contentsOf: bytes) }
    for host in [address] {
      let connection = NWConnection(host: NWEndpoint.Host(host), port: 9, using: .udp)
      connection.start(queue: .global())
      connection.send(content: packet, completion: .contentProcessed { _ in connection.cancel() })
    }
  }
}

// MARK: - Dev server start and logs

struct PalmStartDevView: View {
  @ObservedObject var connection: PalmConnection
  var done: (Bool) -> Void
  @State private var projects: [PalmProject] = []
  @State private var search = ""
  @State private var custom = ""
  @State private var chosen: PalmProject?
  @State private var error: String?

  var body: some View {
    NavigationStack {
      List {
        if let error { Text(error).foregroundStyle(.orange) }
        if let chosen {
          Section("Run in \(chosen.name)") {
            ForEach(chosen.scripts.filter { ["dev", "start", "preview", "serve", "watch", "build"].contains($0) || $0.hasPrefix("dev") }, id: \.self) { script in
              Button { Task { await start(chosen, script: script, command: nil) } } label: {
                Label("npm run \(script)", systemImage: "play.fill").font(.body.monospaced())
              }
            }
            HStack {
              TextField("Other command", text: $custom).textInputAutocapitalization(.never).autocorrectionDisabled()
                .font(.body.monospaced())
              Button("Run") { Task { await start(chosen, script: nil, command: custom) } }.disabled(custom.isEmpty)
            }
          }
        }
        Section("Projects") {
          ForEach(projects.filter { (search.isEmpty || $0.path.localizedCaseInsensitiveContains(search)) && ($0.markers.contains("node") || $0.markers.contains("static") || $0.markers.contains("python")) }) { project in
            Button { chosen = project } label: {
              VStack(alignment: .leading) {
                Text(project.name).foregroundStyle(.white)
                Text(PalmPath.display(project.path)).font(.caption).foregroundStyle(PalmStyle.muted)
              }
            }
          }
        }
      }
      .searchable(text: $search, prompt: "Search projects")
      .navigationTitle("Start dev server")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { done(false) } } }
      .task {
        struct Projects: Decodable { let projects: [PalmProject] }
        projects = (try? await (connection.get("/api/projects") as Projects).projects) ?? []
      }
    }
    .preferredColorScheme(.dark)
  }

  private func start(_ project: PalmProject, script: String?, command: String?) async {
    do {
      var body: [String: Any] = ["cwd": project.path]
      if let script { body["script"] = script } else if let command { body["command"] = command }
      let _: PalmDevServer = try await connection.post("/api/dev", body)
      done(true)
    } catch { self.error = connection.friendlyMessage(error) }
  }
}

struct PalmDevLogsView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  let server: PalmDevServer
  @State private var lines: [PalmDevLogLine] = []
  @State private var listener: UUID?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 1) {
            ForEach(lines) { line in
              Text(line.text).font(.caption2.monospaced()).textSelection(.enabled).id(line.n)
            }
          }
          .padding(10)
        }
        .onChange(of: lines.count) { _, _ in if let last = lines.last { proxy.scrollTo(last.n, anchor: .bottom) } }
      }
      .background(Color.black)
      .navigationTitle(server.name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button { UIPasteboard.general.string = lines.map(\.text).joined(separator: "\n") } label: { Image(systemName: "doc.on.doc") }
        }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .task {
        if let logs: PalmDevLogs = try? await connection.get("/api/dev/\(server.id)/logs") { lines = logs.lines }
        listener = events.listen("dev:\(server.id)") { message in
          guard let raw = message["lines"], let data = try? JSONSerialization.data(withJSONObject: raw),
            let more = try? JSONDecoder().decode([PalmDevLogLine].self, from: data)
          else { return }
          let known = Set(lines.map(\.n))
          lines.append(contentsOf: more.filter { !known.contains($0.n) })
          if lines.count > 3000 { lines.removeFirst(lines.count - 3000) }
        }
      }
      .onDisappear { if let listener { events.stopListening(listener) } }
    }
    .preferredColorScheme(.dark)
  }
}

// MARK: - Web preview

struct PalmPreviewTarget: Identifiable {
  let id = UUID()
  var ticket: PalmPreviewTicket
  let devId: String?
  let port: Int?
}

struct PalmPreviewView: View {
  @ObservedObject var connection: PalmConnection
  @State var target: PalmPreviewTarget
  @State private var reloadID = 0
  @State private var title = ""
  @State private var loading = true
  @State private var error: String?
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL

  var body: some View {
    NavigationStack {
      PalmWebView(url: URL(string: target.ticket.url)!, reloadID: reloadID, title: $title, loading: $loading, error: $error)
        .ignoresSafeArea(.container, edges: .bottom)
        .overlay(alignment: .top) {
          if let error {
            Text(error).font(.caption).padding(8).background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 8)).padding()
          }
        }
        .navigationTitle(title.isEmpty ? "Preview" : title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
          ToolbarItemGroup(placement: .topBarTrailing) {
            if loading { ProgressView() }
            Button { reloadID += 1 } label: { Image(systemName: "arrow.clockwise") }.accessibilityLabel("Reload")
            Button { Task { await openInSafari() } } label: { Image(systemName: "safari") }.accessibilityLabel("Open in Safari")
          }
        }
    }
    .preferredColorScheme(.dark)
  }

  // Safari needs its own single-use ticket to set its own cookie.
  private func openInSafari() async {
    var body: [String: Any] = [:]
    if let devId = target.devId { body["devId"] = devId } else if let port = target.port { body["port"] = port }
    guard let ticket: PalmPreviewTicket = try? await connection.post("/api/dev/preview", body),
      let url = URL(string: ticket.url)
    else { return }
    openURL(url)
  }
}

struct PalmWebView: UIViewRepresentable {
  let url: URL
  let reloadID: Int
  @Binding var title: String
  @Binding var loading: Bool
  @Binding var error: String?

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.allowsInlineMediaPlayback = true
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.allowsBackForwardNavigationGestures = true
    view.isInspectable = true
    view.load(URLRequest(url: url))
    context.coordinator.lastReload = reloadID
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {
    context.coordinator.parent = self
    if context.coordinator.lastReload != reloadID {
      context.coordinator.lastReload = reloadID
      view.reload()
    }
  }

  final class Coordinator: NSObject, WKNavigationDelegate {
    var parent: PalmWebView
    var lastReload = 0
    init(_ parent: PalmWebView) { self.parent = parent }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
      parent.loading = true
      parent.error = nil
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      parent.loading = false
      parent.title = webView.title ?? ""
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
      parent.loading = false
      parent.error = error.localizedDescription
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
      parent.loading = false
      parent.error = error.localizedDescription
    }
  }
}
