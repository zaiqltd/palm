import AVFoundation
import Cocoa
import CoreImage

/// A separate, explicitly started camera/microphone session. No capture is
/// retained on disk, and closing the phone's media socket stops both devices.
final class PalmMedia: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCaptureAudioDataOutputSampleBufferDelegate
{
  private static let permissionLock = NSLock()
  private static var lastRequestResults: [String: String] = [:]
  @MainActor private static var permissionWindows: [String: NSPanel] = [:]

  @MainActor private static func showPermissionWindow(_ kind: String) {
    permissionWindows[kind]?.close()
    let panel = NSPanel(contentRect: CGRect(x: 0, y: 0, width: 440, height: 150),
      styleMask: [.titled, .closable], backing: .buffered, defer: false)
    panel.title = "Palm Companion · \(kind == "camera" ? "Camera" : "Microphone")"
    panel.level = .floating
    panel.isReleasedWhenClosed = false
    let label = NSTextField(wrappingLabelWithString:
      "Approve the macOS \(kind == "camera" ? "Camera" : "Microphone") permission prompt to use this Mac in Palm. Nothing is being recorded while you decide.")
    label.frame = CGRect(x: 22, y: 35, width: 396, height: 75)
    panel.contentView?.addSubview(label)
    panel.center()
    permissionWindows[kind] = panel
    panel.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
  }

  @MainActor private static func closePermissionWindow(_ kind: String) {
    permissionWindows.removeValue(forKey: kind)?.close()
  }

  static func permissionState(_ kind: AVMediaType, synthetic: Bool) -> String {
    if synthetic { return "authorized" }
    switch AVCaptureDevice.authorizationStatus(for: kind) {
    case .authorized: return "authorized"
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .restricted: return "restricted"
    @unknown default: return "unknown"
    }
  }

  static func permissions(synthetic: Bool) -> [String: Any] {
    permissionLock.lock()
    let results = lastRequestResults
    permissionLock.unlock()
    return [
      "camera": permissionState(.video, synthetic: synthetic),
      "microphone": permissionState(.audio, synthetic: synthetic),
      "bundle": Bundle.main.bundleIdentifier ?? "unknown",
      "cameraUsageDescription": Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") != nil,
      "microphoneUsageDescription": Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil,
      "requestResults": results,
    ]
  }

  @MainActor static func requestPermission(_ kind: String, synthetic: Bool) throws -> [String: Any] {
    let mediaType: AVMediaType
    let settings: String
    switch kind {
    case "camera": mediaType = .video; settings = "Privacy_Camera"
    case "microphone": mediaType = .audio; settings = "Privacy_Microphone"
    default: throw PalmError(message: "Choose Camera or Microphone.")
    }
    let state = permissionState(mediaType, synthetic: synthetic)
    if state == "notDetermined" {
      // Only the signed Palm Companion process asks macOS. This prompts for
      // permission without opening a capture session or sending media.
      if !synthetic { showPermissionWindow(kind) }
      AVCaptureDevice.requestAccess(for: mediaType) { granted in
        permissionLock.lock()
        lastRequestResults[kind] = granted ? "granted" : "denied"
        permissionLock.unlock()
        Task { @MainActor in closePermissionWindow(kind) }
      }
      return ["state": "requested", "kind": kind]
    }
    if state == "denied" || state == "restricted" {
      NSWorkspace.shared.open(URL(string:
        "x-apple.systempreferences:com.apple.preference.security?\(settings)")!)
    }
    return ["state": state, "kind": kind]
  }

  private var session: AVCaptureSession?
  private var output: PalmMediaOutput?
  private(set) var isRunning = false
  private var lastDiagnostics: [String: Any] = [:]

