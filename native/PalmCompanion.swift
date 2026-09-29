import Cocoa
import ImageIO
import CoreMedia
import CoreText
import CoreVideo
import ScreenCaptureKit
import VideoToolbox

private let outputLock = NSLock()
func emit(_ object: [String: Any]) {
  guard JSONSerialization.isValidJSONObject(object),
    let data = try? JSONSerialization.data(withJSONObject: object)
  else { return }
  outputLock.lock()
  defer { outputLock.unlock() }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([10]))
}
struct PalmError: LocalizedError {
  let message: String
  var errorDescription: String? { message }
}
func require(_ condition: Bool, _ message: String) throws {
  if !condition { throw PalmError(message: message) }
}

// Geometry is in the same top-left Mac point coordinates as CGWindow/AX.
// Pure helpers are exercised without requesting permission or changing a window.
enum PhoneLayoutGeometry {
  static func near(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 2) -> Bool {
    abs(a.minX - b.minX) < tolerance && abs(a.minY - b.minY) < tolerance
      && abs(a.width - b.width) < tolerance && abs(a.height - b.height) < tolerance
  }
  static func validViewport(_ viewport: CGSize) -> Bool {
    viewport.width.isFinite && viewport.height.isFinite
      && (240...1400).contains(viewport.width) && (200...1400).contains(viewport.height)
  }
  static func proposal(original: CGRect, workArea: CGRect, viewport: CGSize? = nil) -> CGRect? {
    guard !workArea.isNull, workArea.width.isFinite, workArea.height.isFinite,
      workArea.width > 16, workArea.height > 16
    else { return nil }
    // Leave room for AppKit's frame-edge constraints instead of requesting a
    // window that lands exactly on the bottom edge and is clamped by a point.
    let available = workArea.insetBy(dx: 8, dy: 8)
    let width: CGFloat
    let height: CGFloat
    if let viewport {
      guard validViewport(viewport) else { return nil }
      // Preserve the usable phone viewport's aspect at a readable Mac point
      // scale. Fit both dimensions together; never squeeze/stretch one edge.
      let readableScale = max(1, max(430 / viewport.width, 400 / viewport.height))
      let readable = CGSize(
        width: viewport.width * readableScale, height: viewport.height * readableScale)
      let fit = min(1, min(available.width / readable.width, available.height / readable.height))
      width = floor(readable.width * fit + 0.000001)
      height = floor(readable.height * fit + 0.000001)
      guard width >= 430, height >= 400 else { return nil }
    } else {
      // Older clients keep the established portrait layout.
      guard workArea.width >= 430, workArea.height >= 560 else { return nil }
      width = min(460, floor(available.width))
      height = min(860, floor(available.height))
      guard width >= 430, height >= width * 1.2 else { return nil }
    }
    return CGRect(
      x: min(max(original.minX, available.minX), available.maxX - width),
      y: min(max(original.minY, available.minY), available.maxY - height),
      width: width, height: height)
  }
  /// Fill: the window takes the screen's usable area (menu bar and Dock
  /// excluded), keeping the same small margin as phone layout so AppKit never
  /// clamps it against an edge.
  static func fill(workArea: CGRect) -> CGRect? {
    guard !workArea.isNull, workArea.width.isFinite, workArea.height.isFinite,
      workArea.width > 200, workArea.height > 200
    else { return nil }
    let available = workArea.insetBy(dx: 8, dy: 8)
    return CGRect(
      x: available.minX, y: available.minY,
      width: floor(available.width), height: floor(available.height))
  }
  static func syntheticSize(viewport: CGSize?) -> CGSize? {
    guard let viewport else { return CGSize(width: 460, height: 800) }
    return proposal(
      original: CGRect(x: 0, y: 0, width: 1280, height: 800),
      workArea: CGRect(x: 0, y: 0, width: 1600, height: 1000), viewport: viewport)?.size
  }
  /// Stream size for a source measured in points. At the phone's normal view
  /// the long side is at most 1600 pixels. Zoomed in on the phone, the stream
  /// grows with the zoom up to the display's own pixels, so small text stays
  /// sharp instead of being enlarged from a smaller picture.
  static func encodedSize(_ size: CGSize, zoom: Double = 1, backing: CGFloat = 2) -> (Int, Int) {
    let longest = max(1, max(size.width, size.height))
    let steps = max(1, min(4, zoom))
    let cap = steps > 1.01 ? max(1.5, backing) : 1.5
    let ratio = min(cap, 1600 * CGFloat(steps) / longest)
    return (
      max(2, Int(size.width * ratio) / 2 * 2),
      max(2, Int(size.height * ratio) / 2 * 2)
    )
  }
  static func shouldRestore(current: CGRect, applied: CGRect) -> Bool {
    near(current, applied, tolerance: 0.5)
  }
  static func capturedLayoutMatches(expected: CGSize?, captured: CGSize, current: CGSize?) -> Bool {
    guard let expected, let current else { return false }
    return [captured, current].allSatisfy {
      $0.width.isFinite && $0.height.isFinite
        && abs($0.width - expected.width) < 2 && abs($0.height - expected.height) < 2
    }
  }
  static func settlement(ax: CGRect, windowServer: CGRect, applied: CGRect) -> String {
    guard shouldRestore(current: ax, applied: applied) else { return "userChanged" }
    return shouldRestore(current: windowServer, applied: applied) ? "ready" : "pending"
  }
  static func activationReady(windowServer: CGRect, identifiedAX: CGRect?, stableFor: TimeInterval)
    -> Bool
  {
    if let identifiedAX { return shouldRestore(current: windowServer, applied: identifiedAX) }
    // Apps without usable AX geometry remain viewable, after the CG animation settles.
    return stableFor >= 0.2
  }
  static func selfTest() throws -> Int {
    let original = CGRect(x: 1200, y: 500, width: 900, height: 700)
    let work = CGRect(x: 0, y: 38, width: 1440, height: 822)
    let fitted = proposal(original: original, workArea: work)
    try require(
      fitted == CGRect(x: 972, y: 46, width: 460, height: 806), "Portrait work-area fitting failed."
    )
    let leftDisplay = CGRect(x: -1200, y: -300, width: 1200, height: 1000)
    let moved = proposal(
      original: CGRect(x: -40, y: -350, width: 640, height: 400), workArea: leftDisplay)
    try require(
      moved == CGRect(x: -468, y: -292, width: 460, height: 860), "External-display fitting failed."
    )
    try require(
      proposal(original: original, workArea: CGRect(x: 0, y: 0, width: 429, height: 900)) == nil,
      "Narrow work area must be rejected.")
    try require(
      proposal(original: original, workArea: CGRect(x: 0, y: 0, width: 1400, height: 550)) == nil,
      "Short work area must be rejected.")
    let applied = CGRect(x: 10, y: 40, width: 460, height: 800)
    try require(
      shouldRestore(current: applied, applied: applied),
      "Unchanged applied frame must permit restoration.")
    try require(
      !shouldRestore(current: applied.offsetBy(dx: 1, dy: 0), applied: applied),
      "User moves must prevent restoration.")
    try require(
      !shouldRestore(current: CGRect(x: 10, y: 40, width: 700, height: 800), applied: applied),
      "User resizes must prevent restoration.")
    let portrait = encodedSize(CGSize(width: 460, height: 822))
    try require(portrait == (690, 1232), "Portrait encoder dimensions must follow actual geometry.")
    let tall = encodedSize(CGSize(width: 800, height: 4000))
    try require(tall == (320, 1600), "Both encoded edges must be bounded.")
    let edgeSafe = proposal(
      original: CGRect(x: 100, y: 360, width: 640, height: 472),
      workArea: CGRect(x: 0, y: 33, width: 1512, height: 905))
    try require(
      edgeSafe == CGRect(x: 100, y: 70, width: 460, height: 860),
      "Window must clear the constrained screen edge.")
    try require(
      settlement(ax: applied, windowServer: applied.offsetBy(dx: 0, dy: 35), applied: applied)
        == "pending",
      "WindowServer animation must wait while AX remains unchanged.")
    try require(
      settlement(ax: applied.offsetBy(dx: 1, dy: 0), windowServer: applied, applied: applied)
        == "userChanged",
      "Changed AX geometry must never be absorbed while waiting.")
    try require(
      settlement(ax: applied, windowServer: applied, applied: applied) == "ready",
      "Only converged AX and WindowServer geometry may permit another setter.")
    let activeFrame = CGRect(x: 100, y: 360, width: 640, height: 472)
    try require(
      !activationReady(
        windowServer: activeFrame.offsetBy(dx: -1081, dy: 0),
        identifiedAX: activeFrame, stableFor: 2),
      "Identifiable AX geometry must agree even when an animation frame appears stationary.")
    try require(
      activationReady(windowServer: activeFrame, identifiedAX: activeFrame, stableFor: 0),
      "Converged AX and CG should allow immediate activation completion.")
    try require(
      !activationReady(windowServer: activeFrame, identifiedAX: nil, stableFor: 0.19)
        && activationReady(windowServer: activeFrame, identifiedAX: nil, stableFor: 0.2),
      "View-only/custom apps require a bounded stable-CG fallback.")
    try require(
      fill(workArea: CGRect(x: 0, y: 33, width: 1512, height: 905))
        == CGRect(x: 8, y: 41, width: 1496, height: 889),
      "Fill must take the usable screen inside the edge margin.")
    try require(fill(workArea: CGRect(x: 0, y: 0, width: 100, height: 900)) == nil,
      "A tiny work area cannot be filled.")
    let viewportWork = CGRect(x: 0, y: 33, width: 1512, height: 905)
    let landscape = proposal(
      original: activeFrame, workArea: viewportWork, viewport: CGSize(width: 758, height: 409))
    try require(
      landscape?.size == CGSize(width: 758, height: 409),
      "Landscape source must follow the viewport, not the legacy portrait size.")
    let portraitViewport = proposal(
      original: activeFrame, workArea: viewportWork, viewport: CGSize(width: 393, height: 700))
    try require(
      portraitViewport?.size == CGSize(width: 430, height: 765),
      "Portrait must scale both dimensions together to a readable width.")
    let shortViewport = proposal(
      original: activeFrame, workArea: viewportWork, viewport: CGSize(width: 780, height: 300))
    try require(
      shortViewport?.size == CGSize(width: 1040, height: 400),
      "Landscape must scale both dimensions to the minimum Mac height.")
    let fittedViewport = proposal(
      original: activeFrame, workArea: CGRect(x: 0, y: 0, width: 1024, height: 800),
      viewport: CGSize(width: 1400, height: 1000))
    try require(
      fittedViewport?.size == CGSize(width: 1008, height: 720),
      "Oversized viewport must fit the work area without stretching.")
    try require(
      proposal(
        original: activeFrame, workArea: CGRect(x: 0, y: 0, width: 1512, height: 400),
        viewport: CGSize(width: 780, height: 300)) == nil,
      "Unfittable minimum size must return unsupported.")
    let requestedSize = CGSize(width: 758, height: 409)
    try require(
      capturedLayoutMatches(
        expected: requestedSize, captured: requestedSize, current: requestedSize),
      "Already-fitting windows must verify without a restoration record.")
    try require(
      !capturedLayoutMatches(
        expected: requestedSize, captured: CGSize(width: 900, height: 409), current: requestedSize),
      "Capture metadata that differs from the requested layout cannot claim applied.")
    try require(
      !capturedLayoutMatches(
        expected: requestedSize, captured: requestedSize, current: CGSize(width: 900, height: 409)),
      "A resize after capture configuration cannot retain an applied claim.")
    try require(
      !capturedLayoutMatches(expected: nil, captured: requestedSize, current: requestedSize)
        && !capturedLayoutMatches(expected: requestedSize, captured: requestedSize, current: nil),
      "Missing expected or current geometry cannot claim an applied layout.")
    return 27
  }
}

final class SyntheticInputState {
  private let lock = NSLock()
  private var value = 0
  /// The test Mac's last keys and text, so UI tests can prove typing arrives.
  /// Only the test Mac keeps these, in memory; the real Mac never records typing.
  private var typed: [[String: Any]] = []
  func note(_ event: [String: Any]) {
    lock.lock()
    defer { lock.unlock() }
    typed.append(event)
    if typed.count > 20 { typed.removeFirst(typed.count - 20) }
  }
  /// A still test screen (no new pictures), to prove a still picture is sharpened.
  private var paused = false
  var still: Bool {
    get { lock.lock(); defer { lock.unlock() }; return paused }
    set { lock.lock(); paused = newValue; lock.unlock() }
  }
  func recentTyping() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return typed
  }
  func current() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
  func record() -> Int {
    lock.lock()
    defer { lock.unlock() }
    value &+= 1
    return value
  }
}

