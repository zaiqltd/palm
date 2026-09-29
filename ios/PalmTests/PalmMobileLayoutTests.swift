import AVFoundation
import CoreImage
import Foundation
import SwiftUI
import UIKit
import XCTest

@testable import Palm

/// Hosts the production SwiftUI screen, using only an explicitly selected synthetic
/// loopback server and ephemeral test credentials. Never uses the user's Keychain.
@MainActor
final class PalmMobileLayoutTests: XCTestCase {
  func testPortraitRemoteViewGivesMostSafeAreaToLiveSurface() async throws {
    try await withSyntheticConnection { connection in
      try await self.verifyHostedLayout(connection, size: CGSize(width: 393, height: 852))
    }
  }

  func testLandscapeRemoteViewKeepsSurfaceAndToolbarVisible() async throws {
    try await withSyntheticConnection { connection in
      try await self.verifyHostedLayout(connection, size: CGSize(width: 852, height: 393))
    }
  }

  func testPhoneLayoutResponsePreservesOptionalAndUnavailableStates() throws {
    #if !targetEnvironment(simulator)
      throw XCTSkip("Mobile layout regressions run in Simulator only.")
    #else
      let legacy = try JSONDecoder().decode(
        PalmStreamStart.self,
        from: Data(
          #"{"width":1280,"height":800,"target":"Synthetic editor"}"#.utf8))
      XCTAssertNil(legacy.phoneLayout, "Older hosts must remain compatible without a layout field.")
      XCTAssertNil(legacy.sourceWidth)
      XCTAssertNil(legacy.sourceHeight)

      let applied = try JSONDecoder().decode(
        PalmStreamStart.self,
        from: Data(
          #"{"width":600,"height":1000,"target":"Synthetic editor","sourceWidth":600,"sourceHeight":1000,"phoneLayout":{"requested":true,"applied":true,"state":"applied"}}"#
            .utf8))
      XCTAssertEqual(applied.phoneLayout?.requested, true)
      XCTAssertEqual(applied.phoneLayout?.applied, true)
      XCTAssertNil(applied.phoneLayout?.reason)
      XCTAssertEqual(applied.sourceWidth, 600)
      XCTAssertEqual(applied.sourceHeight, 1000)

      let unavailable = try JSONDecoder().decode(
        PalmStreamStart.self,
        from: Data(
          #"{"width":1280,"height":800,"target":"Synthetic editor","phoneLayout":{"requested":true,"applied":false,"state":"unavailable","reason":"Fixture window cannot resize"}}"#
            .utf8))
      XCTAssertEqual(unavailable.phoneLayout?.requested, true)
      XCTAssertEqual(unavailable.phoneLayout?.applied, false)
      XCTAssertEqual(unavailable.phoneLayout?.state, "unavailable")
      XCTAssertEqual(unavailable.phoneLayout?.reason, "Fixture window cannot resize")
    #endif
  }

  private func verifyHostedLayout(_ connection: PalmConnection, size: CGSize) async throws {
    let orientation = size.height > size.width ? "portrait" : "landscape"
    guard #available(iOS 17.4, *) else {
      throw XCTSkip("Displayed H.264 buffer verification requires iOS 17.4 or newer.")
    }
    let scene = try XCTUnwrap(
      UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        .first(where: { $0.activationState == .foregroundActive }),
      "The Simulator test app needs an active scene for real SwiftUI hosting.")
    let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
    let window = UIWindow(windowScene: scene)
    let content = PalmRemoteView(connection: connection)
      .environment(\.scenePhase, .active)
      .environment(\.dynamicTypeSize, .large)
      .overlay(alignment: .top) {
        Text("SYNTHETIC FIXTURE · Layout regression")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(.black)
          .padding(.horizontal, 6).padding(.vertical, 2)
          .background(Color.orange, ignoresSafeAreaEdges: [])
          .allowsHitTesting(false)
      }
    let controller = UIHostingController(rootView: content)
    window.rootViewController = controller
    window.frame = CGRect(origin: .zero, size: size)
    window.windowLevel = .normal + 1
    window.makeKeyAndVisible()
    controller.view.frame = window.bounds
    controller.view.setNeedsLayout()
    controller.view.layoutIfNeeded()
    defer {
      connection.stop()
      window.isHidden = true
      window.rootViewController = nil
      previousKeyWindow?.makeKey()
    }

    let editors = connection.apps.filter { $0.bundleId == "test.editor" }
    guard editors.count == 1, editors[0].windows.contains(where: { $0.id == 7 }) else {
      throw LayoutFailure("The explicit synthetic editor/window fixture is missing.")
    }
    // This only starts the synthetic stream. No mouse, keyboard or named action is sent.
    try await connection.open(app: editors[0], windowID: 7, layout: .original)
    recordDiagnostics(
      connection, controller: controller, window: window, stage: "\(orientation): after open")
    try await waitUntil(
      stage: "\(orientation): mounted PalmSurfaceView",
      diagnostics: {
        self.recordDiagnostics(
          connection, controller: controller, window: window,
          stage: "\(orientation): surface mount timeout")
        self.attachHostedScreenshot(window, orientation: "\(orientation) — surface mount timeout")
      }
    ) {
      controller.view.layoutIfNeeded()
      return !self.descendants(of: controller.view, type: PalmSurfaceView.self).isEmpty
    }
    try await waitUntil(
      stage: "\(orientation): live displayed H264",
      diagnostics: {
        self.recordDiagnostics(
          connection, controller: controller, window: window,
          stage: "\(orientation): displayed video timeout")
        self.attachHostedScreenshot(window, orientation: "\(orientation) — displayed video timeout")
      }
    ) {
      controller.view.layoutIfNeeded()
      return connection.isStreaming && connection.video.isReadyForDisplay && connection.fps > 0
    }
    // Let SwiftUI apply the published stream state before measuring the actual hierarchy.
    try await Task.sleep(nanoseconds: 200_000_000)
    controller.view.layoutIfNeeded()
    XCTAssertEqual(connection.phoneLayout?.requested, false)
    XCTAssertEqual(connection.phoneLayout?.state, "off")
    XCTAssertEqual(
      connection.phoneLayout?.applied, false,
      "The synthetic host must not claim it resized a real Mac window.")
    XCTAssertEqual(connection.videoSize, CGSize(width: 1280, height: 800))
    let surfaces = descendants(of: controller.view, type: PalmSurfaceView.self)
    XCTAssertEqual(surfaces.count, 1, "One production surface should own the entire live viewport.")
    let surface = try XCTUnwrap(surfaces.first)
    let surfaceRect = surface.convert(surface.bounds, to: controller.view)
    let safeRect = controller.view.safeAreaLayoutGuide.layoutFrame
    let portrait = size.height > size.width

    let pixelBuffer = try XCTUnwrap(
      connection.video.displayLayer.sampleBufferRenderer.displayedPixelBuffer(),
      "A live label is insufficient: the attached renderer must have displayed a synthetic H.264 buffer."
    )
    var layerOwner = connection.video.displayLayer.superlayer
    while layerOwner != nil && layerOwner !== surface.layer { layerOwner = layerOwner?.superlayer }
    XCTAssertTrue(
      layerOwner === surface.layer, "The rendered buffer must belong to the hosted Palm surface.")
    XCTAssertEqual(CVPixelBufferGetWidth(pixelBuffer), 1280)
    XCTAssertEqual(CVPixelBufferGetHeight(pixelBuffer), 800)
    let decodedImage = CIImage(cvPixelBuffer: pixelBuffer)
    let decodedCGImage = try XCTUnwrap(
      CIContext().createCGImage(decodedImage, from: decodedImage.extent))
    let decodedAttachment = XCTAttachment(image: UIImage(cgImage: decodedCGImage))
    decodedAttachment.name =
      "Actual displayed H264 frame — SYNTHETIC desktop layout — \(orientation)"
    decodedAttachment.lifetime = .keepAlways
    add(decodedAttachment)

    // Measure the actual image, not the black UIView that contains it. The video layer's
    // ancestors include the production zoom transform and scroll offset; conversion
    // therefore captures visible image coverage, letterboxing and proportional scale.
    let imageRect = connection.video.displayLayer.convert(
      connection.video.displayLayer.bounds,
      to: surface.layer)
    let visibleImageRect = imageRect.intersection(surface.bounds)
    let imageCoverage =
      visibleImageRect.width * visibleImageRect.height
      / max(1, surface.bounds.width * surface.bounds.height)
    let horizontalScale = imageRect.width / CGFloat(CVPixelBufferGetWidth(pixelBuffer))
    let verticalScale = imageRect.height / CGFloat(CVPixelBufferGetHeight(pixelBuffer))
    let visibleSource = surface.visibleNormalizedRect
    // The actual native drawSynthetic fixture places a 180×44 source-pixel button
    // at (W/2−90, H/2+20), with 24-point text and a 28-point section title.
    // Report the on-phone sizes honestly; a Mac button is not a native 44pt target.
    let fixtureButton = CGRect(
      x: imageRect.minX + 550 * horizontalScale,
      y: imageRect.minY + 420 * verticalScale,
      width: 180 * horizontalScale, height: 44 * verticalScale)
    XCTAssertTrue(
      surface.bounds.contains(fixtureButton),
      "The known central target must remain completely visible in the actual video viewport.")
    let fixtureCenter = try XCTUnwrap(
      surface.normalizedPoint(
        at: CGPoint(
          x: fixtureButton.midX, y: fixtureButton.midY)))
    XCTAssertEqual(fixtureCenter.x, 0.5, accuracy: 0.002)
    XCTAssertEqual(fixtureCenter.y, 442.0 / 800.0, accuracy: 0.002)
    attachHostedScreenshot(window, orientation: orientation)
    let metrics: [String: Any] = [
      "kind": "Synthetic hosted SwiftUI layout; not physical phone acceptance",
      "orientation": orientation,
      "requestedWidth": size.width, "requestedHeight": size.height,
      "hostedWidth": controller.view.bounds.width, "hostedHeight": controller.view.bounds.height,
      "safeAreaWidth": safeRect.width, "safeAreaHeight": safeRect.height,
      "surfaceWidth": surfaceRect.width, "surfaceHeight": surfaceRect.height,
      "surfaceSafeAreaHeightFraction": surfaceRect.height / max(1, safeRect.height),
      "imageWidth": imageRect.width, "imageHeight": imageRect.height,
      "visibleImageWidth": visibleImageRect.width, "visibleImageHeight": visibleImageRect.height,
      "visibleImageSurfaceAreaFraction": imageCoverage,
      "imagePointsPerSourcePixelX": horizontalScale,
      "imagePointsPerSourcePixelY": verticalScale,
      "visibleSourceWidthFraction": visibleSource.width,
      "visibleSourceHeightFraction": visibleSource.height,
      "sourceLayout": "Original desktop-shaped synthetic stream; phoneLayout false",
      "fixtureButtonVisible": surface.bounds.contains(fixtureButton),
      "fixtureButtonWidthPoints": fixtureButton.width,
      "fixtureButtonHeightPoints": fixtureButton.height,
      "fixtureTitleNominalFontPoints": 28 * verticalScale,
      "fixtureButtonNominalFontPoints": 24 * verticalScale,
      "displayedPixelWidth": CVPixelBufferGetWidth(pixelBuffer),
      "displayedPixelHeight": CVPixelBufferGetHeight(pixelBuffer),
      "separateTrackpadViews": descendants(of: controller.view, type: PalmTrackpadView.self).count,
      "inputCommandsSent": 0,
    ]
    let evidence = XCTAttachment(
      data: try JSONSerialization.data(
        withJSONObject: metrics,
        options: [.prettyPrinted, .sortedKeys]), uniformTypeIdentifier: "public.json")
    evidence.name = "Synthetic hosted layout measurements — \(orientation)"
    evidence.lifetime = .keepAlways
    add(evidence)

    XCTAssertEqual(controller.view.bounds.width, size.width, accuracy: 1)
    XCTAssertEqual(controller.view.bounds.height, size.height, accuracy: 1)
    XCTAssertGreaterThan(
      surfaceRect.height, safeRect.height * (portrait ? 0.60 : 0.95),
      "Landscape must use the full safe height; fixed header and footer bars must not return.")
    XCTAssertGreaterThan(surfaceRect.width, safeRect.width * 0.90)
    XCTAssertGreaterThan(surfaceRect.height, portrait ? 400 : 280)
    XCTAssertGreaterThan(
      imageCoverage, 0.95,
      "Actual desktop video must fill the viewport; a large black surface is not content coverage.")
    XCTAssertEqual(
      horizontalScale, verticalScale, accuracy: 0.001,
      "The source must remain proportional; stretching cannot fix wasted space.")
    // Full-bleed design (22 September 2026): the live video uses the whole
    // screen and the controls float above it on glass.
    XCTAssertGreaterThanOrEqual(surfaceRect.width, controller.view.bounds.width - 1,
      "The live surface must use the full screen width.")
    XCTAssertGreaterThanOrEqual(surfaceRect.height, controller.view.bounds.height - 1,
      "The live surface must use the full screen height; no fixed bars.")
    XCTAssertTrue(
      descendants(of: controller.view, type: PalmTrackpadView.self).isEmpty,
      "Do not consume screen space with a second trackpad below the live surface.")

    try await waitUntil(
      stage: "\(orientation): keyboard accessibility element",
      diagnostics: {
        self.recordDiagnostics(
          connection, controller: controller, window: window,
          stage: "\(orientation): accessibility timeout")
      }
    ) {
      self.accessibilityObjects(in: controller.view).contains {
        self.accessibilityIdentifier(of: $0) == "remote.keyboard"
      }
    }
    let elements = accessibilityObjects(in: controller.view)
    let keyboard = try XCTUnwrap(
      elements.first {
        accessibilityIdentifier(of: $0) == "remote.keyboard"
      }, "The native keyboard control must remain exposed to accessibility.")
    let stop = try XCTUnwrap(
      elements.first {
        accessibilityIdentifier(of: $0) == "remote.stop"
      }, "Stop must remain exposed to accessibility.")
    let screenBounds = UIAccessibility.convertToScreenCoordinates(
      controller.view.bounds, in: controller.view)
    let surfaceOnScreen = UIAccessibility.convertToScreenCoordinates(
      surfaceRect, in: controller.view)
    for (name, control) in [("Type", keyboard), ("Stop", stop)] {
      let frame = control.accessibilityFrame
      XCTAssertGreaterThanOrEqual(frame.width, 44, "\(name) needs a 44-point-wide target.")
      XCTAssertGreaterThanOrEqual(frame.height, 44, "\(name) needs a 44-point-tall target.")
      XCTAssertTrue(
        screenBounds.insetBy(dx: -1, dy: -1).contains(frame),
        "\(name) must be visible without scrolling the live view.")
    }
    let targetOnScreen = UIAccessibility.convertToScreenCoordinates(
      surface.convert(fixtureButton, to: controller.view), in: controller.view)
    for (name, control) in [("Type", keyboard), ("Stop", stop)] {
      // Floating controls sit in the bottom band of the screen, within thumb
      // reach, and never over the centre of the live picture.
      XCTAssertGreaterThanOrEqual(
        control.accessibilityFrame.minY, surfaceOnScreen.maxY - surfaceOnScreen.height * (portrait ? 0.2 : 0.3),
        "\(name) belongs in the floating bar at the bottom of the screen.")
      XCTAssertFalse(control.accessibilityFrame.intersects(targetOnScreen),
        "\(name) must not cover the central target of the live picture.")
    }
  }

  private func attachHostedScreenshot(_ window: UIWindow, orientation: String) {
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    var rendered = false
    let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
      rendered = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
    }
    XCTAssertTrue(
      rendered, "UIKit must draw the actual hosted hierarchy for the layout attachment.")
    let attachment = XCTAttachment(image: image)
    attachment.name = "Actual hosted PalmRemoteView — \(orientation) — SYNTHETIC"
    attachment.lifetime = .keepAlways
    add(attachment)
    // drawHierarchy can omit an AVSampleBufferDisplayLayer's hardware video plane.
    // The separate displayed-buffer assertion above establishes decoding/attachment;
    // this uncomposited screenshot records the real SwiftUI chrome and layout.
  }

