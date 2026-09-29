import SwiftTerm
import SwiftUI
import UIKit

// MARK: - Terminal tab

/// Opens straight into a shell on the Mac, in the home folder. The shell keeps
/// running on the Mac when you leave; coming back reattaches to it with its
/// screen intact.
struct PalmTerminalsContent: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @State private var terminals: [PalmTerminalInfo] = []
  @State private var error: String?
  @State private var creating = false
  @State private var starting = false
  @State private var listener: UUID?
  @State private var typing = false
  @State private var focusNext = false
  @AppStorage("palm.terminal.current") private var currentId = ""
  /// Where "New shell in a folder" starts. A plain new shell always opens in
  /// the home folder.
  @AppStorage("palm.terminal.chosenFolder") private var chosenFolder = "~"

  private var current: PalmTerminalInfo? { terminals.first { $0.id == currentId } }

  var body: some View {
      Group {
        if let current {
          PalmTerminalScreen(
            terminalId: current.id, connection: connection, events: events, title: current.title,
            focusOnOpen: focusNext, typing: $typing)
            .id(current.id)
        } else {
          placeholder
        }
      }
      // While typing, the key bar owns the bottom edge: the tab bar steps
      // aside so nothing overlaps (it also covers hardware keyboards, where
      // iOS shows the key bar along the bottom of the screen). Done in the
      // top bar, or a swipe down, brings it back.
      .toolbar(typing ? .hidden : .visible, for: .tabBar)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { shellsMenu }
      }
      .sheet(isPresented: $creating) {
        PalmNewTerminalSheet(folder: chosenFolder) { folder, command in
          creating = false
          chosenFolder = folder
          Task { await create(folder: folder, command: command) }
        }
      }
    .task { await openDefault() }
    .onAppear {
      guard listener == nil else { return }
      listener = events.listen("terminals") { message in
        guard let raw = message["terminals"], let data = try? JSONSerialization.data(withJSONObject: raw),
          let list = try? JSONDecoder().decode([PalmTerminalInfo].self, from: data)
        else { return }
        terminals = list
      }
    }
  }

  private var placeholder: some View {
    VStack(spacing: 14) {
      if let error {
        Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(.orange)
        Text(error).multilineTextAlignment(.center).foregroundStyle(PalmStyle.muted)
        Button("Try again") { Task { await openDefault() } }.palmGlassButton(prominent: true)
      } else {
        ProgressView().controlSize(.large)
        Text("Opening a shell on your Mac").foregroundStyle(PalmStyle.muted)
      }
    }
    .padding(24)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(PalmStyle.background.ignoresSafeArea())
  }

  private var shellsMenu: some View {
    Menu {
      Section("Shells on your Mac") {
        ForEach(terminals) { terminal in
          Button {
            focusNext = false
            currentId = terminal.id
          } label: {
            Label("\(PalmTerminalTitle.short(terminal.title)) in \(connection.displayPath(terminal.cwd))",
              systemImage: terminal.id == currentId ? "checkmark" : (terminal.running ? "terminal" : "stop.circle"))
          }
        }
      }
      Button { Task { await create(folder: "~", command: nil) } } label: {
        Label("New shell", systemImage: "plus")
      }
      .accessibilityIdentifier("terminal.new")
      Button { creating = true } label: { Label("New shell in a folder", systemImage: "folder.badge.plus") }
      if let current {
        Button(role: .destructive) { Task { await close(current.id) } } label: {
          Label("Close this shell", systemImage: "xmark")
        }
      }
    } label: {
      Label("Shells", systemImage: "rectangle.stack")
    }
    .accessibilityIdentifier("terminal.sessions")
  }

  /// Reattach to the last shell if it is still running, else the newest
  /// running one in the home folder, else start a new shell there. Shells an
  /// agent session opened in its project stay under Shells; they never take
  /// over this tab.
  private func openDefault() async {
    await refresh()
    if current?.running == true { return }
    if let running = terminals.filter({ $0.running && connection.displayPath($0.cwd) == "~" })
      .max(by: { $0.lastActivity < $1.lastActivity }) {
      currentId = running.id
      return
    }
    await create(folder: "~", command: nil)
  }

  private func refresh() async {
    struct Response: Decodable { let terminals: [PalmTerminalInfo] }
    do {
      terminals = try await (connection.get("/api/terminals") as Response).terminals
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func create(folder: String, command: String?) async {
    guard !starting else { return }
    starting = true
    defer { starting = false }
    do {
      var body: [String: Any] = ["cwd": folder, "cols": 60, "rows": 30]
      if let command, !command.isEmpty { body["command"] = command }
      let terminal: PalmTerminalInfo = try await connection.post("/api/terminals", body)
      await refresh()
      // A shell you asked for is ready to type into.
      focusNext = true
      currentId = terminal.id
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func close(_ id: String) async {
    do {
      try await connection.send("/api/terminals/\(id)/close")
      typing = false
      await refresh()
      if let next = terminals.filter({ $0.running && connection.displayPath($0.cwd) == "~" })
        .max(by: { $0.lastActivity < $1.lastActivity }) {
        focusNext = false
        currentId = next.id
      } else {
        await create(folder: "~", command: nil)
      }
    } catch { self.error = connection.friendlyMessage(error) }
  }
}

/// Shell titles often read "user@host:~/path"; the phone shows the folder.
enum PalmTerminalTitle {
  static func short(_ raw: String) -> String {
    let title = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if let colon = title.lastIndex(of: ":"), title[..<colon].contains("@") {
      let path = title[title.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      if path.isEmpty || path == "~" { return "~" }
      return (path as NSString).lastPathComponent
    }
    return title.isEmpty ? "Shell" : title
  }
}

struct PalmNewTerminalSheet: View {
  @State var folder: String
  var create: (String, String?) -> Void
  @State private var command = ""
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("~", text: $folder).textInputAutocapitalization(.never).autocorrectionDisabled()
            .font(.body.monospaced())
            .accessibilityIdentifier("newshell.folder")
        } header: {
          Text("Folder on your Mac")
        } footer: {
          Text("~ is your home folder, for example ~/Developer/my-app.")
        }
        Section {
          TextField("Optional, such as claude or npm run dev", text: $command)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
            .font(.body.monospaced())
          ForEach(["claude", "codex", "npm run dev", "git status", "npm test"], id: \.self) { suggestion in
            Button(suggestion) { command = suggestion }.font(.body.monospaced())
          }
        } header: {
          Text("Start with a command")
        } footer: {
          Text("The shell stays open after the command, so you can keep working in it.")
        }
      }
      .scrollContentBackground(.hidden)
      .background(PalmStyle.background)
      .navigationTitle("New shell")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button("Open") { create(folder.isEmpty ? "~" : folder, command.isEmpty ? nil : command) }
        }
      }
    }
    .preferredColorScheme(.dark)
  }
}