  /// `audio: false` leaves the microphone to the WebRTC call (PalmRTC).
  @MainActor func start(synthetic: Bool, id: String, audio withAudio: Bool = true) throws -> [String: Any] {
    stop()
    if !synthetic {
      var needsApproval = false
      for kind in [AVMediaType.video, .audio] {  // the call needs the microphone too
        switch AVCaptureDevice.authorizationStatus(for: kind) {
        case .authorized: break
        case .notDetermined:
          needsApproval = true
          _ = try Self.requestPermission(kind == .video ? "camera" : "microphone", synthetic: false)
        default: throw PalmError(message: "Allow Camera and Microphone for Palm in Mac System Settings.")
        }
      }
      if needsApproval { throw PalmError(message: "Allow Palm to use Camera and Microphone on your Mac, then tap Turn on again.") }
    }
    let output = PalmMediaOutput(id: id)
    self.output = output
    if synthetic {
      try output.startSynthetic(audio: withAudio)
      isRunning = true
      return ["camera": "Test camera", "microphone": "Test tone", "synthetic": true,
        "sampleRate": PalmAudioWire.rate, "protocolVersion": 2]
    }
    guard let camera = AVCaptureDevice.default(for: .video),
      let microphone = AVCaptureDevice.default(for: .audio)
    else { throw PalmError(message: "This Mac needs an available camera and microphone.") }
    let session = AVCaptureSession()
    session.beginConfiguration()
    if session.canSetSessionPreset(.hd1280x720) { session.sessionPreset = .hd1280x720 }
    else { session.sessionPreset = .medium }
    let cameraInput = try AVCaptureDeviceInput(device: camera)
    try require(session.canAddInput(cameraInput), "The camera is unavailable.")
    session.addInput(cameraInput)
    if withAudio {
      let microphoneInput = try AVCaptureDeviceInput(device: microphone)
      try require(session.canAddInput(microphoneInput), "The microphone is unavailable.")
      session.addInput(microphoneInput)
    }
    let video = AVCaptureVideoDataOutput()
    video.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    video.alwaysDiscardsLateVideoFrames = true
    let audio = AVCaptureAudioDataOutput()
    // The old Int16 capture-output conversion fails on the Mac's 48 kHz input.
    // Keep the native PCM and use our tested converter on a separate queue.
    audio.audioSettings = nil
    try require(session.canAddOutput(video) && (!withAudio || session.canAddOutput(audio)),
      "The camera or microphone cannot stream right now.")
    session.addOutput(video)
    video.setSampleBufferDelegate(output, queue: output.videoQueue)
    if withAudio {
      session.addOutput(audio)
      audio.setSampleBufferDelegate(output, queue: output.audioQueue)
    }
    session.commitConfiguration()
    self.session = session
    session.startRunning()
    guard session.isRunning else {
      stop()
      throw PalmError(message: "The camera and microphone did not start.")
    }
    isRunning = true
    return ["camera": camera.localizedName, "microphone": microphone.localizedName,
      "synthetic": false, "sampleRate": PalmAudioWire.rate, "protocolVersion": 2]
  }

  @MainActor func stop() {
    isRunning = false
    if let session {
      for output in session.outputs {
        (output as? AVCaptureVideoDataOutput)?.setSampleBufferDelegate(nil, queue: nil)
        (output as? AVCaptureAudioDataOutput)?.setSampleBufferDelegate(nil, queue: nil)
      }
      session.stopRunning()
      self.session = nil
    }
    output?.stop()
    if let output { lastDiagnostics = output.diagnostics }
    output = nil
  }

  @MainActor func keyframe() { output?.requestKeyframe() }
  @MainActor func grantVideo(_ count: Int) { output?.grantVideo(count) }
  @MainActor var diagnostics: [String: Any] {
    var result = output?.diagnostics ?? lastDiagnostics
    result["running"] = isRunning
    return result
  }
}

/// Each capture owns its queues and encoders. Retired callbacks retain their
/// original session id and cannot be forwarded to a newly connected phone.
private final class PalmMediaOutput: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCaptureAudioDataOutputSampleBufferDelegate {
  let id: String
  let videoQueue = DispatchQueue(label: "palm.media.video", qos: .userInitiated)
  let audioQueue = DispatchQueue(label: "palm.media.audio", qos: .userInteractive)
  private let context = CIContext(options: [.cacheIntermediates: false])
  private var encoder: Encoder?
  private var pool: CVPixelBufferPool?
  private var converter = PalmPCMEncoder()
  private var videoTimer: DispatchSourceTimer?
  private var audioTimer: DispatchSourceTimer?
  private var videoActive = true
  private var audioActive = true
  private var lastVideo = 0.0
  private var frames = 0
  private var videoCredits = 0
  private var videoPaused = 0
  private var encoderDropped = 0
  private var audioPackets = 0
  private var width = 0
  private var height = 0
  private var inputWidth = 0
  private var inputHeight = 0
  private var audioFormat = ""
  private var audioError: String?
  private let began = ProcessInfo.processInfo.systemUptime

  init(id: String) { self.id = id }

  private func send(_ object: [String: Any]) {
    var object = object
    object["mediaSession"] = id
    emit(object)
  }

  private func makeEncoder(width: Int, height: Int) throws -> Encoder {
    try Encoder(width: width, height: height, fps: 24, bitRate: 1_200_000,
      onDrop: { [weak self] in
        self?.videoQueue.async { [weak self] in
          guard let self, self.videoActive else { return }
          self.videoCredits = min(5, self.videoCredits + 1)
          self.encoderDropped += 1
        }
      }) { [weak self] event in
      guard let self else { return }
      var event = event
      event["event"] = event["event"] as? String == "config" ? "mediaVideoConfig" : "mediaVideo"
      self.send(event)
    }
  }

