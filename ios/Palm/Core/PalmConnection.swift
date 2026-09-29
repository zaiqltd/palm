import Combine
import Foundation
import Network
import UIKit

struct PalmConnectionDiagnosticError: Codable, Sendable {
  let domain: String
  let code: Int

  init(_ error: Error) {
    let value = error as NSError
    let known = [NSURLErrorDomain, NSPOSIXErrorDomain, NSCocoaErrorDomain, "kCFErrorDomainCFNetwork"]
    domain = known.contains(value.domain) ? value.domain : "application"
    code = value.code
  }
}

enum PalmConnectionDiagnosticPhase: String, Codable, Sendable {
  case restore, restoreReady, restoreFailed, activationRequested, activationAcknowledged
  case socketResume, socketSend, socketSendCompleted, socketSendFailed, socketReceiveFailed
  case serverConnected, videoConfiguration, stopAcknowledged, startAcknowledged
  case networkSatisfied, networkUnsatisfied, sceneActive, sceneInactive, transportCleanup
}

struct PalmConnectionDiagnosticEvent: Codable, Sendable {
  let phase: PalmConnectionDiagnosticPhase
  let elapsedMilliseconds: Double
  let networkAvailable: Bool
  let httpStatus: Int?
  let closeCode: Int?
  let error: PalmConnectionDiagnosticError?
}

private final class PalmSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  // An authenticated request must never forward its token to a redirect target.
  func urlSession(_ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}

@MainActor
final class PalmConnection: ObservableObject {
  @Published private(set) var connectionState: PalmConnectionState = .unpaired
  @Published private(set) var hostURL: String = PalmEndpoint.defaultHost
  @Published private(set) var hostStatus: PalmHostStatus?
  @Published private(set) var apps: [PalmRemoteApp] = []
  @Published private(set) var files: [PalmRemoteFile] = []
  @Published private(set) var currentFolder = ""
  @Published private(set) var actions: [PalmAppAction] = []
  @Published private(set) var actionsApp = ""
  @Published var errorMessage: String?
  @Published private(set) var fps = 0
  @Published private(set) var latencyMilliseconds: Int?
  @Published private(set) var targetName = "Desktop"
  @Published private(set) var targetWindowID = 0
  @Published private(set) var videoSize = CGSize(width: 16, height: 10)
  @Published private(set) var phoneLayout: PalmPhoneLayout?
  @Published private(set) var windowLayout = PalmWindowLayout.fill
  var prefersPhoneLayout: Bool { windowLayout == .phone && targetWindowID > 0 }
  @Published private(set) var isBusy = false
  /// Who may send input to the Mac right now: nil (free), "human" or "agent".
  @Published private(set) var screenOwner: PalmScreenOwner?
  /// The Mac's screens, and the one the whole-screen view shows (nil: the main one).
  @Published private(set) var displays: [PalmDisplay] = []
  @Published private(set) var displayID: Int?
  let video = PalmVideoRenderer()
  // Bounded in-memory metadata only. Never stores requests, URLs, identities or content.
  // Retained across transport cleanup so an opted-in test can inspect a failed handshake.
  private(set) var diagnostics: [PalmConnectionDiagnosticEvent] = []
  private let diagnosticStarted = ProcessInfo.processInfo.systemUptime

  /// Every computer this phone is paired with; one is selected at a time.
  @Published private(set) var devices: [PalmDevice] = []
  /// Changes when the selected computer changes: screens reload for it.
  @Published private(set) var deviceEpoch = 0
  var currentDeviceId: String? { credential?.deviceId }
  /// The other paired computers' names (a request naming one is not run here).
  var otherDeviceNames: [String] { devices.filter { $0.id != currentDeviceId }.map(\.name) }
  private let deviceNamesKey = "palm.devices.names"
  private let deviceLabelsKey = "palm.devices.labels"
  private let selectedDeviceKey = "palm.devices.selected"

  var isPaired: Bool { credential?.isValid == true }
  var isStreaming: Bool { connectionState == .live }
  var pairedUntil: Date? { credential.map { Date(timeIntervalSince1970: $0.expires / 1000) } }

  private var credential: PalmCredential?
  private var endpoint: PalmEndpoint?
  private let session: URLSession
  private let credentialStorage: any PalmCredentialStorage
  private let downloads = PalmDownloadStore()
  private let monitor = NWPathMonitor()
  private var socket: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var reconnectGeneration = UUID()
  private var reconnectAttempt = 0
  /// Reconnections since the app started (the live device tests count them).
  private(set) var reconnects = 0

  /// Stream health since the app started, for the live device tests: any
  /// reconnect, black-frame reset or decoder catch-up is a glitch a person sees.
  var healthSummary: String {
    let now = video.diagnostics
    let all = video.totals
    return "reconnects=\(reconnects) resets=\(all.decoderResets + now.decoderResets) behind=\(all.backpressureFlushes + now.backpressureFlushes) frames=\(all.submittedFrames + now.submittedFrames) fps=\(fps) rtt=\(latencyMilliseconds ?? -1)"
  }
  private var pending: [String: (Result<Data, Error>) -> Void] = [:]
  private var pendingTimers: [String: Task<Void, Never>] = [:]
  private var generation = UUID()
  private var intentGeneration = UUID()
  private var actionRefreshGeneration = UUID()
  private var wantedWindow: Int?
  private var viewport: CGSize?
  private var streamViewport: CGSize?
  private var viewportTask: Task<Void, Never>?
  private var viewportGeneration = UUID()
  private var sceneActive = true
  private var networkAvailable = true
  private var hasRestored = false
  private var receivedFrames = 0
  /// Frames of the current stream received, confirmed to the Mac when it asks
  /// for that (24 September: without it a weak link queued seconds of video).
  private var streamFramesReceived = 0
  private var confirmsFrames = false
  private var lastPong: TimeInterval = 0
  private var pingTracker = PalmPingTracker()
  private var streamStarted: TimeInterval = 0
  /// Timings for More › Timings: when the live screen was asked for, and the
  /// last input still waiting for its picture.
  private var startupAsked: TimeInterval = 0
  private var inputAt: TimeInterval = 0
  private var lastFrame: TimeInterval = 0
  private var inputInFlight = 0
  private var acceptingVideo = false
  private var streamConfirmed = false
  private let simulatorLoopbackOverride: Bool
  private struct Outbound {
    let text: String
    let queuedAt: TimeInterval
    let completion: (Result<Void, Error>) -> Void
  }
  private var outbound: [Outbound] = []
  private var outboundTask: Task<Void, Never>?
  // The first send waits for the server's "connected" message: that proves
  // the HTTP upgrade completed. Sending earlier produced POSIX 57 (Socket is
  // not connected) on the physical phone with no status to explain it.
  private var connectedWaiter: CheckedContinuation<Void, Error>?

  private var allowLoopback: Bool {
    #if DEBUG && targetEnvironment(simulator)
      return simulatorLoopbackOverride || ProcessInfo.processInfo.arguments.contains("-PalmAllowLoopback")
    #else
      return false
    #endif
  }

