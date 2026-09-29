import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The everyday starting point: say what you need, get something you can use.
/// Common requests (a file, an agent in a folder, a project's preview, what
/// needs attention) are answered on the Mac without AI; anything else goes,
/// on one tap, to your own agent as an ordinary session in Agents.
struct PalmAssistantView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @ObservedObject var transfers: PalmTransfers
  @ObservedObject var navigator: PalmNavigator
  @ObservedObject private var store = PalmAssistantStore.shared
  @State private var draft = ""
  @State private var busy = false
  @FocusState private var focused: Bool
  @ObservedObject private var voice = PalmVoice.shared
  /// Spoken requests are answered aloud (typed ones stay quiet).
  @AppStorage("palm.voice.speakReplies") private var speakReplies = true
  /// The same choice as Agents › New: sessions the Assistant starts may use the screen.
  @AppStorage("palm.agent.screen") private var agentScreen = true
  /// Sessions the Assistant starts run with full access.
  @AppStorage(PalmAssistantAccess.key) private var agentAccess = PalmAssistantAccess.full

  private let suggestions = [
    "What needs my attention?",
    "Find my latest PDF",
    "Start Claude in my home folder",
    "Open my website preview",
  ]

  var body: some View {
    NavigationStack {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 18) {
            if store.exchanges.isEmpty { intro }
            ForEach(store.exchanges) { exchange in
              PalmAssistantExchangeView(
                exchange: exchange, connection: connection, events: events, transfers: transfers,
                navigator: navigator, conversation: store.conversation,
                answered: { store.answer(exchange.id, with: $0) },
                ask: { send($0) },
                followedUp: { store.receive($0, turn: exchange.id.uuidString) })
              .id(exchange.id)
            }
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 12)
        }
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: store.exchanges.count) { _, _ in
          if let last = store.exchanges.last { withAnimation { proxy.scrollTo(last.id, anchor: .top) } }
        }
        // Results that come back later scroll into view.
        .onChange(of: store.exchanges.map { $0.followups?.count ?? 0 }) { _, _ in
          if let last = store.exchanges.last(where: { !($0.followups ?? []).isEmpty }) {
            withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
          }
        }
      }
      .safeAreaInset(edge: .bottom) { composer }
      .background(PalmStyle.background.ignoresSafeArea())
      .navigationTitle("Assistant")
      .palmRootTitle()
      .palmDeviceSubtitle(connection)
      .palmComputerMenu(connection, navigator)
      .onAppear { store.start(connection: connection, events: events, transfers: transfers) }
      .sheet(item: Binding(get: { store.autoSaved.map(PalmShareItem.init) }, set: { if $0 == nil { store.autoSaved = nil } })) { item in
        PalmSavedFileSheet(url: item.url)
      }
      .toolbar {
        // Talking to it should not mean always hearing it.
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            speakReplies.toggle()
            if !speakReplies { voice.stopSpeaking() }
          } label: {
            Label(speakReplies ? "Spoken replies on" : "Spoken replies off",
              systemImage: speakReplies ? "speaker.wave.2.fill" : "speaker.slash.fill")
          }
          .accessibilityValue(speakReplies ? "On" : "Off")
          .accessibilityIdentifier("assistant.speak")
        }
        if !store.exchanges.isEmpty {
          ToolbarItem(placement: .topBarTrailing) {
            Button { store.clear() } label: { Label("Clear", systemImage: "trash") }
            .accessibilityIdentifier("assistant.clear")
          }
        }
      }
    }
  }

  private var intro: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Ask for a file, an agent in a folder, a preview of a project, or what needs you.")
        .font(.subheadline).foregroundStyle(PalmStyle.muted)
      ForEach(suggestions, id: \.self) { suggestion in
        Button { send(suggestion) } label: {
          Text(suggestion).font(.subheadline.weight(.medium)).foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
      }
    }
  }

  private var composer: some View {
    VStack(spacing: 6) {
      if let error = voice.error, voice.owner == nil {
        Label(error, systemImage: "exclamationmark.circle").font(.footnote).foregroundStyle(.orange)
          .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16)
          .onTapGesture { voice.error = nil }
      }
      PalmSpeakingBar()
      if voice.isActive(for: "assistant") {
        PalmVoicePill { polish in
          Task {
            if let heard = await voice.finish(connection, polish: polish) { send(heard, spoken: true) }
          }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
      } else {
        typedComposer
      }
    }
    .background(PalmStyle.background)
  }

  private var typedComposer: some View {
    HStack(spacing: 8) {
      TextField("Ask Palm", text: $draft, axis: .vertical)
        .lineLimit(1...4)
        .focused($focused)
        .submitLabel(.send)
        .onSubmit { send(draft) }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 20))
        .accessibilityIdentifier("assistant.input")
      if draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !busy {
        // An empty box offers the microphone, as Messages does.
        PalmMicButton(owner: "assistant", label: "Speak to Palm")
      } else {
        Button { send(draft) } label: {
          Group {
            if busy { ProgressView().tint(PalmStyle.onAccent) } else { Image(systemName: "arrow.up").font(.body.weight(.bold)) }
          }
          .foregroundStyle(PalmStyle.onAccent)
          .frame(width: 40, height: 40)
          .background(PalmStyle.accent, in: Circle())
        }
        .disabled(busy || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        .accessibilityLabel("Send")
        .accessibilityIdentifier("assistant.send")
      }
    }
    .padding(.horizontal, 12).padding(.vertical, 8)
  }

  private func send(_ text: String, spoken: Bool = false) {
    let request = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !request.isEmpty, !busy else { return }
    draft = ""
    // The answer is results to act on: give them the whole screen.
    focused = false
    busy = true
    var exchange = PalmAssistantExchange(text: request)
    exchange.spoken = spoken
    store.append(exchange)
    Task {
      defer { busy = false }
      let asked = Date()
      do {
        let reply: PalmAssistantReply = try await connection.post("/api/assistant", [
          "text": request, "conversation": store.conversation, "turn": exchange.id.uuidString,
          "devices": connection.otherDeviceNames, "screen": agentScreen, "access": agentAccess,
        ], timeout: 60)
        PalmTimings.shared.record(.assistantReply, ms: Date().timeIntervalSince(asked) * 1000)
        store.answer(exchange.id, with: .success(reply))
        store.deliver(reply.cards)
        if spoken && speakReplies { voice.speak(reply.reply, connection: connection) }
      } catch {
        store.answer(exchange.id, with: .failure(connection.friendlyMessage(error)))
      }
    }
  }

}