final class Encoder {
  var session: VTCompressionSession?
  let lock = NSLock()
  var forceKey = true
  var active = true
  var width: Int
  var height: Int
  let fps: Int
  let send: ([String: Any]) -> Void
  let onDrop: (() -> Void)?
  /// 3.5 Mbit/s at 1600 × 1000, rising with the pixel count for sharper
  /// zoomed streams, at most 14 Mbit/s. The most the screen ever gets.
  static func screenBitrate(width: Int, height: Int) -> Int {
    min(14_000_000, max(3_500_000, Int(3_500_000 * Double(width * height) / 1_600_000)))
  }
  init(width: Int, height: Int, fps: Int = 30, bitRate: Int? = nil,
    keyInterval: Double = 1,
    onDrop: (() -> Void)? = nil,
    send: @escaping ([String: Any]) -> Void = emit) throws {
    self.width = width
    self.height = height
    self.fps = fps
    self.send = send
    self.onDrop = onDrop
    let bitrate = bitRate ?? Self.screenBitrate(width: width, height: height)
    let status = VTCompressionSessionCreate(
      allocator: kCFAllocatorDefault, width: Int32(width), height: Int32(height),
      codecType: kCMVideoCodecType_H264,
      encoderSpecification: [
        kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true
      ] as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: { refcon, _, status, _, sample in
        guard let refcon else { return }
        let encoder = Unmanaged<Encoder>.fromOpaque(refcon).takeUnretainedValue()
        guard status == noErr, let sample else { encoder.onDrop?(); return }
        encoder.output(sample)
      }, refcon: Unmanaged.passUnretained(self).toOpaque(), compressionSessionOut: &session)
    try require(status == noErr && session != nil, "Could not start the video encoder.")
    guard let session = session else { return }
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_ProfileLevel,
      value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: fps as CFNumber)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
      value: max(1, Int(Double(fps) * keyInterval)) as CFNumber)
    VTSessionSetProperty(
      session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: keyInterval as CFNumber)
    if bitRate != nil {
      VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits,
        value: [bitrate / 8, 1] as CFArray)
    }
    VTCompressionSessionPrepareToEncodeFrames(session)
  }
  /// The screen's rate follows the phone's connection (set by the host from
  /// how fast the phone confirms frames). Bursts are held to 1.5× the rate.
  func setBitrate(_ bitrate: Int) {
    lock.lock()
    let s = session
    lock.unlock()
    guard let s else { return }
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: bitrate as CFNumber)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_DataRateLimits,
      value: [bitrate * 3 / 16, 1] as CFArray)
  }
  func requestKey() {
    lock.lock()
    forceKey = true
    lock.unlock()
  }
  func encode(_ pixel: CVPixelBuffer, time: CMTime) {
    guard let s = session else { return }
    lock.lock()
    let key = forceKey
    forceKey = false
    lock.unlock()
    let props = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary : nil
    let status = VTCompressionSessionEncodeFrame(
      s, imageBuffer: pixel, presentationTimeStamp: time, duration: CMTime(value: 1, timescale: CMTimeScale(fps)),
      frameProperties: props, sourceFrameRefcon: nil, infoFlagsOut: nil)
    if status != noErr { onDrop?() }
  }
  func output(_ sample: CMSampleBuffer) {
    lock.lock()
    defer { lock.unlock() }
    guard active else { return }
    guard let format = CMSampleBufferGetFormatDescription(sample),
      let block = CMSampleBufferGetDataBuffer(sample)
    else { return }
    let attachments =
      CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
      as? [[CFString: Any]]
    let key = !(attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    if key {
      var spsPtr: UnsafePointer<UInt8>?
      var ppsPtr: UnsafePointer<UInt8>?
      var spsSize = 0
      var ppsSize = 0
      guard
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format, parameterSetIndex: 0, parameterSetPointerOut: &spsPtr,
          parameterSetSizeOut: &spsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
          == noErr,
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
          format, parameterSetIndex: 1, parameterSetPointerOut: &ppsPtr,
          parameterSetSizeOut: &ppsSize, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil)
          == noErr,
        let spsPtr = spsPtr, let ppsPtr = ppsPtr, spsSize > 3
      else { return }
      let sps = Data(bytes: spsPtr, count: spsSize)
      let pps = Data(bytes: ppsPtr, count: ppsSize)
      var avcc = Data([
        1, sps[1], sps[2], sps[3], 255, 225, UInt8(spsSize >> 8), UInt8(spsSize & 255),
      ])
      avcc.append(sps)
      avcc.append(contentsOf: [1, UInt8(ppsSize >> 8), UInt8(ppsSize & 255)])
      avcc.append(pps)
      let codec = String(format: "avc1.%02X%02X%02X", sps[1], sps[2], sps[3])
      send([
        "event": "config", "codec": codec, "description": avcc.base64EncodedString(),
        "width": width, "height": height,
      ])
    }
    let size = CMBlockBufferGetDataLength(block)
    var data = Data(count: size)
    let code = data.withUnsafeMutableBytes { ptr in
      CMBlockBufferCopyDataBytes(
        block, atOffset: 0, dataLength: size, destination: ptr.baseAddress!)
    }
    guard code == noErr else { return }
    send([
      "event": "frame", "key": key,
      "timestamp": CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1_000_000,
      "data": data.base64EncodedString(),
    ])
  }
  func close() {
    lock.lock()
    active = false
    lock.unlock()
    if let s = session {
      VTCompressionSessionCompleteFrames(s, untilPresentationTimeStamp: .invalid)
      VTCompressionSessionInvalidate(s)
      session = nil
    }
  }
  deinit { close() }
}

// Each output retains its own encoder. A callback from a retired stream must
// never be interpreted as a frame from the next selected window.
final class CaptureOutput: NSObject, SCStreamOutput {
  private(set) var encoder: Encoder  // replaced only on queue
  let queue: DispatchQueue
  private var active = true  // accessed only on queue
  private var pending: Encoder?  // the next size's encoder, accessed only on queue
  // Flow control, for phones that confirm every frame (24 September: on a
  // weak link the stream queued seconds of video, the phone's heartbeat
  // timed out and it reconnected in a loop). A picture is encoded only while
  // the phone has room for it; otherwise the newest one waits here and goes
  // as soon as the phone confirms an earlier frame. Skipping raw pictures,
  // never encoded ones, keeps the H.264 chain whole. All on queue.
  static let maxCredits = 6
  private var flow = false
  private var credits = 0
  private var waiting: (CVPixelBuffer, CMTime)?
  // At a low rate the last picture after movement is soft, and the Mac sends
  // nothing more while the screen is still. It is encoded again a few times
  // so the encoder can sharpen it.
  private var last: CVPixelBuffer?
  private var lastTime = CMTime.invalid
  private var lastWall: TimeInterval = 0
  private var refineTicket = 0
  private(set) var skipped = 0
  private(set) var refined = 0
  private(set) var encoded = 0
  init(encoder: Encoder, queue: DispatchQueue) {
    self.encoder = encoder
    self.queue = queue
  }
  func close() {
    queue.sync {
      active = false
      encoder.close()
      pending?.close()
      pending = nil
      waiting = nil
      last = nil
      refineTicket &+= 1
    }
  }
  func enableFlow() {
    queue.sync {
      flow = true
      credits = Self.maxCredits
    }
  }
  /// The phone confirmed `count` frames; `reset` sets the room outright (the
  /// host's once-a-second correction when nothing is in flight).
  func grant(_ count: Int, reset: Bool = false) {
    queue.async { [self] in
      guard active, flow else { return }
      credits = reset ? min(Self.maxCredits, count) : min(Self.maxCredits, credits + count)
      if let (pixel, time) = waiting {
        waiting = nil
        admit(pixel, time)
      }
    }
  }
  /// The encoder lost a frame it was given: its room comes back.
  func refund() {
    queue.async { [self] in
      guard active, flow else { return }
      credits = min(Self.maxCredits, credits + 1)
    }
  }
  var stats: [String: Any] {
    queue.sync { ["flow": flow, "credits": credits, "skipped": skipped, "refined": refined, "encoded": encoded] }
  }
  /// A new stream size needs a new encoder. It takes over with the first frame
  /// captured at its size, so no frame is encoded at the wrong size; its first
  /// frame is a key frame.
  func replace(_ next: Encoder) {
    queue.sync {
      pending?.close()
      pending = next
    }
  }
  /// The synthetic test screen offers its pictures through the same gate.
  func offer(_ pixel: CVPixelBuffer, time: CMTime) {
    queue.async { [self] in
      guard active else { return }
      admit(pixel, time)
    }
  }
  private func admit(_ pixel: CVPixelBuffer, _ time: CMTime) {
    guard flow else {
      encoder.encode(pixel, time: time)
      return
    }
    guard CVPixelBufferGetWidth(pixel) == encoder.width, CVPixelBufferGetHeight(pixel) == encoder.height else {
      return
    }
    guard credits > 0 else {
      waiting = (pixel, time)
      skipped += 1
      return
    }
    credits -= 1
    encoded += 1
    encoder.encode(pixel, time: monotonic(time))
    lastWall = ProcessInfo.processInfo.systemUptime
    last = pixel
    refineTicket &+= 1
    scheduleRefine(ticket: refineTicket, step: 0)
  }
  private func monotonic(_ time: CMTime) -> CMTime {
    var next = time
    if lastTime.isValid && CMTimeCompare(next, lastTime) <= 0 {
      next = CMTimeAdd(lastTime, CMTime(value: 1, timescale: 1000))
    }
    lastTime = next
    return next
  }
  private func scheduleRefine(ticket: Int, step: Int) {
    // 0.25, 0.6 and 1.2 s after the last new picture, then every 5 s while the
    // screen stays still: the phone takes 15 s without a frame for a dead link
    // (a still Mac screen made it reconnect, then give up as "unreachable").
    let gaps = [0.25, 0.35, 0.6]
    let gap = step < gaps.count ? gaps[step] : 5
    queue.asyncAfter(deadline: .now() + gap) { [weak self] in
      guard let self, self.active, self.flow, self.refineTicket == ticket, self.waiting == nil,
        let pixel = self.last,
        CVPixelBufferGetWidth(pixel) == self.encoder.width, CVPixelBufferGetHeight(pixel) == self.encoder.height
      else { return }
      if self.credits > 0 {
        self.credits -= 1
        self.refined += 1
        // Same clock as the captured frames: the last one's time plus the wait.
        let now = ProcessInfo.processInfo.systemUptime
        let time = CMTimeAdd(self.lastTime, CMTime(seconds: now - self.lastWall, preferredTimescale: 1_000_000))
        self.lastWall = now
        self.encoder.encode(pixel, time: self.monotonic(time))
      }
      self.scheduleRefine(ticket: ticket, step: step + 1)
    }
  }
  func stream(
    _ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer,
    of type: SCStreamOutputType
  ) {
    guard active, type == .screen, sample.isValid, let pixel = sample.imageBuffer,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]],
      let status = attachments.first?[.status] as? Int,
      status == SCFrameStatus.complete.rawValue
    else { return }
    if let next = pending {
      guard CVPixelBufferGetWidth(pixel) == next.width, CVPixelBufferGetHeight(pixel) == next.height else {
        // Still the previous size: keep showing it until the change lands.
        admit(pixel, sample.presentationTimeStamp)
        return
      }
      let previous = encoder
      encoder = next
      pending = nil
      waiting = nil
      last = nil
      previous.close()
    }
    admit(pixel, sample.presentationTimeStamp)
  }
}

/// Lets an encoder's callback thread hand a lost frame's room back to the
/// capture output that gave it.
final class FlowRefund: @unchecked Sendable {
  weak var output: CaptureOutput?
}

