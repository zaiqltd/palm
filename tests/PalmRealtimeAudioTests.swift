import AVFoundation
import CoreMedia
import Foundation

@main struct AudioChecks {
  static func check(_ value: @autoclosure () -> Bool, _ message: String) throws {
    if !value() { throw PalmAudioError(message: message) }
  }
  static func main() throws {
    let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 2)!
    let encoder = PalmPCMEncoder()
    var packets: [Data] = []
    for chunk in 0..<50 {
      let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 1_024)!
      input.frameLength = 1_024
      for i in 0..<1_024 {
        let sample = Float(sin(2 * .pi * 700 * Double(chunk * 1_024 + i) / 48_000) * 0.25)
        input.floatChannelData![0][i] = sample
        input.floatChannelData![1][i] = sample
      }
      // Real capture may supply noninterleaved AudioBufferLists. Exercise the
      // CoreMedia copy as well as the sample-rate conversion.
      var description: CMAudioFormatDescription?
      try check(CMAudioFormatDescriptionCreate(allocator: nil,
        asbd: format.streamDescription, layoutSize: 0, layout: nil,
        magicCookieSize: 0, magicCookie: nil, extensions: nil,
        formatDescriptionOut: &description) == noErr, "Audio format description")
      var sample: CMSampleBuffer?
      var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000),
        presentationTimeStamp: CMTime(value: Int64(chunk * 1_024), timescale: 48_000), decodeTimeStamp: .invalid)
      try check(CMSampleBufferCreate(allocator: nil, dataBuffer: nil, dataReady: true,
        makeDataReadyCallback: nil, refcon: nil, formatDescription: description,
        sampleCount: 1_024, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
        sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &sample) == noErr,
        "Audio sample buffer")
      try check(CMSampleBufferSetDataBufferFromAudioBufferList(sample!, blockBufferAllocator: nil,
        blockBufferMemoryAllocator: nil, flags: 0, bufferList: input.audioBufferList) == noErr,
        "Noninterleaved sample data")
      let copied = try PalmPCMEncoder.copyPCM(sample!)
      try encoder.encode(copied) { packets.append($0) }
    }
    try check(packets.count >= 52 && packets.count <= 54, "Converted audio lost duration")
    try check(packets.allSatisfy { $0.count == 960 }, "Packets must be 20 ms")
    try check(encoder.peak > 0.2, "Converter produced silence")
    let player = PalmPCMPlayer()
    try player.start(manual: true)
    for packet in packets { try player.enqueue(packet) }
    let playback = player.diagnostics
    try check(playback["nonzeroRenderedFrames", default: 0] > 20_000, "Audio did not reach the renderer")
    try check(playback["peak", default: 0] > 0.2, "Renderer output was silent")
    player.stop()
    let ring = PalmAudioRing()
    for n in 0..<500 { try ring.enqueue(PalmAudioWire.tone(packet: n)) }
    try check(ring.diagnostics["queuedMs", default: 999] <= 400, "Audio backlog must stay bounded")
    try check(ring.diagnostics["droppedFrames", default: 0] > 0, "Congestion should discard stale audio")
    // Packets arriving twelve at a time after 240 ms stalls (Wi-Fi and mobile data
    // deliver in bursts) must play without gaps once started.
    let bursty = PalmAudioRing()
    let out = UnsafeMutablePointer<Float>.allocate(capacity: PalmAudioWire.frames)
    defer { out.deallocate() }
    var sent = 0
    for tick in 0..<150 {
      if tick % 12 == 0 { for _ in 0..<12 { try bursty.enqueue(PalmAudioWire.tone(packet: sent)); sent += 1 } }
      bursty.render(out, frames: PalmAudioWire.frames)
    }
    try check(bursty.diagnostics["underruns", default: 99] <= 5, "Bursty arrival must not break the sound")
    try check(bursty.diagnostics["droppedFrames", default: 99] == 0, "Bursts must not be thrown away")
    print(String(data: try JSONSerialization.data(withJSONObject: [
      "passed": true, "packets": packets.count, "playback": playback,
      "congested": ring.diagnostics]), encoding: .utf8)!)
  }
}
