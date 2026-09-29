import AVFoundation
import SwiftUI
import WebRTC

/// Receiving video/audio never waits for a network send to finish. During a
/// burst a single cumulative acknowledgement covers the frames already read.
@MainActor private final class PalmMediaAcks {
  private var pending: UInt32?
  private var worker: Task<Void, Never>?
  private var generation = UUID()
  func send(_ sequence: UInt32, op: String, socket: URLSessionWebSocketTask,
    failed: @escaping (Error) -> Void) {
    pending = max(pending ?? 0, sequence)
    guard worker == nil else { return }
    let ticket = generation
    worker = Task { [weak self] in
      guard let self else { return }
      defer { if self.generation == ticket { self.worker = nil } }
      while self.generation == ticket, let sequence = self.pending {
        self.pending = nil
        do { try await socket.send(.string("{\"op\":\"\(op)\",\"sequence\":\(sequence)}")) }
        catch { if self.generation == ticket { failed(error) }; return }
      }
    }
  }
  func cancel() { generation = UUID(); pending = nil; worker?.cancel(); worker = nil }
}

@MainActor
private final class PalmMediaSession: ObservableObject {
  @Published var state = "Ready"
  @Published var detail = ""
  @Published var active = false
  @Published var cameraReceiving = false
  @Published var microphoneReceiving = false
  @Published var talking = false
  @Published var talkState = "Off"
  @Published var error: String?
  @Published var videoSize = CGSize(width: 16, height: 9)
  @Published var audioReady = false
  @Published var phoneVolume: Float = 1
  let video = PalmVideoRenderer()
  private let audio = PalmPCMPlayer()
  private weak var connection: PalmConnection?
  private var socket: URLSessionWebSocketTask?
  private var audioSocket: URLSessionWebSocketTask?
  private var receiver: Task<Void, Never>?
  private var audioReceiver: Task<Void, Never>?
  private var heartbeat: Task<Void, Never>?
  private let videoAcks = PalmMediaAcks()
  private let audioAcks = PalmMediaAcks()
  private var generation = UUID()
  private var talkGeneration = UUID()
  private var talkCapture: PalmTalkCapture?
  private var talkPending = Set<UInt32>()
  private var talkSequence: UInt32 = 0
  private var lastCameraPacket = 0.0
  private var lastMicrophonePacket = 0.0
  private var videoFrames = 0
  private var audioPackets = 0
  private var talkPackets = 0
  private var talkDropped = 0
  private var renderedBefore = 0.0
  private var nonzeroBefore = 0.0
  private var peakBefore = 0.0
  private var startedAt = 0.0
  // The sound as a WebRTC call (a Mac on host 44+): both microphones open at
  // once with echo cancellation; Talk to Mac mutes and unmutes this phone.
  private var call: PalmCall?
  private var usesCall = false
  private var callPacketsBefore = 0.0
  private var callStats: [String: Any] = [:]

  init() {
    video.onNeedsKeyframe = { [weak self] in self?.sendControl(["op": "keyframe"]) }
    video.onFrame = { [weak self] in
      guard let self else { return }
      self.videoFrames += 1
      self.lastCameraPacket = ProcessInfo.processInfo.systemUptime
    }
  }

  private func sendControl(_ object: [String: Any]) {
    guard let socket, let data = try? JSONSerialization.data(withJSONObject: object),
      let text = String(data: data, encoding: .utf8) else { return }
    let ticket = generation
    Task { [weak self] in
      do { try await socket.send(.string(text)) }
      catch { if self?.generation == ticket { self?.fail("The Mac connection stopped. Tap Turn on to reconnect.") } }
    }
  }

