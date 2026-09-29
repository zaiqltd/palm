import Foundation
import WebRTC

// A scripted phone for tests/media-rtc.test.mjs: prints its offer, reads the
// Mac's answer, then reports whether the call connected. It only receives, so
// no real microphone or speaker is used.
@main struct PalmCallPhone {
  static func main() async throws {
    let call = PalmCall(factory: PalmCall.factory(), sends: false, plays: false)
    try call.open()
    let offer = try await call.offer()
    let fmtpOK = offer.contains("maxaveragebitrate=64000") && offer.contains("useinbandfec=1")
    print(String(data: try JSONSerialization.data(withJSONObject: ["offer": offer, "opusParameters": fmtpOK]), encoding: .utf8)!)
    fflush(stdout)
    guard let line = readLine(), let data = line.data(using: .utf8),
      let answer = (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["sdp"] as? String
    else { throw PalmCallError("No answer") }
    try await call.accept(answer)
    for _ in 0..<100 where call.state != "connected" { try await Task.sleep(nanoseconds: 50_000_000) }
    // PALM_CALL_LISTEN=<seconds>: stay and count what arrives (live checks).
    if let seconds = Double(ProcessInfo.processInfo.environment["PALM_CALL_LISTEN"] ?? "") {
      try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
    let stats = await call.statistics()
    print(String(data: try JSONSerialization.data(withJSONObject: ["state": call.state, "path": stats["rtcPath"] ?? "",
      "packets": stats["rtcPacketsReceived"] ?? 0, "bytes": stats["rtcBytesReceived"] ?? 0,
      "lost": stats["rtcPacketsLost"] ?? 0, "jitterMs": stats["rtcJitterMs"] ?? 0, "rttMs": stats["rtcRttMs"] ?? 0]), encoding: .utf8)!)
    fflush(stdout)
    _ = readLine()  // stay on the call until the test hangs up
    call.close()
  }
}