/// The Assistant's conversation on this phone: its requests and results,
/// the id the Mac remembers it by, files delivered to the phone, and results
/// that agents send back later.
@MainActor
final class PalmAssistantStore: ObservableObject {
  static let shared = PalmAssistantStore()
  @Published private(set) var exchanges: [PalmAssistantExchange] = []
  /// A file the user asked to have on the phone, just saved.
  @Published var autoSaved: URL?
  private var listener: UUID?
  private var reconnectHook: UUID?
  private weak var connection: PalmConnection?
  private weak var transfers: PalmTransfers?
  /// Each computer has its own conversation (its Mac remembers it) and history.
  private var device = ""
  private var historyKey: String { "palm.assistant.history." + device }
  private var conversationKey: String { "palm.assistant.conversation." + device }

  /// The Mac remembers this conversation's results under this id; Clear starts a new one.
  var conversation: String {
    if let id = UserDefaults.standard.string(forKey: conversationKey) { return id }
    let id = UUID().uuidString
    UserDefaults.standard.set(id, forKey: conversationKey)
    return id
  }

  /// Another computer: its own conversation and history.
  func computerChanged(_ id: String?) {
    guard let id, id != device else { return }
    device = id
    exchanges = PalmAssistantExchange.saved(historyKey)
    // History from before there were several computers belongs to the first one.
    if exchanges.isEmpty, let legacy = UserDefaults.standard.data(forKey: PalmAssistantExchange.key) {
      UserDefaults.standard.set(legacy, forKey: historyKey)
      UserDefaults.standard.removeObject(forKey: PalmAssistantExchange.key)
      exchanges = PalmAssistantExchange.saved(historyKey)
    }
    Task { await sync() }
  }

  func start(connection: PalmConnection, events: PalmEvents, transfers: PalmTransfers) {
    self.connection = connection
    self.transfers = transfers
    computerChanged(connection.currentDeviceId)
    if listener == nil {
      listener = events.listen("assistant") { [weak self] message in
        guard let self, message["event"] as? String == "assistant.followup", message["conversation"] as? String == self.conversation,
          let turn = message["turn"] as? String, let raw = message["followup"],
          let data = try? JSONSerialization.data(withJSONObject: raw),
          let followup = try? JSONDecoder().decode(PalmAssistantFollowup.self, from: data)
        else { return }
        self.receive(followup, turn: turn)
      }
    }
    if reconnectHook == nil {
      reconnectHook = events.whenConnected { [weak self] in Task { await self?.sync() } }
    }
    Task { await sync() }
  }