  func start(_ connection: PalmConnection) {
    stop()
    self.connection = connection
    do {
      let socket = try connection.mediaSocket()
      self.socket = socket
      state = "Connecting"; error = nil
      startedAt = ProcessInfo.processInfo.systemUptime
      let ticket = generation
      socket.resume()
      receiver = Task { [weak self] in await self?.receiveVideo(socket, ticket: ticket) }
      heartbeat = Task { [weak self] in
        var tick = 0
        while !Task.isCancelled {
          try? await Task.sleep(nanoseconds: 1_000_000_000)
          guard !Task.isCancelled, let self, self.generation == ticket else { return }
          tick += 1
          let now = ProcessInfo.processInfo.systemUptime
          if now - self.startedAt > 15 && (!self.active || !self.audioReady) {
            self.fail("The media connection did not finish opening. Tap Turn on to retry.")
            return
          }
          self.cameraReceiving = self.video.isReadyForDisplay && now - self.lastCameraPacket < 3
          if let call = self.call {
            let stats = await call.statistics()
            guard self.generation == ticket else { return }
            self.callStats = stats
            let packets = stats["rtcPacketsReceived"] as? Double ?? 0
            self.microphoneReceiving = stats["rtcState"] as? String == "connected" && packets > self.callPacketsBefore
            self.callPacketsBefore = packets
            if stats["rtcState"] as? String == "connected" { self.audioReady = true }
            if stats["rtcState"] as? String == "failed" {
              self.fail("The audio call could not connect to the Mac. Tap Turn on to retry."); return
            }
          } else {
            self.microphoneReceiving = self.audioPackets > 0 && now - self.lastMicrophonePacket < 3
          }
          self.phoneVolume = AVAudioSession.sharedInstance().outputVolume
          self.sendStats()
          if let failure = self.talkCapture?.diagnostics.error {
            self.stopTalking(); self.error = failure
          }
          if tick % 5 == 0 {
            self.sendControl(["op": "ping"])
            try? await self.audioSocket?.send(.string("{\"op\":\"ping\"}"))
          }
        }
      }
    } catch { fail(connection.friendlyMessage(error)) }
  }

