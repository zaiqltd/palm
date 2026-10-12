import Foundation

/// One thing in Shared: a link, a note or a file on the Mac.
struct PalmSharedItem: Decodable, Identifiable, Equatable {
  let id: String
  let kind: String  // "link", "text" or "file"
  let url: String?
  let text: String?
  let path: String?
  let name: String?
  let size: Int64?
  let exists: Bool?
  let sensitive: Bool?
  let title: String?
  let source: String  // "mac" or "phone"
  let device: String?
  let created: String
  /// A long note's full length; `partial` when only its start was sent.
  let length: Int?
  let partial: Bool?

  var isFromMac: Bool { source == "mac" }
}

struct PalmSharedList: Decodable { let items: [PalmSharedItem] }

/// Shared for the computer in use: links, notes and files the Mac passed to
/// this phone (palm-share, an agent, the Mac's clipboard) and notes the phone
/// added. Kept on the Mac; the phone follows it live and counts what arrived
/// from the Mac since Shared was last open, for the badge on More.
@MainActor
final class PalmSharedStore: ObservableObject {
  static let shared = PalmSharedStore()

  @Published private(set) var items: [PalmSharedItem] = []
  @Published private(set) var loaded = false
  @Published var error: String?
  @Published private(set) var unseen = 0
  /// Shared is the screen on top of More (it stays there while another tab is in front).
  var isOpen = false {
    didSet { if showing { markSeen() } }
  }
  /// More is the tab in front.
  var onMoreTab = false {
    didSet { if showing { markSeen() } }
  }
  /// Shared in front of you: what arrives is seen at once.
  private var showing: Bool { isOpen && onMoreTab }
  private var deviceId: String?
  private var listener: UUID?
  private var reconnect: UUID?

  func start(_ connection: PalmConnection, events: PalmEvents) {
    guard listener == nil else { return }
    deviceId = connection.currentDeviceId
    listener = events.listen("shared") { [weak self] _ in
      guard let self else { return }
      Task { await self.refresh(connection) }
    }
    reconnect = events.whenConnected { [weak self] in
      guard let self else { return }
      Task { await self.refresh(connection) }
    }
    Task { await refresh(connection) }
  }

  /// Another computer: its own Shared.
  func computerChanged(_ connection: PalmConnection) {
    deviceId = connection.currentDeviceId
    items = []
    loaded = false
    unseen = 0
    Task { await refresh(connection) }
  }

  func refresh(_ connection: PalmConnection) async {
    do {
      let list: PalmSharedList = try await connection.get("/api/shared")
      items = list.items
      loaded = true
      error = nil
      if showing { markSeen() } else { countUnseen() }
    } catch { self.error = connection.friendlyMessage(error) }
  }

  /// Ask the Mac to add something; the live update brings it into the list.
  func add(_ connection: PalmConnection, _ body: [String: Any]) async throws {
    let added: PalmSharedList = try await connection.post("/api/shared", body)
    // Shown at once, before the live update arrives.
    items = added.items + items.filter { item in !added.items.contains { $0.id == item.id } }
    if showing { markSeen() }
  }

  func remove(_ connection: PalmConnection, _ item: PalmSharedItem) async {
    items.removeAll { $0.id == item.id }
    do {
      let list: PalmSharedList = try await connection.post("/api/shared/remove", ["id": item.id])
      items = list.items
      error = nil
    } catch {
      self.error = connection.friendlyMessage(error)
      await refresh(connection)
    }
  }

  /// A long note in full.
  func full(_ connection: PalmConnection, _ item: PalmSharedItem) async throws -> PalmSharedItem {
    guard item.partial == true else { return item }
    return try await connection.get("/api/shared/item", ["id": item.id])
  }

  private var seenKey: String { "palm.shared.seen.\(deviceId ?? "default")" }

  /// Everything listed now is seen ("0" for an empty list: all that follows is new).
  private func markSeen() {
    UserDefaults.standard.set(items.first?.created ?? "0", forKey: seenKey)
    unseen = 0
  }

  private func countUnseen() {
    guard let seen = UserDefaults.standard.string(forKey: seenKey) else {
      // First time on this phone: what is there already is not new ("0" sorts
      // before any date, so everything after an empty list counts).
      UserDefaults.standard.set(items.first?.created ?? "0", forKey: seenKey)
      unseen = 0
      return
    }
    unseen = items.filter { $0.isFromMac && $0.created > seen }.count
  }
}
