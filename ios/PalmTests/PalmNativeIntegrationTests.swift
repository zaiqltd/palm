import AVFoundation
import CoreImage
import Foundation
import UIKit
import XCTest
@testable import Palm

final class PalmNativeIntegrationTests: XCTestCase {
  /// Run only against an explicitly named, isolated synthetic host. Never drives the real Mac.
  @MainActor
  func testSyntheticNativeSessionLifecycleAndDecodedPixels() async throws {
    #if !targetEnvironment(simulator)
      throw XCTSkip("Synthetic integration is restricted to the iOS Simulator.")
    #else
      guard let host = ProcessInfo.processInfo.environment["PALM_INTEGRATION_HOST"] else {
        throw XCTSkip("Set PALM_INTEGRATION_HOST to the isolated synthetic loopback server.")
      }
      let endpoint = try PalmEndpoint(host, allowLoopback: true)
      guard endpoint.origin.scheme == "http", ["localhost", "127.0.0.1"].contains(endpoint.origin.host ?? "") else {
        XCTFail("Integration must use a loopback fixture.")
        return
      }
      struct Session: Decodable { let synthetic: Bool }
      let fixture: Session = try await fixtureAPI(endpoint, path: "/api/session")
      guard fixture.synthetic else {
        XCTFail("Refusing to exercise controls: this is a real Mac host.")
        return
      }
      struct PairCode: Decodable { let code: String }
      let code: PairCode = try await fixtureAPI(endpoint, path: "/api/local/pair-code", post: true)
      let connection = PalmConnection(allowSimulatorLoopback: true)
      try await connection.pair(host: host, code: code.code, name: "Palm isolated iOS integration")
      XCTAssertTrue(connection.isPaired)
      XCTAssertEqual(connection.hostStatus?.name, "Sample Mac")
      XCTAssertEqual(connection.hostStatus?.synthetic, true)
      XCTAssertGreaterThan(connection.apps.count, 0)
      XCTAssertGreaterThan(try XCTUnwrap(connection.pairedUntil).timeIntervalSinceNow, 24 * 3600)
      try await connection.loadFiles()
      XCTAssertEqual(connection.currentFolder, "")
      let welcome = try XCTUnwrap(connection.files.first(where: { $0.name == "Welcome.txt" && !$0.directory }))
      let download = try await connection.download(file: welcome)
      XCTAssertGreaterThan(try Data(contentsOf: download).count, 0)
      connection.releaseDownload(download)
      XCTAssertFalse(FileManager.default.fileExists(atPath: download.path))
      let previousDeviceID = try XCTUnwrap(PalmKeychain.read()).deviceId
      let replacement: PairCode = try await fixtureAPI(endpoint, path: "/api/local/pair-code", post: true)
      try await connection.pair(host: host, code: replacement.code, name: "Palm isolated iOS integration")
      struct DeviceSetup: Decodable {
        struct Device: Decodable { let id: String }
        let devices: [Device]
      }
      let retirementDeadline = Date().addingTimeInterval(5)
      var oldPairingRemains = true
      while oldPairingRemains && Date() < retirementDeadline {
        let setup: DeviceSetup = try await fixtureAPI(endpoint, path: "/api/local/setup")
        oldPairingRemains = setup.devices.contains(where: { $0.id == previousDeviceID })
        if oldPairingRemains { try await Task.sleep(nanoseconds: 100_000_000) }
      }
      XCTAssertFalse(oldPairingRemains, "Re-pairing must retire the displaced native credential.")

      let restored = PalmConnection(allowSimulatorLoopback: true)
      await restored.restore()
      XCTAssertTrue(restored.isPaired, "Pairing must survive a new connection instance through Keychain.")
      XCTAssertEqual(restored.hostURL, connection.hostURL)

      let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
      let window = UIWindow(windowScene: scene)
      let controller = UIViewController()
      window.rootViewController = controller
      window.frame = CGRect(x: 0, y: 0, width: 320, height: 240)
      window.isHidden = false
      connection.video.displayLayer.frame = CGRect(x: 0, y: 0, width: 320, height: 200)
      controller.view.layer.addSublayer(connection.video.displayLayer)
      defer {
        connection.stop()
        connection.video.displayLayer.removeFromSuperlayer()
        window.isHidden = true
      }

      let app = try XCTUnwrap(connection.apps.first(where: { $0.bundleId == "test.editor" }))
      try await connection.open(app: app, windowID: 7, layout: .original)
      try await waitUntil { connection.isStreaming && connection.fps > 0 }
      XCTAssertEqual(connection.targetWindowID, 7)
      XCTAssertEqual(connection.videoSize, CGSize(width: 1280, height: 800))
      try await waitUntil { connection.latencyMilliseconds != nil }
      if #available(iOS 17.4, *) {
        try await waitUntil { connection.video.displayLayer.isReadyForDisplay }
        let pixel = try XCTUnwrap(connection.video.displayLayer.sampleBufferRenderer.displayedPixelBuffer(),
          "Native H264 must produce a displayed pixel buffer, not just accept compressed packets.")
        XCTAssertEqual(CVPixelBufferGetWidth(pixel), 1280)
        XCTAssertEqual(CVPixelBufferGetHeight(pixel), 800)
        let image = CIImage(cvPixelBuffer: pixel)
        let context = CIContext()
        var rgba = [UInt8](repeating: 0, count: 32 * 20 * 4)
        let thumbnail = image.transformed(by: CGAffineTransform(scaleX: 32.0 / 1280, y: 20.0 / 800))
        context.render(thumbnail, toBitmap: &rgba, rowBytes: 32 * 4,
          bounds: CGRect(x: 0, y: 0, width: 32, height: 20), format: .RGBA8,
          colorSpace: CGColorSpaceCreateDeviceRGB())
        let greenValues = stride(from: 1, to: rgba.count, by: 4).map { Int(rgba[$0]) }
        XCTAssertGreaterThan((greenValues.max() ?? 0) - (greenValues.min() ?? 0), 30,
          "Decoded fixture pixels must contain the expected bright shape and darker background.")
        if let cgImage = context.createCGImage(image, from: image.extent) {
          let attachment = XCTAttachment(image: UIImage(cgImage: cgImage))
          attachment.name = "Native-decoded synthetic H264 frame"
          attachment.lifetime = .keepAlways
          add(attachment)
        }
      }

