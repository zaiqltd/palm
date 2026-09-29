import Foundation

/// Owns only disposable copies created by Palm for the iOS share sheet.
/// Saved Files destinations and the Mac originals are outside this store.
final class PalmDownloadStore {
  private let root: URL
  private let manager: FileManager
  private var leased: Set<URL> = []

  init(root: URL = FileManager.default.temporaryDirectory.appendingPathComponent("PalmDownloads", isDirectory: true),
    manager: FileManager = .default) {
    self.root = root.standardizedFileURL
    self.manager = manager
    try? purgeExpired()
  }

  func adopt(_ temporary: URL, name: String, now: Date = Date()) throws -> URL {
    let filename = try Self.validatedFilename(name)
    try manager.createDirectory(at: root, withIntermediateDirectories: true,
      attributes: [.protectionKey: FileProtectionType.complete])
    let directory = root.appendingPathComponent("\(Int(now.timeIntervalSince1970))-\(UUID().uuidString)", isDirectory: true)
    try manager.createDirectory(at: directory, withIntermediateDirectories: false,
      attributes: [.protectionKey: FileProtectionType.complete])
    let destination = directory.appendingPathComponent(filename)
    do {
      // Apply protection before moving the completed URLSession-owned temporary copy.
      try manager.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: temporary.path)
      try manager.moveItem(at: temporary, to: destination)
      leased.insert(destination)
      return destination
    } catch {
      try? manager.removeItem(at: directory)
      throw error
    }
  }

  func release(_ file: URL) {
    let normalized = file.standardizedFileURL
    guard leased.remove(normalized) != nil else { return }
    let directory = normalized.deletingLastPathComponent()
    guard directory.deletingLastPathComponent() == root,
      Self.creationTime(directory.lastPathComponent) != nil else { return }
    try? manager.removeItem(at: directory)
  }

  func purgeExpired(now: Date = Date()) throws {
    guard manager.fileExists(atPath: root.path) else { return }
    let directories = try manager.contentsOfDirectory(at: root,
      includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles])
    for directory in directories {
      guard let created = Self.creationTime(directory.lastPathComponent),
        !leased.contains(where: { $0.deletingLastPathComponent() == directory }) else { continue }
      let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard values.isDirectory == true, values.isSymbolicLink != true,
        now.timeIntervalSince1970 - created > 24 * 3600 else { continue }
      try manager.removeItem(at: directory)
    }
  }

  private static func creationTime(_ directory: String) -> TimeInterval? {
    guard let separator = directory.firstIndex(of: "-"),
      let timestamp = TimeInterval(directory[..<separator]), timestamp.isFinite, timestamp > 0,
      UUID(uuidString: String(directory[directory.index(after: separator)...])) != nil else { return nil }
    return timestamp
  }

  static func validatedFilename(_ name: String) throws -> String {
    guard !name.isEmpty, name != ".", name != "..", !name.contains("/"), !name.contains("\\"),
      !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else {
      throw PalmFailure.message("The Mac returned an invalid file name.")
    }
    return name
  }
}