  func append(_ exchange: PalmAssistantExchange) {
    exchanges.append(exchange)
    PalmAssistantExchange.save(exchanges, historyKey)
  }

  func clear() {
    exchanges = []
    PalmAssistantExchange.save(exchanges, historyKey)
    UserDefaults.standard.set(UUID().uuidString, forKey: conversationKey)
  }

  func answer(_ id: UUID, with result: PalmAssistantExchange.Outcome) {
    guard let index = exchanges.firstIndex(where: { $0.id == id }) else { return }
    switch result {
    case .success(let reply): exchanges[index].reply = reply
    case .failure(let message): exchanges[index].error = message
    }
    PalmAssistantExchange.save(exchanges, historyKey)
  }

  /// Something came back later for a request: an agent's result or question.
  func receive(_ followup: PalmAssistantFollowup, turn: String) {
    guard let index = exchanges.firstIndex(where: { $0.id.uuidString == turn }) else { return }
    var list = exchanges[index].followups ?? []
    guard !list.contains(where: { $0.id == followup.id }) else { return }
    list.append(followup)
    exchanges[index].followups = list
    PalmAssistantExchange.save(exchanges, historyKey)
    deliver(followup.cards)
    let speak = UserDefaults.standard.object(forKey: "palm.voice.speakReplies") as? Bool ?? true
    if exchanges[index].spoken == true && speak, let connection { PalmVoice.shared.speak(followup.reply, connection: connection) }
  }

  /// Files the user asked to have on the phone are saved as soon as they
  /// arrive (checked by SHA-256), each once, whether or not they were seen.
  func deliver(_ cards: [PalmAssistantCard]) {
    let key = "palm.assistant.autosaved"
    var done = Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
    for card in cards where card.type == "file" && card.autoSave == true {
      guard let path = card.path, let transfers else { continue }
      let mark = path + "|" + (card.modified ?? "")
      guard !done.contains(mark) else { continue }
      done.insert(mark)
      Task { [weak self] in
        if let local = await transfers.download(path, confirmSensitive: false) { self?.autoSaved = local }
      }
    }
    UserDefaults.standard.set(Array(done.suffix(200)), forKey: key)
  }

  /// Anything missed while Palm was closed or offline.
  func sync() async {
    struct Turns: Decodable {
      struct Turn: Decodable { let id: String; let followups: [PalmAssistantFollowup] }
      let turns: [Turn]
    }
    guard let connection, let result: Turns = try? await connection.get("/api/assistant/conversation", ["id": conversation])
    else { return }
    for turn in result.turns { for followup in turn.followups { receive(followup, turn: turn.id) } }
  }
}

/// One request and what came back. The last few are kept on the phone.
struct PalmAssistantExchange: Codable, Identifiable, Hashable {
  enum Outcome {
    case success(PalmAssistantReply)
    case failure(String)
  }

  var id = UUID()
  let text: String
  var reply: PalmAssistantReply?
  var error: String?
  /// Results that came back later (an agent's answer or file).
  var followups: [PalmAssistantFollowup]?
  /// Asked by voice: later results are read aloud too.
  var spoken: Bool?

  static let key = "palm.assistant.history"

  static func saved(_ key: String = key) -> [PalmAssistantExchange] {
    guard let data = UserDefaults.standard.data(forKey: key),
      let list = try? JSONDecoder().decode([PalmAssistantExchange].self, from: data)
    else { return [] }
    return list
  }

  static func save(_ list: [PalmAssistantExchange], _ key: String = key) {
    let recent = Array(list.suffix(30))
    if let data = try? JSONEncoder().encode(recent) { UserDefaults.standard.set(data, forKey: key) }
  }
}

