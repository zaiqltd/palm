import CryptoKit
import Foundation
import UIKit

/// Moves files between the phone and the Mac and proves each one arrived
/// intact: the phone hashes what it sends and the Mac hashes what it wrote
/// (uploads), and the reverse for downloads. A mismatch is a failure, never a
/// silent partial file.
@MainActor
final class PalmTransfers: ObservableObject {
  enum Direction: String { case toMac, toPhone }
  enum State: Equatable {
    case preparing, transferring(Double), verifying, verified, failed(String)
  }

  struct Item: Identifiable, Equatable {
    let id = UUID()
    let direction: Direction
    var name: String
    var destination: String
    var size: Int64
    var state: State
    var localURL: URL?
    var macPath: String?
    var sha256: String?
    let started = Date()
  }

  @Published private(set) var items: [Item] = []
  private weak var connection: PalmConnection?

  init(connection: PalmConnection) {
    self.connection = connection
  }

  var active: [Item] {
    items.filter {
      if case .transferring = $0.state { return true }
      return $0.state == .preparing || $0.state == .verifying
    }
  }

  func clearFinished() {
    items.removeAll {
      if case .failed = $0.state { return true }
      return $0.state == .verified
    }
  }

  private func update(_ id: UUID, _ change: (inout Item) -> Void) {
    guard let index = items.firstIndex(where: { $0.id == id }) else { return }
    change(&items[index])
  }

  // MARK: Phone to Mac

  /// Upload a local file into a Mac folder. Returns the Mac path when verified.
  @discardableResult
  func upload(_ file: URL, name: String? = nil, to folder: String, conflict: String = "rename") async -> PalmUploadResult? {
    guard let connection else { return nil }
    let fileName = sanitize(name ?? file.lastPathComponent)
    let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
    var item = Item(direction: .toMac, name: fileName, destination: folder, size: size, state: .preparing)
    item.localURL = file
    items.insert(item, at: 0)
    let id = item.id
    do {
      let digest = try await Self.sha256(of: file)
      update(id) { $0.sha256 = digest; $0.state = .transferring(0) }
      var request = try connection.authorizedRequest(
        "/api/fs/upload", method: "PUT",
        query: ["dir": folder, "name": fileName, "conflict": conflict, "sha256": digest, "size": String(size)])
      request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      let progress = PalmProgressDelegate { [weak self] fraction in
        Task { @MainActor in self?.update(id) { $0.state = .transferring(fraction) } }
      }
      let (data, response) = try await connection.transferSession.upload(for: request, fromFile: file, delegate: progress)
      try connection.validate(response, data: data)
      update(id) { $0.state = .verifying }
      let result = try JSONDecoder().decode(PalmUploadResult.self, from: data)
      guard result.verified, result.sha256 == digest, result.size == size else {
        throw PalmFailure.message("The Mac's copy does not match the phone's file.")
      }
      update(id) {
        $0.state = .verified
        $0.macPath = result.path
        $0.name = result.name
      }
      return result
    } catch {
      update(id) { $0.state = .failed(connection.friendlyMessage(error)) }
      return nil
    }
  }

  /// Upload raw data (a photo or pasted image) by staging it as a file first.
  @discardableResult
  func upload(data: Data, name: String, to folder: String) async -> PalmUploadResult? {
    let staging = FileManager.default.temporaryDirectory.appendingPathComponent("palm-upload-\(UUID().uuidString)")
    do {
      try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
      let file = staging.appendingPathComponent(sanitize(name))
      try data.write(to: file, options: [.completeFileProtection])
      defer { try? FileManager.default.removeItem(at: staging) }
      return await upload(file, name: name, to: folder)
    } catch {
      return nil
    }
  }

  // MARK: Mac to phone

  /// Download a Mac file into Palm's private downloads folder and verify it.
  func download(_ macPath: String, confirmSensitive: Bool = false) async -> URL? {
    guard let connection else { return nil }
    let name = sanitize((macPath as NSString).lastPathComponent)
    var item = Item(direction: .toPhone, name: name, destination: "iPhone", size: 0, state: .transferring(0))
    item.macPath = macPath
    items.insert(item, at: 0)
    let id = item.id
    do {
      var query = ["path": macPath]
      if confirmSensitive { query["confirm"] = "1" }
      let request = try connection.authorizedRequest("/api/fs/download", query: query)
      let progress = PalmProgressDelegate { [weak self] fraction in
        Task { @MainActor in self?.update(id) { $0.state = .transferring(fraction) } }
      }
      let (temporary, response) = try await connection.transferSession.download(for: request, delegate: progress)
      try connection.validate(response, data: nil)
      update(id) { $0.state = .verifying }
      let folder = try Self.downloadsFolder()
      var target = folder.appendingPathComponent(name)
      var counter = 2
      while FileManager.default.fileExists(atPath: target.path) {
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        target = folder.appendingPathComponent(ext.isEmpty ? "\(base) \(counter)" : "\(base) \(counter).\(ext)")
        counter += 1
      }
      try FileManager.default.moveItem(at: temporary, to: target)
      try (target as NSURL).setResourceValue(URLFileProtection.complete, forKey: .fileProtectionKey)
      var hashQuery = ["path": macPath]
      if confirmSensitive { hashQuery["confirm"] = "1" }
      let remote: PalmHash = try await connection.get("/api/fs/hash", hashQuery)
      let local = try await Self.sha256(of: target)
      let size = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? -1
      guard local == remote.sha256, size == remote.size else {
        try? FileManager.default.removeItem(at: target)
        throw PalmFailure.message("The downloaded copy does not match the Mac's file (it may have changed while downloading).")
      }
      update(id) {
        $0.state = .verified
        $0.localURL = target
        $0.size = size
        $0.sha256 = local
      }
      return target
    } catch {
      update(id) { $0.state = .failed(connection.friendlyMessage(error)) }
      return nil
    }
  }

  static func downloadsFolder() throws -> URL {
    let folder = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("From Mac", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder
  }

  nonisolated static func sha256(of file: URL) async throws -> String {
    try await Task.detached(priority: .userInitiated) {
      let handle = try FileHandle(forReadingFrom: file)
      defer { try? handle.close() }
      var hasher = SHA256()
      while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty { hasher.update(data: chunk) }
      return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }.value
  }

  private func sanitize(_ name: String) -> String {
    let cleaned = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: "\0", with: "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "File" : String(cleaned.prefix(200))
  }
}

final class PalmProgressDelegate: NSObject, URLSessionTaskDelegate, URLSessionDownloadDelegate, @unchecked Sendable {
  private let report: (Double) -> Void
  init(_ report: @escaping (Double) -> Void) { self.report = report }

  func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
    if totalBytesExpectedToSend > 0 { report(Double(totalBytesSent) / Double(totalBytesExpectedToSend)) }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
    if totalBytesExpectedToWrite > 0 { report(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)) }
  }

  func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {}

  // Never follow a redirect with the phone's token attached.
  func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
}
