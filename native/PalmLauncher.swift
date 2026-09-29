import Cocoa
import ServiceManagement

@MainActor final class Launcher: NSObject, NSApplicationDelegate {
  var server: Process?
  var quitting = false
  var launchedAtLogin = false
  var restarts: [Date] = []
  var state: URL?
  var loginItemTimer: Timer?
  let url = URL(string: "http://localhost:4318")!

  func applicationWillFinishLaunching(_ notification: Notification) {
    // Started by macOS at login: run quietly, without opening the setup page.
    if let event = NSAppleEventManager.shared().currentAppleEvent, event.eventID == AEEventID(kAEOpenApplication),
      event.paramDescriptor(forKeyword: AEKeyword(keyAEPropData))?.enumCodeValue == OSType(keyAELaunchedAsLogInItem)
    {
      launchedAtLogin = true
    }
    // Scripted restarts (install, live checks) also start quietly.
    if CommandLine.arguments.contains("--quiet") { launchedAtLogin = true }
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    Task { @MainActor in
      if await serverAnswers() {
        if !launchedAtLogin { NSWorkspace.shared.open(url) }
        NSApplication.shared.terminate(nil)
        return
      }
      await start(openSetup: !launchedAtLogin)
    }
  }

  @MainActor func serverAnswers() async -> Bool {
    var request = URLRequest(url: url.appendingPathComponent("api/session"))
    request.timeoutInterval = 1
    guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
    return (response as? HTTPURLResponse)?.statusCode == 200
  }

  @MainActor func start(openSetup: Bool) async {
    let bundled = Bundle.main.object(forInfoDictionaryKey: "PalmBundledRuntime") as? Bool == true
    let root = bundled
      ? Bundle.main.resourceURL!.appendingPathComponent("palm").path
      : Bundle.main.object(forInfoDictionaryKey: "PalmProjectRoot") as? String
    let node = bundled
      ? Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node").path
      : Bundle.main.object(forInfoDictionaryKey: "PalmNodePath") as? String
    guard let root, let node else {
      showFailure("Palm's runtime is missing. Reinstall the app or rebuild the development launcher.")
      return
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: node)
    process.arguments = ["server/index.mjs"]
    process.currentDirectoryURL = URL(fileURLWithPath: root)
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    if bundled {
      do {
        let state = try FileManager.default.url(for: .applicationSupportDirectory,
          in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Palm")
        try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true,
          attributes: [.posixPermissions: 0o700])
        let shared = state.appendingPathComponent("Shared")
        try FileManager.default.createDirectory(at: shared, withIntermediateDirectories: true,
          attributes: [.posixPermissions: 0o700])
        let welcome = shared.appendingPathComponent("Welcome.txt")
        if !FileManager.default.fileExists(atPath: welcome.path) {
          try "This is Palm's shared folder. Add files here to make them available on your paired iPhone.\n"
            .write(to: welcome, atomically: true, encoding: .utf8)
        }
        // The installed host owns its runtime paths. Development overrides,
        // Node preload hooks and dynamic-loader variables must not leak into it.
        let inherited = ProcessInfo.processInfo.environment
        let allowed = Set(["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"])
        var environment = inherited.filter { allowed.contains($0.key) }
        environment["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        environment["PALM_STATE_DIR"] = state.path
        environment["PALM_SHARE_ROOT"] = shared.path
        process.environment = environment
        self.state = state
        watchLoginItem()
      } catch {
        showFailure("Palm could not create its private settings folder in Application Support.")
        return
      }
    }
    process.terminationHandler = { [weak self] ended in
      Task { @MainActor in self?.serverEnded(ended) }
    }
    do {
      try process.run()
      server = process
      for _ in 0..<40 {
        try? await Task.sleep(nanoseconds: 250_000_000)
        if await serverAnswers() {
          if openSetup { NSWorkspace.shared.open(url) }
          return
        }
        if !process.isRunning { return }
      }
      if process.isRunning { process.terminate() }
      showFailure("The companion did not become ready. Check that port 4318 is available, then reopen Palm.")
    } catch {
      showFailure("Palm's runtime could not launch. Reinstall the app or rebuild the development launcher.")
    }
  }

  /// A clean stop (quit, an update) ends Palm. A crash restarts the server,
  /// at most five times in ten minutes; shells live on in the terminal service.
  @MainActor func serverEnded(_ process: Process) {
    guard process === server else { return }
    server = nil
    let crashed = process.terminationReason == .uncaughtSignal
      ? process.terminationStatus != SIGTERM && process.terminationStatus != SIGINT
      : process.terminationStatus != 0
    if quitting || !crashed {
      NSApplication.shared.terminate(nil)
      return
    }
    restarts = restarts.filter { $0.timeIntervalSinceNow > -600 } + [Date()]
    if restarts.count > 5 {
      showFailure("Palm stopped unexpectedly several times. Reopen Palm to try again.")
      return
    }
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      await start(openSetup: false)
    }
  }

  // MARK: Open at login (opt-in)

  /// Palm's server asks for "open at login" by writing login-item-request.json;
  /// only this app can register itself with macOS, so it applies the request
  /// and reports the result in login-item.json. Nothing changes until asked.
  @MainActor func watchLoginItem() {
    reportLoginItem()
    loginItemTimer?.invalidate()
    loginItemTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      Task { @MainActor in self?.applyLoginItemRequest() }
    }
  }

  @MainActor func applyLoginItemRequest() {
    guard let state else { return }
    let requestURL = state.appendingPathComponent("login-item-request.json")
    guard let data = try? Data(contentsOf: requestURL),
      let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let enabled = request["enabled"] as? Bool
    else { return }
    try? FileManager.default.removeItem(at: requestURL)
    var failure: String?
    do {
      if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      failure = error.localizedDescription
    }
    reportLoginItem(failure: failure)
  }

  @MainActor func reportLoginItem(failure: String? = nil) {
    guard let state else { return }
    let status: String
    switch SMAppService.mainApp.status {
    case .enabled: status = "enabled"
    case .requiresApproval: status = "requiresApproval"
    case .notFound: status = "notFound"
    default: status = "off"
    }
    var report: [String: Any] = ["status": status, "checkedAt": ISO8601DateFormatter().string(from: Date())]
    if let failure { report["error"] = failure }
    if let data = try? JSONSerialization.data(withJSONObject: report) {
      try? data.write(to: state.appendingPathComponent("login-item.json"), options: .atomic)
    }
  }

  @MainActor func showFailure(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "Palm could not start."
    alert.informativeText = message
    alert.runModal()
    NSApplication.shared.terminate(nil)
  }

  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    loginItemTimer?.invalidate()
    if server?.isRunning == true { server?.terminate() }
  }
}

MainActor.assumeIsolated {
  let app = NSApplication.shared
  // NSApplication keeps its delegate weakly; this one lives as long as run().
  let delegate = Launcher()
  app.delegate = delegate
  app.setActivationPolicy(.accessory)
  app.run()
}