  func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer,
    from connection: AVCaptureConnection) {
    if output is AVCaptureVideoDataOutput {
      guard videoActive, sample.isValid, let source = sample.imageBuffer else { return }
      let now = ProcessInfo.processInfo.systemUptime
      guard now >= lastVideo else { return }
      guard videoCredits > 0 else { videoPaused += 1; return }
      lastVideo = max(lastVideo + 1.0 / 24.0, now + 1.0 / 96.0)
      do {
        inputWidth = CVPixelBufferGetWidth(source)
        inputHeight = CVPixelBufferGetHeight(source)
        let scale = min(1.0, min(1280.0 / Double(inputWidth), 720.0 / Double(inputHeight)))
        let w = max(2, Int(Double(inputWidth) * scale) / 2 * 2)
        let h = max(2, Int(Double(inputHeight) * scale) / 2 * 2)
        if encoder == nil || w != width || h != height {
          encoder?.close()
          width = w; height = h
          encoder = try makeEncoder(width: w, height: h)
          pool = nil
          if scale < 1 {
            CVPixelBufferPoolCreate(nil, nil, [kCVPixelBufferWidthKey: w,
              kCVPixelBufferHeightKey: h, kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
              kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pool)
          }
        }
        var pixel = source
        if let pool {
          var resized: CVPixelBuffer?
          if CVPixelBufferPoolCreatePixelBuffer(nil, pool, &resized) == kCVReturnSuccess,
            let resized {
            let image = CIImage(cvPixelBuffer: source).transformed(by:
              CGAffineTransform(scaleX: CGFloat(w) / CGFloat(inputWidth), y: CGFloat(h) / CGFloat(inputHeight)))
            context.render(image, to: resized)
            pixel = resized
          } else { return }
        }
        videoCredits -= 1
        encoder?.encode(pixel, time: sample.presentationTimeStamp)
        frames += 1
      } catch {
        videoActive = false
        send(["event": "mediaError", "message": "Camera video encoding failed."])
      }
    } else if output is AVCaptureAudioDataOutput {
      guard audioActive, sample.isValid else { return }
      do {
        let input = try PalmPCMEncoder.copyPCM(sample)
        if audioFormat.isEmpty { audioFormat = input.format.description }
        try converter.encode(input) { packet in
          audioPackets += 1
          send(["event": "mediaAudio", "data": packet.base64EncodedString()])
        }
      } catch {
        audioActive = false
        audioError = error.localizedDescription
        send(["event": "mediaError", "message": "The Mac microphone could not supply audio: \(error.localizedDescription)"])
      }
    }
  }

  func startSynthetic(audio withAudio: Bool = true) throws {
    width = 640; height = 480
    encoder = try makeEncoder(width: width, height: height)
    let video = DispatchSource.makeTimerSource(queue: videoQueue)
    videoTimer = video
    video.schedule(deadline: .now(), repeating: 1.0 / 24.0)
    video.setEventHandler { [weak self] in
      guard let self, self.videoActive, let encoder = self.encoder else { return }
      guard self.videoCredits > 0 else { self.videoPaused += 1; return }
      self.videoCredits -= 1
      self.frames += 1
      Capture.drawSynthetic(encoder: encoder, size: CGSize(width: 640, height: 480),
        sourceSize: CGSize(width: 640, height: 480), frame: self.frames, inputSequence: 0)
    }
    video.resume()
    guard withAudio else { return }
    let audio = DispatchSource.makeTimerSource(queue: audioQueue)
    audioTimer = audio
    audio.schedule(deadline: .now(), repeating: 0.02)
    audio.setEventHandler { [weak self] in
      guard let self, self.audioActive else { return }
      let packet = PalmAudioWire.tone(packet: self.audioPackets)
      self.audioPackets += 1
      self.send(["event": "mediaAudio", "data": packet.base64EncodedString()])
    }
    audio.resume()
  }

  func requestKeyframe() { videoQueue.async { [weak self] in self?.encoder?.requestKey() } }
  func grantVideo(_ count: Int) {
    videoQueue.async { [weak self] in
      guard let self, self.videoActive else { return }
      self.videoCredits = min(5, self.videoCredits + count)
    }
  }
  func stop() {
    videoTimer?.cancel(); audioTimer?.cancel()
    videoTimer = nil; audioTimer = nil
    videoQueue.sync { videoActive = false; encoder?.close(); encoder = nil }
    audioQueue.sync { audioActive = false }
  }
  var diagnostics: [String: Any] {
    var result = videoQueue.sync { ["videoFrames": frames, "videoPausedFrames": videoPaused,
      "encoderDropped": encoderDropped, "width": width, "height": height,
      "inputWidth": inputWidth, "inputHeight": inputHeight] as [String: Any] }
    let audio = audioQueue.sync { ["audioPackets": audioPackets,
      "audioInputFormat": audioFormat, "audioInputFrames": converter.inputFrames,
      "audioOutputFrames": converter.outputFrames, "audioPeak": Double(converter.peak),
      "audioError": audioError ?? ""] as [String: Any] }
    result.merge(audio) { _, value in value }
    result["seconds"] = ProcessInfo.processInfo.systemUptime - began
    return result
  }
}

@MainActor final class PalmTalkSpeaker {
  private let player = PalmPCMPlayer()
  func start(synthetic: Bool) throws { try player.start(manual: synthetic) }
  func play(_ data: Data) throws -> [String: Any] {
    try player.enqueue(data)
    return ["accepted": true]
  }
  func stop() { player.stop() }
  var diagnostics: [String: Double] { player.diagnostics }
}
