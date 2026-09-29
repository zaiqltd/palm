import Foundation
import XCTest
@testable import Palm

final class PalmProtocolTests: XCTestCase {
  func testEndpointConfinementAndNormalization() throws {
    let endpoint = try PalmEndpoint(" HTTPS://example-mac.tail1234.ts.net:8443/ ")
    XCTAssertEqual(endpoint.string, "https://example-mac.tail1234.ts.net:8443")
    XCTAssertEqual(endpoint.socketURL.absoluteString, "wss://example-mac.tail1234.ts.net:8443/socket")
    XCTAssertEqual(endpoint.url("/api/files", query: [.init(name: "path", value: "A B/c.txt")]).host,
      "example-mac.tail1234.ts.net")
    for rejected in [
      "http://example-mac.tail1234.ts.net:8443", "https://evil.example",
      "https://example-mac.tail1234.ts.net.evil.example", "https://user:pass@example-mac.tail1234.ts.net",
      "https://example-mac.tail1234.ts.net/redirect", "https://example-mac.tail1234.ts.net?host=evil",
      "https://example-mac.tail1234.ts.net#pair=123", "http://127.0.0.1:4319",
      "https://.ts.net", "https://-bad.tail1234.ts.net", "https://bad..tail1234.ts.net",
    ] {
      XCTAssertThrowsError(try PalmEndpoint(rejected), rejected)
    }
    XCTAssertEqual(try PalmEndpoint("http://127.0.0.1:4319", allowLoopback: true).socketURL.scheme, "ws")
    XCTAssertThrowsError(try PalmEndpoint("http://192.168.1.2:4319", allowLoopback: true))
  }

  func testAVCCParameterSetsAndMalformedBounds() throws {
    let config = Data([1, 66, 0, 31, 255, 225, 0, 4, 103, 66, 0, 31, 1, 0, 2, 104, 1])
    let parsed = try PalmH264Configuration(avcC: config)
    XCTAssertEqual(parsed.nalLengthSize, 4)
    XCTAssertEqual(parsed.parameterSets, [Data([103, 66, 0, 31]), Data([104, 1])])
    for count in 0..<config.count {
      XCTAssertThrowsError(try PalmH264Configuration(avcC: config.prefix(count)))
    }
    var invalid = config
    invalid[4] = 254 // Three-byte NAL lengths are reserved.
    XCTAssertThrowsError(try PalmH264Configuration(avcC: invalid))
    invalid = config; invalid[8] = 104 // Wrong NAL type in SPS slot.
    XCTAssertThrowsError(try PalmH264Configuration(avcC: invalid))
  }

  func testFrameDecodesBigEndianTimestampAndRejectsTruncation() throws {
    let packet = frame(timestamp: 1_234_567.5, payload: [0, 0, 0, 3, 101, 1, 2])
    let decoded = try PalmVideoFrame(packet: packet, nalLengthSize: 4)
    XCTAssertTrue(decoded.isKey)
    XCTAssertEqual(decoded.timestampMicroseconds, 1_234_567.5)
    XCTAssertEqual(decoded.payload, Data([0, 0, 0, 3, 101, 1, 2]))
    for count in 0..<packet.count {
      XCTAssertThrowsError(try PalmVideoFrame(packet: packet.prefix(count), nalLengthSize: 4))
    }
    XCTAssertThrowsError(try PalmVideoFrame(packet: frame(timestamp: .nan, payload: [0, 0, 0, 1, 101]), nalLengthSize: 4))
    XCTAssertThrowsError(try PalmVideoFrame(packet: frame(timestamp: -1, payload: [0, 0, 0, 1, 101]), nalLengthSize: 4))
    XCTAssertThrowsError(try PalmVideoFrame(packet: frame(timestamp: 1, payload: [0, 0, 0, 0]), nalLengthSize: 4))
    XCTAssertThrowsError(try PalmVideoFrame(packet: frame(timestamp: 1, payload: [255, 255, 255, 255, 101]), nalLengthSize: 4))
    var flag = packet; flag[0] = 2
    XCTAssertThrowsError(try PalmVideoFrame(packet: flag, nalLengthSize: 4))
  }

  func testMultipleNALUnitsAndPermittedHeaderWidths() throws {
    for width in [1, 2, 4] {
      let prefix = Array(repeating: UInt8(0), count: width - 1) + [2]
      let payload = prefix + [101, 1] + prefix + [65, 2]
      XCTAssertNoThrow(try PalmVideoFrame(packet: frame(timestamp: 42, payload: payload), nalLengthSize: width))
    }
    XCTAssertThrowsError(try PalmVideoFrame(packet: frame(timestamp: 1, payload: [0, 0, 1, 101]), nalLengthSize: 3))
  }

  func testPhoneConfirmsFramesOnlyWhenTheMacAsks() throws {
    let older = try JSONDecoder().decode(
      PalmStreamStart.self, from: Data(#"{"width":1280,"height":800,"target":"Desktop"}"#.utf8))
    XCTAssertFalse(older.flow, "An older Mac would reject frame confirmations.")
    let flowing = try JSONDecoder().decode(
      PalmStreamStart.self, from: Data(#"{"width":1600,"height":1038,"target":"Desktop","flow":true}"#.utf8))
    XCTAssertTrue(flowing.flow)
    let odd = try JSONDecoder().decode(
      PalmStreamStart.self, from: Data(#"{"width":1600,"height":1038,"flow":"yes"}"#.utf8))
    XCTAssertFalse(odd.flow)
  }

  func testReconnectHasFiniteBudgetAndNoUnboundedLoop() {
    XCTAssertEqual((0..<6).compactMap(PalmReconnectPolicy.delay), [1, 2, 4, 8, 15, 15])
    XCTAssertNil(PalmReconnectPolicy.delay(attempt: -1))
    XCTAssertNil(PalmReconnectPolicy.delay(attempt: 6))
  }

  func testCredentialExpiryIsMilliseconds() {
    XCTAssertTrue(PalmCredential(host: "host", token: "token", expires: Date().timeIntervalSince1970 * 1000 + 60_000, deviceId: "id").isValid)
    XCTAssertFalse(PalmCredential(host: "host", token: "token", expires: Date().timeIntervalSince1970 * 1000 - 1, deviceId: "id").isValid)
  }

  func testPingUsesOpaqueNonceAndRejectsStaleOrReplayedReplies() {
    var tracker = PalmPingTracker()
    let nonce = tracker.issue(now: 100, nonce: "opaque-connection-a")
    XCTAssertEqual(nonce, "opaque-connection-a")
    XCTAssertEqual(tracker.receive(nonce: nonce, now: 100.125), 125)
    XCTAssertNil(tracker.receive(nonce: nonce, now: 100.25))
    let stale = tracker.issue(now: 100, nonce: "old")
    XCTAssertNil(tracker.receive(nonce: stale, now: 113))
    let previousConnection = tracker.issue(now: 120, nonce: "connection-a")
    tracker.reset()
    _ = tracker.issue(now: 121, nonce: "connection-b")
    XCTAssertNil(tracker.receive(nonce: previousConnection, now: 121.5))
    for index in 0..<100 { _ = tracker.issue(now: 122, nonce: "pending-\(index)") }
    XCTAssertLessThanOrEqual(tracker.outstandingCount, 12)
  }

  private func frame(timestamp: Double, payload: [UInt8]) -> Data {
    let bits = timestamp.bitPattern
    let bytes = (0..<8).map { UInt8((bits >> ((7 - $0) * 8)) & 255) }
    return Data([1] + bytes + payload)
  }
}
