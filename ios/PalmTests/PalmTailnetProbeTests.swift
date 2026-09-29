import XCTest

@testable import Palm

/// Opt-in: runs the production connection and live-updates code from the
/// Simulator against the real private Tailscale address with a temporary
/// pairing supplied by the caller (and revoked by the caller afterwards).
/// It only reads status and opens the events socket: no screen, no input.
@MainActor
final class PalmTailnetProbeTests: XCTestCase {
  func testEventsSocketThroughPrivateAddress() async throws {
    let env = ProcessInfo.processInfo.environment
    guard let origin = env["PALM_PROBE_ORIGIN"], let token = env["PALM_PROBE_TOKEN"] else {
      throw XCTSkip("Set PALM_PROBE_ORIGIN and PALM_PROBE_TOKEN for the tailnet probe.")
    }
    let credential = PalmCredential(host: origin, token: token,
      expires: (Date().timeIntervalSince1970 + 3600) * 1000, deviceId: "probe")
    let connection = PalmConnection(credentialStorage: ProbeCredentials(credential))
    await connection.restore()
    XCTAssertTrue(connection.isPaired, "Probe credential was not accepted.")
    XCTAssertNotNil(connection.hostStatus, connection.errorMessage ?? "status failed")
    let events = PalmEvents(connection: connection)
    events.setActive(true)
    let started = Date()
    while !events.connected && Date().timeIntervalSince(started) < 20 {
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    let report: [String: Any] = [
      "connected": events.connected,
      "seconds": Date().timeIntervalSince(started),
      "lastError": events.lastError ?? "",
      "statusLoaded": connection.hostStatus != nil,
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
    attachment.name = "tailnet-events-probe"
    attachment.lifetime = .keepAlways
    add(attachment)
    XCTAssertTrue(events.connected, "Events socket did not connect: \(events.lastError ?? "no error text")")
    events.setActive(false)
  }
}

private final class ProbeCredentials: PalmCredentialStorage {
  private var credential: PalmCredential?
  init(_ credential: PalmCredential) { self.credential = credential }
  func read() throws -> PalmCredential? { credential }
  func save(_ credential: PalmCredential) throws { self.credential = credential }
  func clear() throws { credential = nil }
}
