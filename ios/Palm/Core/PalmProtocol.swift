import Foundation

enum PalmConnectionState: String, Equatable {
  case unpaired, ready, connecting, live, reconnecting, offline
}

enum PalmFailure: LocalizedError {
  case message(String)
  case expired
  case malformedVideo
  case disconnected

  var errorDescription: String? {
    switch self {
    case .message(let text): return text
    case .expired: return "This pairing has expired or was revoked. Pair with your Mac again."
    case .malformedVideo: return "The Mac sent an unsupported video frame."
    case .disconnected: return "The connection ended. Input was not repeated."
    }
  }
}

struct PalmEndpoint: Equatable, Codable, Sendable {
  static let defaultHost = "https://your-mac.your-tailnet.ts.net:8443"
  let origin: URL

  init(_ input: String, allowLoopback: Bool = false) throws {
    guard var parts = URLComponents(string: input.trimmingCharacters(in: .whitespacesAndNewlines)),
      let hostname = parts.host?.lowercased(), !hostname.isEmpty,
      parts.user == nil, parts.password == nil,
      parts.query == nil, parts.fragment == nil,
      parts.path.isEmpty || parts.path == "/",
      parts.port.map({ (1...65535).contains($0) }) ?? true
    else { throw PalmFailure.message("Enter the Mac’s HTTPS address, without a path or pairing code.") }
    let labels = hostname.split(separator: ".", omittingEmptySubsequences: false)
    let validDNS = labels.allSatisfy { label in
      !label.isEmpty && label.count <= 63 && label.first != "-" && label.last != "-"
        && label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
    }
    let tailscale = hostname.hasSuffix(".ts.net") && labels.count >= 4 && validDNS
    let loopback = ["localhost", "127.0.0.1"].contains(hostname)
    guard (parts.scheme?.lowercased() == "https" && tailscale)
      || (allowLoopback && loopback && parts.scheme?.lowercased() == "http")
    else { throw PalmFailure.message("Use your Mac’s private HTTPS Tailscale address ending in .ts.net.") }
    parts.scheme = parts.scheme?.lowercased()
    parts.host = hostname
    parts.path = ""
    guard let origin = parts.url else { throw PalmFailure.message("That Mac address is invalid.") }
    self.origin = origin
  }

  var string: String { origin.absoluteString }
  func url(_ path: String, query: [URLQueryItem] = []) -> URL {
    var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
    parts.path = path
    parts.queryItems = query.isEmpty ? nil : query
    return parts.url!
  }
  var socketURL: URL {
    var parts = URLComponents(url: url("/socket"), resolvingAgainstBaseURL: false)!
    parts.scheme = origin.scheme == "https" ? "wss" : "ws"
    return parts.url!
  }
}

struct PalmHostStatus: Codable, Sendable {
  let name: String
  let platform: String
  let version: String
  let screenPermission: Bool
  let controlPermission: Bool
  let synthetic: Bool
  /// A test host recording a demo: it runs without the test-host label.
  var demo: Bool? = nil
  let power: [String: Bool]
  let activeApp: String
  let sharedFolder: String?
  let remoteEnabled: Bool?
  /// The Mac user's home folder and the default "Send to Mac" folder.
  var home: String? = nil
  var inbox: String? = nil
}

struct PalmRemoteWindow: Codable, Identifiable, Sendable {
  let id: Int
  let title: String
}

struct PalmRemoteApp: Codable, Identifiable, Sendable {
  var id: String { bundleId }
  let name: String
  let bundleId: String
  let active: Bool
  let icon: String
  let windows: [PalmRemoteWindow]
}

struct PalmRemoteFile: Codable, Identifiable, Sendable {
  var id: String { path }
  let name: String
  let path: String
  let directory: Bool
  let size: Int64
  let modified: String
}

struct PalmAppAction: Codable, Identifiable, Sendable {
  let id: String
  let title: String
}

/// How an app's Mac window is sized while the phone shows it. Undone when
/// sharing ends, unless it was changed on the Mac in the meantime.
enum PalmWindowLayout: String, CaseIterable, Identifiable, Sendable {
  /// The window fills the Mac screen (tapping an app
  /// should open it in full).
  case fill
  /// The window takes the phone's shape at a readable size.
  case phone
  /// The window keeps its size.
  case original
  var id: Self { self }
}

struct PalmPhoneLayout: Decodable, Sendable {
  let requested: Bool
  let applied: Bool
  let state: String
  let reason: String?

  private enum CodingKeys: String, CodingKey { case requested, applied, state, reason }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    requested = (try? c.decode(Bool.self, forKey: .requested)) ?? false
    applied = (try? c.decode(Bool.self, forKey: .applied)) ?? false
    state = (try? c.decode(String.self, forKey: .state)) ?? "unsupported"
    reason = try? c.decode(String.self, forKey: .reason)
  }
}

struct PalmStreamStart: Decodable, Sendable {
  let width: Int
  let height: Int
  let target: String
  let sourceWidth: Double?
  let sourceHeight: Double?
  let phoneLayout: PalmPhoneLayout?
  /// The Mac sends only as many frames as the phone has confirmed (host 39+).
  let flow: Bool

  private enum CodingKeys: String, CodingKey { case width, height, target, sourceWidth, sourceHeight, phoneLayout, flow }

