import AVFoundation
import SwiftUI
import UIKit

// Voice everywhere there is a keyboard ("a transcription
// button running off openrouter ... speak to it and it does things and can
// speak back", and on the screen "voice + polish"). The phone records; the
// Mac sends the audio to OpenRouter with the key it keeps and returns the
// words, polished when asked, or a spoken reply. Nothing is kept on either
// side, and dictation never presses Return.

/// One microphone for the whole app: whoever started a recording gets its
/// words; starting another stops the first, and speaking stops for it.
@MainActor
final class PalmVoice: ObservableObject {
  static let shared = PalmVoice()

  enum Phase: Equatable { case idle, recording, transcribing, polishing, speaking }

  @Published private(set) var phase = Phase.idle
  @Published private(set) var level = 0.0
  @Published private(set) var elapsed: TimeInterval = 0
  /// Which part of the app is listening: "assistant", "task", "screen", "terminal".
  @Published private(set) var owner: String?
  @Published var error: String?

  nonisolated static let maximumSeconds: TimeInterval = 300
  private var recorder: PalmVoiceRecording?
  private var meter: Task<Void, Never>?
  private var speech: Task<Void, Never>?
  private let player = PalmSpeechPlayer()
  /// Changes on every start and cancel, so late results are dropped.
  private var generation = 0

  /// The test host has no microphone to offer: record silence instead.
  static var synthetic: Bool { ProcessInfo.processInfo.environment["PALM_UITEST_HOST"] != nil }

  func isActive(for owner: String) -> Bool {
    self.owner == owner && [.recording, .transcribing, .polishing].contains(phase)
  }

  /// Starts listening for `owner`. Returns false (with `error` set) when the
  /// microphone is not available.
  @discardableResult
  func start(for owner: String) async -> Bool {
    stopSpeaking()
    cancel()
    error = nil
    guard await Self.microphoneAllowed() else {
      error = "Allow the microphone for Palm in Settings › Privacy & Security › Microphone."
      return false
    }
    do {
      try Self.activate(recording: true)
      let recorder: PalmVoiceRecording = Self.synthetic ? PalmSilentRecorder() : PalmMicRecorder()
      try recorder.start()
      self.recorder = recorder
      self.owner = owner
      level = 0
      elapsed = 0
      phase = .recording
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
      let current = generation
      meter = Task { [weak self] in
        while !Task.isCancelled {
          guard let self, self.generation == current, self.phase == .recording else { return }
          self.level = recorder.level
          self.elapsed = recorder.elapsed
          try? await Task.sleep(nanoseconds: 50_000_000)
        }
      }
      return true
    } catch {
      Self.deactivate()
      self.error = "The microphone did not start. Try again."
      return false
    }
  }

  /// Stops listening and returns the words (polished when asked), or nil when
  /// cancelled or nothing came back.
  func finish(_ connection: PalmConnection, polish: Bool) async -> String? {
    guard phase == .recording, let recorder else { return nil }
    meter?.cancel()
    self.recorder = nil
    let audio: Data
    do { audio = try recorder.finish() } catch {
      Self.deactivate()
      phase = .idle
      owner = nil
      self.error = "The recording could not be read. Try again."
      return nil
    }
    Self.deactivate()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    phase = polish ? .polishing : .transcribing
    let current = generation
    struct Heard: Decodable { let text: String }
    do {
      let heard: Heard = try await connection.post("/api/voice/transcribe", [
        "audio": audio.base64EncodedString(), "format": "wav", "polish": polish,
      ])
      guard generation == current else { return nil }
      phase = .idle
      owner = nil
      return heard.text
    } catch {
      guard generation == current else { return nil }
      phase = .idle
      owner = nil
      self.error = connection.friendlyMessage(error)
      return nil
    }
  }

  /// Drops the recording, or the words still on their way.
  func cancel() {
    generation += 1
    meter?.cancel()
    meter = nil
    if let recorder {
      recorder.cancel()
      self.recorder = nil
      Self.deactivate()
    }
    if phase != .speaking { phase = .idle }
    owner = nil
  }

