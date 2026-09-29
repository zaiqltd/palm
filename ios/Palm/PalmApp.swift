import SwiftUI
import UIKit

@main
struct PalmApp: App {
  @StateObject private var connection: PalmConnection
  @StateObject private var events: PalmEvents
  @StateObject private var transfers: PalmTransfers
  @Environment(\.scenePhase) private var scenePhase

  init() {
    #if DEBUG && targetEnvironment(simulator)
      PalmUITestSupport.resetPreferences()
      PalmUITestSupport.listenForTurns()
      let connection = PalmUITestSupport.isActive
        ? PalmConnection(allowSimulatorLoopback: true, credentialStorage: PalmMemoryCredentials())
        : PalmConnection()
    #else
      let connection = PalmConnection()
    #endif
    _connection = StateObject(wrappedValue: connection)
    _events = StateObject(wrappedValue: PalmEvents(connection: connection))
    _transfers = StateObject(wrappedValue: PalmTransfers(connection: connection))
  }

  /// A few seconds of background time for the connections' closing messages.
  static func beginGoodbye() -> UIBackgroundTaskIdentifier {
    var task = UIBackgroundTaskIdentifier.invalid
    task = UIApplication.shared.beginBackgroundTask(withName: "Palm closes its connections") {
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
    return task
  }

  var body: some Scene {
    WindowGroup {
      PalmRootView(connection: connection, events: events, transfers: transfers)
        .palmPrivacyShield()
        .preferredColorScheme(.dark)
        .tint(PalmStyle.accent)
        .task {
          await connection.restore()
          await PalmUITestSupport.pairIfNeeded(connection)
          events.setActive(scenePhase == .active && connection.isPaired)
        }
        .onChange(of: scenePhase) { _, phase in
          // Only leaving Palm ends its connections. A pulled-down Control
          // Centre or a system question (inactive) keeps them, so the screen
          // is still there after it (E2E, 23 September).
          guard phase != .inactive else { return }
          let active = phase == .active
          // Leaving: a moment to say goodbye, so the Mac frees the screen at
          // once instead of refusing the phone's return until it times out.
          let goodbye = active ? UIBackgroundTaskIdentifier.invalid : PalmApp.beginGoodbye()
          connection.setSceneActive(active)
          events.setActive(active && connection.isPaired)
          UIApplication.shared.isIdleTimerDisabled = active && connection.isStreaming
          if goodbye != .invalid {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { UIApplication.shared.endBackgroundTask(goodbye) }
          }
        }
        .onChange(of: connection.isPaired) { _, paired in
          events.setActive(paired && scenePhase == .active)
        }
        .onChange(of: connection.isStreaming) { _, streaming in
          UIApplication.shared.isIdleTimerDisabled = scenePhase == .active && streaming
        }
    }
  }
}
