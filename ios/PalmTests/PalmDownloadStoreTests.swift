import Foundation
import XCTest
@testable import Palm

final class PalmDownloadStoreTests: XCTestCase {
  func testOnlyOwnedShareCopyIsReleased() throws {
    let sandbox = FileManager.default.temporaryDirectory.appendingPathComponent("Palm-download-test-\(UUID())")
    try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: sandbox) }
    let root = sandbox.appendingPathComponent("cache", isDirectory: true)
    let store = PalmDownloadStore(root: root)
    let original = sandbox.appendingPathComponent("original.txt")
    let temporary = sandbox.appendingPathComponent("network.tmp")
    let content = Data("Disposable fixture copy".utf8)
    try content.write(to: original)
    try content.write(to: temporary)
    let copy = try store.adopt(temporary, name: "A shared file.txt")
    XCTAssertEqual(try Data(contentsOf: copy), content)
    store.release(original)
    XCTAssertTrue(FileManager.default.fileExists(atPath: original.path), "A caller cannot delete an unowned file.")
    store.release(copy)
    store.release(copy)
    XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path))
    XCTAssertEqual(try Data(contentsOf: original), content)
  }

  func testFileProtectionClassOnPhysicalDevice() throws {
    #if targetEnvironment(simulator)
      throw XCTSkip("The simulator does not expose iOS data-protection metadata. Verify this class on a physical iPhone.")
    #else
      let sandbox = FileManager.default.temporaryDirectory.appendingPathComponent("Palm-protection-test-\(UUID())")
      try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
      defer { try? FileManager.default.removeItem(at: sandbox) }
      let store = PalmDownloadStore(root: sandbox.appendingPathComponent("cache", isDirectory: true))
      let temporary = sandbox.appendingPathComponent("network.tmp")
      try Data([1, 2, 3]).write(to: temporary)
      let copy = try store.adopt(temporary, name: "fixture.bin")
      let attributes = try FileManager.default.attributesOfItem(atPath: copy.path)
      let protection = (attributes[.protectionKey] as? FileProtectionType)?.rawValue
        ?? attributes[.protectionKey] as? String
      XCTAssertEqual(protection, FileProtectionType.complete.rawValue)
      store.release(copy)
    #endif
  }

  func testAbandonedCopiesExpireButActiveLeaseAndOtherDirectoriesRemain() throws {
    let sandbox = FileManager.default.temporaryDirectory.appendingPathComponent("Palm-cache-test-\(UUID())")
    try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: sandbox) }
    let root = sandbox.appendingPathComponent("cache", isDirectory: true)
    let store = PalmDownloadStore(root: root)
    let temporary = sandbox.appendingPathComponent("network.tmp")
    try Data([1, 2, 3]).write(to: temporary)
    let old = Date().addingTimeInterval(-25 * 3600)
    let copy = try store.adopt(temporary, name: "fixture.bin", now: old)
    try store.purgeExpired()
    XCTAssertTrue(FileManager.default.fileExists(atPath: copy.path), "An active share lease must survive cleanup.")
    let unrelated = root.appendingPathComponent("Keep", isDirectory: true)
    try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: true)
    let nextLaunch = PalmDownloadStore(root: root)
    try nextLaunch.purgeExpired()
    XCTAssertFalse(FileManager.default.fileExists(atPath: copy.path), "Abandoned copies must expire on a later launch.")
    XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
  }

  func testRejectsPathComponentsAndControlCharacters() throws {
    for name in ["", ".", "..", "../../outside", "/absolute", "a\\b", "line\nname", "bad\0name"] {
      XCTAssertThrowsError(try PalmDownloadStore.validatedFilename(name), name)
    }
    XCTAssertEqual(try PalmDownloadStore.validatedFilename("Résumé 📄.pdf"), "Résumé 📄.pdf")
  }
}