@MainActor final class Capture: NSObject, SCStreamDelegate {
  var stream: SCStream?
  var output: CaptureOutput? {
    didSet { refunds.output = output }
  }
  var encoder: Encoder? { output?.encoder }
  /// Set by the host for phones that confirm frames: the encoder rate that
  /// the phone's connection carries, applied to every encoder of the session.
  var flow = false
  var bitrateTarget: Int?
  let refunds = FlowRefund()
  func makeEncoder(width: Int, height: Int) throws -> Encoder {
    let refunds = self.refunds
    // Confirmed frames never go missing, so a full picture is only needed on
    // request (a decoder reset on the phone), not every second: at a low rate
    // those full pictures ate most of the budget.
    let encoder = try Encoder(
      width: width, height: height, keyInterval: flow ? 10 : 1,
      onDrop: flow ? { refunds.output?.refund() } : nil)
    if flow, let bitrateTarget {
      encoder.setBitrate(min(bitrateTarget, Encoder.screenBitrate(width: width, height: height)))
    }
    return encoder
  }
  /// The host's rate for the phone's connection, capped by the picture size.
  func setBitrate(_ bitrate: Int) -> Int {
    bitrateTarget = bitrate
    guard let encoder else { return bitrate }
    let applied = min(bitrate, Encoder.screenBitrate(width: encoder.width, height: encoder.height))
    encoder.setBitrate(applied)
    return applied
  }
  var timer: DispatchSourceTimer?
  var rect = CGRect(x: 0, y: 0, width: 1280, height: 800)
  var sourceSize = CGSize(width: 1280, height: 800)
  var targetWindow: UInt32 = 0
  var targetPID: pid_t = 0
  let queue = DispatchQueue(label: "palm.capture", qos: .userInteractive)
  var generation: UInt64 = 0
  var onUnexpectedStop: (() -> Void)?
  let syntheticInput = SyntheticInputState()
  // Windows Palm itself draws (the privacy curtain) are never part of video.
  var excludedWindowIDs: () -> [CGWindowID] = { [] }
  var capturingDisplay: SCDisplay?
  var configuration: SCStreamConfiguration?
  var backingScale: CGFloat = 2
  var zoomQuality: Double = 1
  /// Re-encodes the live stream for the phone's zoom (see encodedSize).
  func setQuality(zoom: Double) async throws -> [String: Any] {
    guard let stream, let output, let configuration else {
      throw PalmError(message: "Start the live screen first.")
    }
    let steps = zoom < 1.25 ? 1 : zoom < 1.75 ? 1.5 : zoom < 2.5 ? 2 : zoom < 3.5 ? 3 : 4
    let (w, h) = PhoneLayoutGeometry.encodedSize(sourceSize, zoom: steps, backing: backingScale)
    if w == configuration.width && h == configuration.height {
      zoomQuality = steps
      return ["width": w, "height": h, "unchanged": true]
    }
    let ticket = generation
    let next = try makeEncoder(width: w, height: h)
    output.replace(next)
    configuration.width = w
    configuration.height = h
    try await stream.updateConfiguration(configuration)
    guard ticket == generation, self.stream === stream else {
      throw PalmError(message: "Screen session changed.")
    }
    zoomQuality = steps
    return ["width": w, "height": h]
  }
  func refreshExclusions() async {
    guard let stream, let display = capturingDisplay else { return }
    guard let content = try? await SCShareableContent.excludingDesktopWindows(
      true, onScreenWindowsOnly: true)
    else { return }
    let ids = excludedWindowIDs()
    let excluded = content.windows.filter { ids.contains($0.windowID) }
    try? await stream.updateContentFilter(SCContentFilter(display: display, excludingWindows: excluded))
  }
  func start(
    windowId: UInt32, synthetic: Bool, portrait: Bool = false,
    expectedPID: pid_t = 0, viewport: CGSize? = nil, displayId: CGDirectDisplayID? = nil,
    flow: Bool = false, bitrate: Int? = nil
  ) async throws -> [String: Any] {
    generation &+= 1
    let ticket = generation
    await stopResources()
    try require(generation == ticket, "Screen session changed. Open the window again.")
    self.flow = flow
    bitrateTarget = flow ? bitrate : nil
    targetWindow = windowId
    targetPID = 0
    capturingDisplay = nil
    if synthetic {
      let size =
        portrait && windowId > 0
        ? PhoneLayoutGeometry.syntheticSize(viewport: viewport) ?? CGSize(width: 1280, height: 800)
        : CGSize(width: 1280, height: 800)
      rect = CGRect(origin: .zero, size: size)
      sourceSize = size
      let pixelSize =
        portrait && windowId > 0 && viewport != nil
        ? PhoneLayoutGeometry.encodedSize(size) : (Int(size.width), Int(size.height))
      let encoder = try makeEncoder(width: pixelSize.0, height: pixelSize.1)
      let output = CaptureOutput(encoder: encoder, queue: queue)
      if flow { output.enableFlow() }
      self.output = output
      let timer = DispatchSource.makeTimerSource(queue: queue)
      self.timer = timer
      timer.schedule(deadline: .now(), repeating: 1.0 / 30.0)
      var frame = 0
      let input = syntheticInput
      timer.setEventHandler {
        guard !input.still else { return }
        frame += 1
        Self.drawSynthetic(
          encoder: encoder, size: CGSize(width: pixelSize.0, height: pixelSize.1), sourceSize: size,
          frame: frame, inputSequence: input.current(),
          sink: { pixel, time in output.offer(pixel, time: time) })
      }
      timer.resume()
      return [
        "width": pixelSize.0, "height": pixelSize.1,
        "sourceWidth": size.width, "sourceHeight": size.height,
        "target": "Test canvas", "synthetic": true,
      ]
    }
    try require(
      CGPreflightScreenCaptureAccess(),
      "Allow Screen Recording for Palm Companion on your Mac, then restart Palm.")
    let content = try await SCShareableContent.excludingDesktopWindows(
      true, onScreenWindowsOnly: true)
    try require(generation == ticket, "Screen session changed. Open the window again.")
    let filter: SCContentFilter
    var title = "Desktop"
    if windowId > 0 {
      guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
        throw PalmError(message: "That window is no longer available.")
      }
      try require(
        expectedPID > 0 && window.owningApplication?.processID == expectedPID,
        "The selected window changed applications. Choose it again.")
      rect = window.frame
      targetPID = window.owningApplication?.processID ?? 0
      filter = SCContentFilter(desktopIndependentWindow: window)
      title = window.owningApplication?.applicationName ?? "Window"
    } else {
      // The display chosen on the phone (a Mac with several screens), else the main one.
      guard
        let display = content.displays.first(where: { $0.displayID == (displayId ?? CGMainDisplayID()) })
          ?? content.displays.first(where: { $0.displayID == CGMainDisplayID() })
          ?? content.displays.first
      else { throw PalmError(message: "No display is available.") }
      rect = CGDisplayBounds(display.displayID)
      let ids = excludedWindowIDs()
      filter = SCContentFilter(
        display: display, excludingWindows: content.windows.filter { ids.contains($0.windowID) })
      capturingDisplay = display
    }
    sourceSize = rect.size
    backingScale = NSScreen.screens.first(where: { $0.frame.intersects(rect) })?.backingScaleFactor
      ?? NSScreen.main?.backingScaleFactor ?? 2
    zoomQuality = 1
    let (w, h) = PhoneLayoutGeometry.encodedSize(sourceSize)
    let config = SCStreamConfiguration()
    config.width = w
    config.height = h
    config.scalesToFit = true
    config.preservesAspectRatio = true
    config.ignoreShadowsSingleWindow = true
    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    // Flow control may hold two pictures (the waiting one and the last one).
    config.queueDepth = 5
    config.showsCursor = true
    config.capturesAudio = false
    config.pixelFormat = kCVPixelFormatType_32BGRA
    let output = CaptureOutput(encoder: try makeEncoder(width: w, height: h), queue: queue)
    if flow { output.enableFlow() }
    self.output = output
    configuration = config
    let s = SCStream(filter: filter, configuration: config, delegate: self)
    stream = s
    do {
      try s.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
      try await s.startCapture()
      try require(
        generation == ticket && stream === s,
        "Screen session changed. Open the window again.")
    } catch {
      if generation == ticket { await stop() } else { try? await s.stopCapture() }
      throw error
    }
    return [
      "width": w, "height": h, "sourceWidth": sourceSize.width,
      "sourceHeight": sourceSize.height, "target": title, "synthetic": false,
    ]
  }
  func stop() async {
    generation &+= 1
    await stopResources()
  }
  private func stopResources() async {
    timer?.cancel()
    timer = nil
    let previous = stream
    stream = nil
    output?.close()
    output = nil
    configuration = nil
    // Detach before suspending: a late stop may only touch its own stream.
    if let previous { try? await previous.stopCapture() }
  }
  nonisolated func stream(_ stream: SCStream, didStopWithError error: Error) {
    Task { @MainActor [weak self] in
      guard let self, self.stream === stream else { return }
      self.onUnexpectedStop?()
      emit(["event": "error", "message": "Screen sharing stopped. Reconnect to continue."])
    }
  }
  nonisolated static func drawSynthetic(
    encoder: Encoder, size: CGSize, sourceSize: CGSize, frame: Int, inputSequence: Int,
    sink: ((CVPixelBuffer, CMTime) -> Void)? = nil
  ) {
    var pixel: CVPixelBuffer?
    CVPixelBufferCreate(
      kCFAllocatorDefault, Int(size.width), Int(size.height), kCVPixelFormatType_32BGRA,
      [
        kCVPixelBufferCGImageCompatibilityKey: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey: true,
        kCVPixelBufferIOSurfacePropertiesKey: [:],
      ] as CFDictionary, &pixel)
    guard let pixel = pixel else { return }
    CVPixelBufferLockBaseAddress(pixel, [])
    if let context = CGContext(
      data: CVPixelBufferGetBaseAddress(pixel), width: Int(size.width), height: Int(size.height),
      bitsPerComponent: 8,
      bytesPerRow: CVPixelBufferGetBytesPerRow(pixel), space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    {
      if let picture = DemoScreen.current() {
        // Demo recordings (PALM_SYNTHETIC_SCREEN): a sample desktop picture
        // instead of the test pattern, filling the screen.
        let scale = max(size.width / CGFloat(picture.width), size.height / CGFloat(picture.height))
        let w = CGFloat(picture.width) * scale, h = CGFloat(picture.height) * scale
        context.interpolationQuality = .high
        context.draw(picture, in: CGRect(x: (size.width - w) / 2, y: (size.height - h) / 2, width: w, height: h))
        CVPixelBufferUnlockBaseAddress(pixel, [])
        let time = CMTime(value: Int64(frame), timescale: 30)
        if let sink { sink(pixel, time) } else { encoder.encode(pixel, time: time) }
        return
      }
      context.saveGState()
      context.scaleBy(x: size.width / sourceSize.width, y: size.height / sourceSize.height)
      let canvas = sourceSize
      context.setFillColor(CGColor(red: 0.09, green: 0.09, blue: 0.10, alpha: 1))
      context.fill(CGRect(origin: .zero, size: canvas))
      context.setFillColor(CGColor(gray: 0.93, alpha: 1))
      let x = CGFloat(frame % 300) * 3
      context.fillEllipse(in: CGRect(x: 100 + x, y: 280, width: 150, height: 150))
      context.setFillColor(CGColor(red: 0.24, green: 0.24, blue: 0.26, alpha: 1))
      for i in 0..<6 {
        context.fill(
          CGRect(x: 100, y: CGFloat(60 + i * 90), width: 400 + CGFloat(i * 40), height: 25))
      }
      func label(
        _ text: String, x: CGFloat, y: CGFloat, fontSize: CGFloat, centered: Bool = false,
        color: CGColor = CGColor(gray: 1, alpha: 1)
      ) {
        let attributed = NSAttributedString(
          string: text,
          attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName(
              "Helvetica" as CFString, fontSize, nil),
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
          ])
        let line = CTLineCreateWithAttributedString(attributed)
        let width = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
        context.textMatrix = .identity
        context.textPosition = CGPoint(x: centered ? x - width / 2 : x, y: y)
        CTLineDraw(line, context)
      }
      label("SYNTHETIC TEST", x: 24, y: canvas.height - 44, fontSize: 28)
      context.setFillColor(CGColor(red: 0.14, green: 0.14, blue: 0.15, alpha: 1))
      context.fill(CGRect(x: 24, y: canvas.height / 2 - 120, width: canvas.width - 48, height: 240))
      label(
        "Sample window", x: canvas.width / 2, y: canvas.height / 2 + 65, fontSize: 28,
        centered: true)
      label(
        "Phone Layout preview", x: canvas.width / 2, y: canvas.height / 2 + 22, fontSize: 24,
        centered: true)
      context.setFillColor(CGColor(gray: 0.93, alpha: 1))
      context.fill(
        CGRect(x: canvas.width / 2 - 90, y: canvas.height / 2 - 64, width: 180, height: 44))
      label(
        "Tap target", x: canvas.width / 2, y: canvas.height / 2 - 50, fontSize: 24, centered: true,
        color: CGColor(gray: 0.08, alpha: 1))
      context.restoreGState()
      // Fixed top-left encoded-pixel marker for test input-to-visible timing.
      context.setFillColor(
        inputSequence % 2 == 0
          ? CGColor(red: 0, green: 1, blue: 1, alpha: 1)
          : CGColor(red: 1, green: 0, blue: 1, alpha: 1))
      context.fill(CGRect(x: 24, y: size.height - 80 - 48, width: 48, height: 48))
      label("Tap \(inputSequence)", x: 88, y: size.height - 114, fontSize: 24)
    }
    CVPixelBufferUnlockBaseAddress(pixel, [])
    let time = CMTime(value: Int64(frame), timescale: 30)
    if let sink { sink(pixel, time) } else { encoder.encode(pixel, time: time) }
  }
}

