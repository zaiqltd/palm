import Foundation
import WebRTC

/// The Mac's end of the camera-and-mic call (see shared/PalmCall.swift). The
/// Mac microphone and speaker belong to WebRTC while it runs; the test Mac
/// only receives and never plays, so tests touch no real microphone or speaker.
@MainActor final class PalmRTC {
  private var call: PalmCall?
  private var last: [String: Any] = [:]
  var isRunning: Bool { call != nil }

  func answer(offer: String, synthetic: Bool) async throws -> String {
    stop()
    let call = PalmCall(factory: PalmCall.factory(), sends: !synthetic, plays: !synthetic)
    try call.open()
    self.call = call
    do { return try await call.answer(offer) }
    catch { stop(); throw error }
  }

  func stop() {
    if call != nil { last["rtcState"] = "ended" }
    call?.close()
    call = nil
  }

  func diagnostics() async -> [String: Any] {
    guard let call else { return last.isEmpty ? ["rtcState": "off"] : last }
    last = await call.statistics()
    return last
  }
}