  private func descendants<T: UIView>(of root: UIView, type: T.Type) -> [T] {
    ((root as? T).map { [$0] } ?? [])
      + root.subviews.flatMap { descendants(of: $0, type: type) }
  }

  private func accessibilityObjects(in root: NSObject) -> [NSObject] {
    var pending = [root]
    var visited = Set<ObjectIdentifier>()
    var result: [NSObject] = []
    while let object = pending.popLast(), result.count < 2_000 {
      guard visited.insert(ObjectIdentifier(object)).inserted else { continue }
      result.append(object)
      if let view = object as? UIView { pending.append(contentsOf: view.subviews) }
      pending.append(
        contentsOf: (object.accessibilityElements ?? []).compactMap { $0 as? NSObject })
      pending.append(contentsOf: (object.automationElements ?? []).compactMap { $0 as? NSObject })
      let count = object.accessibilityElementCount()
      if (1...500).contains(count) {
        for index in 0..<count {
          if let child = object.accessibilityElement(at: index) as? NSObject {
            pending.append(child)
          }
        }
      }
    }
    return result
  }

  private func accessibilityIdentifier(of object: NSObject) -> String? {
    if let identified = object as? UIAccessibilityIdentification {
      return identified.accessibilityIdentifier
    }
    // SwiftUI can vend an accessibility object implementing the public getter without
    // declaring Objective-C protocol conformance. Read only that public property.
    let getter = #selector(getter: UIAccessibilityIdentification.accessibilityIdentifier)
    guard object.responds(to: getter) else { return nil }
    return object.value(forKey: "accessibilityIdentifier") as? String
  }