/// Test host only: the picture PALM_SYNTHETIC_SCREEN names stands in for the
/// Mac screen in demo recordings. It is read again when the file changes, so a
/// scripted demo can change what the "Mac" shows.
enum DemoScreen {
  nonisolated(unsafe) private static var image: CGImage?
  nonisolated(unsafe) private static var stamp: Date?
  nonisolated(unsafe) private static var checked = Date.distantPast
  private static let lock = NSLock()
  static func current() -> CGImage? {
    guard let path = ProcessInfo.processInfo.environment["PALM_SYNTHETIC_SCREEN"], !path.isEmpty else { return nil }
    lock.lock(); defer { lock.unlock() }
    if Date().timeIntervalSince(checked) > 0.25 {
      checked = Date()
      let modified = (try? FileManager.default.attributesOfItem(atPath: path))?[.modificationDate] as? Date
      if modified != stamp, let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
        let loaded = CGImageSourceCreateImageAtIndex(source, 0, nil)
      {
        image = loaded
        stamp = modified
      }
    }
    return image
  }
}

@MainActor final class Companion {
  let capture = Capture()
  let media = PalmMedia()
  let talk = PalmTalkSpeaker()
  let rtc = PalmRTC()
  let curtain = PalmCurtain()
  var syntheticCurtain = false
  /// Installed apps for the phone's app picker; reading them takes a moment.
  var installedCache: (at: Date, items: [[String: Any]])?
  /// The Dock's items as last listed for the phone, pressed by position.
  var dockElements: [AXUIElement] = []
  var syntheticBrightness: Float = 0.6
  var syntheticKeyboardLight: Float = 0.5
  var syntheticKeyboardAuto = true
  let synthetic = CommandLine.arguments.contains("--synthetic")
  var controlling = false
  var menuItem: NSStatusItem?
  var availableActions: [String: AXUIElement] = [:]
  var actionPID: pid_t = 0
  var primaryDown = false
  var lastPointer = CGPoint.zero
  var sessionGeneration: UInt64 = 0
  struct LayoutRecord {
    let windowID: UInt32
    let pid: pid_t
    let element: AXUIElement
    let original: CGRect
    let applied: CGRect
  }
  struct LayoutOutcome {
    let state: [String: Any]
    let expectedSize: CGSize?
  }
  var appliedLayout: LayoutRecord?