      try await connection.sendTextConfirmed("Synthetic iOS input ✓")
      try await connection.refreshActions()
      XCTAssertEqual(connection.actionsApp, "Sample Editor")
      try await connection.performAction(id: try XCTUnwrap(connection.actions.first).id)
      connection.setSceneActive(false)
      XCTAssertFalse(connection.isStreaming)
      connection.setSceneActive(true)
      try await waitUntil(timeout: 20) { connection.isStreaming }
      connection.stop()
      XCTAssertEqual(connection.connectionState, .ready)
      XCTAssertEqual(connection.targetWindowID, 7)
      try await Task.sleep(nanoseconds: 400_000_000)
      try await connection.start(windowID: 7, name: "Sample Editor")
      try await waitUntil { connection.isStreaming }
      try await connection.disconnect()
      XCTAssertFalse(connection.isPaired)
      await restored.retry()
      XCTAssertFalse(restored.isPaired, "Revoked credentials must not reconnect from memory.")
    #endif
  }

  @MainActor
  func testViewportRotationAdaptsStreamAndPreservesOriginalLayoutChoice() async throws {
    #if !targetEnvironment(simulator)
      throw XCTSkip("Viewport integration is restricted to the isolated Simulator host.")
    #else
      guard let host = ProcessInfo.processInfo.environment["PALM_INTEGRATION_HOST"] else {
        throw XCTSkip("Set PALM_INTEGRATION_HOST to the isolated synthetic loopback server.")
      }
      let endpoint = try PalmEndpoint(host, allowLoopback: true)
      guard endpoint.origin.scheme == "http",
        ["localhost", "127.0.0.1"].contains(endpoint.origin.host ?? "") else {
        XCTFail("Viewport integration must use a loopback fixture."); return
      }
      struct Session: Decodable { let synthetic: Bool }
      let fixture: Session = try await fixtureAPI(endpoint, path: "/api/session")
      guard fixture.synthetic else { XCTFail("Refusing to resize a real Mac in this test."); return }
      struct PairCode: Decodable { let code: String }
      let code: PairCode = try await fixtureAPI(endpoint, path: "/api/local/pair-code", post: true)
      let connection = PalmConnection(allowSimulatorLoopback: true,
        credentialStorage: ViewportCredentialStorage())
      try await connection.pair(host: host, code: code.code, name: "Synthetic viewport rotation")
      let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
      let window = UIWindow(windowScene: scene)
      let controller = UIViewController()
      window.rootViewController = controller
      window.frame = CGRect(x: 0, y: 0, width: 390, height: 800)
      window.isHidden = false
      connection.video.displayLayer.frame = CGRect(x: 0, y: 0, width: 390, height: 720)
      controller.view.layer.addSublayer(connection.video.displayLayer)
      defer {
        connection.stop()
        connection.video.displayLayer.removeFromSuperlayer()
        window.isHidden = true
      }
      do {
        let app = try XCTUnwrap(connection.apps.first(where: { $0.bundleId == "test.editor" }))
        connection.prepareViewport(CGSize(width: 390, height: 720))
        try await connection.open(app: app, windowID: 7)
        try await waitUntil { connection.isStreaming }
        XCTAssertEqual(connection.videoSize.width / connection.videoSize.height, 390.0 / 720, accuracy: 0.01)

        connection.updateViewport(CGSize(width: 780, height: 360))
        try await waitUntil { connection.isStreaming && connection.videoSize.width > connection.videoSize.height }
        XCTAssertEqual(connection.videoSize.width / connection.videoSize.height, 780.0 / 360, accuracy: 0.01)

        try await connection.start(windowID: 7, name: "Original layout", layout: .original)
        try await waitUntil { connection.isStreaming }
        XCTAssertEqual(connection.videoSize, CGSize(width: 1280, height: 800))
        connection.updateViewport(CGSize(width: 390, height: 720))
        try await Task.sleep(nanoseconds: 700_000_000)
        XCTAssertTrue(connection.isStreaming)
        XCTAssertFalse(connection.prefersPhoneLayout)
        XCTAssertEqual(connection.videoSize, CGSize(width: 1280, height: 800),
          "Rotation must respect the user's explicit original-layout choice.")

        try await connection.start(windowID: 7, name: "Phone layout", layout: .phone)
        try await waitUntil { connection.isStreaming }
        connection.updateViewport(CGSize(width: 780, height: 360))
        connection.stop()
        try await Task.sleep(nanoseconds: 700_000_000)
        XCTAssertEqual(connection.connectionState, .ready)
        XCTAssertFalse(connection.isStreaming, "A queued rotation must not reopen a stopped session.")
        try await connection.disconnect()
      } catch {
        try? await connection.disconnect()
        throw error
      }
    #endif
  }

  @MainActor
  func testKeychainFailureRevokesJustIssuedPairing() async throws {
    #if !targetEnvironment(simulator)
      throw XCTSkip("Synthetic integration is restricted to the iOS Simulator.")
    #else
      guard let host = ProcessInfo.processInfo.environment["PALM_INTEGRATION_HOST"] else {
        throw XCTSkip("Set PALM_INTEGRATION_HOST to the isolated synthetic loopback server.")
      }
      let endpoint = try PalmEndpoint(host, allowLoopback: true)
      guard endpoint.origin.scheme == "http", ["localhost", "127.0.0.1"].contains(endpoint.origin.host ?? "") else {
        XCTFail("Integration must use a loopback fixture.")
        return
      }
      struct Session: Decodable { let synthetic: Bool }
      let fixture: Session = try await fixtureAPI(endpoint, path: "/api/session")
      guard fixture.synthetic else { XCTFail("A real host must never be used for this test."); return }
      struct Setup: Decodable {
        struct Device: Decodable { let id: String }
        let devices: [Device]
      }
      struct PairCode: Decodable { let code: String }
      let before: Setup = try await fixtureAPI(endpoint, path: "/api/local/setup")
      let code: PairCode = try await fixtureAPI(endpoint, path: "/api/local/pair-code", post: true)
      let storage = RefusingCredentialStorage()
      let connection = PalmConnection(allowSimulatorLoopback: true, credentialStorage: storage)
      do {
        try await connection.pair(host: host, code: code.code, name: "Rejected Keychain fixture")
        XCTFail("The test storage must reject persistence.")
      } catch {
        XCTAssertTrue(error is PalmKeychainFailure, "The original storage failure must remain visible.")
      }
      XCTAssertFalse(connection.isPaired)
      let after: Setup = try await fixtureAPI(endpoint, path: "/api/local/setup")
      XCTAssertEqual(Set(after.devices.map(\.id)), Set(before.devices.map(\.id)),
        "Failed Keychain persistence must not leave an active orphan token on the Mac.")
    #endif
  }

  @MainActor
  private func waitUntil(timeout: TimeInterval = 12, condition: () -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
    XCTAssertTrue(condition(), "The native session did not reach the expected state before its deadline.")
    if !condition() { throw PalmFailure.message("Native integration state timed out.") }
  }

  private func fixtureAPI<T: Decodable>(_ endpoint: PalmEndpoint, path: String, post: Bool = false) async throws -> T {
    var request = URLRequest(url: endpoint.url(path))
    request.setValue(endpoint.string, forHTTPHeaderField: "Origin")
    if post {
      request.httpMethod = "POST"
      request.httpBody = Data("{}".utf8)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    return try JSONDecoder().decode(T.self, from: data)
  }
}

private final class ViewportCredentialStorage: PalmCredentialStorage {
  private var credential: PalmCredential?
  func read() throws -> PalmCredential? { credential }
  func save(_ credential: PalmCredential) throws { self.credential = credential }
  func clear() throws { credential = nil }
}

private struct RefusingCredentialStorage: PalmCredentialStorage {
  func read() throws -> PalmCredential? { nil }
  func save(_ credential: PalmCredential) throws { throw PalmKeychainFailure(operation: "save", status: -34018) }
  func clear() throws {}
}
