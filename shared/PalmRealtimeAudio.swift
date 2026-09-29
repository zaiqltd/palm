import AVFoundation
import CoreMedia
import Foundation

enum PalmAudioWire {
  static let rate = 24_000.0
  static let frames = 480 // 20 ms, mono signed 16-bit little-endian PCM.
  static let bytes = frames * 2
  static let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!

  static func tone(packet: Int, frequency: Double = 700) -> Data {
    var values = [Int16](repeating: 0, count: frames)
    for i in values.indices {
      values[i] = Int16(sin(2 * .pi * frequency * Double(packet * frames + i) / rate) * 6_000).littleEndian
    }
    return values.withUnsafeBytes { Data($0) }
  }
}

struct PalmAudioError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

/// AVFoundation supplies native device PCM. Convert it here, rather than
/// requesting an Int16 format the capture output may fail to produce.
/// Each instance belongs to one serial capture queue.
final class PalmPCMEncoder {
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?
  private var packet = [Int16](repeating: 0, count: PalmAudioWire.frames)
  private var used = 0
  private(set) var inputFrames = 0
  private(set) var outputFrames = 0
  private(set) var peak: Float = 0

  static func copyPCM(_ sample: CMSampleBuffer) throws -> AVAudioPCMBuffer {
    guard let description = sample.formatDescription,
      let format = AVAudioFormat(cmAudioFormatDescription: description) as AVAudioFormat?,
      let buffer = AVAudioPCMBuffer(pcmFormat: format,
        frameCapacity: AVAudioFrameCount(sample.numSamples))
    else { throw PalmAudioError(message: "The microphone returned an unreadable audio format.") }
    buffer.frameLength = buffer.frameCapacity
    let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0,
      frameCount: Int32(sample.numSamples), into: buffer.mutableAudioBufferList)
    guard status == noErr else { throw PalmAudioError(message: "Could not read microphone samples (\(status)).") }
    return buffer
  }

  func encode(_ input: AVAudioPCMBuffer, emit: (Data) -> Void) throws {
    guard input.frameLength > 0, input.format.sampleRate > 0 else { return }
    inputFrames += Int(input.frameLength)
    if inputFormat != input.format {
      guard let next = AVAudioConverter(from: input.format, to: PalmAudioWire.format)
      else { throw PalmAudioError(message: "Could not convert the microphone's audio format.") }
      converter = next
      inputFormat = input.format
    }
    guard let converter,
      let output = AVAudioPCMBuffer(pcmFormat: PalmAudioWire.format,
        frameCapacity: AVAudioFrameCount(ceil(Double(input.frameLength) * PalmAudioWire.rate / input.format.sampleRate) + 64))
    else { return }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, state in
      if supplied { state.pointee = .noDataNow; return nil }
      supplied = true
      state.pointee = .haveData
      return input
    }
    if status == .error { throw error ?? PalmAudioError(message: "Microphone audio conversion failed.") as NSError }
    guard let samples = output.floatChannelData?[0] else { return }
    for i in 0..<Int(output.frameLength) {
      let value = samples[i].isFinite ? max(-1, min(1, samples[i])) : 0
      peak = max(peak, abs(value))
      packet[used] = Int16(value * 32_767).littleEndian
      used += 1
      outputFrames += 1
      if used == packet.count {
        packet.withUnsafeBytes { emit(Data($0)) }
        used = 0
      }
    }
  }
}

/// A bounded jitter buffer read directly by the audio render callback. It
/// cannot accumulate seconds of old sound, or depend on main-thread callbacks
/// to release queued buffers.
///
/// Earlier versions started playing
/// after 40 ms, went silent at the first late packet and, when a burst
/// arrived after a hiccup, threw all but 40 ms away. Over Wi-Fi or mobile data
/// packets arrive in bursts, so the sound came out in chopped pieces. Then a
/// fixed 100 ms start was "laggy". Now it starts with 60 ms in hand, adds
/// 40 ms after each time it runs dry (up to 240 ms), gives 20 ms back after
/// 10 s without running dry, holds up to 400 ms and trims to its target +60 ms.
final class PalmAudioRing: @unchecked Sendable {
  static let minimumTarget = PalmAudioWire.frames * 3
  static let maximumTarget = 5_760
  static let maximumFrames = 9_600
  private var target = PalmAudioRing.minimumTarget
  private var steadyFrames = 0
  private let lock = NSLock()
  private var samples = [Float](repeating: 0, count: 24_000)
  private var readIndex = 0
  private var count = 0
  private var primed = false
  private var received = 0
  private var rendered = 0
  private var nonzero = 0
  private var dropped = 0
  private var underruns = 0
  private var peak: Float = 0

