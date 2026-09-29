import AVFoundation
import Foundation

/// The audio tap feeds the same tested resampler as the Mac microphone. A
/// packet is 20 ms; backpressure is enforced before anything reaches the wire.
final class PalmTalkCapture {
  private let onChunk: (Data) -> Void
  private var engine: AVAudioEngine?
  private var syntheticTimer: DispatchSourceTimer?
  private let converter = PalmPCMEncoder()
  private let lock = NSLock()
  private var failure: String?
  static var synthetic: Bool { ProcessInfo.processInfo.environment["PALM_UITEST_HOST"] != nil }

  init(onChunk: @escaping (Data) -> Void) { self.onChunk = onChunk }

  static func microphoneAllowed() async -> Bool {
    if synthetic { return true }
    switch AVAudioApplication.shared.recordPermission {
    case .granted: return true
    case .denied: return false
    default: return await AVAudioApplication.requestRecordPermission()
    }
  }

  func start() throws {
    if Self.synthetic {
      let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "palm.talk.synthetic"))
      syntheticTimer = timer
      timer.schedule(deadline: .now() + 0.02, repeating: 0.02)
      var packet = 0
      timer.setEventHandler { [weak self] in
        self?.onChunk(PalmAudioWire.tone(packet: packet, frequency: 400)); packet += 1
      }
      timer.resume()
      return
    }
    let session = AVAudioSession.sharedInstance()
    // No call processing (25 September, "not clear audio"): voice chat mode on
    // speaker muffles the voice to cancel echo, and there is no echo to cancel
    // because the Mac's sound is paused on the phone while you talk.
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothHFP])
    try session.setPreferredIOBufferDuration(0.01)
    try session.setActive(true)
    let engine = AVAudioEngine()
    let input = engine.inputNode
    try? input.setVoiceProcessingEnabled(false)
    let format = input.outputFormat(forBus: 0)
    guard format.channelCount > 0, format.sampleRate > 0 else {
      throw PalmAudioError(message: "The iPhone microphone is unavailable.")
    }
    input.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
      guard let self else { return }
      self.lock.lock(); defer { self.lock.unlock() }
      do { try self.converter.encode(buffer, emit: self.onChunk) }
      catch { self.failure = error.localizedDescription }
    }
    do {
      engine.prepare()
      try engine.start()
      self.engine = engine
    } catch { input.removeTap(onBus: 0); throw error }
  }

  var diagnostics: (frames: Int, peak: Float, error: String?) {
    lock.lock(); defer { lock.unlock() }
    return (converter.inputFrames, converter.peak, failure)
  }

  func stop() {
    syntheticTimer?.cancel(); syntheticTimer = nil
    if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop(); self.engine = nil }
  }
}