  /// The picture's size is all the phone needs to show it. The rest is extra,
  /// and a missing extra never stops the picture (E2E, 23 September: a reply
  /// without one layout field left the screen black, "the data is missing").
  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    width = try c.decode(Int.self, forKey: .width)
    height = try c.decode(Int.self, forKey: .height)
    target = (try? c.decode(String.self, forKey: .target)) ?? ""
    sourceWidth = try? c.decode(Double.self, forKey: .sourceWidth)
    sourceHeight = try? c.decode(Double.self, forKey: .sourceHeight)
    phoneLayout = try? c.decode(PalmPhoneLayout.self, forKey: .phoneLayout)
    flow = (try? c.decode(Bool.self, forKey: .flow)) ?? false
  }
}

struct PalmCredential: Codable, Sendable {
  let host: String
  let token: String
  let expires: Double
  let deviceId: String
  var isValid: Bool { expires > Date().timeIntervalSince1970 * 1000 }
}

struct PalmVideoConfiguration: Decodable, Sendable {
  let codec: String
  let description: String
  let width: Int
  let height: Int
}

struct PalmH264Configuration: Equatable, Sendable {
  let parameterSets: [Data]
  let nalLengthSize: Int

  init(avcC data: Data) throws {
    let bytes = [UInt8](data)
    guard bytes.count >= 7, bytes[0] == 1 else { throw PalmFailure.malformedVideo }
    nalLengthSize = Int(bytes[4] & 3) + 1
    guard [1, 2, 4].contains(nalLengthSize) else { throw PalmFailure.malformedVideo }
    var cursor = 6
    var sets = [Data]()
    func readSet() throws -> Data {
      guard cursor + 2 <= bytes.count else { throw PalmFailure.malformedVideo }
      let size = Int(bytes[cursor]) * 256 + Int(bytes[cursor + 1])
      cursor += 2
      guard size > 0, cursor + size <= bytes.count else { throw PalmFailure.malformedVideo }
      defer { cursor += size }
      return Data(bytes[cursor..<(cursor + size)])
    }
    let spsCount = Int(bytes[5] & 31)
    guard spsCount > 0 else { throw PalmFailure.malformedVideo }
    for _ in 0..<spsCount {
      let set = try readSet()
      guard set.first.map({ $0 & 31 == 7 }) == true else { throw PalmFailure.malformedVideo }
      sets.append(set)
    }
    guard cursor < bytes.count else { throw PalmFailure.malformedVideo }
    let ppsCount = Int(bytes[cursor]); cursor += 1
    guard ppsCount > 0 else { throw PalmFailure.malformedVideo }
    for _ in 0..<ppsCount {
      let set = try readSet()
      guard set.first.map({ $0 & 31 == 8 }) == true else { throw PalmFailure.malformedVideo }
      sets.append(set)
    }
    parameterSets = sets
  }
}

struct PalmVideoFrame: Sendable {
  let isKey: Bool
  let timestampMicroseconds: Double
  let payload: Data

  init(packet: Data, nalLengthSize: Int) throws {
    guard packet.count > 9, packet.count <= 12 * 1024 * 1024,
      [1, 2, 4].contains(nalLengthSize)
    else { throw PalmFailure.malformedVideo }
    let bytes = [UInt8](packet.prefix(9))
    guard bytes[0] <= 1 else { throw PalmFailure.malformedVideo }
    var bits: UInt64 = 0
    for byte in bytes[1...8] { bits = (bits << 8) | UInt64(byte) }
    let timestamp = Double(bitPattern: bits)
    guard timestamp.isFinite, timestamp >= 0, timestamp < Double(Int64.max)
    else { throw PalmFailure.malformedVideo }
    isKey = bytes[0] == 1
    timestampMicroseconds = timestamp
    payload = Data(packet.dropFirst(9))
    var offset = 0
    while offset < payload.count {
      guard offset + nalLengthSize <= payload.count else { throw PalmFailure.malformedVideo }
      var size = 0
      for i in 0..<nalLengthSize { size = (size << 8) | Int(payload[offset + i]) }
      offset += nalLengthSize
      guard size > 0, size <= payload.count - offset else { throw PalmFailure.malformedVideo }
      offset += size
    }
  }
}

struct PalmReconnectPolicy {
  static let maximumAttempts = 6
  static func delay(attempt: Int) -> TimeInterval? {
    guard attempt >= 0, attempt < maximumAttempts else { return nil }
    return min(pow(2, Double(attempt)), 15)
  }
}

struct PalmPingTracker {
  private var pending: [String: TimeInterval] = [:]
  var outstandingCount: Int { pending.count }

  mutating func issue(now: TimeInterval, nonce: String = UUID().uuidString) -> String {
    pending = pending.filter { now >= $0.value && now - $0.value < 12 }
    if pending.count >= 12, let oldest = pending.min(by: { $0.value < $1.value })?.key {
      pending.removeValue(forKey: oldest)
    }
    pending[nonce] = now
    return nonce
  }

  mutating func receive(nonce: String, now: TimeInterval) -> Int? {
    guard let sent = pending.removeValue(forKey: nonce), now >= sent, now - sent < 12 else { return nil }
    return Int((now - sent) * 1000)
  }

  mutating func reset() { pending.removeAll() }
}

/// Screen ownership reported by the Mac: the phone user, an agent task, or free.
struct PalmScreenOwner: Equatable, Sendable {
  let kind: String?
  let taskId: String?
  let held: Bool

  init(kind: String?, taskId: String?, held: Bool) {
    self.kind = kind
    self.taskId = taskId
    self.held = held
  }

  init(_ object: [String: Any]) {
    let owner = object["owner"] as? [String: Any]
    kind = owner?["kind"] as? String
    taskId = owner?["taskId"] as? String
    held = object["held"] as? Bool ?? false
  }

  var agentHasScreen: Bool { kind == "agent" }
}
