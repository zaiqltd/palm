import AudioToolbox
import Foundation
import WebRTC

/// The phone's microphone and speaker for WebRTC in UI tests (PALM_UITEST_HOST):
/// a 440 Hz tone goes out and what arrives is measured, so the Simulator never
/// opens the Mac's real microphone or plays through its speakers.
final class PalmToneAudioDevice: NSObject, RTCAudioDevice, @unchecked Sendable {
  static let shared = PalmToneAudioDevice()
  private static let rate = 48_000.0
  private static let frames = 480  // 10 ms

  private let queue = DispatchQueue(label: "palm.tone-audio", qos: .userInteractive)
  private let lock = NSLock()
  private var delegate: (any RTCAudioDeviceDelegate)?
  private var timer: DispatchSourceTimer?
  private var recording = false
  private var playing = false
  private var recordingReady = false
  private var playoutReady = false
  private var ready = false
  private var phase = 0.0
  private var played: Float = 0
  private var recorded = UnsafeMutablePointer<Int16>.allocate(capacity: PalmToneAudioDevice.frames)
  private var playout = UnsafeMutablePointer<Int16>.allocate(capacity: PalmToneAudioDevice.frames)

  /// The loudest sample WebRTC has handed this "speaker" (0 to 1).
  var playedPeak: Float { lock.lock(); defer { lock.unlock() }; return played }

  var deviceInputSampleRate: Double { Self.rate }
  var inputIOBufferDuration: TimeInterval { 0.01 }
  var inputNumberOfChannels: Int { 1 }
  var inputLatency: TimeInterval { 0 }
  var deviceOutputSampleRate: Double { Self.rate }
  var outputIOBufferDuration: TimeInterval { 0.01 }
  var outputNumberOfChannels: Int { 1 }
  var outputLatency: TimeInterval { 0 }
  var isInitialized: Bool { locked { ready } }
  var isPlayoutInitialized: Bool { locked { playoutReady } }
  var isPlaying: Bool { locked { playing } }
  var isRecordingInitialized: Bool { locked { recordingReady } }
  var isRecording: Bool { locked { recording } }

  func initialize(with delegate: any RTCAudioDeviceDelegate) -> Bool {
    locked { self.delegate = delegate; ready = true }
    return true
  }
  func terminateDevice() -> Bool {
    locked { recording = false; playing = false; recordingReady = false; playoutReady = false; ready = false; delegate = nil }
    updateTimer()
    return true
  }
  func initializePlayout() -> Bool { locked { playoutReady = true }; return true }
  func startPlayout() -> Bool { locked { playing = true }; updateTimer(); return true }
  func stopPlayout() -> Bool { locked { playing = false }; updateTimer(); return true }
  func initializeRecording() -> Bool { locked { recordingReady = true }; return true }
  func startRecording() -> Bool { locked { recording = true }; updateTimer(); return true }
  func stopRecording() -> Bool { locked { recording = false }; updateTimer(); return true }

  private func locked<T>(_ body: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return body() }

  private func updateTimer() {
    let running = locked { recording || playing }
    queue.async { [self] in
      if running, timer == nil {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 0.01)
        timer.setEventHandler { [weak self] in self?.tick() }
        timer.resume()
        self.timer = timer
      } else if !running {
        timer?.cancel()
        timer = nil
      }
    }
  }

  private func tick() {
    let (delegate, recording, playing) = locked { (self.delegate, self.recording, self.playing) }
    guard let delegate else { return }
    var flags = AudioUnitRenderActionFlags()
    var time = AudioTimeStamp()
    let bytes = UInt32(Self.frames * MemoryLayout<Int16>.size)
    if recording {
      for i in 0..<Self.frames {
        recorded[i] = Int16(sin(phase) * 9_000)
        phase += 2 * .pi * 440 / Self.rate
      }
      phase = phase.truncatingRemainder(dividingBy: 2 * .pi)
      var list = AudioBufferList(mNumberBuffers: 1,
        mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: bytes, mData: recorded))
      _ = delegate.deliverRecordedData(&flags, &time, 1, UInt32(Self.frames), &list, nil, nil)
    }
    if playing {
      var list = AudioBufferList(mNumberBuffers: 1,
        mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: bytes, mData: playout))
      _ = delegate.getPlayoutData(&flags, &time, 0, UInt32(Self.frames), &list)
      var peak: Float = 0
      for i in 0..<Self.frames { peak = max(peak, abs(Float(playout[i]) / 32_768)) }
      locked { played = max(played, peak) }
    }
  }
}