  private func beginPlayback() throws {
    pausePlayback()
    if !PalmTalkCapture.synthetic {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playback, mode: .default, options: [])
      try session.setPreferredIOBufferDuration(0.01)
      try session.setActive(true)
    }
    try audio.start(manual: PalmTalkCapture.synthetic)
  }
  private func pausePlayback() {
    if audio.isRunning {
      let stats = audio.diagnostics
      renderedBefore += stats["renderedFrames", default: 0]
      nonzeroBefore += stats["nonzeroRenderedFrames", default: 0]
      peakBefore = max(peakBefore, stats["peak", default: 0])
    }
    audio.stop()
  }
  private func sendStats() {
    let stats = audio.isRunning ? audio.diagnostics : [:]
    let mic = talkCapture?.diagnostics
    var report: [String: Any] = ["op": "stats", "videoFrames": videoFrames,
      "videoFps": Double(videoFrames) / max(1, ProcessInfo.processInfo.systemUptime - startedAt),
      "audioPackets": audioPackets,
      "audioRenderedFrames": renderedBefore + stats["renderedFrames", default: 0],
      "audioNonzeroFrames": nonzeroBefore + stats["nonzeroRenderedFrames", default: 0],
      "audioPeak": max(peakBefore, stats["peak", default: 0]),
      "audioQueuedMs": stats["queuedMs", default: 0], "outputVolume": Double(phoneVolume),
      "talkPackets": talkPackets, "talkDropped": talkDropped,
      "phoneMicFrames": mic?.frames ?? 0, "phoneMicPeak": Double(mic?.peak ?? 0)]
    for (key, value) in callStats { if let number = value as? Double { report[key] = number } }
    if call != nil { report["rtcConnected"] = callStats["rtcState"] as? String == "connected" ? 1 : 0 }
    if PalmTalkCapture.synthetic && usesCall { report["audioPeak"] = Double(PalmToneAudioDevice.shared.playedPeak) }
    sendControl(report)
  }

  func startTalking() async {
    guard active, audioReady, talkState == "Off" else { return }
    if let call {
      call.microphoneOn = true
      talking = true; talkState = "On"
      return
    }
    let ticket = generation
    talkState = "Connecting"; error = nil
    guard await PalmTalkCapture.microphoneAllowed() else {
      talkState = "Off"
      error = "Allow the microphone for Palm in iPhone Settings to talk to your Mac."
      return
    }
    guard generation == ticket, active, talkState == "Connecting" else { return }
    pausePlayback()
    sendControl(["op": "talk.start"])
  }
  func stopTalking() {
    if let call {
      call.microphoneOn = false
      talking = false; talkState = "Off"
      return
    }
    talkGeneration = UUID()
    talkCapture?.stop(); talkCapture = nil
    talking = false; talkState = "Stopping"
    talkPending.removeAll()
    sendControl(["op": "talk.stop"])
  }
  private func sendTalk(_ data: Data, ticket: UUID) {
    guard talking, talkGeneration == ticket, let socket = audioSocket else { return }
    guard talkPending.count < 12 else { talkDropped += 1; return }
    talkSequence &+= 1
    let sequence = talkSequence
    talkPending.insert(sequence)
    var packet = Data([4])
    var big = sequence.bigEndian
    withUnsafeBytes(of: &big) { packet.append(contentsOf: $0) }
    packet.append(data)
    talkPackets += 1
    let connectionTicket = generation
    Task { [weak self] in
      do { try await socket.send(.data(packet)) }
      catch { if self?.generation == connectionTicket { self?.fail("Audio connection stopped. Tap Turn on to reconnect.") } }
    }
  }

  func stop() {
    generation = UUID(); talkGeneration = UUID()
    receiver?.cancel(); receiver = nil
    audioReceiver?.cancel(); audioReceiver = nil
    heartbeat?.cancel(); heartbeat = nil
    videoAcks.cancel(); audioAcks.cancel()
    socket?.cancel(with: .normalClosure, reason: nil); socket = nil
    audioSocket?.cancel(with: .normalClosure, reason: nil); audioSocket = nil
    talkCapture?.stop(); talkCapture = nil
    call?.close(); call = nil; usesCall = false; callStats = [:]; callPacketsBefore = 0
    audio.stop(); video.reset()
    if !PalmTalkCapture.synthetic { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    active = false; audioReady = false; talking = false
    cameraReceiving = false; microphoneReceiving = false
    lastCameraPacket = 0; lastMicrophonePacket = 0
    videoFrames = 0; audioPackets = 0; talkPackets = 0; talkDropped = 0
    renderedBefore = 0; nonzeroBefore = 0; peakBefore = 0
    talkPending.removeAll()
    state = "Ready"; talkState = "Off"; detail = ""
  }
  private func fail(_ message: String) { stop(); error = message }

  private func receiveVideo(_ socket: URLSessionWebSocketTask, ticket: UUID) async {
    do {
      while !Task.isCancelled && generation == ticket {
        let message = try await socket.receive()
        guard generation == ticket else { return }
        switch message {
        case .string(let text):
          guard let data = text.data(using: .utf8),
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let event = object["event"] as? String else { continue }
          switch event {
          case "connected":
            guard object["protocolVersion"] as? Int == 2 else { throw PalmAudioError(message: "Update Palm on your Mac to use camera and audio.") }
            let rtc = object["rtc"] as? Bool == true
            try await socket.send(.string("{\"op\":\"start\",\"protocolVersion\":2\(rtc ? ",\"rtc\":true" : "")}"))
            state = "Starting"
          case "media.started":
            guard let id = object["mediaSession"] as? String, let connection else { throw PalmFailure.disconnected }
            active = true; state = "Live"
            detail = "\(object["camera"] as? String ?? "Camera") · \(object["microphone"] as? String ?? "Microphone")"
            if object["rtc"] as? Bool == true {
              usesCall = true
              try await startCall(ticket: ticket)
              break
            }
            let audioSocket = try connection.mediaSocket(audioSession: id)
            self.audioSocket = audioSocket
            audioSocket.resume()
            audioReceiver = Task { [weak self] in await self?.receiveAudio(audioSocket, ticket: ticket) }
          case "media.videoConfig":
            try video.configure(JSONDecoder().decode(PalmVideoConfiguration.self, from: data))
            if let width = object["width"] as? Int, let height = object["height"] as? Int {
              videoSize = CGSize(width: width, height: height)
            }
          case "media.talkStarted":
            guard talkState == "Connecting" else { sendControl(["op": "talk.stop"]); break }
            let talkTicket = UUID(); talkGeneration = talkTicket
            let capture = PalmTalkCapture { [weak self] packet in
              Task { @MainActor [weak self] in self?.sendTalk(packet, ticket: talkTicket) }
            }
            do { try capture.start(); talkCapture = capture; talking = true }
            catch { capture.stop(); stopTalking(); self.error = error.localizedDescription }
          case "media.talkStopped", "media.talkError":
            talkGeneration = UUID(); talkCapture?.stop(); talkCapture = nil
            talking = false; talkState = "Off"; talkPending.removeAll()
            try beginPlayback()
            if event == "media.talkError" { error = object["message"] as? String ?? "Talk to Mac stopped." }
          case "rtc.answer":
            guard let call, let sdp = object["sdp"] as? String else { break }
            try await call.accept(sdp)
          case "rtc.error":
            fail(object["message"] as? String ?? "The Mac could not answer the audio call."); return
          case "media.error": fail(object["message"] as? String ?? "Media capture stopped."); return
          case "media.stopped": stop(); return
          default: break
          }
        case .data(let packet):
          guard active, packet.count > 14, packet[0] == 2 else { continue }
          let sequence = packet.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 1, as: UInt32.self).bigEndian }
          try video.enqueue(Data(packet.dropFirst(5)))
          videoAcks.send(sequence, op: "video.ack", socket: socket) { [weak self] error in
            self?.fail("Video connection stopped: \(error.localizedDescription)")
          }
        @unknown default: break
        }
      }
    } catch { if generation == ticket { fail(error.localizedDescription) } }
  }

  /// Offers the Mac a WebRTC call for the sound. Real calls use iOS's voice
  /// chat audio (echo cancellation, loudspeaker); UI tests use a test tone.
  private func startCall(ticket: UUID) async throws {
    let factory: RTCPeerConnectionFactory
    if PalmTalkCapture.synthetic {
      factory = PalmCall.factory(audioDevice: PalmToneAudioDevice.shared)
    } else {
      guard await PalmTalkCapture.microphoneAllowed() else {
        throw PalmAudioError(message: "Allow the microphone for Palm in iPhone Settings to use camera and mic.")
      }
      let config = RTCAudioSessionConfiguration.webRTC()
      config.category = AVAudioSession.Category.playAndRecord.rawValue
      config.mode = AVAudioSession.Mode.voiceChat.rawValue
      config.categoryOptions = [.defaultToSpeaker, .allowBluetoothHFP]
      RTCAudioSessionConfiguration.setWebRTC(config)
      factory = PalmCall.factory()
    }
    guard generation == ticket else { return }
    let call = PalmCall(factory: factory)
    try call.open()
    call.microphoneOn = false
    self.call = call
    let offer = try await call.offer()
    guard generation == ticket, self.call === call else { return }
    sendControl(["op": "rtc.offer", "sdp": offer])
  }

  private func receiveAudio(_ socket: URLSessionWebSocketTask, ticket: UUID) async {
    do {
      while !Task.isCancelled && generation == ticket {
        let message = try await socket.receive()
        guard generation == ticket else { return }
        switch message {
        case .string(let text):
          guard let data = text.data(using: .utf8),
            let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
            let event = object["event"] as? String else { continue }
          if event == "audio.connected" {
            try beginPlayback(); audioReady = true
          } else if event == "talk.ack", let sequence = object["sequence"] as? UInt32 {
            talkPending = talkPending.filter { $0 > sequence }
            if talking, object["accepted"] as? Bool == true { talkState = "On" }
          }
        case .data(let packet):
          guard packet.count == PalmAudioWire.bytes + 5, packet[0] == 3 else { throw PalmAudioError(message: "Invalid Mac audio packet.") }
          let sequence = packet.withUnsafeBytes { $0.loadUnaligned(fromByteOffset: 1, as: UInt32.self).bigEndian }
          lastMicrophonePacket = ProcessInfo.processInfo.systemUptime
          audioPackets += 1
          if talkState == "Off", audio.isRunning { try audio.enqueue(Data(packet.dropFirst(5))) }
          audioAcks.send(sequence, op: "ack", socket: socket) { [weak self] error in
            self?.fail("Audio connection stopped: \(error.localizedDescription)")
          }
        @unknown default: break
        }
      }
    } catch { if generation == ticket { fail("Audio connection stopped: \(error.localizedDescription)") } }
  }
}