// MARK: - One terminal

struct PalmTerminalScreen: View {
  let terminalId: String
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  let title: String
  var focusOnOpen = false
  @Binding var typing: Bool
  @StateObject private var controller = PalmTerminalController()
  @AppStorage("palm.terminal.fontSize") private var fontSize = 12.0
  @ObservedObject private var voice = PalmVoice.shared
  private var voiceOwner: String { "terminal:\(terminalId)" }
  @AppStorage("palm.terminal.shortcuts") private var shortcutText = "claude\ncodex\nnpm run dev\ngit status\ngit diff\nclear"

  private var shortcuts: [String] { shortcutText.split(separator: "\n").map(String.init).filter { !$0.isEmpty } }

  var body: some View {
    VStack(spacing: 0) {
      if let status = controller.status {
        Text(status).font(.footnote).foregroundStyle(.orange)
          .padding(.horizontal, 16).padding(.vertical, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(PalmStyle.panel)
      }
      PalmTerminalRepresentable(controller: controller, fontSize: fontSize, shortcuts: shortcuts, focusOnOpen: focusOnOpen)
        .padding(.horizontal, 4)
        .accessibilityIdentifier("terminal.view")
    }
    .background(PalmStyle.background.ignoresSafeArea())
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .principal) {
        Text(PalmTerminalTitle.short(controller.title ?? title))
          .font(.headline).lineLimit(1).minimumScaleFactor(0.6)
          .accessibilityIdentifier("terminal.title")
      }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button { controller.focusKeyboard() } label: { Label("Show keyboard", systemImage: "keyboard") }
          Button { controller.paste() } label: { Label("Paste from iPhone", systemImage: "doc.on.clipboard") }
          Button { controller.copyScreen() } label: { Label("Copy screen text", systemImage: "doc.on.doc") }
          Button { controller.signal("SIGINT") } label: { Label("Interrupt (Ctrl-C)", systemImage: "stop.circle") }
          Section("Text size") {
            Button { fontSize = min(22, fontSize + 1) } label: { Label("Larger text", systemImage: "textformat.size.larger") }
            Button { fontSize = max(8, fontSize - 1) } label: { Label("Smaller text", systemImage: "textformat.size.smaller") }
          }
        } label: {
          Label("Terminal options", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("terminal.options")
      }
      // "if u open keyboard, u cant get off it". Done is
      // always in the same place while typing; swiping down also hides it.
      if controller.focused {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { controller.dismissKeyboard() }
            .fontWeight(.semibold)
            .accessibilityIdentifier("terminal.done")
        }
      }
    }
    .overlay(alignment: .bottom) {
      if voice.isActive(for: voiceOwner) {
        // Spoken words go to the shell's prompt; Return stays yours to press.
        PalmVoicePill { polish in
          Task {
            guard let heard = await voice.finish(connection, polish: polish) else { return }
            controller.sendText(heard)
            // Also on both clipboards, to paste again elsewhere.
            UIPasteboard.general.string = heard
            try? await connection.send("/api/clipboard", ["text": heard])
          }
        }
        .padding(.horizontal, 12).padding(.bottom, 12)
      } else if let error = voice.error, voice.owner == nil {
        Text(error).font(.footnote).foregroundStyle(.orange).padding(10)
          .background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 12)).padding(12)
          .onTapGesture { voice.error = nil }
      }
    }
    .onChange(of: controller.speakRequests) { _, _ in
      controller.dismissKeyboard()
      Task { await voice.start(for: voiceOwner) }
    }
    .onAppear { controller.attach(terminalId, events: events) }
    .onDisappear {
      controller.detach()
      typing = false
    }
    .onChange(of: controller.focused) { _, focused in typing = focused }
  }
}