  init(allowSimulatorLoopback: Bool = false, credentialStorage: any PalmCredentialStorage = PalmSystemKeychain()) {
    self.credentialStorage = credentialStorage
    #if DEBUG && targetEnvironment(simulator)
      simulatorLoopbackOverride = allowSimulatorLoopback
    #else
      simulatorLoopbackOverride = false
    #endif
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpShouldSetCookies = false
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.timeoutIntervalForRequest = 12
    configuration.timeoutIntervalForResource = 120
    configuration.waitsForConnectivity = false
    session = URLSession(configuration: configuration, delegate: PalmSessionDelegate(), delegateQueue: nil)
    video.onFrame = { [weak self] in
      guard let self, self.socket != nil, self.sceneActive else { return }
      self.receivedFrames += 1
      self.lastFrame = ProcessInfo.processInfo.systemUptime
      if self.startupAsked > 0 && self.video.isReadyForDisplay {
        PalmTimings.shared.record(.screenStart, ms: (self.lastFrame - self.startupAsked) * 1000)
        self.startupAsked = 0
      }
      if self.inputAt > 0 {
        let elapsed = self.lastFrame - self.inputAt
        if elapsed < 2 { PalmTimings.shared.record(.inputToPicture, ms: elapsed * 1000) }
        self.inputAt = 0
      }
      if self.streamConfirmed && self.lastFrame > 0 && self.video.isReadyForDisplay && self.connectionState != .live { self.connectionState = .live }
    }
    video.onNeedsKeyframe = { [weak self] in self?.sendEphemeral(["op": "keyframe"]) }
    monitor.pathUpdateHandler = { [weak self] path in
      let available = path.status == .satisfied
      let kind = path.usesInterfaceType(.wifi) ? "Wi-Fi" : path.usesInterfaceType(.cellular) ? "cellular"
        : path.usesInterfaceType(.wiredEthernet) ? "wired" : "other"
      Task { @MainActor [weak self] in
        PalmTimings.shared.network = kind
        self?.networkChanged(available)
      }
    }
    monitor.start(queue: DispatchQueue(label: "app.palm.network"))
  }

  deinit {
    monitor.cancel()
    session.invalidateAndCancel()
  }

  private func record(_ phase: PalmConnectionDiagnosticPhase,
    socket observed: URLSessionWebSocketTask? = nil, network: Bool? = nil, error: Error? = nil) {
    let task = observed ?? socket
    diagnostics.append(PalmConnectionDiagnosticEvent(
      phase: phase,
      elapsedMilliseconds: (ProcessInfo.processInfo.systemUptime - diagnosticStarted) * 1000,
      networkAvailable: network ?? networkAvailable,
      httpStatus: (task?.response as? HTTPURLResponse)?.statusCode,
      closeCode: task.map { Int($0.closeCode.rawValue) },
      error: error.map(PalmConnectionDiagnosticError.init)))
    if diagnostics.count > 64 { diagnostics.removeFirst(diagnostics.count - 64) }
  }

  func restore() async {
    guard !hasRestored else { return }
    hasRestored = true
    record(.restore)
    do {
      let all = try pairedDevices()
      publishDevices(all)
      let selected = UserDefaults.standard.string(forKey: selectedDeviceKey)
      guard let saved = all.first(where: { $0.deviceId == selected }) ?? all.first else { return }
      endpoint = try PalmEndpoint(saved.host, allowLoopback: allowLoopback)
      credential = saved
      hostURL = saved.host
      try await refresh()
      record(.restoreReady)
    } catch {
      record(.restoreFailed, error: error)
      errorMessage = friendly(error)
      connectionState = isPaired ? .offline : .unpaired
    }
  }

  func pair(host: String, code: String, name: String = "My iPhone") async throws {
    guard !isBusy else { throw PalmFailure.message("Wait for the current connection change to finish.") }
    isBusy = true
    defer { isBusy = false }
    let approved = try PalmEndpoint(host, allowLoopback: allowLoopback)
    let normalized = code.replacingOccurrences(of: " ", with: "")
      .replacingOccurrences(of: "-", with: "").uppercased()
    guard normalized.count == 10, normalized.utf8.allSatisfy({
      (48...57).contains($0) || (65...70).contains($0)
    }) else { throw PalmFailure.message("Enter the ten-character pairing code shown on your Mac.") }
    struct PairResponse: Decodable { let token: String; let expires: Double; let deviceId: String }
    let result: PairResponse = try await api("/api/native/pair", method: "POST",
      body: ["code": normalized, "name": String(name.prefix(50))], approved: approved, authenticated: false)
    guard result.token.count >= 40, result.token.count <= 256,
      result.token.utf8.allSatisfy({ $0 == 45 || (48...57).contains($0) || (65...90).contains($0) || $0 == 95 || (97...122).contains($0) }),
      result.expires.isFinite, result.expires > Date().timeIntervalSince1970 * 1000,
      !result.deviceId.isEmpty
    else { throw PalmFailure.message("The Mac returned an invalid pairing response.") }
    let saved = PalmCredential(host: approved.string, token: result.token, expires: result.expires,
      deviceId: result.deviceId)
    // Pairing a computer again replaces only that computer's pairing; the
    // other computers stay paired.
    let replaced = ((try? pairedDevices()) ?? []).filter { $0.host == saved.host && $0.deviceId != saved.deviceId }
    do { try credentialStorage.save(saved, device: saved.deviceId) }
    catch {
      let storageFailure = error
      do { try await revokeCredential(saved) }
      catch {
        throw PalmFailure.message(storageFailure.localizedDescription
          + " The unused pairing could not be revoked; remove this phone in Palm’s Mac setup.")
      }
      throw storageFailure
    }
    stop()
    endpoint = approved
    credential = saved
    hostURL = approved.string
    connectionState = .ready
    errorMessage = nil
    UserDefaults.standard.set(saved.deviceId, forKey: selectedDeviceKey)
    for old in replaced { try? credentialStorage.clear(device: old.deviceId) }
    publishDevices((try? pairedDevices()) ?? [saved])
    deviceEpoch += 1
    defer {
      for previous in replaced {
        Task { [weak self] in
          guard let self else { return }
          do { try await self.revokeCredential(previous) }
          catch {
            if self.credential?.token == saved.token {
              self.errorMessage = "Your new pairing is saved. The previous pairing could not be revoked; remove the old phone entry in that Mac’s Palm setup."
            }
          }
        }
      }
    }
    do { try await refresh() }
    catch {
      errorMessage = friendly(error)
      if isPaired { connectionState = .offline }
      throw error
    }
  }

  func refresh() async throws {
    do {
      let status: PalmHostStatus = try await api("/api/status")
      hostStatus = status
      if let id = credential?.deviceId, !status.name.isEmpty {
        var names = UserDefaults.standard.dictionary(forKey: deviceNamesKey) as? [String: String] ?? [:]
        if names[id] != status.name {
          names[id] = status.name
          UserDefaults.standard.set(names, forKey: deviceNamesKey)
          publishDevices((try? pairedDevices()) ?? [])
        }
      }
      if let home = status.home { PalmPath.home = home }
      try await refreshApps()
      if socket == nil && reconnectTask == nil { connectionState = .ready }
      errorMessage = nil
    } catch {
      if socket == nil { connectionState = isPaired ? .offline : .unpaired }
      throw error
    }
  }

