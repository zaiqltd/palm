import AVFoundation
import CoreMedia
import UIKit

struct PalmVideoDiagnostics: Sendable {
  var receivedPackets = 0
  var submittedFrames = 0
  var keyframeWaitDrops = 0
  var backpressureFlushes = 0
  var decoderResets = 0
  var enqueueWorkMilliseconds = 0.0
  var maximumEnqueueWorkMilliseconds = 0.0
}

@MainActor
final class PalmVideoRenderer {
  let displayLayer = AVSampleBufferDisplayLayer()
  var onNeedsKeyframe: (() -> Void)?
  var onFrame: (() -> Void)?
  private var format: CMVideoFormatDescription?
  private var configuration: PalmH264Configuration?
  private var waitingForKeyframe = true
  private var lastKeyframeRequest: TimeInterval = 0
  private var decodeFailures = 0
  private(set) var diagnostics = PalmVideoDiagnostics()
  /// Since the app started: every stream's resets and catch-ups added up.
  private(set) var totals = PalmVideoDiagnostics()

  /// A picture of this stream is on screen, including the last frame kept
  /// through a zoom step or format change. Control and typing follow this, not
  /// the decoder's momentary readiness: after every zoom step the decoder is
  /// briefly not ready, which closed the keyboard and dropped keys ("zoom in, press the keyboard, half the time it collapses").
  private(set) var hasPicture = false

  var isReadyForDisplay: Bool {
    if #available(iOS 17.4, *) { return displayLayer.isReadyForDisplay }
    return displayLayer.status == .rendering
  }

  init() {
    displayLayer.videoGravity = .resizeAspect
    displayLayer.backgroundColor = UIColor.black.cgColor
  }

  /// `keepPicture` leaves the last frame on screen until the next one decodes
  /// (the screen blinked and went black when things moved
  /// quickly, on every format change and whenever decoding fell behind).
  func reset(keepPicture: Bool = false) {
    if keepPicture { displayLayer.flush() } else {
      displayLayer.flushAndRemoveImage()
      hasPicture = false
    }
    format = nil
    configuration = nil
    waitingForKeyframe = true
    decodeFailures = 0
    totals.receivedPackets += diagnostics.receivedPackets
    totals.submittedFrames += diagnostics.submittedFrames
    totals.keyframeWaitDrops += diagnostics.keyframeWaitDrops
    totals.backpressureFlushes += diagnostics.backpressureFlushes
    totals.decoderResets += diagnostics.decoderResets
    diagnostics = PalmVideoDiagnostics()
  }

  func configure(_ config: PalmVideoConfiguration) throws {
    guard config.codec.hasPrefix("avc1."), (2...8192).contains(config.width),
      (2...8192).contains(config.height), let avcC = Data(base64Encoded: config.description)
    else { throw PalmFailure.malformedVideo }
    let parsed = try PalmH264Configuration(avcC: avcC)
    if parsed == configuration { return }
    // A new size or zoom step: the old picture stays until the new one shows.
    reset(keepPicture: true)
    let pointers = parsed.parameterSets.map { data -> UnsafeMutablePointer<UInt8> in
      let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: data.count)
      data.copyBytes(to: pointer, count: data.count)
      return pointer
    }
    defer { pointers.forEach { $0.deallocate() } }
    var immutablePointers = pointers.map { UnsafePointer($0) }
    var sizes = parsed.parameterSets.map(\.count)
    var description: CMFormatDescription?
    let code = CMVideoFormatDescriptionCreateFromH264ParameterSets(
      allocator: kCFAllocatorDefault, parameterSetCount: pointers.count,
      parameterSetPointers: &immutablePointers, parameterSetSizes: &sizes,
      nalUnitHeaderLength: Int32(parsed.nalLengthSize), formatDescriptionOut: &description)
    guard code == noErr, let description else { throw PalmFailure.malformedVideo }
    format = description
    configuration = parsed
  }

  func enqueue(_ packet: Data) throws {
    let began = ProcessInfo.processInfo.systemUptime
    diagnostics.receivedPackets += 1
    defer {
      let elapsed = (ProcessInfo.processInfo.systemUptime - began) * 1000
      diagnostics.enqueueWorkMilliseconds += elapsed
      diagnostics.maximumEnqueueWorkMilliseconds = max(
        diagnostics.maximumEnqueueWorkMilliseconds, elapsed)
    }
    guard let format, let configuration else { return }
    let frame = try PalmVideoFrame(packet: packet, nalLengthSize: configuration.nalLengthSize)
    if displayLayer.status == .failed {
      decodeFailures += 1
      guard decodeFailures < 3 else {
        throw PalmFailure.message(
          "Your iPhone could not decode the Mac video. Reconnect to start a fresh stream.")
      }
      displayLayer.flush()
      diagnostics.decoderResets += 1
      waitingForKeyframe = true
      requestKeyframe()
    } else if isReadyForDisplay {
      decodeFailures = 0
    }
    if waitingForKeyframe && !frame.isKey {
      diagnostics.keyframeWaitDrops += 1
      return
    }
    guard displayLayer.isReadyForMoreMediaData else {
      // Behind: skip to the next full frame, holding the last picture meanwhile.
      displayLayer.flush()
      diagnostics.backpressureFlushes += 1
      waitingForKeyframe = true
      requestKeyframe()
      return
    }
    var block: CMBlockBuffer?
    let blockResult = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: frame.payload.count,
      blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
      dataLength: frame.payload.count, flags: 0, blockBufferOut: &block)
    guard blockResult == kCMBlockBufferNoErr, let block else { throw PalmFailure.malformedVideo }
    let copyResult = frame.payload.withUnsafeBytes { bytes in
      CMBlockBufferReplaceDataBytes(
        with: bytes.baseAddress!, blockBuffer: block,
        offsetIntoDestination: 0, dataLength: frame.payload.count)
    }
    guard copyResult == kCMBlockBufferNoErr else { throw PalmFailure.malformedVideo }
    var timing = CMSampleTimingInfo(
      duration: .invalid,
      presentationTimeStamp: CMTime(
        value: Int64(frame.timestampMicroseconds), timescale: 1_000_000),
      decodeTimeStamp: .invalid)
    var size = frame.payload.count
    var sample: CMSampleBuffer?
    let sampleResult = CMSampleBufferCreateReady(
      allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
      sampleCount: 1, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
      sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
    guard sampleResult == noErr, let sample else { throw PalmFailure.malformedVideo }
    if let array = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: true) {
      let attachments = unsafeBitCast(
        CFArrayGetValueAtIndex(array, 0), to: CFMutableDictionary.self)
      CFDictionarySetValue(
        attachments,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
        Unmanaged.passUnretained(kCFBooleanTrue).toOpaque())
      CFDictionarySetValue(
        attachments,
        Unmanaged.passUnretained(kCMSampleAttachmentKey_NotSync).toOpaque(),
        Unmanaged.passUnretained(frame.isKey ? kCFBooleanFalse : kCFBooleanTrue).toOpaque())
    }
    displayLayer.enqueue(sample)
    hasPicture = true
    diagnostics.submittedFrames += 1
    waitingForKeyframe = false
    onFrame?()
  }

  private func requestKeyframe() {
    let now = ProcessInfo.processInfo.systemUptime
    guard now - lastKeyframeRequest >= 0.4 else { return }
    lastKeyframeRequest = now
    onNeedsKeyframe?()
  }
}