struct PalmAssistantExchangeView: View {
  let exchange: PalmAssistantExchange
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @ObservedObject var transfers: PalmTransfers
  @ObservedObject var navigator: PalmNavigator
  var conversation = ""
  var answered: (PalmAssistantExchange.Outcome) -> Void
  var ask: (String) -> Void = { _ in }
  var followedUp: (PalmAssistantFollowup) -> Void = { _ in }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(exchange.text)
        .font(.body)
        .foregroundStyle(PalmStyle.onAccent)
        .padding(.horizontal, 14).padding(.vertical, 9)
        .background(PalmStyle.accent, in: RoundedRectangle(cornerRadius: 18))
        .frame(maxWidth: .infinity, alignment: .trailing)
      if let reply = exchange.reply {
        Text(reply.reply).font(.body).foregroundStyle(.white)
          .accessibilityIdentifier("assistant.reply")
        ForEach(reply.cards) { card in
          PalmAssistantCardView(
            card: card, connection: connection, events: events, transfers: transfers, navigator: navigator,
            conversation: conversation, handedOver: { answered(.success($0)) }, ask: ask, followedUp: followedUp)
        }
        ForEach(exchange.followups ?? []) { followup in
          Text(followup.reply).font(.body).foregroundStyle(.white)
            .padding(.top, 4)
            .accessibilityIdentifier("assistant.followup")
          ForEach(followup.cards) { card in
            PalmAssistantCardView(
              card: card, connection: connection, events: events, transfers: transfers, navigator: navigator,
              conversation: conversation, handedOver: { answered(.success($0)) }, ask: ask, followedUp: followedUp)
          }
        }
      } else if let error = exchange.error {
        Label(error, systemImage: "exclamationmark.circle").font(.subheadline).foregroundStyle(.orange)
      } else {
        PalmAssistantWaiting()
      }
    }
  }
}

