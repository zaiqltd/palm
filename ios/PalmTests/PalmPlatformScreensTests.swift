import SwiftUI
import UIKit
import XCTest

@testable import Palm

/// Renders the production tabs against an explicitly selected synthetic
/// loopback host and attaches screenshots for review. Simulator only; it
/// never uses the user's Keychain or a real Mac.
@MainActor
final class PalmPlatformScreensTests: XCTestCase {
  func testPlatformTabsRenderAgainstSyntheticHost() async throws {
    try await withSyntheticConnection { connection in
      let events = PalmEvents(connection: connection)
      events.setActive(true)
      let transfers = PalmTransfers(connection: connection)
      let navigator = PalmNavigator()
      let screens: [(String, AnyView)] = [
        ("assistant", AnyView(PalmAssistantView(connection: connection, events: events, transfers: transfers, navigator: navigator))),
        ("agents", AnyView(PalmAgentsView(connection: connection, events: events, transfers: transfers, navigator: navigator))),
        ("terminal", AnyView(NavigationStack { PalmTerminalsContent(connection: connection, events: events) })),
        ("files", AnyView(PalmMacFilesView(connection: connection, transfers: transfers, navigator: navigator))),
        ("mac", AnyView(NavigationStack { PalmMacContent(connection: connection, events: events, transfers: transfers) })),
        ("more", AnyView(PalmMoreView(connection: connection, events: events, transfers: transfers, navigator: PalmNavigator()))),
      ]
      for (name, view) in screens {
        try await render(view, name: name, size: CGSize(width: 393, height: 852), settle: name == "terminal" ? 3 : 2)
      }
      XCTAssertTrue(events.connected, "The events socket should connect to the synthetic host.")
    }
  }

  func testRemoteViewFloatingControlsAndTyping() async throws {
    try await withSyntheticConnection { connection in
      let editors = connection.apps.filter { $0.bundleId == "test.editor" }
      guard editors.count == 1 else { throw ScreensFailure("Synthetic editor fixture missing.") }
      try await connection.open(app: editors[0], windowID: 7, layout: .original)
      try await render(AnyView(PalmRemoteView(connection: connection)), name: "remote-portrait",
        size: CGSize(width: 393, height: 852), settle: 2)
      try await render(AnyView(PalmRemoteView(connection: connection)), name: "remote-landscape",
        size: CGSize(width: 852, height: 393), settle: 2)
    }
  }

  private func render(_ view: AnyView, name: String, size: CGSize, settle: Double) async throws {
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        .first(where: { $0.activationState == .foregroundActive }))
    let window = UIWindow(windowScene: scene)
    let controller = UIHostingController(
      rootView: view.environment(\.scenePhase, .active).preferredColorScheme(.dark).tint(PalmStyle.accent))
    window.rootViewController = controller
    window.frame = CGRect(origin: .zero, size: size)
    window.windowLevel = .normal + 1
    window.makeKeyAndVisible()
    defer {
      window.isHidden = true
      window.rootViewController = nil
    }
    try await Task.sleep(nanoseconds: UInt64(settle * 1_000_000_000))
    controller.view.layoutIfNeeded()
    let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
    let image = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
    let attachment = XCTAttachment(image: image)
    attachment.name = "screen-\(name)"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func withSyntheticConnection(_ body: (PalmConnection) async throws -> Void) async throws {
    #if !targetEnvironment(simulator)
      throw XCTSkip("Screen rendering runs in the Simulator only.")
    #else
      guard let host = ProcessInfo.processInfo.environment["PALM_INTEGRATION_HOST"], !host.isEmpty else {
        throw XCTSkip("Set PALM_INTEGRATION_HOST to an isolated synthetic loopback fixture.")
      }
      let endpoint = try PalmEndpoint(host, allowLoopback: true)
      guard endpoint.origin.scheme == "http", ["127.0.0.1", "localhost"].contains(endpoint.origin.host ?? "") else {
        throw ScreensFailure("Screens require an explicit HTTP loopback fixture.")
      }
      struct Session: Decodable { let synthetic: Bool }
      struct PairCode: Decodable { let code: String }
      let session: Session = try await fixture(endpoint, "/api/session")
      guard session.synthetic else { throw ScreensFailure("Refusing a real Mac host.") }
      let storage = ScreensMemoryCredentials()
      let connection = PalmConnection(allowSimulatorLoopback: true, credentialStorage: storage)
      let code: PairCode = try await fixture(endpoint, "/api/local/pair-code", post: true)
      try await connection.pair(host: endpoint.string, code: code.code, name: "Synthetic screens test")
      defer { connection.stop() }
      try await body(connection)
      try? await connection.disconnect()
    #endif
  }

  private func fixture<T: Decodable>(_ endpoint: PalmEndpoint, _ path: String, post: Bool = false) async throws -> T {
    var request = URLRequest(url: endpoint.url(path))
    request.setValue(endpoint.string, forHTTPHeaderField: "Origin")
    if post {
      request.httpMethod = "POST"
      request.httpBody = Data("{}".utf8)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, _) = try await URLSession.shared.data(for: request)
    return try JSONDecoder().decode(T.self, from: data)
  }
}

private final class ScreensMemoryCredentials: PalmCredentialStorage {
  private var credential: PalmCredential?
  func read() throws -> PalmCredential? { credential }
  func save(_ credential: PalmCredential) throws { self.credential = credential }
  func clear() { credential = nil }
}

private struct ScreensFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
