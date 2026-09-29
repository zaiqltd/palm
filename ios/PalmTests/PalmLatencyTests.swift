import AVFoundation
import CoreImage
import Foundation
import UIKit
import XCTest

@testable import Palm

final class PalmLatencyTests: XCTestCase {
  /// Measures an actual changed, displayed fixture pixel. Does not infer visual latency from RTT.
  @MainActor
  func testSyntheticPointerToDisplayedPixelLatency() async throws {
    #if !targetEnvironment(simulator)
      throw XCTSkip("Latency automation is restricted to an isolated Simulator fixture.")
    #else
      guard #available(iOS 17.4, *),
        let host = ProcessInfo.processInfo.environment["PALM_LATENCY_HOST"]
      else { throw XCTSkip("Set PALM_LATENCY_HOST to the isolated synthetic marker host.") }
      let endpoint = try PalmEndpoint(host, allowLoopback: true)
      guard endpoint.origin.scheme == "http",
        ["127.0.0.1", "localhost"].contains(endpoint.origin.host ?? "")
      else { throw PalmFailure.message("Latency fixture must use loopback.") }
      struct Status: Decodable { let synthetic: Bool }
      let status: Status = try await fixture(endpoint, path: "/api/session")
      guard status.synthetic else {
        XCTFail("Refusing latency input: this host controls a real Mac.")
        return
      }
      struct PairCode: Decodable { let code: String }
      let code: PairCode = try await fixture(endpoint, path: "/api/local/pair-code", post: true)
      let connection = PalmConnection(
        allowSimulatorLoopback: true,
        credentialStorage: PalmLatencyCredentialStorage())
      try await connection.pair(host: host, code: code.code, name: "Isolated latency fixture")
      guard connection.hostStatus?.synthetic == true else {
        XCTFail("Refusing input without synthetic confirmation.")
        return
      }
      let scene = try XCTUnwrap(
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
      let window = UIWindow(windowScene: scene)
      let controller = UIViewController()
      window.rootViewController = controller
      window.frame = CGRect(x: 0, y: 0, width: 390, height: 740)
      window.isHidden = false
      connection.video.displayLayer.frame = CGRect(x: 0, y: 0, width: 390, height: 244)
      controller.view.layer.addSublayer(connection.video.displayLayer)
      defer {
        connection.stop()
        connection.video.displayLayer.removeFromSuperlayer()
        window.isHidden = true
      }
      let openedAt = ProcessInfo.processInfo.systemUptime
      try await connection.start(windowID: 7, name: "Synthetic latency marker", layout: .original)
      let context = CIContext(options: [.cacheIntermediates: false])
      let initial = try await waitForMarker(
        connection, context: context, differentFrom: nil, timeout: 12)
      let firstDisplayedMs = (ProcessInfo.processInfo.systemUptime - openedAt) * 1000
      XCTAssertEqual(connection.videoSize, CGSize(width: 1280, height: 800))
      // The display buffer can become available before the next receive/heartbeat
      // publishes .live. Wait for the production input gate before measuring a click.
      let readyDeadline = ProcessInfo.processInfo.systemUptime + 3
      while !connection.isStreaming && ProcessInfo.processInfo.systemUptime < readyDeadline {
        try await Task.sleep(nanoseconds: 5_000_000)
      }
      guard connection.isStreaming else {
        throw PalmFailure.message("The fixture did not enable live input.")
      }

      var previous = initial
      var samples: [Double] = []
      for _ in 0..<10 {
        // Keep commands distinct, rather than coalescing a burst into a single observed frame.
        try await Task.sleep(nanoseconds: 100_000_000)
        let sent = ProcessInfo.processInfo.systemUptime
        connection.sendPointer(action: "click", x: 0.5, y: 0.5)
        previous = try await waitForMarker(
          connection, context: context, differentFrom: previous, timeout: 3)
        samples.append((ProcessInfo.processInfo.systemUptime - sent) * 1000)
      }
      let ordered = samples.sorted()
      let counters = connection.video.diagnostics
      let evidence: [String: Any] = [
        "fixture": "synthetic-only, loopback, iOS Simulator",
        "measurement": "sendPointer call to changed pixel returned by displayedPixelBuffer",
        "excludes":
          "physical touchscreen sampling, panel scanout, real app rendering and cellular/Tailscale paths",
        "firstDisplayedFrameMilliseconds": firstDisplayedMs,
        "inputToDisplayedPixelMilliseconds": samples,
        "medianMilliseconds": (ordered[(ordered.count - 1) / 2] + ordered[ordered.count / 2]) / 2,
        "p95Milliseconds": ordered[Int(ceil(Double(ordered.count) * 0.95)) - 1],
        "maximumMilliseconds": ordered.last ?? 0,
        "receivedPackets": counters.receivedPackets,
        "submittedFrames": counters.submittedFrames,
        "keyframeWaitDrops": counters.keyframeWaitDrops,
        "backpressureFlushes": counters.backpressureFlushes,
        "decoderResets": counters.decoderResets,
        "averageEnqueueWorkMilliseconds": counters.enqueueWorkMilliseconds
          / Double(max(1, counters.receivedPackets)),
        "maximumEnqueueWorkMilliseconds": counters.maximumEnqueueWorkMilliseconds,
      ]
      let data = try JSONSerialization.data(
        withJSONObject: evidence, options: [.prettyPrinted, .sortedKeys])
      let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
      attachment.name = "Synthetic pointer-to-displayed-pixel latency"
      attachment.lifetime = .keepAlways
      add(attachment)
      // A loose failure threshold catches seconds of hidden buffering without disguising
      // a good result on this local fixture as a physical-device performance guarantee.
      XCTAssertLessThan(
        try XCTUnwrap(ordered.last), 1500,
        "Inspect the numeric attachment: input accumulated over a second of video delay.")
      XCTAssertEqual(counters.decoderResets, 0)
      try await connection.disconnect()
    #endif
  }

  @available(iOS 17.4, *)
  @MainActor
  private func waitForMarker(
    _ connection: PalmConnection, context: CIContext,
    differentFrom previous: Bool?, timeout: TimeInterval
  ) async throws -> Bool {
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    while ProcessInfo.processInfo.systemUptime < deadline {
      if let pixel = connection.video.displayLayer.sampleBufferRenderer.displayedPixelBuffer() {
        let image = CIImage(cvPixelBuffer: pixel)
        var rgba = [UInt8](repeating: 0, count: 4)
        // The synthetic fixture owns a48px square at top-left encoded pixel(24,80).
        context.render(
          image, toBitmap: &rgba, rowBytes: 4,
          bounds: CGRect(x: 48, y: CVPixelBufferGetHeight(pixel) - 104, width: 1, height: 1),
          format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        let magenta = rgba[0] > 180 && rgba[1] < 80 && rgba[2] > 180
        let cyan = rgba[0] < 80 && rgba[1] > 180 && rgba[2] > 180
        if magenta || cyan, previous == nil || magenta != previous { return magenta }
      }
      try await Task.sleep(nanoseconds: 5_000_000)
    }
    throw PalmFailure.message("The isolated fixture did not display its changed latency marker.")
  }

  private func fixture<T: Decodable>(_ endpoint: PalmEndpoint, path: String, post: Bool = false)
    async throws -> T
  {
    var request = URLRequest(url: endpoint.url(path))
    request.setValue(endpoint.string, forHTTPHeaderField: "Origin")
    if post {
      request.httpMethod = "POST"
      request.httpBody = Data("{}".utf8)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await URLSession.shared.data(for: request)
    guard (response as? HTTPURLResponse)?.statusCode == 200 else {
      throw PalmFailure.message("The isolated latency host rejected setup.")
    }
    return try JSONDecoder().decode(T.self, from: data)
  }
}

private final class PalmLatencyCredentialStorage: PalmCredentialStorage {
  private var value: PalmCredential?
  func read() throws -> PalmCredential? { value }
  func save(_ credential: PalmCredential) throws { value = credential }
  func clear() throws { value = nil }
}