@MainActor
final class PalmTerminalController: NSObject, ObservableObject, TerminalViewDelegate {
  @Published var title: String?
  @Published var status: String?
  @Published var focused = false
  /// Counts the key bar's microphone presses.
  @Published var speakRequests = 0
  weak var view: PalmTerminalUIView?
  private weak var events: PalmEvents?
  private var terminalId: String?
  private var listener: UUID?
  private var reconnectHook: UUID?

  func attach(_ id: String, events: PalmEvents) {
    self.terminalId = id
    self.events = events
    listener = events.listen("terminal:\(id)") { [weak self] message in self?.receive(message) }
    reconnectHook = events.whenConnected { [weak self] in self?.sendAttach() }
  }

  func detach() {
    guard let events, let terminalId else { return }
    events.send(["op": "terminal.detach", "id": terminalId])
    if let listener { events.stopListening(listener) }
    if let reconnectHook { events.cancelWhenConnected(reconnectHook) }
    listener = nil
    reconnectHook = nil
    _ = view?.resignFirstResponder()
  }

  private func sendAttach() {
    guard let terminalId, let events else { return }
    var message: [String: Any] = ["op": "terminal.attach", "id": terminalId]
    if let view {
      let terminal = view.getTerminal()
      message["cols"] = terminal.cols
      message["rows"] = terminal.rows
    }
    events.send(message)
  }

  func viewReady(_ view: PalmTerminalUIView) {
    self.view = view
    sendAttach()
  }

  private func receive(_ message: [String: Any]) {
    guard let view else { return }
    switch message["event"] as? String {
    case "terminal.snapshot":
      let terminal = view.getTerminal()
      terminal.resetToInitialState()
      view.feed(text: "\u{1b}[2J\u{1b}[H")
      if let data = message["data"] as? String { view.feed(text: data) }
      if message["running"] as? Bool == false { status = "This shell has ended. Open a new one from Shells." } else { status = nil }
    case "terminal.output":
      if let data = message["data"] as? String { view.feed(text: data) }
    case "terminal.exit":
      status = "The shell ended (exit \(message["exitCode"] as? Int ?? 0)). Open a new one from Shells."
    case "terminal.closed":
      status = "This shell was closed on the Mac."
    case "terminal.resync":
      sendAttach()
    default: break
    }
  }

  func sendText(_ text: String) {
    guard let terminalId else { return }
    events?.send(["op": "terminal.input", "id": terminalId, "data": text])
  }

