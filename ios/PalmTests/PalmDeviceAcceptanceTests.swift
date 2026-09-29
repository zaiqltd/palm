import AVFoundation
import CoreImage
import Foundation
import UIKit
import XCTest

@testable import Palm

/// Opt-in acceptance of Palm's own device transport against its isolated Mac fixture.
/// This is not a finger-gesture/UI-automation test. It never pairs, revokes, activates an
/// arbitrary app, targets Desktop, or exports the existing phone credential.
final class PalmDeviceAcceptanceTests: XCTestCase {
  private static let fixtureBundleID = "local.palm.testpad"
  private static let fixtureWindowTitle = "Palm — isolated input test"

  @MainActor
  func testIsolatedTestPadDisplayedVideoAndAcknowledgedNamedAction() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard environment["PALM_DEVICE_ACCEPTANCE"] == "isolated-test-pad" else {
      throw XCTSkip("Physical acceptance requires the explicit isolated-test-pad opt-in.")
    }
    guard !Self.isSimulator else {
      throw XCTSkip("Physical acceptance runs only on an explicitly selected iPhone.")
    }
    guard #available(iOS 17.4, *) else {
      throw XCTSkip("Displayed-pixel acceptance requires iOS 17.4 or newer.")
    }
    try require(
      UIDevice.current.userInterfaceIdiom == .phone,
      "This acceptance test requires a physical iPhone.")
    guard let approvedHost = environment["PALM_ACCEPTANCE_HOST"], !approvedHost.isEmpty else {
      throw AcceptanceFailure("Set PALM_ACCEPTANCE_HOST to the exact already-paired Mac URL.")
    }
    guard let saved = try PalmKeychain.read() else {
      throw AcceptanceFailure(
        "The iPhone must already be paired; this test will not create a pairing.")
    }
    // Do not use XCTAssertEqual on credential fields: failure output must never disclose them.
    try require(saved.isValid, "The existing pairing has expired; no test command was sent.")
    try require(
      approvedHost == saved.host,
      "The approved host does not exactly match the existing pairing; no test command was sent.")
    let endpoint = try PalmEndpoint(approvedHost)
    try require(
      endpoint.string == approvedHost && endpoint.origin.scheme == "https",
      "Acceptance requires the exact canonical private HTTPS pairing URL.")

    // Even an unexpected 401 must not erase the real phone's saved pairing during this test.
    let connection = PalmConnection(credentialStorage: ReadOnlyPairing(saved: saved))
    var diagnosticPhase = "restore"
    var acceptanceCompleted = false
    defer {
      connection.stop()
      if !acceptanceCompleted {
        struct FailureMetadata: Encodable {
          let phase: String
          let events: [PalmConnectionDiagnosticEvent]
        }
        if let data = try? JSONEncoder().encode(FailureMetadata(
          phase: diagnosticPhase, events: connection.diagnostics)) {
          let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
          attachment.name = "Palm connection failure metadata"
          attachment.lifetime = .keepAlways
          add(attachment)
        }
      }
      do {
        if let current = try PalmKeychain.read() {
          XCTAssertTrue(
            current.host == saved.host && current.token == saved.token
              && current.deviceId == saved.deviceId && current.expires == saved.expires,
            "Acceptance must leave the existing Keychain pairing unchanged.")
        } else {
          XCTFail("Acceptance must preserve the existing Keychain pairing.")
        }
      } catch {
        XCTFail("Could not verify preservation of the existing Keychain pairing.")
      }
    }
    await connection.restore()
    try require(
      connection.isPaired && connection.connectionState == .ready,
      "The existing pairing did not restore to Ready; no test command was sent.")
    let fixtureApp = try approvedApp(in: connection)
    let scene = try activePhoneScene()

    // A separate app-owned view proves actual AVSampleBufferDisplayLayer output. It does
    // not inject touches or use accessibility automation to drive another application.
    let window = UIWindow(windowScene: scene)
    let controller = UIViewController()
    controller.view.backgroundColor = .black
    window.rootViewController = controller
    window.frame = scene.coordinateSpace.bounds
    window.windowLevel = .normal + 1
    window.isUserInteractionEnabled = false
    window.isHidden = false
    window.layoutIfNeeded()
    let surface = PalmSurfaceView(frame: controller.view.bounds.insetBy(dx: 16, dy: 80))
    surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    controller.view.addSubview(surface)
    let displayLayer = connection.video.displayLayer
    func configureSurface() {
      surface.configure(
        layer: displayLayer, size: connection.videoSize, enabled: false,
        mode: .touch, resetZoomID: 0,
        pointer: { _, _, _ in XCTFail("Device acceptance must not inject pointer input.") },
        scroll: { _, _ in XCTFail("Device acceptance must not inject scroll input.") },
        cancelSession: { connection.stop() })
      surface.layoutIfNeeded()
    }
    configureSurface()
    defer {
      connection.stop()
      surface.detach()
      window.isHidden = true
      window.rootViewController = nil
    }

    // Exercise the same app-card path as the native client, including an app hidden on
    // another Space. Activate only the unique fixture bundle; validate its exact window
    // after activation and before any input. The production foreground guard stays intact.
    diagnosticPhase = "openFixture"
    do { try await connection.open(app: fixtureApp) }
    catch {
      let safe = PalmConnectionDiagnosticError(error)
      throw AcceptanceFailure("Fixture connection failed (\(safe.domain), code \(safe.code)); inspect the connection metadata attachment.")
    }
    diagnosticPhase = "waitForDisplayedVideo"
    configureSurface()
    try await waitUntil(connection: connection, scene: scene) {
      connection.isStreaming && connection.video.isReadyForDisplay && connection.fps > 0
    }
    diagnosticPhase = "verifyTarget"
    try await connection.refresh()
    let target = try approvedTarget(in: connection)
    try require(
      connection.targetWindowID == target.window.id,
      "The stream does not target the exact approved fixture window; no input action was sent.")
    var ancestor: CALayer? = displayLayer.superlayer
    while ancestor != nil && ancestor !== surface.layer { ancestor = ancestor?.superlayer }
    try require(
      surface.window === window && ancestor === surface.layer
        && displayLayer.bounds.width > 0 && displayLayer.bounds.height > 0,
      "The displayed layer is not attached to the current Palm viewport.")
    let evidence = try displayedPixelEvidence(connection: connection)

    // PalmTestPad.swift creates exactly one NSButton titled Add note. Its selector only
    // increments the isolated note counter and saves PALM_TEST_STATE. Do not infer pointer
    // coordinates: phone models do not provide the current NSWindow content-frame inset.
    diagnosticPhase = "queryNamedControls"
    try await connection.refreshActions()
    try require(
      connection.actionsApp == target.app.name,
      "The named controls belong to a different app; no input action was sent.")
    let addNoteActions = connection.actions.filter { $0.title == "Add note" }
    try require(
      addNoteActions.count == 1,
      "The unique Add note fixture action is missing or ambiguous; no input action was sent.")
    try require(
      scene.activationState == .foregroundActive && connection.isStreaming,
      "Palm left the foreground or lost its stream; no input action was sent.")
    // The server checks the captured PID and exact foreground window again here. An input
    // rejection fails this test; it is never retried or replaced with app activation.
    var inputToDisplayedPixelMilliseconds: Double?
    diagnosticPhase = "performNamedAction"
    if environment["PALM_DEVICE_LATENCY"] == "isolated-test-pad-marker" {
      let context = CIContext(options: [.cacheIntermediates: false])
      let previous = try displayedMarker(connection: connection, context: context)
      let sent = ProcessInfo.processInfo.systemUptime
      let action = Task { try await connection.performAction(id: addNoteActions[0].id) }
      do {
        let deadline = sent + 5
        while true {
          try Task.checkCancellation()
          try require(
            scene.activationState == .foregroundActive && connection.isStreaming,
            "Palm left the foreground or lost its stream during the marker measurement.")
          if let current = try? displayedMarker(connection: connection, context: context),
            current != previous
          {
            break
          }
          try require(
            ProcessInfo.processInfo.systemUptime < deadline,
            "The fixture did not display its changed marker within five seconds; the action is not repeated."
          )
          try await Task.sleep(nanoseconds: 5_000_000)
        }
        inputToDisplayedPixelMilliseconds = (ProcessInfo.processInfo.systemUptime - sent) * 1000
        // Observe pixels concurrently: performAction also refreshes app controls, which
        // may finish after the visible change and must not inflate this measurement.
        try await action.value
      } catch {
        _ = try? await action.value
        throw error
      }
    } else {
      try await connection.performAction(id: addNoteActions[0].id)
    }
    try require(
      connection.errorMessage == nil,
      "The native connection reported a failure during the isolated action.")

    // Keep only fixture-derived metrics. No credentials, screen frame or typed text is saved.
    var report: [String: Any] = [
      "kind": "Physical iPhone Palm transport against isolated Test Pad",
      "displayedPixelWidth": evidence.width,
      "displayedPixelHeight": evidence.height,
      "sampledGreenRange": evidence.greenRange,
      "sampledGreenDominantPixels": evidence.greenDominantPixels,
      "layerAttachedToPalmSurfaceView": true,
      "namedAction": "Add note",
      "namedActionAcknowledged": true,
      "persistentCounterVerifiedByThisTest": false,
      "pointerCommandSent": false,
      "fingerGestureAcceptance": false,
      "pairingChanged": false,
    ]
    if let latency = inputToDisplayedPixelMilliseconds {
      let counters = connection.video.diagnostics
      report["inputToDisplayedPixelMilliseconds"] = latency
      report["latencySamples"] = 1
      report["latencyMeasurement"] =
        "Named Add note dispatch to changed actual displayed marker pixel"
      report["latencyIncludes"] =
        "Private HTTPS, real app action, ScreenCaptureKit, encoder, video transport and native decoder"
      report["latencyExcludes"] =
        "Touchscreen recognition and physical panel scanout; one sample is not a performance distribution"
      report["decoderResets"] = counters.decoderResets
      report["backpressureFlushes"] = counters.backpressureFlushes
      report["keyframeWaitDrops"] = counters.keyframeWaitDrops
      report["maximumEnqueueWorkMilliseconds"] = counters.maximumEnqueueWorkMilliseconds
    }
    let attachment = XCTAttachment(
      data: try JSONSerialization.data(
        withJSONObject: report,
        options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
    attachment.name = "Isolated Test Pad native transport evidence"
    attachment.lifetime = .keepAlways
    add(attachment)
    connection.stop()
    XCTAssertFalse(connection.isStreaming, "The acceptance stream must stop on completion.")
    acceptanceCompleted = true
  }

  @MainActor
  private func approvedApp(in connection: PalmConnection) throws -> PalmRemoteApp {
    guard let status = connection.hostStatus else {
      throw AcceptanceFailure("The paired host did not return status.")
    }
    try require(
      status.platform == "macOS" && !status.synthetic,
      "Physical acceptance requires the already-paired real macOS host.")
    try require(
      status.screenPermission && status.controlPermission
        && status.remoteEnabled != false,
      "The paired Mac is not ready for approved capture and control.")
    let fixtures = connection.apps.filter { $0.bundleId == Self.fixtureBundleID }
    try require(fixtures.count == 1, "The isolated fixture app is missing or ambiguous.")
    return fixtures[0]
  }

  @MainActor
  private func approvedTarget(in connection: PalmConnection) throws -> (
    app: PalmRemoteApp, window: PalmRemoteWindow
  ) {
    let app = try approvedApp(in: connection)
    try require(
      app.active && connection.hostStatus?.activeApp == app.name,
      "The isolated fixture must be the active Mac app before input.")
    // Require exactly one total window, not merely one matching title among unrelated windows.
    try require(
      app.windows.count == 1,
      "The fixture must have exactly one visible window; found \(app.windows.count).")
    let window = app.windows[0]
    try require(
      window.title == Self.fixtureWindowTitle && window.id > 0
        && UInt64(window.id) <= UInt64(UInt32.max),
      "The fixture window is not the exact approved non-Desktop target.")
    return (app, window)
  }

  @MainActor
  private func activePhoneScene() throws -> UIWindowScene {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }
    try require(scenes.count == 1, "Palm must have one active scene on the unlocked phone.")
    return scenes[0]
  }

  @MainActor
  private func waitUntil(
    connection: PalmConnection, scene: UIWindowScene,
    timeout: TimeInterval = 15, condition: () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() {
      try Task.checkCancellation()
      try require(
        scene.activationState == .foregroundActive,
        "Palm left the foreground during the acceptance check.")
      try require(
        connection.errorMessage == nil,
        "The native connection failed while awaiting displayed fixture pixels.")
      try require(Date() < deadline, "The native fixture did not display before the deadline.")
      try await Task.sleep(nanoseconds: 100_000_000)
    }
  }

  @available(iOS 17.4, *)
  @MainActor
  private func displayedMarker(connection: PalmConnection, context: CIContext) throws -> Bool {
    guard let pixel = connection.video.displayLayer.sampleBufferRenderer.displayedPixelBuffer()
    else {
      throw AcceptanceFailure("The approved fixture has no displayed marker frame.")
    }
    // Locate only the fixture's saturated marker. Window/title-bar geometry can change
    // during phone layout, so do not infer its encoded coordinates from AppKit points.
    let image = CIImage(cvPixelBuffer: pixel).transformed(
      by: CGAffineTransform(
        scaleX: 96.0 / Double(CVPixelBufferGetWidth(pixel)),
        y: 96.0 / Double(CVPixelBufferGetHeight(pixel))))
    var rgba = [UInt8](repeating: 0, count: 96 * 96 * 4)
    context.render(
      image, toBitmap: &rgba, rowBytes: 96 * 4,
      bounds: CGRect(x: 0, y: 0, width: 96, height: 96), format: .RGBA8,
      colorSpace: CGColorSpaceCreateDeviceRGB())
    var cyan = 0
    var magenta = 0
    for index in stride(from: 0, to: rgba.count, by: 4) where rgba[index + 2] > 180 {
      if rgba[index] < 80 && rgba[index + 1] > 180 { cyan += 1 }
      if rgba[index] > 180 && rgba[index + 1] < 80 { magenta += 1 }
    }
    try require(
      (cyan >= 4 && magenta == 0) || (magenta >= 4 && cyan == 0),
      "The approved Test Pad marker is missing or ambiguous; no marker timing can be established.")
    return magenta > cyan
  }

  @available(iOS 17.4, *)
  @MainActor
  private func displayedPixelEvidence(connection: PalmConnection) throws -> (
    width: Int, height: Int, greenRange: Int, greenDominantPixels: Int
  ) {
    guard let pixel = connection.video.displayLayer.sampleBufferRenderer.displayedPixelBuffer()
    else {
      throw AcceptanceFailure("H.264 packets did not produce an actual displayed pixel buffer.")
    }
    let width = CVPixelBufferGetWidth(pixel)
    let height = CVPixelBufferGetHeight(pixel)
    try require(
      width > 0 && height > 0
        && width == Int(connection.videoSize.width) && height == Int(connection.videoSize.height),
      "Displayed fixture pixels do not match the native stream dimensions.")
    let thumbnailWidth = 48
    let thumbnailHeight = 32
    let thumbnail = CIImage(cvPixelBuffer: pixel).transformed(
      by: CGAffineTransform(
        scaleX: Double(thumbnailWidth) / Double(width),
        y: Double(thumbnailHeight) / Double(height)))
    var rgba = [UInt8](repeating: 0, count: thumbnailWidth * thumbnailHeight * 4)
    CIContext().render(
      thumbnail, toBitmap: &rgba, rowBytes: thumbnailWidth * 4,
      bounds: CGRect(x: 0, y: 0, width: thumbnailWidth, height: thumbnailHeight),
      format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
    let green = stride(from: 1, to: rgba.count, by: 4).map { Int(rgba[$0]) }
    let range = (green.max() ?? 0) - (green.min() ?? 0)
    let greenDominant = stride(from: 0, to: rgba.count, by: 4).filter {
      Int(rgba[$0 + 1]) > Int(rgba[$0]) + 5
        && Int(rgba[$0 + 1]) > Int(rgba[$0 + 2]) + 3
    }.count
    // The fixture source has a dark green canvas and bright text/controls. These broad
    // checks reject a black/blank decoder surface without inventing a screenshot match.
    try require(
      range > 40 && greenDominant > 100,
      "Displayed pixels do not contain the isolated fixture's green canvas and bright content.")
    return (width, height, range, greenDominant)
  }

  private func require(_ condition: Bool, _ message: String) throws {
    guard condition else { throw AcceptanceFailure(message) }
  }

  private static var isSimulator: Bool {
    #if targetEnvironment(simulator)
      true
    #else
      false
    #endif
  }
}

private struct AcceptanceFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

private struct ReadOnlyPairing: PalmCredentialStorage {
  let saved: PalmCredential
  func read() throws -> PalmCredential? { saved }
  func save(_ credential: PalmCredential) throws {
    throw AcceptanceFailure("Device acceptance must not write pairing credentials.")
  }
  func clear() throws {
    throw AcceptanceFailure("Device acceptance must not remove pairing credentials.")
  }
}
