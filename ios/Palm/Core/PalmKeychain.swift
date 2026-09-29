import Foundation
import Security

protocol PalmCredentialStorage {
  func read() throws -> PalmCredential?
  func save(_ credential: PalmCredential) throws
  func clear() throws
  /// Several computers: one pairing each, kept apart.
  func readAll() throws -> [PalmCredential]
  func save(_ credential: PalmCredential, device: String) throws
  func clear(device: String) throws
}

/// Storage that holds one pairing (older tests) acts as a list of one.
extension PalmCredentialStorage {
  func readAll() throws -> [PalmCredential] { try read().map { [$0] } ?? [] }
  func save(_ credential: PalmCredential, device: String) throws { try save(credential) }
  func clear(device: String) throws {
    if try read()?.deviceId == device { try clear() }
  }
}

struct PalmSystemKeychain: PalmCredentialStorage {
  func read() throws -> PalmCredential? { try readAll().first }
  func save(_ credential: PalmCredential) throws { try PalmKeychain.save(credential, account: PalmKeychain.account(credential.deviceId)) }
  func clear() throws { for credential in try readAll() { try clear(device: credential.deviceId) } }
  func readAll() throws -> [PalmCredential] { try PalmKeychain.readAll() }
  func save(_ credential: PalmCredential, device: String) throws { try PalmKeychain.save(credential, account: PalmKeychain.account(device)) }
  func clear(device: String) throws { try PalmKeychain.clear(account: PalmKeychain.account(device)) }
}

struct PalmKeychainFailure: LocalizedError {
  let operation: String
  let status: OSStatus

  var errorDescription: String? {
    if status == errSecMissingEntitlement {
      return "This Palm build is missing its Keychain signing entitlement. Install a signed build. (Keychain \(status))"
    }
    if status == errSecInteractionNotAllowed || status == errSecAuthFailed {
      return "Unlock your iPhone to \(operation) its saved Mac pairing. (Keychain \(status))"
    }
    return "Your iPhone could not \(operation) its saved Mac pairing securely. (Keychain \(status))"
  }
}

/// One Keychain item per paired computer (service app.palm.connection,
/// account "mac.<pairing id>"), this device only, readable when unlocked.
/// The single "paired-mac" item of earlier builds is moved over once.
enum PalmKeychain {
  static let service = "app.palm.connection"
  static let legacyAccount = "paired-mac"

  static func account(_ device: String) -> String { "mac." + device }

  /// The first paired computer (for callers that know only one).
  static func read() throws -> PalmCredential? { try readAll().first }

  private static func query(account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: service,
     kSecAttrAccount as String: account,
     kSecAttrSynchronizable as String: false]
  }

  static func readAll() throws -> [PalmCredential] {
    let request: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrSynchronizable as String: false,
      kSecReturnData as String: true,
      kSecReturnAttributes as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = result as? [[String: Any]] else {
      throw PalmKeychainFailure(operation: "read", status: status)
    }
    var credentials: [PalmCredential] = []
    for item in items {
      guard let data = item[kSecValueData as String] as? Data,
        let credential = try? JSONDecoder().decode(PalmCredential.self, from: data)
      else { continue }
      if item[kSecAttrAccount as String] as? String == legacyAccount {
        // Earlier builds kept one pairing under a fixed name: file it by its computer.
        try? save(credential, account: account(credential.deviceId))
        try? clear(account: legacyAccount)
      }
      if !credentials.contains(where: { $0.deviceId == credential.deviceId }) { credentials.append(credential) }
    }
    return credentials
  }

  static func save(_ credential: PalmCredential, account: String) throws {
    let query = query(account: account)
    let values: [String: Any] = [
      kSecValueData as String: try JSONEncoder().encode(credential),
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    ]
    let updated = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    if updated == errSecItemNotFound {
      var item = query
      item.merge(values) { _, value in value }
      let added = SecItemAdd(item as CFDictionary, nil)
      guard added == errSecSuccess else {
        throw PalmKeychainFailure(operation: "save", status: added)
      }
    } else if updated != errSecSuccess {
      throw PalmKeychainFailure(operation: "update", status: updated)
    }
  }

  static func clear(account: String) throws {
    let status = SecItemDelete(query(account: account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw PalmKeychainFailure(operation: "remove", status: status)
    }
  }
}