  func refreshApps() async throws { apps = try await api("/api/apps") }

  // MARK: Several computers

  /// Valid pairings; expired ones are removed from the Keychain.
  private func pairedDevices() throws -> [PalmCredential] {
    var valid: [PalmCredential] = []
    for credential in try credentialStorage.readAll() {
      if credential.isValid { valid.append(credential) } else { try? credentialStorage.clear(device: credential.deviceId) }
    }
    return valid
  }

  private func publishDevices(_ list: [PalmCredential]) {
    let names = UserDefaults.standard.dictionary(forKey: deviceNamesKey) as? [String: String] ?? [:]
    let labels = UserDefaults.standard.dictionary(forKey: deviceLabelsKey) as? [String: String] ?? [:]
    devices = list.map { credential in
      PalmDevice(
        id: credential.deviceId, host: credential.host,
        name: labels[credential.deviceId] ?? names[credential.deviceId] ?? PalmDevice.label(for: credential.host),
        expires: credential.expires)
    }
  }

  /// Makes another paired computer the one every tab works with. The live
  /// screen stops first; nothing started on the previous computer moves.
  func switchTo(_ id: String) async {
    guard id != credential?.deviceId else { return }
    guard !isBusy else {
      errorMessage = "Wait for the current connection change to finish."
      return
    }
    guard let target = ((try? pairedDevices()) ?? []).first(where: { $0.deviceId == id }),
      let approved = try? PalmEndpoint(target.host, allowLoopback: allowLoopback)
    else {
      errorMessage = "That computer is no longer paired. Pair it again from More › Pairing."
      publishDevices((try? pairedDevices()) ?? [])
      return
    }
    stop()
    endpoint = approved
    credential = target
    hostURL = target.host
    hostStatus = nil
    apps = []; files = []; actions = []; currentFolder = ""
    UserDefaults.standard.set(id, forKey: selectedDeviceKey)
    connectionState = .ready
    errorMessage = nil
    deviceEpoch += 1
    do { try await refresh() } catch {
      errorMessage = friendly(error)
      connectionState = .offline
    }
  }

  /// Revokes this phone's pairing on that computer and removes it here.
  func forget(_ id: String) async {
    guard let target = ((try? pairedDevices()) ?? []).first(where: { $0.deviceId == id }) else { return }
    try? await revokeCredential(target)
    try? credentialStorage.clear(device: id)
    var labels = UserDefaults.standard.dictionary(forKey: deviceLabelsKey) as? [String: String] ?? [:]
    labels[id] = nil
    UserDefaults.standard.set(labels, forKey: deviceLabelsKey)
    let rest = (try? pairedDevices()) ?? []
    publishDevices(rest)
    guard credential?.deviceId == id else { return }
    stop()
    credential = nil
    endpoint = nil
    hostStatus = nil
    apps = []; files = []; actions = []; currentFolder = ""
    if let next = rest.first {
      await switchTo(next.deviceId)
    } else {
      connectionState = .unpaired
      deviceEpoch += 1
    }
  }

  /// A name for a computer on this phone only.
  func rename(_ id: String, to name: String) {
    let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
    var labels = UserDefaults.standard.dictionary(forKey: deviceLabelsKey) as? [String: String] ?? [:]
    labels[id] = clean.isEmpty ? nil : String(clean.prefix(40))
    UserDefaults.standard.set(labels, forKey: deviceLabelsKey)
    publishDevices((try? pairedDevices()) ?? [])
  }

  /// A read-only look at another paired computer (its sessions), with its own
  /// pairing: nothing is sent to the selected computer.
  func peek<T: Decodable>(_ path: String, on id: String) async throws -> T {
    guard let target = ((try? pairedDevices()) ?? []).first(where: { $0.deviceId == id }) else { throw PalmFailure.expired }
    let other = try PalmEndpoint(target.host, allowLoopback: allowLoopback)
    var request = URLRequest(url: other.url(path, query: []))
    request.setValue(other.string, forHTTPHeaderField: "Origin")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.setValue("Bearer \(target.token)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 8
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
      throw PalmFailure.message("That computer did not answer.")
    }
    return try JSONDecoder().decode(T.self, from: data)
  }

  func loadFiles(path: String = "") async throws {
    struct Response: Decodable { let items: [PalmRemoteFile]; let folder: String }
    let response: Response = try await api("/api/files", query: [URLQueryItem(name: "path", value: path)])
    files = response.items
    currentFolder = path
  }

  func download(file: PalmRemoteFile) async throws -> URL {
    guard !file.directory else { throw PalmFailure.message("Open this folder to choose a file.") }
    _ = try PalmDownloadStore.validatedFilename(file.name)
    let token = credential?.token
    let request = try request("/api/download", query: [URLQueryItem(name: "path", value: file.path)])
    let (temporary, response) = try await session.download(for: request)
    defer { try? FileManager.default.removeItem(at: temporary) }
    guard credential?.token == token else { throw PalmFailure.disconnected }
    try checkResponse(response, data: nil)
    return try downloads.adopt(temporary, name: file.name)
  }

  func releaseDownload(_ file: URL) { downloads.release(file) }