  /// Reads a reply aloud as it arrives from the Mac.
  func speak(_ text: String, connection: PalmConnection) {
    let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !words.isEmpty, phase == .idle else { return }
    stopSpeaking()
    phase = .speaking
    let player = self.player
    speech = Task { [weak self] in
      do {
        var request = try connection.authorizedRequest("/api/voice/speak", method: "POST")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": words])
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 30
        let (bytes, response) = try await connection.transferSession.bytes(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
          var data = Data()
          for try await byte in bytes { data.append(byte); if data.count > 8192 { break } }
          try connection.validate(response, data: data)
        }
        let rate = Double((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "X-Audio-Sample-Rate") ?? "") ?? 24000
        if Self.synthetic {
          // The test Mac has no sound: take as long as the reply would.
          var count = 0
          for try await _ in bytes { count += 1 }
          try await Task.sleep(nanoseconds: UInt64(Double(count) / 2 / rate * 1_000_000_000))
        } else {
          try Self.activate(recording: false)
          try await player.play(bytes, sampleRate: rate)
        }
      } catch is CancellationError {
      } catch {
        if !Task.isCancelled { self?.error = connection.friendlyMessage(error) }
      }
      guard let self, !Task.isCancelled else { return }
      if self.phase == .speaking { self.phase = .idle }
      Self.deactivate()
    }
  }

  func stopSpeaking() {
    speech?.cancel()
    speech = nil
    player.stop()
    if phase == .speaking {
      phase = .idle
      Self.deactivate()
    }
  }

  // MARK: Audio session

  private static func microphoneAllowed() async -> Bool {
    if synthetic { return true }
    switch AVAudioApplication.shared.recordPermission {
    case .granted: return true
    case .denied: return false
    default: return await AVAudioApplication.requestRecordPermission()
    }
  }

  private static func activate(recording: Bool) throws {
    guard !synthetic else { return }
    let session = AVAudioSession.sharedInstance()
    if recording {
      try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
    } else {
      try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
    }
    try session.setActive(true)
  }

  private static func deactivate() {
    guard !synthetic else { return }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

// MARK: - Recording

protocol PalmVoiceRecording: AnyObject {
  func start() throws
  func finish() throws -> Data
  func cancel()
  var level: Double { get }
  var elapsed: TimeInterval { get }
}

/// 16 kHz mono 16-bit WAV, the format MAI-Transcribe takes.
/// The file lives in the app's temporary folder only while recording.
final class PalmMicRecorder: PalmVoiceRecording {
  private var recorder: AVAudioRecorder?
  private var url: URL?

  func start() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("palm-voice", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let file = folder.appendingPathComponent(UUID().uuidString + ".wav")
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
      AVLinearPCMBitDepthKey: 16, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsFloatKey: false,
    ]
    let recorder = try AVAudioRecorder(url: file, settings: settings)
    recorder.isMeteringEnabled = true
    url = file
    guard recorder.prepareToRecord(), recorder.record(forDuration: PalmVoice.maximumSeconds) else {
      discard()
      throw PalmFailure.message("The microphone did not start.")
    }
    self.recorder = recorder
  }

  var level: Double {
    guard let recorder else { return 0 }
    recorder.updateMeters()
    return max(0, min(1, Double((recorder.averagePower(forChannel: 0) + 55) / 55)))
  }

  var elapsed: TimeInterval { recorder?.currentTime ?? 0 }

  func finish() throws -> Data {
    recorder?.stop()
    recorder = nil
    defer { discard() }
    guard let url else { throw PalmFailure.message("There is no recording.") }
    return try Data(contentsOf: url)
  }

  func cancel() {
    recorder?.stop()
    recorder = nil
    discard()
  }

  private func discard() {
    if let url { try? FileManager.default.removeItem(at: url) }
    url = nil
  }

  deinit { cancel() }
}

/// Half a second of silence, for the Simulator tests.
final class PalmSilentRecorder: PalmVoiceRecording {
  private var started: Date?
  func start() throws { started = Date() }
  var level: Double { 0.3 }
  var elapsed: TimeInterval { started.map { Date().timeIntervalSince($0) } ?? 0 }
  func cancel() { started = nil }
  func finish() throws -> Data {
    started = nil
    let samples = 8000
    var data = Data()
    func append<T>(_ value: T) { withUnsafeBytes(of: value) { data.append(contentsOf: $0) } }
    data.append(contentsOf: Array("RIFF".utf8)); append(UInt32(36 + samples * 2).littleEndian)
    data.append(contentsOf: Array("WAVEfmt ".utf8)); append(UInt32(16).littleEndian); append(UInt16(1).littleEndian)
    append(UInt16(1).littleEndian); append(UInt32(16000).littleEndian); append(UInt32(32000).littleEndian)
    append(UInt16(2).littleEndian); append(UInt16(16).littleEndian)
    data.append(contentsOf: Array("data".utf8)); append(UInt32(samples * 2).littleEndian)
    data.append(Data(count: samples * 2))
    return data
  }
}

// MARK: - Speaking

/// Plays 16-bit little-endian mono PCM as it streams in, a fifth of a second
/// at a time, and returns when the last of it has been heard.
final class PalmSpeechPlayer: @unchecked Sendable {
  private let lock = NSLock()
  private var engine: AVAudioEngine?
  private var node: AVAudioPlayerNode?

