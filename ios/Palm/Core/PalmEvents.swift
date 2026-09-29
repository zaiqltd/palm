import Foundation
import UIKit

/// The Mac's multi-listener event stream (/events): task updates and streamed
/// replies, terminal I/O, dev-server logs and Mac state. It is separate from the
/// single live-screen socket, so chat and terminals keep working without video.
/// Everything shown also exists on the Mac, so a dropped connection only means
/// re-reading state after reconnecting.
@MainActor
final class PalmEvents: ObservableObject {
  @Published private(set) var connected = false
  @Published private(set) var lastError: String?

  typealias Handler = @MainActor ([String: Any]) -> Void
  private struct Listener {
    let id: UUID
    let topic: String
    let handler: Handler
  }

  private weak var connection: PalmConnection?
  private var socket: URLSessionWebSocketTask?
  private var receiveTask: Task<Void, Never>?
  private var pingTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var listeners: [Listener] = []
  private var topicCounts: [String: Int] = [:]
  private var generation = UUID()
  private var active = false
  private var attempt = 0
  private var onReconnect: [UUID: @MainActor () -> Void] = [:]

  private var watchdog: Timer?
  private var observers: [NSObjectProtocol] = []

  init(connection: PalmConnection) {
    self.connection = connection
    // Self-starting: follow the app's own foreground state rather than relying
    // on a single launch-time call that can run before pairing is restored.
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.setActive(true) }
    })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.setActive(false) }
    })
    watchdog = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        if UIApplication.shared.applicationState == .active, !self.active { self.active = true }
        if self.active, !self.connected { self.ensureConnected() }
      }
    }
  }

  func setActive(_ value: Bool) {
    active = value
    if value { ensureConnected() } else { disconnect() }
  }

  /// Another computer was chosen: listen to that one instead.
  func switchComputer() {
    disconnect()
    attempt = 0
    active = UIApplication.shared.applicationState == .active
    if active { ensureConnected() }
  }

  /// Retry now (user tapped the status).
  func reconnect() {
    reconnectTask?.cancel()
    reconnectTask = nil
    attempt = 0
    if socket != nil && !connected {
      socket?.cancel(with: .goingAway, reason: nil)
      socket = nil
    }
    active = true
    ensureConnected()
  }

  /// Receive every message published on `topic` ("tasks", "task:<id>",
  /// "terminal:<id>", "dev", "dev:<id>", "system", "screen", "terminals").
  @discardableResult
  func listen(_ topic: String, _ handler: @escaping Handler) -> UUID {
    let id = UUID()
    listeners.append(Listener(id: id, topic: topic, handler: handler))
    let isTerminal = topic.hasPrefix("terminal:")
    if !isTerminal {
      topicCounts[topic, default: 0] += 1
      if topicCounts[topic] == 1 { sendRaw(["op": "subscribe", "topics": [topic]]) }
    }
    ensureConnected()
    return id
  }

  func stopListening(_ id: UUID) {
    guard let index = listeners.firstIndex(where: { $0.id == id }) else { return }
    let topic = listeners[index].topic
    listeners.remove(at: index)
    guard !topic.hasPrefix("terminal:"), let count = topicCounts[topic] else { return }
    if count <= 1 {
      topicCounts[topic] = nil
      sendRaw(["op": "unsubscribe", "topics": [topic]])
    } else { topicCounts[topic] = count - 1 }
  }

  /// Run after every (re)connection, e.g. to re-attach a terminal.
  @discardableResult
  func whenConnected(_ action: @escaping @MainActor () -> Void) -> UUID {
    let id = UUID()
    onReconnect[id] = action
    if connected { action() }
    return id
  }

  func cancelWhenConnected(_ id: UUID) { onReconnect[id] = nil }

  func send(_ object: [String: Any]) { sendRaw(object) }

  private func sendRaw(_ object: [String: Any]) {
    guard connected, let socket,
      let data = try? JSONSerialization.data(withJSONObject: object),
      let text = String(data: data, encoding: .utf8)
    else { return }
    socket.send(.string(text)) { [weak self] error in
      if error != nil { Task { @MainActor in self?.dropped() } }
    }
  }

  private func ensureConnected() {
    guard active, socket == nil, reconnectTask == nil, let connection, connection.isPaired else { return }
    let request: URLRequest
    do { request = try connection.eventsRequest() } catch {
      lastError = connection.friendlyMessage(error)
      return
    }
    let ws = connection.transferSession.webSocketTask(with: request)
    ws.maximumMessageSize = 16 * 1024 * 1024
    let epoch = UUID()
    generation = epoch
    socket = ws
    ws.resume()
    Task { [weak self] in
      try? await Task.sleep(nanoseconds: 10_000_000_000)
      guard let self, self.generation == epoch, !self.connected else { return }
      self.lastError = "The Mac did not answer the live-updates connection in time."
      self.dropped()
    }
    receiveTask = Task { [weak self] in
      do {
        while !Task.isCancelled {
          let message = try await ws.receive()
          guard let self, self.generation == epoch else { return }
          if case .string(let text) = message, let data = text.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
          {
            self.dispatch(object)
          }
        }
      } catch {
        guard let self, self.generation == epoch else { return }
        let status = (ws.response as? HTTPURLResponse)?.statusCode
        self.lastError = status.map { "Live updates refused (HTTP \($0))." } ?? connection.friendlyMessage(error)
        self.dropped()
      }
    }
  }

  private func dispatch(_ object: [String: Any]) {
    if object["event"] as? String == "connected" {
      connected = true
      attempt = 0
      lastError = nil
      let topics = Array(topicCounts.keys)
      if !topics.isEmpty { sendRaw(["op": "subscribe", "topics": topics]) }
      pingTask?.cancel()
      let epoch = generation
      pingTask = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: 15_000_000_000)
          guard let self, self.generation == epoch else { return }
          self.sendRaw(["op": "ping"])
        }
      }
      for action in onReconnect.values { action() }
      return
    }
    guard let topic = object["topic"] as? String else { return }
    for listener in listeners where listener.topic == topic { listener.handler(object) }
  }

  private func dropped() {
    generation = UUID()
    connected = false
    receiveTask?.cancel(); receiveTask = nil
    pingTask?.cancel(); pingTask = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    guard active, reconnectTask == nil else { return }
    attempt += 1
    let delay = min(8.0, 0.5 * pow(2.0, Double(min(attempt, 5))))
    reconnectTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
      guard let self else { return }
      self.reconnectTask = nil
      self.ensureConnected()
    }
  }

  private func disconnect() {
    generation = UUID()
    reconnectTask?.cancel(); reconnectTask = nil
    receiveTask?.cancel(); receiveTask = nil
    pingTask?.cancel(); pingTask = nil
    socket?.cancel(with: .normalClosure, reason: nil)
    socket = nil
    connected = false
  }
}