  @discardableResult func invalidateSession() -> UInt64 {
    sessionGeneration &+= 1
    releasePointer()
    controlling = false
    availableActions = [:]
    actionPID = 0
    showMenuState(sharing: false)
    return sessionGeneration
  }
  func requireSession(_ ticket: UInt64) throws {
    try require(ticket == sessionGeneration, "Screen session changed. Open the window again.")
  }
  func requestedViewport(_ command: [String: Any], enabled: Bool) throws -> CGSize? {
    guard command["phoneLayoutWidth"] != nil || command["phoneLayoutHeight"] != nil else {
      return nil
    }
    guard enabled, let width = command["phoneLayoutWidth"] as? NSNumber,
      let height = command["phoneLayoutHeight"] as? NSNumber,
      CFGetTypeID(width) != CFBooleanGetTypeID(), CFGetTypeID(height) != CFBooleanGetTypeID()
    else { throw PalmError(message: "Invalid Phone Layout viewport.") }
    let size = CGSize(width: width.doubleValue, height: height.doubleValue)
    try require(PhoneLayoutGeometry.validViewport(size), "Invalid Phone Layout viewport.")
    return size
  }
  func stopSession() async -> String {
    let ticket = invalidateSession()
    await capture.stop()
    return await restorePhoneLayout(ticket: ticket)
  }
  func releasePointer() {
    guard primaryDown, !synthetic else { return }
    CGEvent(
      mouseEventSource: nil, mouseType: .leftMouseUp,
      mouseCursorPosition: lastPointer, mouseButton: .left)?.post(tap: .cghidEventTap)
    primaryDown = false
  }
  func attribute(_ e: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    if AXUIElementCopyAttributeValue(e, key as CFString, &value) == .success { return value }
    return nil
  }
  func axFrame(_ window: AXUIElement) -> CGRect? {
    guard let position = attribute(window, kAXPositionAttribute),
      let size = attribute(window, kAXSizeAttribute),
      CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
    else { return nil }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
      AXValueGetValue(size as! AXValue, .cgSize, &dimensions)
    else { return nil }
    return CGRect(origin: point, size: dimensions)
  }
  func windowInfo(_ id: UInt32) -> (pid: pid_t, frame: CGRect, title: String)? {
    guard id > 0,
      let infos = CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]],
      let info = infos.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == id }),
      let pid = info[kCGWindowOwnerPID as String] as? Int32,
      let bounds = info[kCGWindowBounds as String] as? [String: Any],
      let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary)
    else { return nil }
    return (pid, frame, info[kCGWindowName as String] as? String ?? "")
  }
  func exactAXWindow(_ id: UInt32) -> (pid: pid_t, frame: CGRect, element: AXUIElement)? {
    guard let info = windowInfo(id) else { return nil }
    let windows =
      attribute(AXUIElementCreateApplication(info.pid), kAXWindowsAttribute)
      as? [AXUIElement] ?? []
    let matching = windows.filter {
      guard let frame = axFrame($0), PhoneLayoutGeometry.near(frame, info.frame) else {
        return false
      }
      let title = attribute($0, kAXTitleAttribute) as? String ?? ""
      return info.title.isEmpty || title == info.title
    }
    guard matching.count == 1 else { return nil }
    return (info.pid, info.frame, matching[0])
  }
  // AX position and size are separate app operations. AppKit can constrain a
  // tall resize at the old origin, or move the origin while resizing. Let each
  // operation settle, then correct the final position. Every wait is guarded
  // by the session and the exact last frame Palm itself observed applying.
  func layoutDiagnostic(_ phase: String, record: LayoutRecord, code: AXError? = nil) {
    guard ProcessInfo.processInfo.environment["PALM_TEST_LAYOUT_DIAGNOSTIC"] == "1",
      NSRunningApplication(processIdentifier: record.pid)?.bundleIdentifier == "local.palm.testpad"
    else { return }
    func coordinates(_ r: CGRect) -> [String: CGFloat] {
      ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
    }
    var result: [String: Any] = [
      "event": "layoutDiagnostic", "phase": phase,
      "applied": coordinates(record.applied),
    ]
    if let ax = axFrame(record.element) { result["ax"] = coordinates(ax) }
    if let info = windowInfo(record.windowID) { result["cg"] = coordinates(info.frame) }
    if let code { result["code"] = code.rawValue }
    emit(result)
  }
  func waitForLayoutFrame(_ record: LayoutRecord, ticket: UInt64) async -> String {
    // AppKit publishes the new AX frame before the WindowServer animation has
    // reached it. Wait only while AX still equals our known applied frame.
    // A changed AX frame is not absorbed into the restoration lease.
    for attempt in 0...30 {
      guard sessionGeneration == ticket else { return "superseded" }
      var pid: pid_t = 0
      guard AXUIElementGetPid(record.element, &pid) == .success, pid == record.pid,
        let ax = axFrame(record.element), let info = windowInfo(record.windowID),
        info.pid == record.pid
      else { return "unavailable" }
      let settlement = PhoneLayoutGeometry.settlement(
        ax: ax, windowServer: info.frame, applied: record.applied)
      if settlement == "userChanged" {
        appliedLayout = nil
        return "userChanged"
      }
      if settlement == "ready" {
        guard let exact = exactAXWindow(record.windowID), exact.pid == record.pid,
          CFEqual(exact.element, record.element)
        else { return "unavailable" }
        return "ready"
      }
      if attempt < 30 { try? await Task.sleep(nanoseconds: 40_000_000) }
    }
    return "unavailable"
  }
  func setLayoutFrame(_ frame: CGRect, ticket: UInt64) async -> String {
    guard var record = appliedLayout else { return "unavailable" }
    var size = frame.size
    var point = frame.origin
    guard let sizeValue = AXValueCreate(.cgSize, &size),
      let positionValue = AXValueCreate(.cgPoint, &point)
    else { return "failed" }
    let steps: [(String, AXValue)] = [
      (kAXPositionAttribute, positionValue),
      (kAXSizeAttribute, sizeValue),
      (kAXPositionAttribute, positionValue),
    ]
    for (key, value) in steps {
      let ready = await waitForLayoutFrame(record, ticket: ticket)
      guard sessionGeneration == ticket else { return "superseded" }
      guard ready == "ready" else { return ready }
      layoutDiagnostic("before-" + key, record: record)
      guard sessionGeneration == ticket else { return "superseded" }
      guard let exact = exactAXWindow(record.windowID), exact.pid == record.pid,
        CFEqual(exact.element, record.element)
      else { return "unavailable" }
      guard PhoneLayoutGeometry.shouldRestore(current: exact.frame, applied: record.applied)
      else {
        appliedLayout = nil
        return "userChanged"
      }
      let code = AXUIElementSetAttributeValue(record.element, key as CFString, value)
      guard let immediate = axFrame(record.element) else { return "unavailable" }
      record = LayoutRecord(
        windowID: record.windowID, pid: record.pid, element: record.element,
        original: record.original, applied: immediate)
      // A stop or newer start can now restore this intermediate applied frame.
      appliedLayout = record
      layoutDiagnostic("immediate-" + key, record: record, code: code)
      let settledResult = await waitForLayoutFrame(record, ticket: ticket)
      guard sessionGeneration == ticket else { return "superseded" }
      layoutDiagnostic("settled-" + key + "-" + settledResult, record: record, code: code)
      guard settledResult == "ready" else { return settledResult }
      guard let settled = exactAXWindow(record.windowID), settled.pid == record.pid,
        CFEqual(settled.element, record.element)
      else { return "unavailable" }
      guard PhoneLayoutGeometry.shouldRestore(current: settled.frame, applied: record.applied)
      else {
        layoutDiagnostic("userChanged-" + key, record: record, code: code)
        appliedLayout = nil
        return "userChanged"
      }
      guard code == .success else { return "failed" }
    }
    return PhoneLayoutGeometry.shouldRestore(current: record.applied, applied: frame)
      ? "applied" : "unsupported"
  }
  func restorePhoneLayout(ticket: UInt64) async -> String {
    guard sessionGeneration == ticket else { return "superseded" }
    guard let record = appliedLayout else { return "unchanged" }
    let ready = await waitForLayoutFrame(record, ticket: ticket)
    guard sessionGeneration == ticket else { return "superseded" }
    guard ready == "ready" else { return ready }
    guard let exact = exactAXWindow(record.windowID), exact.pid == record.pid,
      CFEqual(exact.element, record.element)
    else { return "unavailable" }
    // Never undo a move/resize made on the Mac after Palm's own change.
    guard PhoneLayoutGeometry.shouldRestore(current: exact.frame, applied: record.applied) else {
      appliedLayout = nil
      return "userChanged"
    }
    let result = await setLayoutFrame(record.original, ticket: ticket)
    guard sessionGeneration == ticket else { return "superseded" }
    if result == "applied" {
      appliedLayout = nil
      return "restored"
    }
    return result == "unsupported" ? "failed" : result
  }
  func phoneLayout(
    windowID: UInt32, expectedPID: pid_t, requested: Bool, ticket: UInt64,
    viewport: CGSize? = nil, fill: Bool = false
  )
    async throws -> LayoutOutcome
  {
    func state(
      _ name: String, _ reason: String? = nil, applied: Bool = false,
      expectedSize: CGSize? = nil
    ) -> LayoutOutcome {
      var result: [String: Any] = ["requested": requested, "applied": applied, "state": name]
      if let reason { result["reason"] = reason }
      return LayoutOutcome(state: result, expectedSize: expectedSize)
    }
    guard requested else { return state("off") }
    guard windowID > 0 else {
      return state("desktop", "Phone Layout applies to one app window, not the desktop.")
    }
    if synthetic {
      if PhoneLayoutGeometry.syntheticSize(viewport: viewport) == nil {
        return state(
          "unsupported",
          "The requested viewport cannot fit the synthetic work area at a readable size.")
      }
      return state("synthetic", "Viewport test canvas; no Mac window was changed.")
    }
    // A failed restore keeps the original geometry available for a later retry.
    // Keep viewing possible, but never overwrite that lease with another resize.
    guard appliedLayout == nil else {
      return state(
        "unsupported",
        "Palm could not restore the previous window yet. Sharing this window at its current size.")
    }
    guard AXIsProcessTrusted() else {
      return state("unsupported", "Allow Accessibility on the Mac to adapt this window.")
    }
    guard let target = exactAXWindow(windowID) else {
      return state(
        "unsupported",
        "Palm could not identify one exact resizable app window. Sharing its current size.")
    }
    try require(
      target.pid == expectedPID, "The selected window changed applications. Choose it again.")
    if fill, attribute(target.element, "AXFullScreen") as? Bool == true {
      return state("fullScreen", "This window is already full screen.")
    }
    guard attribute(target.element, "AXFullScreen") as? Bool != true,
      attribute(target.element, kAXMinimizedAttribute) as? Bool != true
    else {
      return state("unsupported", "Leave full screen or restore this window to use Phone Layout.")
    }
    var sizeSettable = DarwinBoolean(false)
    var positionSettable = DarwinBoolean(false)
    guard
      AXUIElementIsAttributeSettable(target.element, kAXSizeAttribute as CFString, &sizeSettable)
        == .success,
      AXUIElementIsAttributeSettable(
        target.element, kAXPositionAttribute as CFString, &positionSettable) == .success,
      sizeSettable.boolValue, positionSettable.boolValue
    else {
      return state(
        "unsupported", "This app does not allow its window to be resized. Sharing its current size."
      )
    }
    // NSScreen is bottom-left; CGWindow and AX are top-left relative to the primary display.
    let primaryHeight = CGDisplayBounds(CGMainDisplayID()).height
    let workAreas = NSScreen.screens.map { screen in
      let r = screen.visibleFrame
      return CGRect(x: r.minX, y: primaryHeight - r.maxY, width: r.width, height: r.height)
    }
    let workArea = workAreas.max {
      let a = $0.intersection(target.frame)
      let b = $1.intersection(target.frame)
      return (a.isNull ? 0 : a.width * a.height) < (b.isNull ? 0 : b.width * b.height)
    }
    guard let workArea, workArea.intersects(target.frame),
      let proposed = fill
        ? PhoneLayoutGeometry.fill(workArea: workArea)
        : PhoneLayoutGeometry.proposal(
          original: target.frame, workArea: workArea, viewport: viewport)
    else {
      return state(
        "unsupported", "This display cannot fit the requested phone layout at a readable size.")
    }
    try requireSession(ticket)
    if PhoneLayoutGeometry.near(target.frame, proposed) {
      return state("applied", applied: true, expectedSize: proposed.size)
    }
    appliedLayout = LayoutRecord(
      windowID: windowID, pid: target.pid,
      element: target.element, original: target.frame, applied: target.frame)
    let result = await setLayoutFrame(proposed, ticket: ticket)
    if let record = appliedLayout { layoutDiagnostic("layoutResult-" + result, record: record) }
    try requireSession(ticket)
    guard result == "applied" else {
      _ = await restorePhoneLayout(ticket: ticket)
      try requireSession(ticket)
      return state(
        "unsupported",
        fill
          ? "This app could not fill the screen. Sharing its current window size."
          : "This app could not use the requested phone layout. Sharing its current window size.")
    }
    return state("applied", applied: true, expectedSize: proposed.size)
  }
  func phoneActions() throws -> [String: Any] {
    if synthetic {
      return [
        "app": "Sample Editor",
        "actions": [
          ["id": "00000000-0000-0000-0000-000000000001", "title": "Save document"],
          ["id": "00000000-0000-0000-0000-000000000002", "title": "New note"],
        ],
      ]
    }
    try require(AXIsProcessTrusted(), "Allow Accessibility on your Mac to use app actions.")
    try requireTarget()
    guard let app = NSWorkspace.shared.frontmostApplication else {
      return ["app": "Desktop", "actions": []]
    }
    availableActions = [:]
    actionPID = app.processIdentifier
    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    guard let window = attribute(appElement, kAXFocusedWindowAttribute) else {
      return ["app": app.localizedName ?? "App", "actions": []]
    }
    guard CFGetTypeID(window) == AXUIElementGetTypeID() else {
      return ["app": app.localizedName ?? "App", "actions": []]
    }
    var queue: [AXUIElement] = [window as! AXUIElement]
    var results: [[String: Any]] = []
    var seen = 0
    while !queue.isEmpty && seen < 250 && results.count < 30 {
      let element = queue.removeFirst()
      seen += 1
      let role = attribute(element, kAXRoleAttribute) as? String ?? ""
      if [kAXButtonRole, kAXCheckBoxRole, kAXRadioButtonRole, kAXPopUpButtonRole].contains(role),
        attribute(element, kAXEnabledAttribute) as? Bool != false
      {
        let title =
          (attribute(element, kAXTitleAttribute) as? String).flatMap { $0.isEmpty ? nil : $0 }
          ?? (attribute(element, kAXDescriptionAttribute) as? String ?? "")
        var names: CFArray?
        AXUIElementCopyActionNames(element, &names)
        if !title.isEmpty && title.count < 90 && (names as? [String] ?? []).contains(kAXPressAction)
        {
          let id = UUID().uuidString
          availableActions[id] = element
          results.append(["id": id, "title": title])
        }
      }
      if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
        queue.append(contentsOf: children.prefix(60))
      }
    }
    return ["app": app.localizedName ?? "App", "actions": results]
  }
  func requireTarget() throws {
    try require(
      controlling && capture.stream != nil,
      "Start a screen session before using controls.")
    guard capture.targetPID > 0 else { return }
    try require(
      NSWorkspace.shared.frontmostApplication?.processIdentifier == capture.targetPID,
      "The front app changed on your Mac. Open your chosen app again before controlling it.")
    let windows =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    let frontWindow = Self.frontWindow(of: capture.targetPID, target: capture.targetWindow, in: windows)
    try require(
      (frontWindow?[kCGWindowNumber as String] as? UInt32) == capture.targetWindow,
      "The selected window is no longer in front. Bring it forward on your Mac before controlling it."
    )
    if let bounds = frontWindow?[kCGWindowBounds as String] as? [String: Any],
      let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary)
    {
      try require(
        abs(rect.width - capture.sourceSize.width) < 2
          && abs(rect.height - capture.sourceSize.height) < 2,
        "The window was resized on your Mac. Reopen it in Palm before using controls.")
      capture.rect = rect
    } else {
      throw PalmError(message: "The selected window geometry is unavailable.")
    }
  }
  /// The app's window that input would reach: the chosen window, unless a real
  /// window of the same app lies over it. Helper windows (tiny, invisible, or
  /// elsewhere on screen), which apps such as ChatGPT keep, do not count: they
  /// made Palm refuse every touch and key on a window that was in front.
  static func frontWindow(of pid: pid_t, target: UInt32, in windows: [[String: Any]]) -> [String: Any]? {
    func frame(_ window: [String: Any]) -> CGRect? {
      (window[kCGWindowBounds as String] as? [String: Any]).flatMap { CGRect(dictionaryRepresentation: $0 as CFDictionary) }
    }
    let mine = windows.filter {
      ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0
    }
    let chosen = mine.first { ($0[kCGWindowNumber as String] as? UInt32) == target }
    let chosenFrame = chosen.flatMap(frame)
    return mine.first { window in
      if (window[kCGWindowNumber as String] as? UInt32) == target { return true }
      let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
      guard alpha > 0.05, let rect = frame(window), rect.width >= 60, rect.height >= 60 else { return false }
      guard let chosenFrame else { return true }
      return rect.intersection(chosenFrame).width * rect.intersection(chosenFrame).height > 1600
    }
  }

  /// Brings an app to the front. `activate` is only a request on recent macOS and
  /// is often ignored when it comes from a background process such as Palm;
  /// Accessibility's frontmost attribute is honoured for a trusted process.
  func bringToFront(_ app: NSRunningApplication) {
    app.unhide()
    if AXIsProcessTrusted() {
      AXUIElementSetAttributeValue(
        AXUIElementCreateApplication(app.processIdentifier), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    }
    _ = app.activate(options: [.activateAllWindows])
  }

  /// The Accessibility window for a window-server window, matched by frame and title.
  func axWindow(_ windowID: UInt32, pid: pid_t) -> AXUIElement? {
    let infos = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]] ?? []
    guard let info = infos.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == windowID }),
      let bounds = info[kCGWindowBounds as String] as? [String: Any],
      let expected = CGRect(dictionaryRepresentation: bounds as CFDictionary)
    else { return nil }
    let title = info[kCGWindowName as String] as? String ?? ""
    let windows = attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement] ?? []
    let matching = windows.prefix(64).filter { window in
      guard let rect = axFrame(window) else { return false }
      let axTitle = attribute(window, kAXTitleAttribute) as? String ?? ""
      return abs(rect.minX - expected.minX) < 2 && abs(rect.minY - expected.minY) < 2
        && abs(rect.width - expected.width) < 2 && abs(rect.height - expected.height) < 2
        && (title.isEmpty || axTitle == title)
    }
    return matching.count == 1 ? matching[0] : nil
  }

  /// Before input: if the chosen app or window is no longer in front, bring it
  /// back (the phone shows it, so that is where the touch or key belongs), then
  /// check again. Only a window that is gone, resized or cannot be brought back
  /// stops input.
  func ensureTarget() async throws {
    do {
      try requireTarget()
    } catch {
      guard controlling, capture.stream != nil, capture.targetPID > 0, capture.targetWindow > 0, AXIsProcessTrusted(),
        let app = NSRunningApplication(processIdentifier: capture.targetPID)
      else { throw error }
      bringToFront(app)
      if let window = axWindow(capture.targetWindow, pid: capture.targetPID) {
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
      }
      for _ in 0..<8 {
        try? await Task.sleep(nanoseconds: 50_000_000)
        if (try? requireTarget()) != nil { return }
      }
      try requireTarget()
    }
  }

  func waitForFrontWindow(pid: pid_t, windowID: UInt32? = nil, ticket: UInt64) async throws
    -> UInt32
  {
    // Activation is a request; a Space/window animation can outlive its return.
    var stableID: UInt32?
    var stableFrame: CGRect?
    var stableSince = ProcessInfo.processInfo.systemUptime
    for attempt in 0...30 {
      try requireSession(ticket)
      if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
        let visible =
          CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
          as? [[String: Any]] ?? []
        // The app's real front window: helper windows (tiny, invisible, or
        // elsewhere) that apps such as ChatGPT and Codex keep do not count.
        if let front = Self.frontWindow(of: pid, target: windowID ?? 0, in: visible),
          let id = front[kCGWindowNumber as String] as? UInt32,
          let bounds = front[kCGWindowBounds as String] as? [String: Any],
          let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary),
          windowID == nil || id == windowID
        {
          if stableID != id
            || stableFrame.map({ !PhoneLayoutGeometry.shouldRestore(current: frame, applied: $0) })
              != false
          {
            stableID = id
            stableFrame = frame
            stableSince = ProcessInfo.processInfo.systemUptime
          }
          var identifiedAX: CGRect?
          if AXIsProcessTrusted() {
            let title = front[kCGWindowName as String] as? String ?? ""
            let windows =
              attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement]
              ?? []
            let candidates = windows.prefix(64).compactMap { element -> CGRect? in
              let axTitle = attribute(element, kAXTitleAttribute) as? String ?? ""
              guard title.isEmpty || axTitle == title else { return nil }
              return axFrame(element)
            }
            let exact = candidates.filter {
              PhoneLayoutGeometry.shouldRestore(current: frame, applied: $0)
            }
            if exact.count == 1 {
              identifiedAX = exact[0]
            } else if candidates.count == 1 {
              identifiedAX = candidates[0]
            }
          }
          if PhoneLayoutGeometry.activationReady(
            windowServer: frame, identifiedAX: identifiedAX,
            stableFor: ProcessInfo.processInfo.systemUptime - stableSince)
          {
            return id
          }
        } else {
          stableID = nil
          stableFrame = nil
        }
      } else {
        stableID = nil
        stableFrame = nil
      }
      if attempt < 30 { try? await Task.sleep(nanoseconds: 50_000_000) }
    }
    throw PalmError(
      message:
        "Palm could not bring that window to the current desktop. Bring it forward on your Mac and try again."
    )
  }
  func raiseWindow(_ windowID: UInt32, ticket: UInt64) async throws {
    guard !synthetic, windowID > 0, AXIsProcessTrusted() else { return }
    let infos =
      CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]] ?? []
    guard let info = infos.first(where: { ($0[kCGWindowNumber as String] as? UInt32) == windowID }),
      let pid = info[kCGWindowOwnerPID as String] as? Int32,
      let bounds = info[kCGWindowBounds as String] as? [String: Any],
      let expected = CGRect(dictionaryRepresentation: bounds as CFDictionary),
      let app = NSRunningApplication(processIdentifier: pid)
    else { throw PalmError(message: "That window is no longer available.") }
    let axApp = AXUIElementCreateApplication(pid)
    let windows = attribute(axApp, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let expectedTitle = info[kCGWindowName as String] as? String ?? ""
    let matching = windows.filter { window in
      guard let position = attribute(window, kAXPositionAttribute),
        let size = attribute(window, kAXSizeAttribute),
        CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
      else { return false }
      var point = CGPoint.zero
      var dimensions = CGSize.zero
      guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
        AXValueGetValue(size as! AXValue, .cgSize, &dimensions)
      else { return false }
      let title = attribute(window, kAXTitleAttribute) as? String ?? ""
      return abs(point.x - expected.minX) < 2 && abs(point.y - expected.minY) < 2
        && abs(dimensions.width - expected.width) < 2
        && abs(dimensions.height - expected.height) < 2
        && (expectedTitle.isEmpty || title == expectedTitle)
    }
    try requireSession(ticket)
    bringToFront(app)
    if matching.count == 1 {
      _ = AXUIElementPerformAction(matching[0], kAXRaiseAction as CFString)
    }
    _ = try await waitForFrontWindow(pid: pid, windowID: windowID, ticket: ticket)
  }
  /// Palm's hand for the menu bar: the shapes from scripts/render-brand.swift,
  /// cropped to the hand and drawn as a template so it follows the menu bar.
  static let handImage: NSImage = {
    // x, y, width, height, corner radius, rotation (degrees), in the 1024 box.
    let shapes: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)] = [
      (404, 450, 390, 220, 24, 0), (404, 450, 390, 384, 170, 0), (404, 262, 90, 400, 45, 0),
      (504, 204, 90, 440, 45, 0), (604, 236, 90, 420, 45, 0), (704, 318, 90, 340, 45, 0),
      (171.5, 533, 389, 104, 52, 53.9),
    ]
    let image = NSImage(size: NSSize(width: 16, height: 16), flipped: true) { _ in
      // The hand spans x 227...794 and y 204...834 of the box.
      let scale: CGFloat = 16 / 630
      let dx = -227 * scale + (16 - 567 * scale) / 2
      let dy = -204 * scale
      NSColor.black.setFill()
      for (x, y, width, height, radius, rotation) in shapes {
        let rect = CGRect(x: x * scale + dx, y: y * scale + dy, width: width * scale, height: height * scale)
        let r = min(radius * scale, rect.width / 2, rect.height / 2)
        let shape = NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r)
        if rotation != 0 {
          var turn = AffineTransform(translationByX: rect.midX, byY: rect.midY)
          turn.rotate(byDegrees: rotation)
          turn.translate(x: -rect.midX, y: -rect.midY)
          shape.transform(using: turn)
        }
        shape.fill()
      }
      return true
    }
    image.isTemplate = true
    return image
  }()

  func showMenuState(sharing: Bool) {
    guard let button = menuItem?.button else { return }
    button.image = Self.handImage
    let active = sharing || media.isRunning
    button.imagePosition = active ? .imageLeading : .imageOnly
    button.title = media.isRunning ? " Camera and mic" : sharing ? " Sharing" : ""
    button.toolTip = media.isRunning ? "Palm is sharing this Mac's camera and microphone" :
      sharing ? "Palm is sharing this Mac's screen" : "Palm"
  }

  func setupMenu() {
    menuItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    showMenuState(sharing: false)
    let menu = NSMenu()
    let title = NSMenuItem(
      title: "Palm Companion · development build", action: nil, keyEquivalent: "")
    menu.addItem(title)
    menu.addItem(NSMenuItem.separator())
    let setup = NSMenuItem(
      title: "Open Palm setup", action: #selector(openSetupFromMenu), keyEquivalent: "")
    setup.target = self
    menu.addItem(setup)
    let stop = NSMenuItem(
      title: "Stop screen sharing", action: #selector(stopFromMenu), keyEquivalent: "")
    stop.target = self
    menu.addItem(stop)
    let stopMedia = NSMenuItem(
      title: "Stop camera and microphone", action: #selector(stopMediaFromMenu), keyEquivalent: "")
    stopMedia.target = self
    menu.addItem(stopMedia)
    let quit = NSMenuItem(title: "Quit Palm", action: #selector(quitFromMenu), keyEquivalent: "")
    quit.target = self
    menu.addItem(quit)
    menuItem?.menu = menu
  }
  @objc func openSetupFromMenu() {
    let port = Int(ProcessInfo.processInfo.environment["PALM_PORT"] ?? "4318") ?? 4318
    if (1...65535).contains(port), let url = URL(string: "http://localhost:\(port)") {
      NSWorkspace.shared.open(url)
    }
  }
  @objc func quitFromMenu() {
    Task {
      talk.stop()
      media.stop()
      rtc.stop()
      _ = await stopSession()
      emit(["event": "quit"])
    }
  }
  @objc func stopFromMenu() {
    Task {
      _ = await stopSession()
      emit(["event": "stopped"])
    }
  }
  @objc func stopMediaFromMenu() {
    talk.stop()
    media.stop()
    rtc.stop()
    showMenuState(sharing: controlling)
    emit(["event": "mediaStopped"])
  }
  func icon(_ app: NSRunningApplication) -> String {
    guard let image = app.icon else { return "" }
    return png(image, side: 64)
  }
  /// An icon as a PNG exactly `side` pixels square. Drawing into an NSImage
  /// made it twice that on a Retina Mac: four times the bytes on every list
  /// (the Apps sheet came to 1.5 MB, measured 23 September).
  func png(_ image: NSImage, side: CGFloat) -> String {
    let pixels = Int(side)
    guard
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
        hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
      let context = NSGraphicsContext(bitmapImageRep: bitmap)
    else { return "" }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    image.draw(in: NSRect(x: 0, y: 0, width: side, height: side))
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { return "" }
    return "data:image/png;base64," + data.base64EncodedString()
  }
  /// The Dock's own items ("the dock still is impossible
  /// to get to"): the phone shows them at a readable size, hidden Dock or not,
  /// and pressing one does what a click in the Dock does.
  func dockItems() -> [[String: Any]] {
    if synthetic {
      return [
        ["id": 0, "title": "Sample Editor", "kind": "app", "running": true, "icon": ""],
        ["id": 1, "title": "Sample Browser", "kind": "app", "running": true, "icon": ""],
        ["id": 2, "title": "Downloads", "kind": "folder", "running": false, "icon": ""],
        ["id": 3, "title": "Trash", "kind": "trash", "running": false, "icon": ""],
      ]
    }
    guard AXIsProcessTrusted(),
      let dock = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.dock").first
    else { return [] }
    let lists = attribute(AXUIElementCreateApplication(dock.processIdentifier), kAXChildrenAttribute) as? [AXUIElement] ?? []
    var items: [AXUIElement] = []
    for list in lists where attribute(list, kAXRoleAttribute) as? String == kAXListRole {
      items += attribute(list, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }
    dockElements = items
    return items.enumerated().compactMap { index, item in
      let subrole = attribute(item, kAXSubroleAttribute) as? String ?? ""
      guard subrole != "AXSeparatorDockItem" else { return nil }
      let kind =
        subrole == "AXApplicationDockItem" ? "app"
        : subrole == "AXFolderDockItem" ? "folder"
        : subrole == "AXTrashDockItem" ? "trash"
        : subrole == "AXMinimizedWindowDockItem" ? "window" : "item"
      var icon = ""
      if let url = attribute(item, kAXURLAttribute) as? URL { icon = png(NSWorkspace.shared.icon(forFile: url.path), side: 40) }
      return [
        "id": index, "title": attribute(item, kAXTitleAttribute) as? String ?? "", "kind": kind,
        "running": attribute(item, "AXIsApplicationRunning" as CFString as String) as? Bool ?? false, "icon": icon,
      ]
    }
  }

  /// The Mac's screens (with several monitors, switch
  /// between them from the phone). The test Mac has two.
  func displays() -> [[String: Any]] {
    if synthetic {
      return [
        ["id": 1, "name": "Built-in Display", "width": 1280, "height": 800, "main": true],
        ["id": 2, "name": "Studio Display", "width": 1280, "height": 800, "main": false],
      ]
    }
    var ids = [CGDirectDisplayID](repeating: 0, count: 16)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(16, &ids, &count) == .success else { return [] }
    return ids.prefix(Int(count)).map { id in
      let bounds = CGDisplayBounds(id)
      let screen = NSScreen.screens.first {
        ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
      }
      return [
        "id": Int(id), "name": screen?.localizedName ?? "Display \(id)",
        "width": bounds.width, "height": bounds.height, "main": id == CGMainDisplayID(),
      ]
    }
  }

  /// The screen a window is on (its centre), for showing an opened app's whole screen.
  func display(containing frame: CGRect?) -> CGDirectDisplayID? {
    guard let frame else { return nil }
    var id: CGDirectDisplayID = 0
    var count: UInt32 = 0
    guard CGGetDisplaysWithPoint(CGPoint(x: frame.midX, y: frame.midY), 1, &id, &count) == .success, count > 0
    else { return nil }
    return id
  }

  /// Apps installed in the usual folders, to open one that is not running
  /// (the phone's app picker). Names, bundle ids and small icons.
  func installedApps() -> [[String: Any]] {
    if synthetic {
      return [
        ["name": "Sample Browser", "bundleId": "test.browser", "icon": ""],
        ["name": "Sample Editor", "bundleId": "test.editor", "icon": ""],
        ["name": "Sample Notes", "bundleId": "test.notes", "icon": ""],
      ]
    }
    if let cached = installedCache, Date().timeIntervalSince(cached.at) < 600 { return cached.items }
    let files = FileManager.default
    let roots = [
      "/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
      files.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path,
    ]
    var seen = Set<String>()
    var items: [[String: Any]] = []
    for root in roots {
      guard let names = try? files.contentsOfDirectory(atPath: root) else { continue }
      for name in names where name.hasSuffix(".app") {
        let path = (root as NSString).appendingPathComponent(name)
        guard let bundle = Bundle(path: path), let id = bundle.bundleIdentifier, id != "local.palm.companion",
          !seen.contains(id)
        else { continue }
        seen.insert(id)
        let shown =
          bundle.localizedInfoDictionary?["CFBundleDisplayName"] as? String
          ?? bundle.infoDictionary?["CFBundleDisplayName"] as? String
          ?? String(name.dropLast(4))
        items.append(["name": shown, "bundleId": id, "icon": png(NSWorkspace.shared.icon(forFile: path), side: 40)])
      }
    }
    items.sort { ($0["name"] as? String ?? "").localizedStandardCompare($1["name"] as? String ?? "") == .orderedAscending }
    installedCache = (Date(), items)
    return items
  }
  func apps() -> [[String: Any]] {
    if synthetic {
      return [
        [
          "name": "Sample Editor", "bundleId": "test.editor", "active": true, "icon": "",
          "windows": [["id": 7, "title": "Welcome to Palm"]],
        ],
        [
          "name": "Sample Browser", "bundleId": "test.browser", "active": false, "icon": "",
          "windows": [],
        ],
      ]
    }
    let windows =
      CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]] ?? []
    return NSWorkspace.shared.runningApplications.filter {
      $0.activationPolicy == .regular && $0.bundleIdentifier != "local.palm.companion"
    }.compactMap { app in
      guard let id = app.bundleIdentifier else { return nil }
      let wins = windows.filter {
        ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier
          && ($0[kCGWindowLayer as String] as? Int) == 0
      }.map {
        [
          "id": $0[kCGWindowNumber as String] ?? 0,
          "title": $0[kCGWindowName as String] ?? app.localizedName ?? "Window",
        ]
      }
      return [
        "name": app.localizedName ?? id, "bundleId": id, "active": app.isActive, "icon": icon(app),
        "windows": wins,
      ]
    }.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
  }
  func handle(_ x: [String: Any]) async throws -> Any {
    guard let op = x["op"] as? String else { throw PalmError(message: "Missing command.") }
    switch op {
    case "status":
      return [
        "name": synthetic ? "Sample Mac" : (Host.current().localizedName ?? "Your Mac"),
        "platform": "macOS", "version": ProcessInfo.processInfo.operatingSystemVersionString,
        "screenPermission": synthetic || CGPreflightScreenCaptureAccess(),
        "controlPermission": synthetic || AXIsProcessTrusted(), "synthetic": synthetic,
        "power": [
          "lock": synthetic || AXIsProcessTrusted(), "wake": false, "shutdown": false,
          "restart": false,
        ], "activeApp": NSWorkspace.shared.frontmostApplication?.localizedName ?? "Desktop",
      ] as [String: Any]
    case "mediaStart":
      guard let id = x["mediaSession"] as? String, !id.isEmpty, id.count <= 80 else {
        throw PalmError(message: "Missing media session.")
      }
      // A phone that makes a WebRTC call takes the Mac microphone through it.
      let result = try media.start(synthetic: synthetic, id: id, audio: !(x["rtc"] as? Bool ?? false))
      showMenuState(sharing: controlling)
      return result
    case "mediaRtcAnswer":
      try require(media.isRunning, "Turn on Camera and mic on the phone first.")
      guard let offer = x["sdp"] as? String, !offer.isEmpty, offer.utf8.count <= 20_000 else {
        throw PalmError(message: "Invalid audio call offer.")
      }
      return ["sdp": try await rtc.answer(offer: offer, synthetic: synthetic)]
    case "mediaStop":
      talk.stop()
      media.stop()
      rtc.stop()
      showMenuState(sharing: controlling)
      return ["ok": true]
    case "mediaPermissions":
      return PalmMedia.permissions(synthetic: synthetic)
    case "mediaDiagnostics":
      return ["capture": media.diagnostics, "speaker": talk.diagnostics, "rtc": await rtc.diagnostics()]
    case "mediaKeyframe":
      media.keyframe()
      return ["ok": true]
    case "mediaVideoCredit":
      guard let count = x["count"] as? Int, (1...5).contains(count) else {
        throw PalmError(message: "Invalid camera frame credit.")
      }
      media.grantVideo(count)
      return ["ok": true]
    case "mediaTalkStart":
      try require(media.isRunning, "Turn on Camera and mic on the phone first.")
      try talk.start(synthetic: synthetic)
      return ["ok": true]
    case "mediaTalkData":
      try require(media.isRunning, "Camera and mic is off.")
      guard let encoded = x["data"] as? String,
        encoded.count <= 2_000, let data = Data(base64Encoded: encoded)
      else { throw PalmError(message: "Invalid phone audio packet.") }
      return try talk.play(data)
    case "mediaTalkStop":
      talk.stop()
      return ["ok": true]
    case "apps": return apps()
    case "installedApps": return ["apps": installedApps()]
    case "displays": return ["displays": displays()]
    case "dockItems": return ["items": dockItems()]
    case "revealEdge":
      // The pointer pushed against the bottom (or top) edge of the display the
      // phone shows, as a mouse is: a hidden Dock slides out, and the Dock
      // moves over from the other display (a Mac can have several).
      let top = x["edge"] as? String == "top"
      if synthetic {
        capture.syntheticInput.note(["op": "revealEdge", "edge": top ? "top" : "bottom"])
        return ["ok": true, "synthetic": true]
      }
      try require(AXIsProcessTrusted(), "Allow Accessibility for Palm on your Mac to reach the Dock and the menu bar.")
      let bounds = CGDisplayBounds(capture.capturingDisplay?.displayID ?? CGMainDisplayID())
      for step in 0..<10 {
        let point = CGPoint(x: bounds.midX + CGFloat(step % 2) * 2, y: top ? bounds.minY : bounds.maxY - 1)
        let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
        event?.setIntegerValueField(.mouseEventDeltaY, value: top ? -8 : 8)
        event?.post(tap: .cghidEventTap)
        try? await Task.sleep(nanoseconds: 70_000_000)
      }
      return ["ok": true]
    case "dockPress":
      let index = (x["index"] as? NSNumber)?.intValue ?? -1
      if synthetic {
        capture.syntheticInput.note(["op": "dockPress", "index": index])
        return ["ok": true, "synthetic": true]
      }
      try require(AXIsProcessTrusted(), "Allow Accessibility for Palm on your Mac to use the Dock.")
      guard dockElements.indices.contains(index) else { throw PalmError(message: "The Dock changed. Open it again.") }
      let result = AXUIElementPerformAction(dockElements[index], kAXPressAction as CFString)
      try require(result == .success, "The Dock did not respond. Try again.")
      return ["ok": true]
    case "actions": return try phoneActions()
    case "action":
      if synthetic { return ["ok": true, "synthetic": true] }
      try require(
        AXIsProcessTrusted() && controlling, "Start a control session to use app actions.")
      try await ensureTarget()
      try require(
        NSWorkspace.shared.frontmostApplication?.processIdentifier == actionPID,
        "The front app changed. Refresh its controls first.")
      guard let id = x["actionId"] as? String, let element = availableActions[id] else {
        throw PalmError(message: "That control has changed. Refresh the controls first.")
      }
      try require(
        AXUIElementPerformAction(element, kAXPressAction as CFString) == .success,
        "The app could not perform that action.")
      return ["ok": true]
    case "permission":
      let kind = x["kind"] as? String ?? ""
      if kind == "camera" || kind == "microphone" {
        return try PalmMedia.requestPermission(kind, synthetic: synthetic)
      }
      if kind == "screen" {
        _ = CGRequestScreenCaptureAccess()
        NSWorkspace.shared.open(
          URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
        )
      } else {
        let options =
          [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
        NSWorkspace.shared.open(
          URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!
        )
      }
      return ["ok": true]
    case "start":
      let windowNumber = x["windowId"] as? Int ?? 0
      try require(
        windowNumber >= 0 && UInt64(windowNumber) <= UInt64(UInt32.max),
        "Invalid window identifier.")
      if let raw = x["phoneLayout"] {
        try require(
          CFGetTypeID(raw as CFTypeRef) == CFBooleanGetTypeID(), "Invalid Phone Layout option.")
      }
      if let raw = x["fill"] {
        try require(
          CFGetTypeID(raw as CFTypeRef) == CFBooleanGetTypeID(), "Invalid window layout option.")
      }
      try require(
        synthetic || CGPreflightScreenCaptureAccess(),
        "Allow Screen Recording for Palm on your Mac, then restart Palm.")
      let expectedPID =
        synthetic || windowNumber == 0 ? 0 : windowInfo(UInt32(windowNumber))?.pid ?? 0
      try require(
        synthetic || windowNumber == 0 || expectedPID > 0, "That window is no longer available.")
      // Opening an app fills the Mac screen with its window; phone layout
      // reshapes it to the phone instead. Either is undone when sharing ends.
      let fill = (x["fill"] as? Bool ?? false) && windowNumber > 0
      // An opened app fills the Mac screen and the phone sees the whole screen,
      // menu bar and Dock included ("I can't access the
      // bottom nav or the top nav"). Input then goes where the phone points.
      let wholeScreen = (x["wholeScreen"] as? Bool ?? false) && windowNumber > 0 && fill
      let phoneShaped = x["phoneLayout"] as? Bool ?? false
      try require(!(fill && phoneShaped), "Choose one window layout.")
      let requested = phoneShaped || fill
      let viewport = try requestedViewport(x, enabled: phoneShaped)
      let ticket = invalidateSession()
      await capture.stop()
      try requireSession(ticket)
      _ = await restorePhoneLayout(ticket: ticket)
      try requireSession(ticket)
      do {
        // Every field the phone reads, also when the best-effort fill below
        // fails (E2E, 23 September: without "requested" the phone rejected the
        // reply and the screen stayed black).
        var layoutOutcome = LayoutOutcome(
          state: ["requested": requested, "applied": false, "state": "unsupported", "reason": "The window keeps its size."],
          expectedSize: nil)
        if wholeScreen {
          // Best effort: the app in front with its window filling the screen.
          // The whole screen shows either way, so the picture never stops here
          // (picking ChatGPT or Codex "breaks the entire screen").
          do {
            try await raiseWindow(UInt32(windowNumber), ticket: ticket)
            layoutOutcome = try await phoneLayout(
              windowID: UInt32(windowNumber), expectedPID: expectedPID,
              requested: requested, ticket: ticket, viewport: viewport, fill: fill)
          } catch {
            try requireSession(ticket)
            if let app = NSRunningApplication(processIdentifier: expectedPID) { bringToFront(app) }
          }
        } else {
          try await raiseWindow(UInt32(windowNumber), ticket: ticket)
          try require(
            synthetic || windowNumber == 0 || windowInfo(UInt32(windowNumber))?.pid == expectedPID,
            "The selected window changed applications. Choose it again.")
          layoutOutcome = try await phoneLayout(
            windowID: UInt32(windowNumber), expectedPID: expectedPID,
            requested: requested, ticket: ticket, viewport: viewport, fill: fill)
        }
        var layout = layoutOutcome.state
        try requireSession(ticket)
        let requestedDisplay = (x["displayId"] as? NSNumber).map { CGDirectDisplayID($0.uint32Value) }
        if synthetic { capture.syntheticInput.note(["op": "start", "displayId": Int(requestedDisplay ?? 0)]) }
        let flow = x["flow"] as? Bool ?? false
        let bitrate = (x["bitrate"] as? NSNumber)?.intValue
        try require(bitrate == nil || (100_000...20_000_000).contains(bitrate!), "Invalid screen rate.")
        var result = try await capture.start(
          windowId: wholeScreen ? 0 : UInt32(windowNumber), synthetic: synthetic, portrait: phoneShaped,
          expectedPID: wholeScreen ? 0 : expectedPID, viewport: viewport,
          displayId: wholeScreen ? display(containing: windowInfo(UInt32(windowNumber))?.frame) : requestedDisplay,
          flow: flow, bitrate: bitrate)
        try requireSession(ticket)
        if layout["applied"] as? Bool == true && !wholeScreen {
          let current = windowInfo(UInt32(windowNumber))
          let currentSize = current?.pid == expectedPID ? current?.frame.size : nil
          if !PhoneLayoutGeometry.capturedLayoutMatches(
            expected: layoutOutcome.expectedSize,
            captured: capture.sourceSize, current: currentSize)
          {
            layout["applied"] = false
            layout["state"] = "unsupported"
            layout["reason"] = "The window size changed while opening. Sharing its current size."
          }
        }
        result["phoneLayout"] = layout
        controlling = true
        showMenuState(sharing: true)
        return result
      } catch {
        if sessionGeneration == ticket { _ = await stopSession() }
        throw error
      }
    case "stop":
      let restored = await stopSession()
      return ["ok": true, "phoneLayoutRestore": restored]
    case "keyframe":
      capture.encoder?.requestKey()
      return ["ok": true]
    case "screenCredit":
      // Room for more frames: the phone confirmed some (see CaptureOutput).
      guard let count = x["count"] as? Int, (0...CaptureOutput.maxCredits).contains(count) else {
        throw PalmError(message: "Invalid screen frame credit.")
      }
      capture.output?.grant(count, reset: x["reset"] as? Bool ?? false)
      return ["ok": true]
    case "screenBitrate":
      guard let bitrate = (x["bitrate"] as? NSNumber)?.intValue, (100_000...20_000_000).contains(bitrate) else {
        throw PalmError(message: "Invalid screen rate.")
      }
      return ["bitrate": capture.setBitrate(bitrate)]
    case "screenFlow":
      var stats = capture.output?.stats ?? ["flow": false]
      stats["bitrate"] = capture.bitrateTarget ?? NSNull()
      return stats
    case "quality":
      let zoom = (x["zoom"] as? NSNumber)?.doubleValue ?? 1
      try require(zoom.isFinite && zoom >= 1 && zoom <= 16, "Choose a zoom between 1 and 16.")
      if synthetic { return ["ok": true, "synthetic": true, "zoom": zoom] }
      return try await capture.setQuality(zoom: zoom)
    case "launch":
      // Opens an installed app (or brings it forward), then waits for its window.
      if synthetic { return ["ok": true, "windowId": 7] }
      guard let id = x["bundleId"] as? String,
        let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id)
      else { throw PalmError(message: "That app is not installed on this Mac.") }
      let ticket = sessionGeneration
      let configuration = NSWorkspace.OpenConfiguration()
      configuration.activates = true
      let app = try await NSWorkspace.shared.openApplication(at: url, configuration: configuration)
      bringToFront(app)
      // An app that opens without a window (a menu bar app) still counts as opened.
      let windowID = (try? await waitForFrontWindow(pid: app.processIdentifier, ticket: ticket)) ?? 0
      return ["ok": true, "windowId": windowID]
    case "activate":
      if synthetic { return ["ok": true, "windowId": 7] }
      guard let id = x["bundleId"] as? String,
        let app = NSRunningApplication.runningApplications(withBundleIdentifier: id).first
      else { throw PalmError(message: "That app is no longer running. Open it on your Mac first.") }
      let ticket = sessionGeneration
      bringToFront(app)
      let onScreen =
        CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] ?? []
      let windowID =
        (try? await waitForFrontWindow(pid: app.processIdentifier, ticket: ticket))
        ?? (Self.frontWindow(of: app.processIdentifier, target: 0, in: onScreen)?[kCGWindowNumber as String] as? UInt32)
        ?? 0
      return ["ok": true, "windowId": windowID]
    case "clipboardRead":
      if synthetic { return ["kinds": ["text"], "text": "synthetic clipboard", "changeCount": 1] }
      return PalmClipboard.read()
    case "clipboardWrite":
      if synthetic {
        // The test Mac notes what arrived (kind and size only), so tests can see a paste land.
        capture.syntheticInput.note([
          "op": "clipboardWrite", "kind": x["imagePNG"] != nil ? "image" : x["text"] != nil ? "text" : "files",
          "text": x["text"] as? String ?? "",
        ])
        return ["ok": true, "synthetic": true]
      }
      return try PalmClipboard.write(x)
    case "trash":
      guard let paths = x["paths"] as? [String], !paths.isEmpty else {
        throw PalmError(message: "Choose items to move to the Trash.")
      }
      return ["moved": try PalmTrash.move(paths)]
    case "screenshot":
      let maxWidth = (x["maxWidth"] as? NSNumber)?.intValue ?? 1440
      if synthetic {
        return ["jpeg": "", "width": 1280, "height": 800, "synthetic": true,
          "screen": ["x": 0, "y": 0, "width": 1280, "height": 800], "frontmost": ["name": "Sample Editor"]]
      }
      return try await PalmAgentScreen.screenshot(maxWidth: max(320, min(2560, maxWidth)), excluding: curtain.windowIDs)
    case "agentInput":
      if synthetic {
        return ["ok": true, "synthetic": true, "syntheticInputSequence": capture.syntheticInput.record()]
      }
      // An agent works in screen coordinates on the whole desktop. Release any
      // press held by the phone's own session before acting.
      releasePointer()
      return try await PalmAgentScreen.perform(x)
    case "release":
      releasePointer()
      return ["quiescent": true, "released": true]
    case "displayState":
      if synthetic {
        return ["brightness": syntheticBrightness, "curtain": syntheticCurtain, "builtIn": true, "synthetic": true,
          "keyboardLight": ["level": Double(syntheticKeyboardLight), "auto": syntheticKeyboardAuto]]
      }
      var state: [String: Any] = [
        "curtain": curtain.isOn, "builtIn": PalmBrightness.builtInDisplay() != nil,
        "displays": NSScreen.screens.count,
      ]
      if let value = PalmBrightness.get() { state["brightness"] = value }
      if let keyboard = PalmKeyboardLight.state() { state["keyboardLight"] = keyboard }
      return state
    case "brightness":
      guard let value = (x["value"] as? NSNumber)?.floatValue, value.isFinite else {
        throw PalmError(message: "Choose a brightness between 0 and 1.")
      }
      if synthetic {
        syntheticBrightness = max(0, min(1, value))
        return ["brightness": syntheticBrightness, "synthetic": true]
      }
      return ["brightness": try PalmBrightness.set(value)]
    case "keyboardLight":
      if synthetic {
        if let value = (x["level"] as? NSNumber)?.floatValue { syntheticKeyboardLight = max(0, min(1, value)) }
        if let auto = x["auto"] as? Bool { syntheticKeyboardAuto = auto }
        return ["level": Double(syntheticKeyboardLight), "auto": syntheticKeyboardAuto, "synthetic": true]
      }
      if let auto = x["auto"] as? Bool { return try PalmKeyboardLight.set(auto: auto) }
      guard let value = (x["level"] as? NSNumber)?.floatValue, value.isFinite else {
        throw PalmError(message: "Choose a keyboard light level between 0 and 1.")
      }
      return try PalmKeyboardLight.set(level: value)
    case "curtain":
      let on = x["on"] as? Bool == true
      if synthetic {
        syntheticCurtain = on
        return ["curtain": on, "synthetic": true]
      }
      curtain.set(on)
      await capture.refreshExclusions()
      return ["curtain": curtain.isOn]
    case "powerCheck":
      if synthetic { return ["allowed": true, "synthetic": true] }
      return PalmPower.check(x["kind"] as? String ?? "")
    case "power":
      try require(x["confirm"] as? Bool == true, "Confirm this action on the phone first.")
      if synthetic { return ["ok": true, "synthetic": true] }
      _ = await stopSession()
      try PalmPower.send(x["kind"] as? String ?? "")
      return ["ok": true]
    default: break
    }
    if synthetic {
      if op == "key" || op == "text" {
        capture.syntheticInput.note([
          "op": op, "key": x["key"] as? String ?? "", "modifiers": x["modifiers"] as? [String] ?? [],
          "text": x["text"] as? String ?? "",
        ])
      }
      if op == "pointer", x["action"] as? String == "move" {
        capture.syntheticInput.note([
          "op": op, "action": "move", "x": (x["x"] as? NSNumber)?.doubleValue ?? 0, "y": (x["y"] as? NSNumber)?.doubleValue ?? 0,
        ])
      }
      if op == "scroll" {
        capture.syntheticInput.note([
          "op": op, "dx": (x["dx"] as? NSNumber)?.doubleValue ?? 0, "dy": (x["dy"] as? NSNumber)?.doubleValue ?? 0,
        ])
      }
      if op == "syntheticTyping" { return ["events": capture.syntheticInput.recentTyping()] }
      if op == "syntheticStill" {
        capture.syntheticInput.still = x["on"] as? Bool ?? false
        return ["ok": true, "synthetic": true]
      }
      if op == "pointer", ["click", "doubleSecond"].contains(x["action"] as? String ?? "") {
        return [
          "ok": true, "synthetic": true, "syntheticInputSequence": capture.syntheticInput.record(),
        ]
      }
      return ["ok": true, "synthetic": true]
    }
    try require(
      AXIsProcessTrusted(), "Allow Accessibility for Palm Companion on your Mac to use controls.")
    if op == "lock" {
      key(12, flags: [.maskControl, .maskCommand])
      return ["ok": true]
    }
    if op == "pointer", x["action"] as? String == "up", primaryDown {
      releasePointer()
      return ["ok": true]
    }
    do { try await ensureTarget() } catch {
      releasePointer()
      throw error
    }
    if op == "pointer" {
      // requireTarget just checked the exact window and its captured size.
      let p = CGPoint(
        x: capture.rect.minX + (x["x"] as? Double ?? 0) * capture.rect.width,
        y: capture.rect.minY + (x["y"] as? Double ?? 0) * capture.rect.height)
      let action = x["action"] as? String ?? "move"
      if ["click", "right", "double", "doubleSecond"].contains(action) { releasePointer() }
      lastPointer = p
      func event(_ type: CGEventType, _ button: CGMouseButton = .left, count: Int64 = 1) {
        let event = CGEvent(
          mouseEventSource: nil, mouseType: type,
          mouseCursorPosition: p, mouseButton: button)
        event?.setIntegerValueField(.mouseEventClickState, value: count)
        event?.post(tap: .cghidEventTap)
      }
      switch action {
      case "click":
        event(.leftMouseDown)
        event(.leftMouseUp)
      case "right":
        event(.rightMouseDown, .right)
        event(.rightMouseUp, .right)
      case "double":
        event(.leftMouseDown)
        event(.leftMouseUp)
        event(.leftMouseDown, count: 2)
        event(.leftMouseUp, count: 2)
      case "doubleSecond":
        event(.leftMouseDown, count: 2)
        event(.leftMouseUp, count: 2)
      case "down":
        event(.leftMouseDown)
        primaryDown = true
      case "up":
        event(.leftMouseUp)
        primaryDown = false
      default: event(primaryDown ? .leftMouseDragged : .mouseMoved)
      }
    } else if op == "scroll" {
      let event = CGEvent(
        scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
        wheel1: Int32(-(x["dy"] as? Double ?? 0)), wheel2: Int32(-(x["dx"] as? Double ?? 0)),
        wheel3: 0)
      if capture.targetWindow > 0 {
        event?.location =
          capture.rect.contains(lastPointer)
          ? lastPointer
          : CGPoint(x: capture.rect.midX, y: capture.rect.midY)
      }
      event?.post(tap: .cghidEventTap)
    } else if op == "text" {
      var chunks: [[UInt16]] = []
      var current: [UInt16] = []
      for scalar in (x["text"] as? String ?? "").unicodeScalars {
        let chars = Array(String(scalar).utf16)
        if current.count + chars.count > 20 {
          chunks.append(current)
          current = []
        }
        current.append(contentsOf: chars)
      }
      if !current.isEmpty { chunks.append(current) }
      for part in chunks {
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        part.withUnsafeBufferPointer { p in
          down?.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress!)
          up?.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress!)
        }
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
      }
    } else if op == "key" {
      let name = x["key"] as? String ?? ""
      let plain: [String: CGKeyCode] = [
        "enter": 36, "escape": 53, "backspace": 51, "tab": 48, "left": 123, "right": 124, "up": 126,
        "down": 125, "space": 49,
      ]
      let shortcuts: [String: CGKeyCode] = [
        "save": 1, "undo": 6, "redo": 6, "copy": 8, "paste": 9, "selectAll": 0, "find": 3,
        "closeWindow": 13,
      ]
      let modifiers = (x["modifiers"] as? [String]) ?? []
      if !modifiers.isEmpty || (plain[name] == nil && shortcuts[name] == nil) {
        try PalmAgentScreen.press(key: name, modifiers: modifiers)
      } else if let code = plain[name] {
        key(code)
      } else if let code = shortcuts[name] {
        key(code, flags: name == "redo" ? [.maskCommand, .maskShift] : [.maskCommand])
      }
    } else {
      throw PalmError(message: "Unsupported command.")
    }
    return ["ok": true]
  }
  func key(_ code: CGKeyCode, flags: CGEventFlags = []) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    down?.flags = flags
    up?.flags = flags
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
  }
}