  func play(_ bytes: URLSession.AsyncBytes, sampleRate: Double) async throws {
    stop()
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)
    else { throw PalmFailure.message("The spoken reply could not be played.") }
    let engine = AVAudioEngine()
    let node = AVAudioPlayerNode()
    engine.attach(node)
    engine.connect(node, to: engine.mainMixerNode, format: format)
    try engine.start()
    node.play()
    lock.withLock {
      self.engine = engine
      self.node = node
    }
    let chunk = max(2, Int(sampleRate) / 5 * 2)
    var pending = [UInt8]()
    pending.reserveCapacity(chunk)
    var last: AVAudioPCMBuffer?
    for try await byte in bytes {
      try Task.checkCancellation()
      pending.append(byte)
      if pending.count >= chunk {
        if let buffer = Self.buffer(pending, format: format) { node.scheduleBuffer(buffer, completionHandler: nil); last = buffer }
        pending.removeAll(keepingCapacity: true)
      }
    }
    if pending.count >= 2, let buffer = Self.buffer(Array(pending.prefix(pending.count - pending.count % 2)), format: format) {
      node.scheduleBuffer(buffer, completionHandler: nil)
      last = buffer
    }
    guard last != nil else { return stop() }
    // A silent tail marks the end: its completion means everything was heard.
    let tail = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 240)!
    tail.frameLength = 240
    await withTaskCancellationHandler {
      await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
        node.scheduleBuffer(tail, completionCallbackType: .dataPlayedBack) { _ in done.resume() }
      }
    } onCancel: { [weak self] in self?.stop() }
    stop()
  }

  func stop() {
    let (engine, node) = lock.withLock { () -> (AVAudioEngine?, AVAudioPlayerNode?) in
      defer {
        self.engine = nil
        self.node = nil
      }
      return (self.engine, self.node)
    }
    node?.stop()
    engine?.stop()
  }

  private static func buffer(_ bytes: [UInt8], format: AVAudioFormat) -> AVAudioPCMBuffer? {
    let frames = bytes.count / 2
    guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
      let channel = buffer.floatChannelData?[0]
    else { return nil }
    for index in 0..<frames {
      let bits = UInt16(bytes[index * 2]) | UInt16(bytes[index * 2 + 1]) << 8
      channel[index] = Float(Int16(bitPattern: bits)) / 32768
    }
    buffer.frameLength = AVAudioFrameCount(frames)
    return buffer
  }
}

// MARK: - Controls

/// The microphone button: one tap starts listening.
struct PalmMicButton: View {
  let owner: String
  var size: CGFloat = 40
  var label = "Speak"
  var id: String?
  @ObservedObject private var voice = PalmVoice.shared