  private func revokeCredential(_ saved: PalmCredential) async throws {
    let endpoint = try PalmEndpoint(saved.host, allowLoopback: allowLoopback)
    var request = URLRequest(url: endpoint.url("/api/disconnect"))
    request.httpMethod = "POST"
    request.httpBody = Data("{}".utf8)
    request.setValue(endpoint.string, forHTTPHeaderField: "Origin")
    request.setValue("Bearer \(saved.token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    let (_, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse,
      (200...299).contains(http.statusCode) || http.statusCode == 401 else {
      throw PalmFailure.message("The unused pairing could not be revoked.")
    }
  }

  func open(app: PalmRemoteApp, windowID: Int? = nil, layout: PalmWindowLayout = .fill) async throws {
    guard !isBusy else { throw PalmFailure.message("Wait for the current app to finish opening.") }
    isBusy = true
    defer { isBusy = false }
    let intent = UUID()
    intentGeneration = intent
    if let windowID, !app.windows.contains(where: { $0.id == windowID }) {
      throw PalmFailure.message("That window is no longer in this app. Refresh the app list.")
    }
    struct Activation: Decodable { let ok: Bool; let windowId: Int }
    record(.activationRequested)
    let result: Activation = try await api("/api/command", method: "POST",
      body: ["op": "activate", "bundleId": app.bundleId])
    record(.activationAcknowledged)
    guard intentGeneration == intent, sceneActive else { throw PalmFailure.disconnected }
    guard result.ok else { throw PalmFailure.message("The Mac could not bring this app forward.") }
    let selectedWindow = windowID ?? result.windowId
    // No window to fill: the app is in front; show the whole screen.
    guard selectedWindow > 0 else {
      try await startStream(windowID: 0, name: app.name, layout: .original)
      return
    }
    let document = app.windows.first(where: { $0.id == selectedWindow })?.title ?? ""
    try await startStream(windowID: selectedWindow,
      name: document.isEmpty || document == app.name ? app.name : document,
      layout: layout)
  }

  // The Apps screen supplies an initial estimate, so opening in landscape does
  // not first create a portrait window. The live surface refines it afterward.
  func prepareViewport(_ size: CGSize) {
    guard wantedWindow == nil, !isBusy else { return }
    viewport = validViewport(size)
  }

  func updateViewport(_ size: CGSize) {
    guard let next = validViewport(size) else { return }
    viewport = next
    guard prefersPhoneLayout, let window = wantedWindow, window > 0 else { return }
    let previous = streamViewport ?? CGSize(width: 460, height: 860)
    guard needsViewportChange(from: previous, to: next) else { return }
    viewportTask?.cancel()
    let ticket = UUID()
    viewportGeneration = ticket
    let intent = intentGeneration
    viewportTask = Task { [weak self] in
      guard let self else { return }
      defer { if self.viewportGeneration == ticket { self.viewportTask = nil } }
      do { try await Task.sleep(nanoseconds: 200_000_000) } catch { return }
      for _ in 0..<40 {
        guard !Task.isCancelled, self.viewportGeneration == ticket,
          self.intentGeneration == intent, self.sceneActive,
          self.wantedWindow == window, self.prefersPhoneLayout else { return }
        if !self.isBusy && self.connectionState == .live { break }
        do { try await Task.sleep(nanoseconds: 100_000_000) } catch { return }
      }
      guard !Task.isCancelled, self.viewportGeneration == ticket,
        self.intentGeneration == intent, self.sceneActive,
        self.wantedWindow == window, self.prefersPhoneLayout, !self.isBusy,
        self.connectionState == .live, let current = self.viewport,
        self.needsViewportChange(from: self.streamViewport ?? previous, to: current)
      else { return }
      self.isBusy = true
      defer { self.isBusy = false }
      do { try await self.openStream(windowID: window, reconnecting: false) }
      catch {
        guard self.intentGeneration == intent, self.sceneActive,
          self.wantedWindow == window else { return }
        self.errorMessage = self.friendly(error)
        self.scheduleReconnect()
      }
    }
  }

  private func validViewport(_ size: CGSize) -> CGSize? {
    guard size.width.isFinite, size.height.isFinite,
      (240...1400).contains(size.width), (200...1400).contains(size.height) else { return nil }
    return CGSize(width: size.width.rounded(), height: size.height.rounded())
  }

  private func needsViewportChange(from old: CGSize, to next: CGSize) -> Bool {
    // Small safe-area changes should not interrupt a live session. Keyboard
    // changes are excluded by the view before reaching this method.
    (old.width > old.height) != (next.width > next.height)
      || abs(log((next.width / next.height) / (old.width / old.height))) > 0.12
  }

  private func cancelViewportChange() {
    viewportGeneration = UUID()
    viewportTask?.cancel()
    viewportTask = nil
  }

  func start(windowID: Int = 0, name: String = "Desktop", layout: PalmWindowLayout = .original) async throws {
    guard !isBusy else { throw PalmFailure.message("Wait for the current connection change to finish.") }
    isBusy = true
    defer { isBusy = false }
    streamQuality = 1
    startupAsked = ProcessInfo.processInfo.systemUptime
    try await startStream(windowID: windowID, name: name, layout: layout)
  }

  /// The zoom the Mac last encoded for (1 = the phone's normal view).
  private var streamQuality: Double = 1

  /// Zoomed in, the Mac sends a sharper stream (up to the display's own
  /// pixels), so text stays crisp instead of being enlarged. Steps keep a
  /// pinch from reconfiguring the stream on every small change.
  func setStreamQuality(zoom: CGFloat) {
    guard isStreaming, zoom.isFinite else { return }
    let step: Double = zoom < 1.25 ? 1 : zoom < 1.75 ? 1.5 : zoom < 2.5 ? 2 : zoom < 3.5 ? 3 : 4
    guard step != streamQuality else { return }
    streamQuality = step
    sendEphemeral(["op": "quality", "zoom": step])
  }

  private func startStream(windowID: Int, name: String, layout: PalmWindowLayout) async throws {
    guard isPaired else { throw PalmFailure.expired }
    guard (0...Int(UInt32.max)).contains(windowID) else {
      throw PalmFailure.message("That window identifier is invalid. Refresh the Mac’s app list.")
    }
    guard sceneActive else { throw PalmFailure.message("Return to Palm to begin sharing.") }
    if hostStatus?.screenPermission == false {
      throw PalmFailure.message("Enable Screen Recording for Palm on your Mac, then reopen Palm on the Mac.")
    }
    cancelViewportChange()
    reconnectTask?.cancel(); reconnectTask = nil
    reconnectAttempt = 0
    wantedWindow = max(0, windowID)
    windowLayout = windowID > 0 ? layout : .original
    let intent = UUID()
    intentGeneration = intent
    targetWindowID = max(0, windowID)
    targetName = name
    errorMessage = nil
    do {
      try await openStream(windowID: max(0, windowID), reconnecting: false)
      // App controls are fetched when their tray opens. First video must not wait for
      // a potentially slow Accessibility traversal of the selected app.
    } catch {
      guard intentGeneration == intent, sceneActive else { return }
      errorMessage = friendly(error)
      if isPaired { scheduleReconnect() }
      throw error
    }
  }

  func stop() {
    cancelViewportChange()
    intentGeneration = UUID()
    wantedWindow = nil
    reconnectTask?.cancel(); reconnectTask = nil
    closeTransport()
    connectionState = isPaired ? .ready : .unpaired
  }

  func disconnect() async throws {
    guard !isBusy else { throw PalmFailure.message("Wait for the current connection change to finish.") }
    isBusy = true
    defer { isBusy = false }
    stop()
    var revocationError: Error?
    do { let _: EmptyResponse = try await api("/api/disconnect", method: "POST", body: [:]) }
    catch { revocationError = error }
    if let id = credential?.deviceId { try credentialStorage.clear(device: id) } else { try credentialStorage.clear() }
    publishDevices((try? pairedDevices()) ?? [])
    credential = nil
    endpoint = nil
    hostStatus = nil
    apps = []; files = []; actions = []; currentFolder = ""
    connectionState = .unpaired
    errorMessage = nil
    if revocationError != nil {
      throw PalmFailure.message("Pairing removed from this iPhone. The Mac was unreachable; revoke this phone in Mac setup to remove its server access immediately.")
    }
  }

  func refreshActions() async throws {
    let epoch = generation
    let refresh = UUID()
    actionRefreshGeneration = refresh
    struct Response: Decodable { let app: String; let actions: [PalmAppAction] }
    let response: Response = try await api("/api/command", method: "POST", body: ["op": "actions"])
    guard generation == epoch, actionRefreshGeneration == refresh else { return }
    actionsApp = response.app
    actions = response.actions
  }

  func performAction(id: String) async throws {
    guard isStreaming, sceneActive, video.hasPicture else { throw PalmFailure.message("Start live control before using app controls.") }
    let _: EmptyResponse = try await api("/api/command", method: "POST", body: ["op": "action", "actionId": id])
    try await refreshActions()
  }

  func sendPointer(action: String, x: Double, y: Double) {
    guard ["click", "double", "doubleSecond", "right", "move", "down", "up"].contains(action), x.isFinite, y.isFinite else { return }
    sendInput(["op": "pointer", "action": action, "x": min(1, max(0, x)), "y": min(1, max(0, y))])
  }
  /// "Invert scrolling" (More › Preferences, and the screen's options): the
  /// default direction can feel wrong, one finger or two.
  static let invertScrollKey = "palm.remote.invertScroll"

  func sendScroll(dx: Double, dy: Double) {
    guard dx.isFinite, dy.isFinite else { return }
    let sign: Double = UserDefaults.standard.bool(forKey: Self.invertScrollKey) ? -1 : 1
    sendInput(["op": "scroll", "dx": min(500, max(-500, sign * dx)), "dy": min(500, max(-500, sign * dy))])
  }
  func sendText(_ text: String) {
    guard !text.isEmpty, text.utf16.count <= 4000 else {
      errorMessage = "Send up to 4,000 characters at a time."
      return
    }
    sendInput(["op": "text", "text": text])
  }
  func sendTextConfirmed(_ text: String) async throws {
    guard isStreaming, sceneActive, video.hasPicture, hostStatus?.controlPermission == true else {
      throw PalmFailure.message("Start live control and enable Accessibility on your Mac before sending input.")
    }
    guard !text.isEmpty, text.utf16.count <= 4000 else {
      throw PalmFailure.message("Send up to 4,000 characters at a time.")
    }
    _ = try await socketRequest(["op": "text", "text": text])
  }
  /// The Mac's installed apps, kept for this session: the Apps sheet shows
  /// them at once and refreshes quietly (the list is the heaviest one Palm reads).
  @Published var installedApps: [PalmInstalledApp] = []

  /// With several monitors, switch between them from the phone.
  func refreshDisplays() async {
    struct List: Decodable { let displays: [PalmDisplay] }
    if let list: List = try? await get("/api/displays") { displays = list.displays }
  }

  /// Shows one of the Mac's screens; touches and typing go to that screen.
  func show(display: PalmDisplay) async throws {
    displayID = display.main ? nil : display.id
    try await start(windowID: 0, name: display.name)
  }

  /// The screen the whole-screen view shows now.
  var currentDisplay: PalmDisplay? {
    guard targetWindowID == 0 else { return nil }
    return displays.first { displayID == nil ? $0.main : $0.id == displayID }
  }

  /// Pushes the Mac's pointer against the bottom (Dock) or top (menu bar) edge
  /// of the screen being shown, as a mouse does.
  func revealEdge(_ top: Bool) async {
    struct Done: Decodable { let ok: Bool }
    let _: Done? = try? await post("/api/command", ["op": "revealEdge", "edge": top ? "top" : "bottom"])
  }

  /// The picture is the whole Mac screen (the desktop, or an opened app filling
  /// it), not a single window: the menu bar and Dock are in view.
  var showsWholeScreen: Bool { targetWindowID == 0 || windowLayout == .fill }

  /// Text or a picture from this iPhone onto the Mac's clipboard, then pasted
  /// where the Mac's cursor is (without leaving the screen).
  func pasteOnMac(text: String?, image: UIImage?) async throws {
    if let image {
      guard let png = image.palmScaled(maxSide: 2048).pngData() else {
        throw PalmFailure.message("That picture could not be read.")
      }
      try await send("/api/clipboard", ["imagePNG": png.base64EncodedString()])
    } else if let text, !text.isEmpty {
      try await send("/api/clipboard", ["text": String(text.prefix(200_000))])
    } else {
      throw PalmFailure.message("Nothing is copied on this iPhone.")
    }
    try? await Task.sleep(nanoseconds: 150_000_000)
    sendKey("v", modifiers: ["cmd"])
  }

  /// Who holds the screen, from the events connection (so a chat knows its
  /// agent is using the screen even while the phone is not watching it).
  func noteScreenState(_ state: [String: Any]) { noteScreenOwner(PalmScreenOwner(state)) }

  func noteScreenOwner(_ owner: PalmScreenOwner) {
    if owner != screenOwner { screenOwner = owner }
  }

  /// A new stream takes input once its first picture shows; a shortcut sent
  /// straight after switching streams waits for that (up to three seconds).
  func waitUntilControllable(seconds: Double = 3) async -> Bool {
    let end = Date().addingTimeInterval(seconds)
    while Date() < end {
      if isStreaming && sceneActive && video.isReadyForDisplay { return true }
      try? await Task.sleep(nanoseconds: 100_000_000)
    }
    return isStreaming && sceneActive && video.isReadyForDisplay
  }

  func sendKey(_ key: String, modifiers: [String] = []) {
    var object: [String: Any] = ["op": "key", "key": key]
    if !modifiers.isEmpty { object["modifiers"] = modifiers }
    sendInput(object)
  }

  func setSceneActive(_ active: Bool) {
    guard active != sceneActive else { return }
    record(active ? .sceneActive : .sceneInactive)
    sceneActive = active
    if !active {
      cancelViewportChange()
      reconnectTask?.cancel(); reconnectTask = nil
      closeTransport()
      connectionState = isPaired ? .ready : .unpaired
    } else if isPaired {
      if wantedWindow != nil { scheduleReconnect() }
      else { Task { try? await refresh() } }
    }
  }

  func retry() async {
    errorMessage = nil
    do {
      try await refresh()
      if let window = wantedWindow {
        try await start(windowID: window, name: targetName, layout: windowLayout)
      }
    } catch { errorMessage = friendly(error) }
  }

  private func request(_ path: String, method: String = "GET", body: [String: Any]? = nil,
    query: [URLQueryItem] = [], approved: PalmEndpoint? = nil, authenticated: Bool = true) throws -> URLRequest {
    guard let endpoint = approved ?? endpoint else { throw PalmFailure.expired }
    var request = URLRequest(url: endpoint.url(path, query: query))
    request.httpMethod = method
    request.setValue(endpoint.string, forHTTPHeaderField: "Origin")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    if authenticated {
      guard let credential, credential.isValid else {
        expirePairing()
        throw PalmFailure.expired
      }
      request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
    }
    if let body {
      request.httpBody = try JSONSerialization.data(withJSONObject: body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    return request
  }

  /// A separate capture lease from the remote-screen socket. It uses the same
  /// vetted tailnet endpoint, pairing token and no-redirect URLSession.
  func mediaSocket(audioSession: String? = nil) throws -> URLSessionWebSocketTask {
    var request = try request(audioSession == nil ? "/media" : "/media-audio")
    if let audioSession { request.setValue(audioSession, forHTTPHeaderField: "X-Palm-Media-Session") }
    var parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
    parts.scheme = parts.scheme == "https" ? "wss" : "ws"
    request.url = parts.url!
    return session.webSocketTask(with: request)
  }

  private func api<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil,
    query: [URLQueryItem] = [], approved: PalmEndpoint? = nil, authenticated: Bool = true,
    timeout: TimeInterval? = nil) async throws -> T {
    let token = credential?.token
    var request = try request(path, method: method, body: body, query: query, approved: approved,
      authenticated: authenticated)
    if let timeout { request.timeoutInterval = timeout }
    let (data, response) = try await session.data(for: request)
    guard !authenticated || credential?.token == token else { throw PalmFailure.disconnected }
    try checkResponse(response, data: data)
    guard data.count <= 16 * 1024 * 1024 else { throw PalmFailure.message("The Mac response is too large.") }
    return try JSONDecoder().decode(T.self, from: data)
  }

  private func checkResponse(_ response: URLResponse, data: Data?) throws {
    guard let http = response as? HTTPURLResponse else { throw PalmFailure.disconnected }
    if http.statusCode == 401 {
      expirePairing()
      throw PalmFailure.expired
    }
    guard (200...299).contains(http.statusCode) else {
      if let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let message = object["error"] as? String { throw PalmFailure.message(String(message.prefix(400))) }
      if (300...399).contains(http.statusCode) { throw PalmFailure.message("The Mac address redirected. Use its direct Tailscale HTTPS address.") }
      if http.statusCode == 409 { throw PalmFailure.message("Another device is controlling this Mac. Stop its session and retry.") }
      throw PalmFailure.message("The Mac rejected this request (\(http.statusCode)).")
    }
  }

  private func openStream(windowID: Int, reconnecting: Bool) async throws {
    guard let endpoint, let credential, credential.isValid else { throw PalmFailure.expired }
    guard networkAvailable else { throw PalmFailure.message("Your iPhone is offline. Connect it to a network and Tailscale.") }
    // Reconfigure under the existing controller lease. Closing and immediately
    // upgrading another socket races the host's mandatory capture cleanup.
    let reuse = socket != nil && !reconnecting
    if !reuse { closeTransport() }
    let epoch = generation
    connectionState = reconnecting ? .reconnecting : .connecting
    acceptingVideo = false
    streamConfirmed = false
    actionRefreshGeneration = UUID()
    actions = []; actionsApp = ""
    phoneLayout = nil
    do {
      if reuse {
        // The ordered stop reply is a barrier: all older inputs and frames have
        // drained before the decoder and capture geometry are replaced.
        _ = try await socketRequest(["op": "stop"])
        record(.stopAcknowledged)
        guard generation == epoch, socket != nil else { throw PalmFailure.disconnected }
        // HTTP action replies can outlive the old capture. Discard any control
        // refresh begun while the ordered stop was draining.
        actionRefreshGeneration = UUID()
        actions = []; actionsApp = ""
        // Switching window or app: the last picture stays until the new stream's first frame.
        video.reset(keepPicture: true)
        fps = 0; receivedFrames = 0
      } else {
        var request = URLRequest(url: endpoint.socketURL)
        request.setValue(endpoint.string, forHTTPHeaderField: "Origin")
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        let ws = session.webSocketTask(with: request)
        ws.maximumMessageSize = 12 * 1024 * 1024
        socket = ws
        lastPong = ProcessInfo.processInfo.systemUptime
        record(.socketResume, socket: ws)
        ws.resume()
        receiveTask = Task { [weak self] in
          do {
            while !Task.isCancelled {
              let message = try await ws.receive()
              guard let self, self.generation == epoch else { return }
              try self.handle(message)
            }
          } catch {
            guard let self, self.generation == epoch else { return }
            self.record(.socketReceiveFailed, socket: ws, error: error)
            if let waiter = self.connectedWaiter {
              self.connectedWaiter = nil
              waiter.resume(throwing: self.upgradeFailure(ws, error))
              return
            }
            if ws.closeCode.rawValue == 4001 { self.expirePairing() }
            else { self.transportFailed(error) }
          }
        }
        try await waitForServerConnected(ws, epoch: epoch)
        startHeartbeat(epoch: epoch)
      }
      streamStarted = ProcessInfo.processInfo.systemUptime
      lastFrame = 0
      acceptingVideo = true
      streamFramesReceived = 0
      confirmsFrames = false
      var start: [String: Any] = [
        "op": "start", "windowId": windowID, "phoneLayout": prefersPhoneLayout && windowID > 0,
        "flow": true,
      ]
      // An opened app fills the Mac screen and the phone sees the whole screen,
      // menu bar and Dock included.
      if windowLayout == .fill && windowID > 0 {
        start["fill"] = true
        start["wholeScreen"] = true
      }
      if windowID == 0, let displayID { start["displayId"] = displayID }
      streamViewport = prefersPhoneLayout && windowID > 0 ? viewport : nil
      if let size = streamViewport {
        start["phoneLayoutWidth"] = Double(size.width)
        start["phoneLayoutHeight"] = Double(size.height)
      }
      let result = try await socketRequest(start)
      record(.startAcknowledged)
      Task { await refreshDisplays() }
      guard generation == epoch else { throw PalmFailure.disconnected }
      let started = try JSONDecoder().decode(PalmStreamStart.self, from: result)
      if started.flow {
        confirmsFrames = true
        if streamFramesReceived > 0 { sendEphemeral(["op": "ack", "n": streamFramesReceived]) }
      }
      videoSize = CGSize(width: started.width, height: started.height)
      phoneLayout = started.phoneLayout
      streamConfirmed = true
      if lastFrame > 0 && video.isReadyForDisplay { connectionState = .live }
    } catch {
      if generation == epoch { closeTransport() }
      throw error
    }
  }

  private func handle(_ message: URLSessionWebSocketTask.Message) throws {
    switch message {
    case .data(let data):
      streamFramesReceived += 1
      if confirmsFrames { sendEphemeral(["op": "ack", "n": streamFramesReceived]) }
      if acceptingVideo { try video.enqueue(data) }
    case .string(let text):
      guard let data = text.data(using: .utf8), data.count <= 1024 * 1024,
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let event = object["event"] as? String else { throw PalmFailure.malformedVideo }
      switch event {
      case "config":
        guard acceptingVideo else { return }
        record(.videoConfiguration)
        let config = try JSONDecoder().decode(PalmVideoConfiguration.self, from: data)
        try video.configure(config)
        videoSize = CGSize(width: config.width, height: config.height)
      case "reply":
        if let id = object["requestId"] as? String, let result = object["result"] {
          finishRequest(id, result: .success(try JSONSerialization.data(withJSONObject: result, options: [.fragmentsAllowed])))
        }
      case "error":
        let failure = PalmFailure.message(String((object["message"] as? String ?? "The Mac could not complete that action.").prefix(400)))
        if let id = object["requestId"] as? String, pending[id] != nil {
          finishRequest(id, result: .failure(failure))
        } else { throw failure }
      case "pong":
        let now = ProcessInfo.processInfo.systemUptime
        if let nonce = object["at"] as? String, let latency = pingTracker.receive(nonce: nonce, now: now) {
          lastPong = now
          latencyMilliseconds = latency
        }
      case "stopped":
        stop()
        errorMessage = "Sharing was stopped on your Mac. Tap Start when you are ready."
      case "connected":
        record(.serverConnected)
        if let waiter = connectedWaiter {
          connectedWaiter = nil
          waiter.resume()
        }
        if let owner = object["screenOwner"] as? [String: Any] { screenOwner = PalmScreenOwner(owner) }
      case "screenOwner":
        screenOwner = PalmScreenOwner(object)
      default: break
      }
    @unknown default: break
    }
  }

  private func socketRequest(_ object: [String: Any]) async throws -> Data {
    return try await withCheckedThrowingContinuation { continuation in
      beginRequest(object) { continuation.resume(with: $0) }
    }
  }

  private func beginRequest(_ object: [String: Any], completion: @escaping (Result<Data, Error>) -> Void) {
    guard socket != nil else { completion(.failure(PalmFailure.disconnected)); return }
    let id = UUID().uuidString
    var command = object
    command["requestId"] = id
    guard let data = try? JSONSerialization.data(withJSONObject: command) else {
      completion(.failure(PalmFailure.message("The input could not be encoded.")))
      return
    }
    let text = String(decoding: data, as: UTF8.self)
    pending[id] = completion
    pendingTimers[id] = Task { [weak self] in
      do { try await Task.sleep(nanoseconds: 18_000_000_000) } catch { return }
      self?.finishRequest(id, result: .failure(PalmFailure.message("The Mac did not confirm that action. It was not repeated.")))
    }
    enqueueOrdered(text) { [weak self] result in
      if case .failure(let error) = result { self?.finishRequest(id, result: .failure(error)) }
    }
  }

  private func finishRequest(_ id: String, result: Result<Data, Error>) {
    pendingTimers.removeValue(forKey: id)?.cancel()
    pending.removeValue(forKey: id)?(result)
  }

  private func sendInput(_ object: [String: Any]) {
    guard isStreaming, sceneActive, video.hasPicture, hostStatus?.controlPermission == true else {
      errorMessage = "Start live control and enable Accessibility on your Mac before sending input."
      if object["action"] as? String == "up" { stop() }
      return
    }
    // Inputs are bounded and tied to this transport; none enter the reconnect path.
    guard inputInFlight < 32 else {
      if object["op"] as? String != "scroll" && object["action"] as? String != "move" {
        errorMessage = "The connection is busy. Wait for the Mac to catch up, then try that input again."
      }
      // If a press could be outstanding, closing the session releases it on the host.
      if object["action"] as? String == "up" { stop() }
      return
    }
    inputInFlight += 1
    let epoch = generation
    // A completed tap, a key or text: timed to the Mac's reply and to the next picture.
    let timed = object["op"] as? String == "text" || object["op"] as? String == "key" || object["action"] as? String == "up"
      || object["action"] as? String == "click"
    let sent = ProcessInfo.processInfo.systemUptime
    if timed { inputAt = sent }
    beginRequest(object) { [weak self] result in
      guard let self, self.generation == epoch else { return }
      self.inputInFlight = max(0, self.inputInFlight - 1)
      if timed, case .success = result { PalmTimings.shared.record(.inputAck, ms: (ProcessInfo.processInfo.systemUptime - sent) * 1000) }
      if case .failure(let error) = result {
        self.errorMessage = self.friendly(error)
        if object["action"] as? String == "up" { self.stop() }
      }
    }
  }

  private func sendEphemeral(_ object: [String: Any]) {
    guard socket != nil, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
    let epoch = generation
    enqueueOrdered(String(decoding: data, as: UTF8.self)) { [weak self] result in
      if case .failure(let error) = result, let self, self.generation == epoch { self.transportFailed(error) }
    }
  }

  private func enqueueOrdered(_ text: String, completion: @escaping (Result<Void, Error>) -> Void) {
    guard socket != nil else { completion(.failure(PalmFailure.disconnected)); return }
    outbound.append(Outbound(text: text, queuedAt: ProcessInfo.processInfo.systemUptime,
      completion: completion))
    guard outboundTask == nil else { return }
    let epoch = generation
    outboundTask = Task { [weak self] in
      guard let self else { return }
      defer { if self.generation == epoch { self.outboundTask = nil } }
      while self.generation == epoch, !self.outbound.isEmpty, let socket = self.socket {
        let next = self.outbound.removeFirst()
        guard ProcessInfo.processInfo.systemUptime - next.queuedAt < 1 else {
          next.completion(.failure(PalmFailure.message("The connection was too slow to send this action. It was not repeated.")))
          continue
        }
        do {
          self.record(.socketSend, socket: socket)
          try await socket.send(.string(next.text))
          self.record(.socketSendCompleted, socket: socket)
          next.completion(.success(()))
        } catch {
          self.record(.socketSendFailed, socket: socket, error: error)
          next.completion(.failure(error))
          if self.generation == epoch { self.transportFailed(error) }
          return
        }
      }
    }
  }

  private func startHeartbeat(epoch: UUID) {
    heartbeatTask = Task { [weak self] in
      while !Task.isCancelled {
        do { try await Task.sleep(nanoseconds: 1_000_000_000) } catch { return }
        guard let self, self.generation == epoch else { return }
        let now = ProcessInfo.processInfo.systemUptime
        self.fps = self.receivedFrames
        self.receivedFrames = 0
        if self.streamConfirmed && self.lastFrame > 0 && self.video.isReadyForDisplay && self.connectionState != .live { self.connectionState = .live }
        // Ten seconds of a working stream (a picture shown and the Mac answering
        // pings) clears the reconnect count. It used to need a frame in the last
        // 3 s, so a still Mac screen never cleared it and a few ordinary
        // reconnects ended in "Your Mac is unreachable" (24 September).
        if now - self.streamStarted > 10 && self.lastFrame > 0 && now - self.lastPong < 3 {
          self.reconnectAttempt = 0
        }
        // A stream that never showed a picture, or stopped sending frames. The
        // decoder is briefly not ready after every zoom step or catch-up; that
        // used to count here and tore the connection down mid-use.
        if now - self.lastPong > 12 || (!self.video.hasPicture && now - self.streamStarted > 20)
          || (self.lastFrame > 0 && now - self.lastFrame > 15) {
          self.transportFailed(PalmFailure.message("The Mac stopped responding. Reconnecting."))
          return
        }
        self.sendEphemeral(["op": "ping", "at": self.pingTracker.issue(now: now)])
      }
    }
  }

  private func closeTransport() {
    record(.transportCleanup)
    if let waiter = connectedWaiter {
      connectedWaiter = nil
      waiter.resume(throwing: PalmFailure.disconnected)
    }
    acceptingVideo = false
    streamConfirmed = false
    confirmsFrames = false
    generation = UUID()
    actionRefreshGeneration = UUID()
    phoneLayout = nil
    receiveTask?.cancel(); receiveTask = nil
    heartbeatTask?.cancel(); heartbeatTask = nil
    socket?.cancel(with: .normalClosure, reason: nil); socket = nil
    outboundTask?.cancel(); outboundTask = nil
    let unsent = outbound
    outbound.removeAll()
    for item in unsent { item.completion(.failure(PalmFailure.disconnected)) }
    let requests = Array(pending.keys)
    for id in requests { finishRequest(id, result: .failure(PalmFailure.disconnected)) }
    inputInFlight = 0
    video.reset()
    fps = 0; receivedFrames = 0; latencyMilliseconds = nil
    pingTracker.reset()
    actions = []; actionsApp = ""
  }

  private func transportFailed(_ error: Error) {
    closeTransport()
    errorMessage = friendly(error)
    connectionState = isPaired ? .offline : .unpaired
    scheduleReconnect()
  }

  private func scheduleReconnect() {
    guard reconnectTask == nil, sceneActive, networkAvailable, isPaired, wantedWindow != nil else { return }
    connectionState = .reconnecting
    let reconnectEpoch = UUID()
    reconnectGeneration = reconnectEpoch
    reconnectTask = Task { [weak self] in
      guard let self else { return }
      defer { if self.reconnectGeneration == reconnectEpoch { self.reconnectTask = nil } }
      while let delay = PalmReconnectPolicy.delay(attempt: self.reconnectAttempt) {
        guard !Task.isCancelled else { return }
        self.reconnectAttempt += 1
        self.reconnects += 1
        do { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) } catch { return }
        guard self.sceneActive, self.networkAvailable, let window = self.wantedWindow, self.isPaired else { return }
        do {
          try await self.refresh()
          guard !Task.isCancelled, self.sceneActive, self.wantedWindow == window else { return }
          try await self.openStream(windowID: window, reconnecting: true)
          self.errorMessage = nil
          return
        } catch {
          self.errorMessage = self.friendly(error)
          if !self.isPaired { return }
        }
      }
      self.connectionState = .offline
      self.errorMessage = "Your Mac is unreachable. Check that it is awake, Palm is running, and Tailscale is connected on both devices. Tap Retry to reconnect."
    }
  }

  private func networkChanged(_ available: Bool) {
    record(available ? .networkSatisfied : .networkUnsatisfied, network: available)
    guard networkAvailable != available else { return }
    networkAvailable = available
    if !available {
      cancelViewportChange()
      reconnectTask?.cancel(); reconnectTask = nil
      closeTransport()
      connectionState = isPaired ? .offline : .unpaired
      if isPaired { errorMessage = "Your iPhone is offline. Palm reconnects when the network returns." }
    } else if sceneActive, isPaired {
      if wantedWindow != nil { scheduleReconnect() }
      else { Task { try? await refresh() } }
    }
  }

  private func expirePairing() {
    wantedWindow = nil
    reconnectTask?.cancel(); reconnectTask = nil
    closeTransport()
    credential = nil
    try? credentialStorage.clear()
    hostStatus = nil
    apps = []; files = []; actions = []; currentFolder = ""
    connectionState = .unpaired
    errorMessage = PalmFailure.expired.localizedDescription
  }

  private func waitForServerConnected(_ ws: URLSessionWebSocketTask, epoch: UUID) async throws {
    let timeout = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 12_000_000_000)
      guard let self, !Task.isCancelled, let waiter = self.connectedWaiter else { return }
      self.connectedWaiter = nil
      waiter.resume(throwing: PalmFailure.message("The Mac did not open the live connection in time. Check Tailscale on both devices, then retry."))
    }
    defer { timeout.cancel() }
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      if generation != epoch || socket !== ws {
        continuation.resume(throwing: PalmFailure.disconnected)
      } else {
        connectedWaiter = continuation
      }
    }
  }

  private func upgradeFailure(_ ws: URLSessionWebSocketTask, _ error: Error) -> Error {
    switch (ws.response as? HTTPURLResponse)?.statusCode {
    case 401:
      expirePairing()
      return PalmFailure.expired
    case 403: return PalmFailure.message("The Mac rejected this connection's origin (403). Check the Mac address in Settings.")
    case 409: return PalmFailure.message("Another screen session is still open on the Mac (409). Palm will retry in a moment.")
    case .some(let code): return PalmFailure.message("The Mac refused the live connection (HTTP \(code)).")
    case .none: return PalmFailure.message(friendly(error))
    }
  }

  // MARK: - Platform API used by agents, files, terminal, dev and Mac views

  func get<T: Decodable>(_ path: String, _ query: [String: String] = [:]) async throws -> T {
    try await api(path, query: query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) })
  }

  func post<T: Decodable>(_ path: String, _ body: [String: Any] = [:]) async throws -> T {
    try await api(path, method: "POST", body: body)
  }

  /// A request the Mac may think about for a while (the Assistant's search).
  func post<T: Decodable>(_ path: String, _ body: [String: Any], timeout: TimeInterval) async throws -> T {
    try await api(path, method: "POST", body: body, timeout: timeout)
  }

  func send(_ path: String, _ body: [String: Any] = [:]) async throws {
    let _: EmptyResponse = try await api(path, method: "POST", body: body)
  }

  /// An authenticated request for streaming transfers (upload, download).
  func authorizedRequest(_ path: String, method: String = "GET", query: [String: String] = [:]) throws -> URLRequest {
    var request = try request(path, method: method,
      query: query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) })
    request.timeoutInterval = 600
    return request
  }

  var transferSession: URLSession { session }

  func validate(_ response: URLResponse, data: Data?) throws { try checkResponse(response, data: data) }

  /// The multi-listener events socket (/events): chat streams, terminal I/O.
  func eventsRequest() throws -> URLRequest {
    guard let endpoint, let credential, credential.isValid else { throw PalmFailure.expired }
    var parts = URLComponents(url: endpoint.url("/events"), resolvingAgainstBaseURL: false)!
    parts.scheme = endpoint.origin.scheme == "https" ? "wss" : "ws"
    var request = URLRequest(url: parts.url!)
    request.setValue(endpoint.string, forHTTPHeaderField: "Origin")
    request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
    return request
  }

  func friendlyMessage(_ error: Error) -> String { friendly(error) }

  private func friendly(_ error: Error) -> String {
    if let url = error as? URLError {
      switch url.code {
      case .notConnectedToInternet, .networkConnectionLost, .cannotFindHost, .cannotConnectToHost, .timedOut:
        return "Cannot reach your Mac. Keep it awake with Palm running, and check Tailscale is connected on both devices."
      case .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
        .serverCertificateNotYetValid, .secureConnectionFailed:
        return "The Mac’s HTTPS certificate could not be verified. Check its Tailscale HTTPS setup."
      case .cancelled: return "The connection ended. Input was not repeated."
      default: return "The connection failed. Check the Mac address and Tailscale, then retry."
      }
    }
    // Never Swift's own words ("The data couldn't be read because it is missing").
    if error is DecodingError { return "The Mac sent a reply this version of Palm cannot read. Update Palm on the Mac and the iPhone." }
    return error.localizedDescription
  }
}

private struct EmptyResponse: Decodable {}


extension UIImage {
  /// At most `maxSide` points on its longer side, at 1x: a phone photo made small enough to send.
  func palmScaled(maxSide: CGFloat) -> UIImage {
    let side = max(size.width, size.height)
    guard side > maxSide else { return self }
    let scale = maxSide / side
    let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    return UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
  }
}