@main struct Main {
  @MainActor static func main() {
    if CommandLine.arguments.contains("--test-phone-layout") {
      do { emit(["ok": true, "checks": try PhoneLayoutGeometry.selfTest()]) } catch {
        emit(["ok": false, "error": error.localizedDescription])
        exit(1)
      }
      return
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let companion = Companion()
    companion.capture.onUnexpectedStop = { [weak companion] in
      guard let companion else { return }
      let ticket = companion.invalidateSession()
      Task { @MainActor in
        guard companion.sessionGeneration == ticket else { return }
        await companion.capture.stop()
        _ = await companion.restorePhoneLayout(ticket: ticket)
      }
    }
    companion.capture.excludedWindowIDs = { [weak companion] in companion?.curtain.windowIDs ?? [] }
    companion.curtain.onChange = { [weak companion] in
      guard let companion else { return }
      emit(["event": "curtain", "on": companion.curtain.isOn])
      Task { @MainActor in await companion.capture.refreshExclusions() }
    }
    companion.setupMenu()
    signal(SIGTERM, SIG_IGN)
    let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    termination.setEventHandler {
      Task { @MainActor in
        companion.talk.stop()
        companion.media.stop()
        companion.rtc.stop()
        _ = await companion.stopSession()
        NSApplication.shared.terminate(nil)
      }
    }
    termination.resume()
    defer { termination.cancel() }
    DispatchQueue.global(qos: .userInitiated).async {
      while let line = readLine() {
        guard let data = line.data(using: .utf8),
          let x = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { continue }
        Task { @MainActor in
          let id = x["id"] as? String ?? ""
          do {
            let result = try await companion.handle(x)
            emit(["id": id, "result": result])
          } catch { emit(["id": id, "error": error.localizedDescription]) }
        }
      }
      Task { @MainActor in
        companion.talk.stop()
        companion.media.stop()
        companion.rtc.stop()
        _ = await companion.stopSession()
        NSApplication.shared.terminate(nil)
      }
    }
    app.run()
  }
}
