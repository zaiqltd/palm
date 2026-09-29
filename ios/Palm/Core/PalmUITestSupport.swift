import Foundation
import UIKit

/// Lets the UI tests run the real app against an isolated test host.
/// Compiled only into Simulator debug builds: a device or release build has no
/// way to pair without a code from the Mac, and never skips the Keychain.
enum PalmUITestSupport {
  #if DEBUG && targetEnvironment(simulator)
    static var host: String? { value("PALM_UITEST_HOST") }
    static var code: String? { value("PALM_UITEST_CODE") }
    static var isActive: Bool { host != nil && code != nil }

    private static func value(_ key: String) -> String? {
      guard let value = ProcessInfo.processInfo.environment[key], !value.isEmpty else { return nil }
      return value
    }

    /// Each UI test starts from a clean app: no saved preferences.
    static func resetPreferences() {
      guard isActive, let domain = Bundle.main.bundleIdentifier else { return }
      UserDefaults.standard.removePersistentDomain(forName: domain)
    }

    /// A headless Simulator never turns the interface when a test turns the
    /// "device", so the product film's recordings ask the app to turn itself
    /// with a Darwin notification from the test runner.
    static func listenForTurns() {
      guard isActive else { return }
      let center = CFNotificationCenterGetDarwinNotifyCenter()
      for name in ["palm.uitest.turn.landscape", "palm.uitest.turn.portrait"] {
        CFNotificationCenterAddObserver(center, nil, { _, _, name, _, _ in
          let landscape = name?.rawValue as String? == "palm.uitest.turn.landscape"
          Task { @MainActor in PalmUITestSupport.turn(landscape: landscape) }
        }, name as CFString, nil, .deliverImmediately)
      }
    }

    @MainActor private static func turn(landscape: Bool) {
      guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
      for window in scene.windows { window.rootViewController?.setNeedsUpdateOfSupportedInterfaceOrientations() }
      scene.requestGeometryUpdate(.iOS(interfaceOrientations: landscape ? .landscapeRight : .portrait))
    }

    @MainActor static func pairIfNeeded(_ connection: PalmConnection) async {
      guard let host, let code, !connection.isPaired else { return }
      do { try await connection.pair(host: host, code: code, name: "UI test iPhone") } catch {
        connection.errorMessage = "UI test pairing failed: \(error.localizedDescription)"
      }
    }
  #else
    static let isActive = false
    static func resetPreferences() {}
    @MainActor static func pairIfNeeded(_ connection: PalmConnection) async {}
  #endif
}

#if DEBUG && targetEnvironment(simulator)
  /// Credentials kept in memory for a UI test run, never in the Keychain.
  final class PalmMemoryCredentials: PalmCredentialStorage {
    private var credentials: [PalmCredential] = []
    func read() throws -> PalmCredential? { credentials.first }
    func save(_ credential: PalmCredential) throws { try save(credential, device: credential.deviceId) }
    func clear() throws { credentials = [] }
    func readAll() throws -> [PalmCredential] { credentials }
    func save(_ credential: PalmCredential, device: String) throws {
      credentials.removeAll { $0.deviceId == device }
      credentials.append(credential)
    }
    func clear(device: String) throws { credentials.removeAll { $0.deviceId == device } }
  }
#endif