  func signal(_ name: String) {
    guard let terminalId else { return }
    events?.send(["op": "terminal.signal", "id": terminalId, "signal": name])
  }

  func paste() {
    if let text = UIPasteboard.general.string { sendText(text) }
  }

  func copyScreen() {
    guard let view else { return }
    let terminal = view.getTerminal()
    var lines: [String] = []
    for row in 0..<terminal.rows {
      if let line = terminal.getLine(row: row) { lines.append(line.translateToString(trimRight: true)) }
    }
    UIPasteboard.general.string = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  func focusKeyboard() { _ = view?.becomeFirstResponder() }

  func dismissKeyboard() { _ = view?.resignFirstResponder() }

  // MARK: TerminalViewDelegate
  nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
    Task { @MainActor in
      guard let terminalId = self.terminalId else { return }
      self.events?.send(["op": "terminal.resize", "id": terminalId, "cols": newCols, "rows": newRows])
    }
  }
  nonisolated func setTerminalTitle(source: TerminalView, title: String) {
    Task { @MainActor in self.title = title.isEmpty ? nil : String(title.prefix(80)) }
  }
  nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
  nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
    let text = String(decoding: data, as: UTF8.self)
    Task { @MainActor in self.sendText(text) }
  }
  nonisolated func scrolled(source: TerminalView, position: Double) {}
  nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
    guard let url = URL(string: link), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
    Task { @MainActor in UIApplication.shared.open(url) }
  }
  nonisolated func bell(source: TerminalView) {
    Task { @MainActor in UIImpactFeedbackGenerator(style: .light).impactOccurred() }
  }
  nonisolated func clipboardCopy(source: TerminalView, content: Data) {
    let text = String(decoding: content, as: UTF8.self)
    Task { @MainActor in UIPasteboard.general.string = text }
  }
  nonisolated func clipboardRead(source: TerminalView) -> Data? { nil }
  nonisolated func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {}
  nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// SwiftTerm's view with Palm's key bar and focus reporting.
final class PalmTerminalUIView: TerminalView {
  var onFocusChange: ((Bool) -> Void)?
  var onSpeak: (() -> Void)?
  private(set) var keyBar: PalmTerminalKeyBar!

  override init(frame: CGRect, font: UIFont?) {
    super.init(frame: frame, font: font)
    keyBar = PalmTerminalKeyBar(terminal: self)
    inputAccessoryView = keyBar
    keyboardAppearance = .dark
    // A steady cursor: no endless blink animation on the phone (programs such
    // as vim still set their own style).
    getTerminal().setCursorStyle(.steadyBlock)
  }

  required init?(coder: NSCoder) { nil }

  override func becomeFirstResponder() -> Bool {
    let became = super.becomeFirstResponder()
    if became { onFocusChange?(true) }
    return became
  }

  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    if resigned {
      keyBar.stopRepeating()
      onFocusChange?(false)
    }
    return resigned
  }
}

/// The keys a phone keyboard lacks, for the shell: Escape, Tab, sticky Control
/// and Option, arrows (they repeat while held), common symbols, Ctrl-C, paste
/// from the iPhone and your saved commands.
final class PalmTerminalKeyBar: PalmAccessoryBar {
  private weak var terminal: TerminalView?
  private var control: UIButton!
  private var option: UIButton!
  private var commandsButton: UIButton!
  private var observers: [NSObjectProtocol] = []