/// While the Mac works on a request: a spinner, then what it is doing.
struct PalmAssistantWaiting: View {
  @State private var long = false
  var body: some View {
    HStack(spacing: 8) {
      ProgressView().tint(PalmStyle.muted)
      if long { Text("Looking on your Mac").font(.subheadline).foregroundStyle(PalmStyle.muted) }
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("assistant.waiting")
    .task {
      try? await Task.sleep(nanoseconds: 1_200_000_000)
      withAnimation { long = true }
    }
  }
}

// MARK: - Result cards

struct PalmAssistantCardView: View {
  let card: PalmAssistantCard
  @ObservedObject var connection: PalmConnection
  @ObservedObject var events: PalmEvents
  @ObservedObject var transfers: PalmTransfers
  @ObservedObject var navigator: PalmNavigator
  var conversation = ""
  /// A request handed to an agent comes back as that agent's session.
  var handedOver: (PalmAssistantReply) -> Void
  /// A choice sends its exact request.
  var ask: (String) -> Void = { _ in }
  /// A hand-off's first news: the session it started.
  var followedUp: (PalmAssistantFollowup) -> Void = { _ in }
  @State private var working = false
  @State private var error: String?
  @State private var saved: URL?
  @State private var confirmSensitive = false
  @State private var server: PalmDevServer?
  @State private var preview: PalmPreviewTarget?
  @State private var logs: PalmDevServer?
  @State private var photos: [PhotosPickerItem] = []
  @State private var importing = false
  @State private var uploaded: String?
  @AppStorage("palm.agent.screen") private var agentScreen = true
  @AppStorage(PalmAssistantAccess.key) private var agentAccess = PalmAssistantAccess.full

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      // Choices are only their options: the reply above already says why.
      if card.type != "choice" {
        HStack(alignment: .top, spacing: 12) {
          icon
          VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.body.weight(.semibold)).foregroundStyle(.white).lineLimit(2)
            Text(detail).font(.caption).foregroundStyle(PalmStyle.muted).lineLimit(2)
          }
          Spacer(minLength: 0)
        }
      }
      if card.type == "choice" {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(card.options ?? [], id: \.request) { option in
            Button { ask(option.request) } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(option.label).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
                if let detail = option.detail { Text(detail).font(.caption).foregroundStyle(PalmStyle.muted) }
              }
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 12).padding(.vertical, 8)
              .background(PalmStyle.raised, in: RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("assistant.choice")
          }
        }
      } else {
        actions
      }
      if card.type == "handoff", let brief = card.text, !brief.isEmpty {
        // The agent is asked in an agent's terms; this is what it gets.
        VStack(alignment: .leading, spacing: 4) {
          Text(card.briefed == true ? "What \(card.agents?.first?.name ?? "the agent") will be asked" : "What the agent will be asked")
            .font(.caption.weight(.semibold)).foregroundStyle(PalmStyle.muted)
          Text(brief).font(.callout).foregroundStyle(.white).fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(PalmStyle.raised, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("assistant.handoff.brief")
      }
      if card.type == "handoff" || card.type == "ask" {
        // Said before the tap: whether the agent may use the Mac's screen.
        Label(PalmAssistantAccess.summary(agentAccess) + (agentScreen ? "; it may use the Mac screen, which you can watch and take over" : "; it will not use the Mac screen"),
          systemImage: agentScreen ? "rectangle.inset.filled.and.person.filled" : "rectangle.slash")
          .font(.caption).foregroundStyle(PalmStyle.muted)
          .accessibilityIdentifier("assistant.handoff.screen")
      }
      if let error { Text(error).font(.caption).foregroundStyle(.orange) }
      if let uploaded { Text(uploaded).font(.caption).foregroundStyle(PalmStyle.success) }
    }
    .padding(12)
    .background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 14))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("assistant.card.\(card.type)")

    .sheet(item: Binding(get: { saved.map(PalmShareItem.init) }, set: { if $0 == nil { saved = nil } })) { item in
      PalmSavedFileSheet(url: item.url)
    }
    .sheet(item: $preview) { target in PalmPreviewView(connection: connection, target: target) }
    .sheet(item: $logs) { server in PalmDevLogsView(connection: connection, events: events, server: server) }
    .confirmationDialog("This file may hold credentials. Save it to this iPhone?", isPresented: $confirmSensitive, titleVisibility: .visible) {
      Button("Save to iPhone") { Task { await save(confirm: true) } }
    }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      guard case .success(let urls) = result, let folder = card.path else { return }
      Task {
        for url in urls {
          let access = url.startAccessingSecurityScopedResource()
          _ = await transfers.upload(url, to: folder)
          if access { url.stopAccessingSecurityScopedResource() }
        }
        uploaded = "\(urls.count) item\(urls.count == 1 ? "" : "s") sent to \(card.name ?? "the folder")."
      }
    }
    .onChange(of: photos) { _, picked in
      guard !picked.isEmpty, let folder = card.path else { return }
      Task {
        var count = 0
        for item in picked {
          if let media = try? await item.loadTransferable(type: PalmPickedMedia.self),
            await transfers.upload(PalmMedia.jpegIfNeeded(media.url), to: folder) != nil
          {
            count += 1
          }
        }
        photos = []
        uploaded = "\(count) photo\(count == 1 ? "" : "s") sent to \(card.name ?? "the folder"), checked."
      }
    }
    .task(id: card.devId) { await followServer() }
  }

  private var title: String {
    switch card.type {
    case "task", "agent": return card.title ?? "Agent session"
    case "ask": return "Ask \(card.agentName ?? "your agent")"
    case "choice": return card.title ?? "Which one?"
    case "handoff": return "Hand it to an agent"
    default: return card.name ?? card.title ?? "Result"
    }
  }

  private var detail: String {
    var parts: [String] = []
    switch card.type {
    case "file":
      if let folder = card.folder { parts.append(PalmPath.display(folder)) }
      if let modified = card.modified { parts.append(PalmTime.relative(modified)) }
      if let size = card.size { parts.append(size.palmBytes) }
    case "task":
      parts.append(card.agentName ?? card.provider ?? "Agent")
      parts.append(statusText(card.status, approvals: card.pendingApprovals ?? 0))
      if let cwd = card.cwd { parts.append(PalmPath.display(cwd)) }
    case "preview":
      if let server, server.status == "running" {
        parts.append(server.port.map { "Running on port \($0)" } ?? "Starting")
      } else {
        parts.append(server?.status == "exited" ? "Stopped" : "Starting")
      }
      if let cwd = card.cwd { parts.append(PalmPath.display(cwd)) }
    case "folder":
      if let path = card.path { parts.append(PalmPath.display(path)) }
    case "ask":
      parts.append("“\(card.text ?? "")”")
    case "agent":
      parts.append(card.agentName ?? "Agent")
      parts.append(PalmWatchStatus.style(card.status ?? "").0)
      if let text = card.text { parts.append(text) }
    case "handoff":
      if let cwd = card.cwd { parts.append(PalmPath.display(cwd)) }
    case "choice":
      return card.device ?? ""
    default: break
    }
    if let device = card.device { parts.append(device) }
    return parts.joined(separator: " · ")
  }

  @ViewBuilder private var icon: some View {
    Group {
      switch card.type {
      case "task", "ask": PalmProviderBadge(provider: card.provider ?? "claude", name: card.agentName ?? "")
      case "agent": PalmProviderBadge(provider: String((card.agentId ?? "claude").prefix { $0 != ":" }), name: card.agentName ?? "")
      case "handoff": PalmProviderBadge(provider: card.agents?.first?.id ?? "claude", name: card.agents?.first?.name ?? "")
      case "choice": symbol("questionmark.circle")
      case "preview": symbol("globe")
      case "folder": symbol("folder.fill")
      default: symbol(fileSymbol)
      }
    }
  }

  private func symbol(_ name: String) -> some View {
    Image(systemName: name).font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
      .frame(width: 34, height: 34).background(PalmStyle.raised, in: RoundedRectangle(cornerRadius: 10))
  }

  private var fileSymbol: String {
    let type = UTType(filenameExtension: ((card.name ?? "") as NSString).pathExtension)
    if type?.conforms(to: .image) == true { return "photo" }
    if type?.conforms(to: .movie) == true { return "film" }
    if type?.conforms(to: .pdf) == true { return "doc.richtext" }
    if type?.conforms(to: .spreadsheet) == true { return "tablecells" }
    if type?.conforms(to: .presentation) == true { return "rectangle.on.rectangle" }
    return "doc"
  }

  @ViewBuilder private var actions: some View {
    HStack(spacing: 8) {
      switch card.type {
      case "file":
        action("Save to iPhone", prominent: true, id: "assistant.save") {
          if card.sensitive == true { confirmSensitive = true } else { await save(confirm: false) }
        }
        if let folder = card.folder {
          action("Show in Files", id: "assistant.showInFiles") {
            chose()
            navigator.openFolder(folder)
          }
        }
      case "task":
        if let id = card.taskId { action("Open agent", prominent: true, id: "assistant.openAgent") { navigator.openAgent(id) } }
      case "agent":
        if let id = card.agentId { action("Show", prominent: true, id: "assistant.showAgent") { navigator.openWatch(id) } }
      case "handoff":
        // The Assistant asks before any agent starts.
        ForEach(Array((card.agents ?? []).prefix(2).enumerated()), id: \.offset) { index, agent in
          action("Ask \(agent.name)", prominent: index == 0, id: index == 0 ? "assistant.handoff" : "assistant.handoff.\(agent.id)") {
            await handOff(to: agent.id)
          }
        }
      case "preview":
        action("Open", prominent: true, id: "assistant.openPreview") { await openPreview() }
          .disabled(server?.port == nil)
        action("Logs", id: "assistant.logs") { logs = server }.disabled(server == nil)
        if let id = card.devId {
          action("Restart") { await devAction(id, "restart") }
          action("Stop") { await devAction(id, "stop") }
        }
      case "folder":
        PhotosPicker(selection: $photos, maxSelectionCount: 20, matching: .any(of: [.images, .videos])) {
          label("Photos here", prominent: true)
        }
        .accessibilityIdentifier("assistant.uploadPhotos")
        action("Files here") { importing = true }
        if let path = card.path { action("Open in Files") { navigator.openFolder(path) } }
      case "ask":
        action("Ask \(card.agentName ?? "agent")", prominent: true, id: "assistant.ask") { await handOver() }
      default: EmptyView()
      }
    }
    .disabled(working)
  }

  private func action(_ title: String, prominent: Bool = false, id: String? = nil, _ run: @escaping () async -> Void) -> some View {
    Button {
      Task {
        working = true
        defer { working = false }
        error = nil
        await run()
      }
    } label: { label(title, prominent: prominent) }
    .buttonStyle(.plain)
    .accessibilityIdentifier(id ?? "assistant.action.\(title)")
  }

  private func label(_ title: String, prominent: Bool) -> some View {
    Text(title).font(.subheadline.weight(.semibold))
      .foregroundStyle(prominent ? PalmStyle.onAccent : .white)
      .padding(.horizontal, 12).frame(height: 34)
      .background(prominent ? PalmStyle.accent : PalmStyle.raised, in: Capsule())
  }

  private func statusText(_ status: String?, approvals: Int) -> String {
    if approvals > 0 { return "Needs you" }
    switch status {
    case "running", "starting": return "Working"
    case "waiting": return "Needs you"
    case "idle": return "Ready"
    case "failed": return "Failed"
    case "interrupted": return "Interrupted"
    case "stopped": return "Stopped"
    default: return status?.capitalized ?? ""
    }
  }

  // MARK: Actions

  private func save(confirm: Bool) async {
    guard let path = card.path else { return }
    if let local = await transfers.download(path, confirmSensitive: confirm) {
      saved = local
      chose()
    } else {
      error = transfers.items.first.flatMap { if case .failed(let message) = $0.state { return message } else { return nil } }
    }
  }

  /// The Mac hears which file was saved or shown: "send me that file" means
  /// this one from now on (E2E, 23 September: it sent the first result instead).
  private func chose() {
    guard let path = card.path, !conversation.isEmpty else { return }
    Task {
      struct Done: Decodable { let ok: Bool }
      let _: Done? = try? await connection.post("/api/assistant/chosen", ["conversation": conversation, "path": path])
    }
  }

  /// Starts the agent the Assistant offered; its result comes back here.
  private func handOff(to provider: String) async {
    guard let proposal = card.proposalId else { return }
    struct Started: Decodable { let turn: String; let followup: PalmAssistantFollowup }
    do {
      let started: Started = try await connection.post("/api/assistant/handoff", [
        "conversation": conversation, "proposal": proposal, "provider": provider, "screen": agentScreen, "access": agentAccess,
      ])
      followedUp(started.followup)
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func handOver() async {
    guard let provider = card.provider, let text = card.text else { return }
    do {
      let task: PalmTaskSummary = try await connection.post("/api/tasks", [
        "provider": provider, "cwd": "~", "text": text, "access": agentAccess, "model": "default", "screenControl": agentScreen,
      ])
      handedOver(PalmAssistantReply(
        reply: "\(task.providerName) is on it.",
        cards: [PalmAssistantCard(
          type: "task", device: card.device, taskId: task.id, title: task.title, provider: task.provider,
          agentName: task.providerName, cwd: task.cwd, status: task.status, pendingApprovals: task.pendingApprovals)]))
    } catch { self.error = connection.friendlyMessage(error) }
  }

  /// A preview card follows its dev server until it is up (a URL alone is not
  /// a working preview).
  private func followServer() async {
    guard let devId = card.devId else { return }
    struct DevList: Decodable { let servers: [PalmDevServer] }
    for _ in 0..<90 {
      if let list: DevList = try? await connection.get("/api/dev") {
        server = list.servers.first { $0.id == devId }
        if server?.port != nil || server?.status == "exited" || server == nil { return }
      }
      try? await Task.sleep(nanoseconds: 1_000_000_000)
    }
  }

  private func openPreview() async {
    guard let devId = card.devId else { return }
    do {
      let ticket: PalmPreviewTicket = try await connection.post("/api/dev/preview", ["devId": devId])
      preview = PalmPreviewTarget(ticket: ticket, devId: devId, port: server?.port)
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func devAction(_ id: String, _ action: String) async {
    do {
      try await connection.send("/api/dev/\(id)/\(action)")
      server = nil
      await followServer()
    } catch { self.error = connection.friendlyMessage(error) }
  }
}

extension View {
  /// The computer this screen works on, under its title (the brief: a
  /// clear device at the top). One computer for now; more come with
  /// multiple-device support, each with its own sign-in and tasks.
  @ViewBuilder func palmDeviceSubtitle(_ connection: PalmConnection) -> some View {
    let name = connection.hostStatus?.name ?? "Mac"
    let state = connection.connectionState == .offline ? " · offline" : ""
    if #available(iOS 26.0, *) {
      self.navigationSubtitle(name + state)
    } else {
      self
    }
  }
}

/// How much the sessions the Assistant starts may do without asking.
enum PalmAssistantAccess {
  static let key = "palm.assistant.agentAccess"
  static let full = "full"
  static let choices: [(String, String)] = [
    ("full", "Full access, no questions"), ("workspace", "Edit the project, ask for commands"), ("ask", "Ask before changes"),
  ]
  static func summary(_ value: String) -> String {
    switch value {
    case "full": return "Full access: it will not ask before running commands or changing files"
    case "ask": return "It asks before changes"
    default: return "It edits the project and asks before commands"
    }
  }
}