  func enqueue(_ data: Data) throws {
    guard data.count == PalmAudioWire.bytes else {
      throw PalmAudioError(message: "Invalid live audio packet.")
    }
    lock.lock(); defer { lock.unlock() }
    if count + PalmAudioWire.frames > Self.maximumFrames {
      let discard = max(0, min(count, count + PalmAudioWire.frames - (target + 1_440)))
      readIndex = (readIndex + discard) % samples.count
      count -= discard
      dropped += discard
    }
    data.withUnsafeBytes { bytes in
      for i in 0..<PalmAudioWire.frames {
        let bits = bytes.loadUnaligned(fromByteOffset: i * 2, as: UInt16.self).littleEndian
        samples[(readIndex + count) % samples.count] = Float(Int16(bitPattern: bits)) / 32_768
        count += 1
      }
    }
    received += PalmAudioWire.frames
  }

  func render(_ output: UnsafeMutablePointer<Float>, frames: Int) {
    lock.lock(); defer { lock.unlock() }
    if !primed && count >= target { primed = true }
    let available = primed ? min(count, frames) : 0
    for i in 0..<available {
      let value = samples[(readIndex + i) % samples.count]
      output[i] = value
      peak = max(peak, abs(value))
      if abs(value) > 0.0001 { nonzero += 1 }
    }
    if available < frames {
      output.advanced(by: available).initialize(repeating: 0, count: frames - available)
      if primed {
        underruns += 1
        target = min(Self.maximumTarget, target + 960)
        steadyFrames = 0
      }
      primed = false
    } else {
      steadyFrames += frames
      if steadyFrames >= 240_000 {
        steadyFrames = 0
        target = max(Self.minimumTarget, target - 480)
      }
    }
    readIndex = (readIndex + available) % samples.count
    count -= available
    rendered += available
  }

  var diagnostics: [String: Double] {
    lock.lock(); defer { lock.unlock() }
    return ["receivedFrames": Double(received), "renderedFrames": Double(rendered),
      "nonzeroRenderedFrames": Double(nonzero), "droppedFrames": Double(dropped),
      "queuedMs": Double(count) * 1_000 / PalmAudioWire.rate,
      "underruns": Double(underruns), "peak": Double(peak),
      "targetMs": Double(target) * 1_000 / PalmAudioWire.rate]
  }
}

final class PalmPCMPlayer {
  private var engine: AVAudioEngine?
  private var source: AVAudioSourceNode?
  private var ring = PalmAudioRing()
  private var manual = false
  var isRunning: Bool { engine?.isRunning == true }
  var diagnostics: [String: Double] { ring.diagnostics }

  func start(manual: Bool = false) throws {
    stop()
    self.manual = manual
    let ring = PalmAudioRing()
    self.ring = ring
    let engine = AVAudioEngine()
    let source = AVAudioSourceNode(format: PalmAudioWire.format) { _, _, frames, buffers in
      let list = UnsafeMutableAudioBufferListPointer(buffers)
      guard let first = list.first, let memory = first.mData else { return noErr }
      ring.render(memory.assumingMemoryBound(to: Float.self), frames: Int(frames))
      return noErr
    }
    engine.attach(source)
    engine.connect(source, to: engine.mainMixerNode, format: PalmAudioWire.format)
    engine.mainMixerNode.outputVolume = 1
    if manual {
      try engine.enableManualRenderingMode(.offline, format: PalmAudioWire.format,
        maximumFrameCount: 1_024)
    }
    engine.prepare()
    try engine.start()
    self.engine = engine
    self.source = source
  }

  func enqueue(_ packet: Data) throws {
    guard isRunning else { throw PalmAudioError(message: "Audio playback is not running.") }
    try ring.enqueue(packet)
    if manual { _ = try renderOffline(frames: PalmAudioWire.frames) }
  }

  @discardableResult func renderOffline(frames: Int) throws -> AVAudioPCMBuffer {
    guard manual, let engine,
      let buffer = AVAudioPCMBuffer(pcmFormat: PalmAudioWire.format,
        frameCapacity: AVAudioFrameCount(frames))
    else { throw PalmAudioError(message: "Offline audio rendering is unavailable.") }
    let state = try engine.renderOffline(AVAudioFrameCount(frames), to: buffer)
    guard state == .success else { throw PalmAudioError(message: "Audio rendering did not complete.") }
    return buffer
  }

  func stop() {
    engine?.stop()
    engine = nil
    source = nil
  }
}