  private func recordDiagnostics(
    _ connection: PalmConnection, controller: UIViewController,
    window: UIWindow, stage: String
  ) {
    let surfaces = descendants(of: controller.view, type: PalmSurfaceView.self)
    let layer = connection.video.displayLayer
    func rect(_ value: CGRect) -> [String: CGFloat] {
      ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height]
    }
    var pixelSize: [String: Int] = [:]
    if #available(iOS 17.4, *), let pixel = layer.sampleBufferRenderer.displayedPixelBuffer() {
      pixelSize = ["width": CVPixelBufferGetWidth(pixel), "height": CVPixelBufferGetHeight(pixel)]
    }
    let details: [String: Any] = [
      "kind": "Synthetic hosted layout diagnostic", "stage": stage,
      "connectionState": connection.connectionState.rawValue,
      "fps": connection.fps, "isStreaming": connection.isStreaming,
      "displayReady": connection.video.isReadyForDisplay,
      "videoWidth": connection.videoSize.width, "videoHeight": connection.videoSize.height,
      "targetWindowID": connection.targetWindowID,
      "phoneLayoutState": connection.phoneLayout?.state ?? "absent",
      "connectionError": connection.errorMessage ?? "none",
      "layerStatus": layer.status.rawValue,
      "layerError": layer.error?.localizedDescription ?? "none",
      "layerBounds": rect(layer.bounds), "layerFrame": rect(layer.frame),
      "layerAttached": layer.superlayer != nil,
      "displayedPixels": pixelSize,
      "surfaceCount": surfaces.count,
      "surfaceBounds": surfaces.map { rect($0.bounds) },
      "surfaceOnWindow": surfaces.map { $0.window === window },
      "surfaceHidden": surfaces.map { $0.isHidden },
      "controllerBounds": rect(controller.view.bounds),
      "safeArea": rect(controller.view.safeAreaLayoutGuide.layoutFrame),
      "windowBounds": rect(window.bounds), "windowHidden": window.isHidden,
      "windowIsKey": window.isKeyWindow,
      "sceneActivation": window.windowScene?.activationState.rawValue ?? -99,
      "accessibilityNodes": accessibilityObjects(in: controller.view).prefix(80).map { object in
        [
          "class": String(describing: type(of: object)),
          "identifier": accessibilityIdentifier(of: object) ?? "",
          "label": object.accessibilityLabel ?? "",
          "frame": rect(object.accessibilityFrame),
        ] as [String: Any]
      },
    ]
    guard let data = try? JSONSerialization.data(withJSONObject: details, options: [.sortedKeys])
    else { return }
    // Fixture-only metadata; never include token, pairing code or arbitrary Mac content.
    print("PALM_LAYOUT_DIAGNOSTIC \(String(decoding: data, as: UTF8.self))")
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "Synthetic layout diagnostic — \(stage)"
    attachment.lifetime = .keepAlways
    add(attachment)
  }

  private func waitUntil(
    stage: String, timeout: TimeInterval = 12,
    diagnostics: () -> Void = {}, condition: () -> Bool
  ) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
    guard condition() else {
      diagnostics()
      throw LayoutFailure("Synthetic hosted UI timed out at stage: \(stage).")
    }
  }

  private func withSyntheticConnection(_ body: (PalmConnection) async throws -> Void) async throws {
    #if !targetEnvironment(simulator)
      throw XCTSkip(
        "Hosted integration is restricted to the iOS Simulator; no physical host is accessed.")
    #else
      guard let host = ProcessInfo.processInfo.environment["PALM_INTEGRATION_HOST"], !host.isEmpty
      else {
        throw XCTSkip("Set PALM_INTEGRATION_HOST to an isolated synthetic loopback fixture.")
      }
      let endpoint = try PalmEndpoint(host, allowLoopback: true)
      guard endpoint.origin.scheme == "http",
        ["127.0.0.1", "localhost"].contains(endpoint.origin.host ?? "")
      else { throw LayoutFailure("Layout integration requires an explicit HTTP loopback fixture.") }
      let config = URLSessionConfiguration.ephemeral
      config.httpShouldSetCookies = false
      config.httpCookieStorage = nil
      config.urlCache = nil
      config.timeoutIntervalForRequest = 10
      let session = URLSession(
        configuration: config, delegate: LayoutNoRedirects(), delegateQueue: nil)
      defer { session.invalidateAndCancel() }
      struct FixtureSession: Decodable { let synthetic: Bool }
      let fixture: FixtureSession = try await fixtureAPI(
        session, endpoint: endpoint, path: "/api/session")
      guard fixture.synthetic else {
        throw LayoutFailure(
          "Refusing the real Mac: synthetic preflight failed before any pairing or stream command.")
      }

      let storage = LayoutMemoryCredentials()
      let connection = PalmConnection(allowSimulatorLoopback: true, credentialStorage: storage)
      defer {
        connection.stop()
        storage.clear()
      }
      do {
        struct PairCode: Decodable { let code: String }
        let code: PairCode = try await fixtureAPI(
          session, endpoint: endpoint, path: "/api/local/pair-code", post: true)
        try await connection.pair(
          host: endpoint.string, code: code.code, name: "Synthetic mobile layout test")
        guard connection.hostStatus?.synthetic == true else {
          throw LayoutFailure(
            "The paired fixture did not retain synthetic status; refusing to start video.")
        }
        try await body(connection)
        try await connection.disconnect()
      } catch {
        connection.stop()
        try? await connection.disconnect()
        throw error
      }
    #endif
  }

  private func fixtureAPI<T: Decodable>(
    _ session: URLSession, endpoint: PalmEndpoint,
    path: String, post: Bool = false
  ) async throws -> T {
    var request = URLRequest(url: endpoint.url(path))
    request.setValue(endpoint.string, forHTTPHeaderField: "Origin")
    if post {
      request.httpMethod = "POST"
      request.httpBody = Data("{}".utf8)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200,
      http.url?.host == endpoint.origin.host, http.url?.port == endpoint.origin.port
    else { throw LayoutFailure("Synthetic fixture request failed or changed endpoint.") }
    return try JSONDecoder().decode(T.self, from: data)
  }
}

private final class LayoutMemoryCredentials: PalmCredentialStorage {
  private var credential: PalmCredential?
  func read() throws -> PalmCredential? { credential }
  func save(_ credential: PalmCredential) throws { self.credential = credential }
  func clear() { credential = nil }
}

private final class LayoutNoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) { completionHandler(nil) }
}

private struct LayoutFailure: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
