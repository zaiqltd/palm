import Foundation
import WebRTC

/// Camera-and-mic sound as a WebRTC call between the phone and the Mac.
///
/// Earlier, raw 24 kHz PCM went over the same TCP
/// connection as everything else, so one late packet held up all the rest, and
/// neither end cancelled echo, so it had to be walkie-talkie. Now each end runs
/// Google's WebRTC audio engine: Opus at up to 64 kbit/s with in-band error
/// correction, straight UDP between the two devices (over Tailscale when away),
/// its adaptive jitter buffer and loss concealment, and echo cancellation, so
/// both microphones can stay open at once.
///
/// The phone makes the offer and the Mac answers; the SDP travels over Palm's
/// existing media socket. Candidates are gathered in full before the SDP is
/// sent (no STUN or TURN: both devices share the tailnet, and at home the LAN).
final class PalmCall: NSObject, RTCPeerConnectionDelegate, @unchecked Sendable {
  private static let setup: Void = { RTCInitializeSSL() }()
  private static var shared: RTCPeerConnectionFactory?
  private static let factoryLock = NSLock()

  /// One factory per process. `audioDevice` replaces the microphone and
  /// speaker (the phone's test tone); nil uses the real ones.
  #if os(iOS)
    static func factory(audioDevice: (any RTCAudioDevice)? = nil) -> RTCPeerConnectionFactory {
      make { RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: nil, audioDevice: audioDevice) }
    }
  #else
    static func factory() -> RTCPeerConnectionFactory {
      make { RTCPeerConnectionFactory(encoderFactory: nil, decoderFactory: nil) }
    }
  #endif
  private static func make(_ build: () -> RTCPeerConnectionFactory) -> RTCPeerConnectionFactory {
    factoryLock.lock(); defer { factoryLock.unlock() }
    if let shared { return shared }
    _ = setup
    let made = build()
    shared = made
    return made
  }

  private let factory: RTCPeerConnectionFactory
  private let sends: Bool
  private let plays: Bool
  private var connection: RTCPeerConnection?
  private var track: RTCAudioTrack?
  private let lock = NSLock()
  private var iceState = "new"
  /// Called on WebRTC's thread when the connection state changes.
  var onState: ((String) -> Void)?

  /// `sends` adds this device's microphone; `plays` lets the other side's
  /// sound out of the speaker (the test Mac neither records nor plays).
  init(factory: RTCPeerConnectionFactory, sends: Bool = true, plays: Bool = true) {
    self.factory = factory
    self.sends = sends
    self.plays = plays
  }

  var state: String { lock.lock(); defer { lock.unlock() }; return iceState }

  func open() throws {
    let config = RTCConfiguration()
    config.sdpSemantics = .unifiedPlan
    config.iceServers = []
    config.bundlePolicy = .maxBundle
    config.rtcpMuxPolicy = .require
    config.tcpCandidatePolicy = .disabled
    config.continualGatheringPolicy = .gatherOnce
    let none = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
    guard let connection = factory.peerConnection(with: config, constraints: none, delegate: self) else {
      throw PalmCallError("The audio call could not be set up.")
    }
    self.connection = connection
    if sends {
      let processing = RTCMediaConstraints(mandatoryConstraints: [
        "googEchoCancellation": "true", "googAutoGainControl": "true",
        "googNoiseSuppression": "true", "googHighpassFilter": "true",
      ], optionalConstraints: nil)
      let track = factory.audioTrack(with: factory.audioSource(with: processing), trackId: "palm-audio")
      connection.add(track, streamIds: ["palm"])
      self.track = track
    } else {
      let receiveOnly = RTCRtpTransceiverInit()
      receiveOnly.direction = .recvOnly
      connection.addTransceiver(of: .audio, init: receiveOnly)
    }
  }

  /// The phone's side: an offer with every candidate in it.
  func offer() async throws -> String {
    guard let connection else { throw PalmCallError("The audio call is closed.") }
    let offer = try await describe { connection.offer(for: Self.constraints, completionHandler: $0) }
    try await apply { connection.setLocalDescription(RTCSessionDescription(type: .offer, sdp: Self.opus(offer.sdp)), completionHandler: $0) }
    return try await gathered()
  }

  /// The Mac's side: answers the phone's offer.
  func answer(_ offer: String) async throws -> String {
    guard let connection else { throw PalmCallError("The audio call is closed.") }
    try await apply { connection.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: offer), completionHandler: $0) }
    let answer = try await describe { connection.answer(for: Self.constraints, completionHandler: $0) }
    try await apply { connection.setLocalDescription(RTCSessionDescription(type: .answer, sdp: Self.opus(answer.sdp)), completionHandler: $0) }
    return try await gathered()
  }

  /// The phone takes the Mac's answer.
  func accept(_ answer: String) async throws {
    guard let connection else { throw PalmCallError("The audio call is closed.") }
    try await apply { connection.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answer), completionHandler: $0) }
  }

  /// Mute without renegotiating (the phone's Talk button).
  var microphoneOn: Bool {
    get { track?.isEnabled ?? false }
    set { track?.isEnabled = newValue }
  }

  func close() {
    connection?.close()
    connection = nil
    track = nil
  }

  /// Counts and timings only: packets, loss, jitter, buffer, concealment,
  /// level, round trip and the path.
  func statistics() async -> [String: Any] {
    guard let connection else { return ["rtcState": "closed"] }
    let report: RTCStatisticsReport = await withCheckedContinuation { done in
      connection.statistics { done.resume(returning: $0) }
    }
    var result: [String: Any] = ["rtcState": state]
    let all = report.statistics
    func number(_ values: [String: NSObject], _ key: String) -> Double { (values[key] as? NSNumber)?.doubleValue ?? 0 }
    for stat in all.values {
      let v = stat.values
      switch stat.type {
      case "inbound-rtp" where (v["kind"] as? String) == "audio":
        result["rtcPacketsReceived"] = number(v, "packetsReceived")
        result["rtcPacketsLost"] = number(v, "packetsLost")
        result["rtcJitterMs"] = number(v, "jitter") * 1000
        let emitted = number(v, "jitterBufferEmittedCount")
        result["rtcBufferMs"] = emitted > 0 ? number(v, "jitterBufferDelay") / emitted * 1000 : 0
        let samples = number(v, "totalSamplesReceived")
        result["rtcConcealedPct"] = samples > 0 ? number(v, "concealedSamples") / samples * 100 : 0
        result["rtcAudioLevel"] = number(v, "audioLevel")
        result["rtcBytesReceived"] = number(v, "bytesReceived")
      case "outbound-rtp" where (v["kind"] as? String) == "audio":
        result["rtcPacketsSent"] = number(v, "packetsSent")
        result["rtcBytesSent"] = number(v, "bytesSent")
      case "candidate-pair" where (v["state"] as? String) == "succeeded" && (v["nominated"] as? NSNumber)?.boolValue == true:
        result["rtcRttMs"] = number(v, "currentRoundTripTime") * 1000
        if let remote = v["remoteCandidateId"] as? String, let candidate = all[remote]?.values,
          let address = candidate["address"] as? String ?? candidate["ip"] as? String {
          result["rtcPath"] = address.hasPrefix("100.") ? "tailscale" : "local network"
        }
      case "codec" where (v["mimeType"] as? String)?.lowercased() == "audio/opus":
        result["rtcCodec"] = "opus"
      default: break
      }
    }
    return result
  }

  // MARK: - Details

  private static let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)

  /// Asks the other side for up to 64 kbit/s Opus with in-band error
  /// correction (WebRTC's default is about half that, tuned for phone calls).
  static func opus(_ sdp: String) -> String {
    let lines = sdp.components(separatedBy: "\r\n")
    guard let map = lines.first(where: { $0.hasPrefix("a=rtpmap:") && $0.lowercased().contains(" opus/48000") }),
      let payload = map.dropFirst("a=rtpmap:".count).split(separator: " ").first
    else { return sdp }
    let prefix = "a=fmtp:\(payload) "
    return lines.map { line in
      guard line.hasPrefix(prefix) else { return line }
      var parameters = line.dropFirst(prefix.count).split(separator: ";").map(String.init)
        .filter { !$0.hasPrefix("maxaveragebitrate=") && !$0.hasPrefix("useinbandfec=") }
      parameters += ["maxaveragebitrate=64000", "useinbandfec=1"]
      return prefix + parameters.joined(separator: ";")
    }.joined(separator: "\r\n")
  }

  private func describe(_ start: (@escaping @Sendable (RTCSessionDescription?, Error?) -> Void) -> Void) async throws -> RTCSessionDescription {
    try await withCheckedThrowingContinuation { done in
      start { description, error in
        if let description { done.resume(returning: description) }
        else { done.resume(throwing: error ?? PalmCallError("The audio call could not be described.")) }
      }
    }
  }

  private func apply(_ start: (@escaping @Sendable (Error?) -> Void) -> Void) async throws {
    try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
      start { error in
        if let error { done.resume(throwing: error) } else { done.resume() }
      }
    }
  }

  /// Waits (at most 3 s) until every candidate is in the local description.
  private func gathered() async throws -> String {
    for _ in 0..<60 {
      if connection?.iceGatheringState == .complete { break }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    guard let sdp = connection?.localDescription?.sdp else { throw PalmCallError("The audio call is closed.") }
    return sdp
  }

  private func set(_ value: String) {
    lock.lock(); iceState = value; lock.unlock()
    onState?(value)
  }

  // MARK: - RTCPeerConnectionDelegate

  func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
  func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
    let names: [RTCIceConnectionState: String] = [
      .new: "new", .checking: "connecting", .connected: "connected", .completed: "connected",
      .failed: "failed", .disconnected: "interrupted", .closed: "closed",
    ]
    set(names[newState] ?? "new")
  }
  func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
  func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
    if !plays { rtpReceiver.track?.isEnabled = false }
  }
}

struct PalmCallError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}