  var body: some View {
    Button { Task { await voice.start(for: owner) } } label: {
      Image(systemName: "mic.fill").font(.system(size: size * 0.42, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: size, height: size)
        .background(PalmStyle.raised, in: Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
    .accessibilityIdentifier(id ?? "\(owner).mic")
  }
}

/// Shown while listening: cancel, the level and time, then Polish (tidy the
/// words first) or Done (use them as said). While the Mac works on the words
/// it says which step it is on.
struct PalmVoicePill: View {
  /// Over the Mac picture the pill uses the dark glass of the screen controls.
  var overVideo = false
  let finish: (_ polish: Bool) -> Void
  @ObservedObject private var voice = PalmVoice.shared

  var body: some View {
    HStack(spacing: 10) {
      Button { voice.cancel() } label: {
        Image(systemName: "xmark").font(.body.weight(.semibold)).foregroundStyle(.white)
          .frame(width: 40, height: 40).background(Color.white.opacity(0.12), in: Circle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Cancel")
      .accessibilityIdentifier("voice.cancel")
      if voice.phase == .recording {
        PalmLevelBars(level: voice.level).frame(width: 46, height: 24)
        Text(Self.time(voice.elapsed)).font(.subheadline.monospacedDigit().weight(.semibold)).foregroundStyle(.white)
          .accessibilityLabel("Listening, \(Int(voice.elapsed)) seconds")
        Spacer(minLength: 4)
        Button { finish(true) } label: {
          Label("Polish", systemImage: "sparkles").font(.subheadline.weight(.semibold)).foregroundStyle(.white)
            .padding(.horizontal, 12).frame(height: 40).background(Color.white.opacity(0.12), in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Polish, then use it")
        .accessibilityIdentifier("voice.polish")
        Button { finish(false) } label: {
          Image(systemName: "checkmark").font(.body.weight(.bold)).foregroundStyle(PalmStyle.onAccent)
            .frame(width: 40, height: 40).background(PalmStyle.accent, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Done, use what I said")
        .accessibilityIdentifier("voice.done")
      } else {
        ProgressView().tint(.white)
        Text(voice.phase == .polishing ? "Polishing" : "Writing it down").font(.subheadline.weight(.semibold))
          .foregroundStyle(.white)
          .accessibilityIdentifier("voice.working")
        Spacer(minLength: 0)
      }
    }
    .padding(.horizontal, 8)
    .frame(height: 56)
    .modifier(PalmVoicePillBackground(overVideo: overVideo))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("voice.pill")
  }

  static func time(_ seconds: TimeInterval) -> String {
    let s = Int(seconds)
    return String(format: "%d:%02d", s / 60, s % 60)
  }
}

private struct PalmVoicePillBackground: ViewModifier {
  let overVideo: Bool
  func body(content: Content) -> some View {
    if overVideo { content.palmVideoGlass(Capsule()) } else { content.background(PalmStyle.panel, in: Capsule()) }
  }
}

/// Five bars that follow the voice's loudness.
struct PalmLevelBars: View {
  let level: Double
  var body: some View {
    HStack(spacing: 3) {
      ForEach(0..<5, id: \.self) { index in
        let weight = [0.5, 0.8, 1.0, 0.8, 0.5][index]
        Capsule().fill(Color.white)
          .frame(width: 4, height: max(4, 24 * min(1, level * 1.4) * weight))
      }
    }
    .animation(.easeOut(duration: 0.08), value: level)
    .accessibilityHidden(true)
  }
}

/// While a reply is read aloud: a small bar to stop it.
struct PalmSpeakingBar: View {
  @ObservedObject private var voice = PalmVoice.shared
  var body: some View {
    if voice.phase == .speaking {
      Button { voice.stopSpeaking() } label: {
        Label("Speaking · Stop", systemImage: "speaker.wave.2.fill").font(.footnote.weight(.semibold))
          .foregroundStyle(.white).padding(.horizontal, 12).frame(height: 30)
          .background(PalmStyle.raised, in: Capsule())
      }
      .buttonStyle(.plain)
      .accessibilityIdentifier("voice.stopSpeaking")
    }
  }
}