  init(terminal: TerminalView) {
    self.terminal = terminal
    super.init()
    // The shell's everyday keys first, all four arrows in view without
    // scrolling (E2E, 23 September: the arrows sat past the edge).
    key("esc", label: "Escape", id: "termbar.esc") { [weak self] in self?.terminal?.send([0x1b]) }
    key("tab", label: "Tab") { [weak self] in self?.terminal?.send([0x09]) }
    control = key("⌃", label: "Control", id: "termbar.ctrl") { [weak self] in
      guard let terminal = self?.terminal else { return }
      terminal.controlModifier.toggle()
      self?.refresh()
    }
    key(symbol: "arrow.up", label: "Up arrow", repeats: true) { [weak self] in self?.arrow("A") }
    key(symbol: "arrow.down", label: "Down arrow", repeats: true) { [weak self] in self?.arrow("B") }
    key(symbol: "arrow.left", label: "Left arrow", repeats: true) { [weak self] in self?.arrow("D") }
    key(symbol: "arrow.right", label: "Right arrow", repeats: true) { [weak self] in self?.arrow("C") }
    key("⌃C", label: "Interrupt, Control C", id: "termbar.interrupt") { [weak self] in self?.terminal?.send([0x03]) }
    commandsButton = key(symbol: "chevron.forward.2", label: "Saved commands", id: "termbar.commands") {}
    commandsButton.showsMenuAsPrimaryAction = true
    option = key("⌥", label: "Option") { [weak self] in
      guard let terminal = self?.terminal else { return }
      terminal.metaModifier.toggle()
      self?.refresh()
    }
    for symbol in ["~", "|", "/", "-", "*", "$"] {
      key(symbol, label: symbol) { [weak self] in self?.terminal?.send(txt: symbol) }
    }
    key(symbol: "doc.on.clipboard", label: "Paste from iPhone") { [weak self] in
      if let text = UIPasteboard.general.string { self?.terminal?.send(txt: text) }
    }
    key(symbol: "mic.fill", label: "Speak instead of typing", fixed: true, id: "termbar.mic") { [weak self] in
      (self?.terminal as? PalmTerminalUIView)?.onSpeak?()
    }
    key(symbol: "keyboard.chevron.compact.down", label: "Hide keyboard", fixed: true, id: "termbar.hide") { [weak self] in
      _ = self?.terminal?.resignFirstResponder()
    }
    // SwiftTerm clears Control and Option after the next key; mirror that here.
    for name in ["SwiftTerm.TerminalView.controlModifierReset", "SwiftTerm.TerminalView.metaModifierReset"] {
      observers.append(NotificationCenter.default.addObserver(forName: Notification.Name(name), object: terminal, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.refresh() }
      })
    }
    setCommands(["claude", "codex", "npm run dev", "git status"])
  }

  required init?(coder: NSCoder) { nil }

  deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

  func setCommands(_ commands: [String]) {
    commandsButton.menu = UIMenu(title: "Run in this shell", children: commands.map { command in
      UIAction(title: command, image: UIImage(systemName: "terminal")) { [weak self] _ in
        self?.terminal?.send(txt: command + "\r")
      }
    })
  }

  private func refresh() {
    guard let terminal else { return }
    Self.setLatched(control, terminal.controlModifier)
    Self.setLatched(option, terminal.metaModifier)
  }

  /// Arrow keys honour the program's cursor mode (vim, less and agents' TUIs
  /// switch to application mode).
  private func arrow(_ final: Character) {
    guard let terminal else { return }
    let application = terminal.getTerminal().applicationCursor
    terminal.send([0x1b, application ? 0x4f : 0x5b, final.asciiValue ?? 0x41])
  }
}

struct PalmTerminalRepresentable: UIViewRepresentable {
  @ObservedObject var controller: PalmTerminalController
  let fontSize: Double
  let shortcuts: [String]
  var focusOnOpen = false

  func makeUIView(context: Context) -> PalmTerminalUIView {
    let view = PalmTerminalUIView(frame: CGRect(x: 0, y: 0, width: 390, height: 600),
      font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
    view.terminalDelegate = controller
    view.accessibilityIdentifier = "terminal.view"
    view.nativeBackgroundColor = UIColor(PalmStyle.background)
    view.nativeForegroundColor = UIColor(white: 0.92, alpha: 1)
    view.optionAsMetaKey = true
    view.keyBar.setCommands(shortcuts)
    // Scrolling the output hides the keyboard, so you can read. (Interactive
    // dismissal, as in Messages, froze midway with SwiftTerm resizing under
    // the moving keyboard.)
    view.keyboardDismissMode = .onDrag
    view.alwaysBounceVertical = true
    view.onFocusChange = { [weak controller] focused in
      DispatchQueue.main.async { controller?.focused = focused }
    }
    view.onSpeak = { [weak controller] in controller?.speakRequests += 1 }
    DispatchQueue.main.async {
      controller.viewReady(view)
      if focusOnOpen { _ = view.becomeFirstResponder() }
    }
    return view
  }

  func updateUIView(_ view: PalmTerminalUIView, context: Context) {
    let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
    if view.font.pointSize != font.pointSize { view.font = font }
    view.keyBar.setCommands(shortcuts)
  }
}