private final class PalmCameraHost: UIView {
  weak var videoLayer: AVSampleBufferDisplayLayer?
  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin(); CATransaction.setDisableActions(true)
    videoLayer?.frame = bounds
    CATransaction.commit()
  }
}
private struct PalmCameraSurface: UIViewRepresentable {
  let renderer: PalmVideoRenderer
  func makeUIView(context: Context) -> PalmCameraHost {
    let view = PalmCameraHost()
    view.backgroundColor = .black
    view.videoLayer = renderer.displayLayer
    view.layer.addSublayer(renderer.displayLayer)
    return view
  }
  func updateUIView(_ view: PalmCameraHost, context: Context) { view.setNeedsLayout() }
}

struct PalmMediaView: View {
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject var connection: PalmConnection
  @StateObject private var media = PalmMediaSession()

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        ZStack {
          Color.black
          PalmCameraSurface(renderer: media.video)
          if !media.cameraReceiving {
            VStack(spacing: 8) {
              Image(systemName: "camera").font(.title).foregroundStyle(PalmStyle.muted)
              Text(media.active ? "Waiting for camera" : "Camera is off")
                .foregroundStyle(PalmStyle.muted)
            }
          }
        }
        .aspectRatio(media.videoSize, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(media.cameraReceiving ? "Camera picture" : "Camera is off")
        .accessibilityIdentifier("media.picture")

        VStack(spacing: 10) {
          statusRow("Camera", symbol: "camera", receiving: media.cameraReceiving,
            identifier: "media.cameraStatus")
          Divider()
          statusRow("Microphone", symbol: "mic", receiving: media.microphoneReceiving,
            identifier: "media.microphoneStatus")
          Divider()
          HStack {
            Label("Phone microphone to Mac", systemImage: "waveform")
            Spacer()
            Text(media.talkState)
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(media.talking ? .red : PalmStyle.muted)
              .accessibilityIdentifier("media.talkStatus")
          }
        }

        HStack {
          if media.active && media.audioReady {
            Button(media.talking ? "Stop talking" : media.talkState == "Connecting" ? "Cancel talk" : "Talk to Mac") {
              if media.talkState == "Off" { Task { await media.startTalking() } }
              else { media.stopTalking() }
            }
            .buttonStyle(.bordered)
            .accessibilityIdentifier("media.talk")
          }
          Spacer(minLength: 8)
          if media.active {
            Button("Turn off") { media.stop() }
              .buttonStyle(.bordered)
              .accessibilityIdentifier("media.stop")
          } else if media.state == "Connecting" || media.state == "Starting" {
            Button("Cancel") { media.stop() }
              .buttonStyle(.bordered)
              .accessibilityIdentifier("media.cancel")
          } else {
            Button("Turn on") { media.start(connection) }
              .buttonStyle(.borderedProminent)
              .tint(PalmStyle.accent)
              .foregroundStyle(PalmStyle.onAccent)
              .disabled(media.state == "Connecting" || media.state == "Starting")
              .accessibilityIdentifier("media.start")
          }
        }
        if media.state == "Connecting" || media.state == "Starting" {
          Text("Connecting to Mac").font(.caption).foregroundStyle(PalmStyle.muted)
        }
        if media.active && media.phoneVolume < 0.05 { Text("Raise your iPhone volume to hear the Mac.").foregroundStyle(.orange) }
        if !media.detail.isEmpty { Text(media.detail).font(.caption).foregroundStyle(PalmStyle.muted) }
        if let error = media.error { Text(error).foregroundStyle(.orange) }
        Text("Camera and microphone stay off until you turn them on here. Talk to Mac turns on your iPhone microphone to the Mac's current audio output; you keep hearing the Mac. Leaving this view turns everything off.")
          .font(.footnote).foregroundStyle(PalmStyle.muted)
      }
      .padding(16)
    }
    .background(PalmStyle.background)
    .navigationTitle("Camera and mic")
    .navigationBarTitleDisplayMode(.inline)
    .onDisappear { media.stop() }
    .onChange(of: scenePhase) { _, phase in if phase == .background { media.stop() } }
    .onChange(of: connection.deviceEpoch) { _, _ in media.stop() }
  }

  private func statusRow(_ title: String, symbol: String, receiving: Bool,
    identifier: String) -> some View {
    HStack {
      Label(title, systemImage: symbol)
      Spacer()
      Text(receiving ? "On" : media.active ? "Waiting" : "Off")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(receiving ? .red : PalmStyle.muted)
        .accessibilityIdentifier(identifier)
    }
  }
}
