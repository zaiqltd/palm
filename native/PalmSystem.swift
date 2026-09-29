import Cocoa
import CoreServices
import ScreenCaptureKit

// Native services beyond the live video session: clipboard, Trash, agent
// observations and input, display brightness, the privacy curtain and power
// events. Each operation reports what macOS actually allowed.

// MARK: - Clipboard

enum PalmClipboard {
  static let maxImageBytes = 12 * 1024 * 1024
  static func read() -> [String: Any] {
    let board = NSPasteboard.general
    var result: [String: Any] = ["changeCount": board.changeCount]
    let files =
      (board.readObjects(
        forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    if !files.isEmpty { result["files"] = files.prefix(50).map { $0.path } }
    if let text = board.string(forType: .string) {
      result["text"] = String(text.prefix(200_000))
      result["textTruncated"] = text.count > 200_000
    }
    if files.isEmpty,
      let data = board.data(forType: .png) ?? board.data(forType: .tiff),
      let image = NSBitmapImageRep(data: data),
      let png = image.representation(using: .png, properties: [:])
    {
      if png.count <= maxImageBytes {
        result["imagePNG"] = png.base64EncodedString()
        result["imageWidth"] = image.pixelsWide
        result["imageHeight"] = image.pixelsHigh
      } else {
        result["imageTooLarge"] = true
      }
    }
    var kinds: [String] = []
    if result["files"] != nil { kinds.append("files") }
    if result["imagePNG"] != nil || result["imageTooLarge"] != nil { kinds.append("image") }
    if result["text"] != nil { kinds.append("text") }
    result["kinds"] = kinds
    return result
  }

  static func write(_ x: [String: Any]) throws -> [String: Any] {
    let board = NSPasteboard.general
    if let text = x["text"] as? String {
      try require(text.utf8.count <= 4_000_000, "That text is too large for the clipboard.")
      board.clearContents()
      try require(board.setString(text, forType: .string), "macOS rejected the clipboard text.")
      return ["ok": true, "kind": "text", "changeCount": board.changeCount]
    }
    if let base64 = x["imagePNG"] as? String {
      guard let data = Data(base64Encoded: base64), data.count <= maxImageBytes,
        let image = NSImage(data: data)
      else { throw PalmError(message: "That image could not be read.") }
      board.clearContents()
      try require(board.writeObjects([image]), "macOS rejected the clipboard image.")
      return ["ok": true, "kind": "image", "changeCount": board.changeCount]
    }
    if let paths = x["files"] as? [String], !paths.isEmpty, paths.count <= 50 {
      let urls = paths.map { URL(fileURLWithPath: $0) }
      for url in urls {
        try require(
          FileManager.default.fileExists(atPath: url.path), "\(url.lastPathComponent) is missing.")
      }
      board.clearContents()
      try require(board.writeObjects(urls as [NSURL]), "macOS rejected the clipboard files.")
      return ["ok": true, "kind": "files", "changeCount": board.changeCount]
    }
    throw PalmError(message: "Nothing to put on the Mac clipboard.")
  }
}

// MARK: - Trash

enum PalmTrash {
  static func move(_ paths: [String]) throws -> [[String: Any]] {
    var results: [[String: Any]] = []
    for path in paths.prefix(200) {
      var resulting: NSURL?
      do {
        try FileManager.default.trashItem(at: URL(fileURLWithPath: path), resultingItemURL: &resulting)
        results.append(["from": path, "to": resulting?.path ?? ""])
      } catch {
        throw PalmError(
          message: "macOS could not move \(URL(fileURLWithPath: path).lastPathComponent) to the Trash.")
      }
    }
    return results
  }
}

// MARK: - Brightness (built-in display, DisplayServices)

enum PalmBrightness {
  typealias Getter = @convention(c) (CGDirectDisplayID, UnsafeMutablePointer<Float>) -> Int32
  typealias Setter = @convention(c) (CGDirectDisplayID, Float) -> Int32
  static let handle = dlopen(
    "/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_NOW)
  static var getter: Getter? {
    guard let handle, let symbol = dlsym(handle, "DisplayServicesGetBrightness") else { return nil }
    return unsafeBitCast(symbol, to: Getter.self)
  }
  static var setter: Setter? {
    guard let handle, let symbol = dlsym(handle, "DisplayServicesSetBrightness") else { return nil }
    return unsafeBitCast(symbol, to: Setter.self)
  }
  static func builtInDisplay() -> CGDirectDisplayID? {
    var count: UInt32 = 0
    CGGetOnlineDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetOnlineDisplayList(count, &ids, &count)
    return ids.first { CGDisplayIsBuiltin($0) != 0 }
  }
  static func get() -> Float? {
    guard let display = builtInDisplay(), let getter else { return nil }
    var value: Float = 0
    return getter(display, &value) == 0 ? value : nil
  }
  static func set(_ value: Float) throws -> Float {
    guard let display = builtInDisplay() else {
      throw PalmError(message: "No built-in display is active. External display brightness is not supported.")
    }
    guard let setter else { throw PalmError(message: "Brightness control is unavailable on this Mac.") }
    try require(setter(display, max(0, min(1, value))) == 0, "macOS rejected the brightness change.")
    return get() ?? value
  }
}

// MARK: - Keyboard backlight

// The built-in keyboard's backlight, through macOS's private CoreBrightness
// client (the same one Control Centre uses). Every call is checked: if this
// macOS lacks the client or a method, Palm reports the light as unavailable.
enum PalmKeyboardLight {
  private static let client: NSObject? = {
    guard Bundle(path: "/System/Library/PrivateFrameworks/CoreBrightness.framework")?.load() == true,
      let type = NSClassFromString("KeyboardBrightnessClient") as? NSObject.Type
    else { return nil }
    return type.init()
  }()

  private static func imp<T>(_ name: String, as type: T.Type) -> (NSObject, Selector, T)? {
    guard let client else { return nil }
    let selector = NSSelectorFromString(name)
    guard client.responds(to: selector), let method = client.method(for: selector) else { return nil }
    return (client, selector, unsafeBitCast(method, to: type))
  }

  /// The built-in keyboard's backlight ID (usually 1).
  static func keyboardID() -> UInt64? {
    guard let client else { return nil }
    let selector = NSSelectorFromString("copyKeyboardBacklightIDs")
    guard client.responds(to: selector),
      let ids = client.perform(selector)?.takeRetainedValue() as? [NSNumber], !ids.isEmpty
    else { return nil }
    typealias BuiltIn = @convention(c) (AnyObject, Selector, UInt64) -> Bool
    if let (object, sel, builtIn) = imp("isKeyboardBuiltIn:", as: BuiltIn.self),
      let id = ids.map(\.uint64Value).first(where: { builtIn(object, sel, $0) })
    {
      return id
    }
    return ids.first?.uint64Value
  }

  static func state() -> [String: Any]? {
    guard let id = keyboardID() else { return nil }
    typealias Level = @convention(c) (AnyObject, Selector, UInt64) -> Float
    typealias Auto = @convention(c) (AnyObject, Selector, UInt64) -> Bool
    guard let (object, sel, level) = imp("brightnessForKeyboard:", as: Level.self) else { return nil }
    var state: [String: Any] = ["level": Double(max(0, min(1, level(object, sel, id))))]
    if let (autoObject, autoSel, auto) = imp("isAutoBrightnessEnabledForKeyboard:", as: Auto.self) {
      state["auto"] = auto(autoObject, autoSel, id)
    }
    return state
  }

  static func set(level: Float) throws -> [String: Any] {
    guard let id = keyboardID() else { throw PalmError(message: "This Mac has no adjustable keyboard light.") }
    typealias Set = @convention(c) (AnyObject, Selector, Float, UInt64) -> Bool
    guard let (object, sel, set) = imp("setBrightness:forKeyboard:", as: Set.self) else {
      throw PalmError(message: "Keyboard light control is unavailable on this macOS.")
    }
    try require(set(object, sel, max(0, min(1, level)), id), "macOS did not change the keyboard light.")
    return state() ?? ["level": Double(level)]
  }

  static func set(auto on: Bool) throws -> [String: Any] {
    guard let id = keyboardID() else { throw PalmError(message: "This Mac has no adjustable keyboard light.") }
    typealias Enable = @convention(c) (AnyObject, Selector, Bool, UInt64) -> Bool
    guard let (object, sel, enable) = imp("enableAutoBrightness:forKeyboard:", as: Enable.self) else {
      throw PalmError(message: "Automatic keyboard light is unavailable on this macOS.")
    }
    try require(enable(object, sel, on, id), "macOS did not change the automatic keyboard light.")
    return state() ?? ["auto": on]
  }
}

// MARK: - Privacy curtain

// A black window over every display, above the menu bar and Dock. It ignores
// the mouse, never becomes key and is excluded from Palm's own capture, so the
// phone keeps seeing and controlling the Mac while its own screen shows black.
@MainActor final class PalmCurtain {
  private(set) var windows: [NSWindow] = []
  private var monitor: Any?
  private var screenObserver: NSObjectProtocol?
  var onChange: (() -> Void)?
  var isOn: Bool { !windows.isEmpty }
  var windowIDs: [CGWindowID] { windows.map { CGWindowID($0.windowNumber) } }

  func set(_ on: Bool) {
    if on == isOn { return }
    if on {
      rebuild()
      screenObserver = NotificationCenter.default.addObserver(
        forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
      ) { [weak self] _ in
        MainActor.assumeIsolated { if self?.isOn == true { self?.rebuild() } }
      }
      // Local escape hatch: Control-Option-Command-P turns the curtain off.
      monitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if flags.contains([.control, .option, .command]), event.charactersIgnoringModifiers == "p" {
          MainActor.assumeIsolated { self?.set(false) }
        }
      }
    } else {
      for window in windows { window.orderOut(nil) }
      windows = []
      if let monitor { NSEvent.removeMonitor(monitor) }
      monitor = nil
      if let screenObserver { NotificationCenter.default.removeObserver(screenObserver) }
      screenObserver = nil
    }
    onChange?()
  }

  private func rebuild() {
    for window in windows { window.orderOut(nil) }
    windows = NSScreen.screens.map { screen in
      let window = NSWindow(
        contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
      window.level = .screenSaver
      window.backgroundColor = .black
      window.isOpaque = true
      window.ignoresMouseEvents = true
      window.hasShadow = false
      window.isReleasedWhenClosed = false
      window.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]
      let label = NSTextField(
        labelWithString: "Palm privacy screen · controlled from your iPhone\nPress ⌃⌥⌘P to show this screen")
      label.alignment = .center
      label.maximumNumberOfLines = 2
      label.textColor = NSColor(white: 0.32, alpha: 1)
      label.font = .systemFont(ofSize: 15)
      label.translatesAutoresizingMaskIntoConstraints = false
      let content = NSView(frame: screen.frame)
      content.wantsLayer = true
      content.layer?.backgroundColor = NSColor.black.cgColor
      content.addSubview(label)
      NSLayoutConstraint.activate([
        label.centerXAnchor.constraint(equalTo: content.centerXAnchor),
        label.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -48),
      ])
      window.contentView = content
      window.setFrame(screen.frame, display: true)
      window.orderFrontRegardless()
      return window
    }
  }
}

// MARK: - Agent observation and input (whole main display, screen points)

@MainActor enum PalmAgentScreen {
  static func mainDisplayBounds() -> CGRect { CGDisplayBounds(CGMainDisplayID()) }

  static func screenshot(maxWidth: Int, excluding: [CGWindowID]) async throws -> [String: Any] {
    try require(
      CGPreflightScreenCaptureAccess(), "Allow Screen Recording for Palm on the Mac first.")
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: true)
    guard
      let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() })
        ?? content.displays.first
    else { throw PalmError(message: "No display is available.") }
    let bounds = CGDisplayBounds(display.displayID)
    let excluded = content.windows.filter { excluding.contains($0.windowID) }
    let filter = SCContentFilter(display: display, excludingWindows: excluded)
    let config = SCStreamConfiguration()
    let width = max(320, min(maxWidth, Int(bounds.width * 2)))
    let scale = CGFloat(width) / bounds.width
    config.width = width
    config.height = Int((bounds.height * scale).rounded())
    config.showsCursor = true
    config.capturesAudio = false
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter, configuration: config)
    let rep = NSBitmapImageRep(cgImage: image)
    guard
      let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.72])
    else { throw PalmError(message: "The screenshot could not be encoded.") }
    var frontmost: [String: Any] = [:]
    if let app = NSWorkspace.shared.frontmostApplication {
      frontmost = ["name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? ""]
    }
    return [
      "jpeg": jpeg.base64EncodedString(), "width": image.width, "height": image.height,
      "screen": [
        "x": bounds.minX, "y": bounds.minY, "width": bounds.width, "height": bounds.height,
      ],
      "frontmost": frontmost,
    ]
  }

  static let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
    "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
    "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
    "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
    ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116,
    "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  ]

  static func flags(_ modifiers: [String]) -> CGEventFlags {
    var flags = CGEventFlags()
    for m in modifiers {
      switch m.lowercased() {
      case "cmd", "command", "meta": flags.insert(.maskCommand)
      case "shift": flags.insert(.maskShift)
      case "opt", "option", "alt": flags.insert(.maskAlternate)
      case "ctrl", "control": flags.insert(.maskControl)
      case "fn": flags.insert(.maskSecondaryFn)
      default: break
      }
    }
    return flags
  }

  /// Command, Shift, Option and Control as keys of their own.
  static let modifierKeys: [(flag: CGEventFlags, code: CGKeyCode)] = [
    (.maskCommand, 55), (.maskShift, 56), (.maskAlternate, 58), (.maskControl, 59),
  ]

  /// The modifiers go down, the key is pressed, the modifiers come up, as on
  /// a keyboard. Shortcuts that wait for the release finish: ⌘Tab's app
  /// switcher stayed open without it (E2E, 23 September).
  static func press(key: String, modifiers: [String]) throws {
    guard let code = keyCodes[key.lowercased()] else {
      throw PalmError(message: "Unsupported key \(key.prefix(20)).")
    }
    let f = flags(modifiers)
    let held = modifierKeys.filter { f.contains($0.flag) }
    var current = f.subtracting(CGEventFlags(held.map(\.flag)))
    for modifier in held {
      current.insert(modifier.flag)
      let down = CGEvent(keyboardEventSource: nil, virtualKey: modifier.code, keyDown: true)
      down?.flags = current
      down?.post(tap: .cghidEventTap)
    }
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    down?.flags = f
    up?.flags = f
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
    for modifier in held.reversed() {
      current.remove(modifier.flag)
      let up = CGEvent(keyboardEventSource: nil, virtualKey: modifier.code, keyDown: false)
      up?.flags = current
      up?.post(tap: .cghidEventTap)
    }
  }

  static func type(_ text: String) {
    var chunks: [[UInt16]] = []
    var current: [UInt16] = []
    for scalar in text.unicodeScalars {
      if scalar == "\n" || scalar == "\r" {
        if !current.isEmpty { chunks.append(current); current = [] }
        chunks.append([])  // an empty chunk means Return
        continue
      }
      let chars = Array(String(scalar).utf16)
      if current.count + chars.count > 20 {
        chunks.append(current)
        current = []
      }
      current.append(contentsOf: chars)
    }
    if !current.isEmpty { chunks.append(current) }
    for part in chunks {
      if part.isEmpty {
        try? press(key: "return", modifiers: [])
        continue
      }
      let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
      let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
      part.withUnsafeBufferPointer { p in
        down?.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress!)
        up?.keyboardSetUnicodeString(stringLength: p.count, unicodeString: p.baseAddress!)
      }
      down?.post(tap: .cghidEventTap)
      up?.post(tap: .cghidEventTap)
    }
  }

  static func point(_ x: [String: Any], _ key: String = "x", _ keyY: String = "y") throws -> CGPoint {
    guard let px = (x[key] as? NSNumber)?.doubleValue, let py = (x[keyY] as? NSNumber)?.doubleValue,
      px.isFinite, py.isFinite
    else { throw PalmError(message: "Missing screen coordinates.") }
    // Clamp to the union of displays so a stale coordinate cannot fly off-screen.
    var union = CGRect.null
    for screen in NSScreen.screens {
      let id = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID ?? 0
      union = union.union(CGDisplayBounds(id))
    }
    if union.isNull { union = mainDisplayBounds() }
    return CGPoint(
      x: min(max(px, union.minX), union.maxX - 1), y: min(max(py, union.minY), union.maxY - 1))
  }

  static func mouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton = .left, count: Int64 = 1, flags: CGEventFlags = []) {
    let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button)
    event?.setIntegerValueField(.mouseEventClickState, value: count)
    if !flags.isEmpty { event?.flags = flags }
    event?.post(tap: .cghidEventTap)
  }

  static func perform(_ x: [String: Any]) async throws -> [String: Any] {
    try require(AXIsProcessTrusted(), "Allow Accessibility for Palm on the Mac first.")
    let action = x["action"] as? String ?? ""
    let modifiers = (x["modifiers"] as? [String]) ?? []
    switch action {
    case "click", "double", "right", "move":
      let p = try point(x)
      let f = flags(modifiers)
      mouse(.mouseMoved, p)
      if action == "move" { break }
      if action == "right" {
        mouse(.rightMouseDown, p, .right, flags: f)
        mouse(.rightMouseUp, p, .right, flags: f)
      } else {
        mouse(.leftMouseDown, p, flags: f)
        mouse(.leftMouseUp, p, flags: f)
        if action == "double" {
          mouse(.leftMouseDown, p, count: 2, flags: f)
          mouse(.leftMouseUp, p, count: 2, flags: f)
        }
      }
    case "drag":
      let from = try point(x)
      let to = try point(x, "toX", "toY")
      mouse(.mouseMoved, from)
      mouse(.leftMouseDown, from)
      for step in 1...12 {
        let t = CGFloat(step) / 12
        mouse(.leftMouseDragged, CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t))
        try? await Task.sleep(nanoseconds: 12_000_000)
      }
      mouse(.leftMouseUp, to)
    case "scroll":
      let p = try point(x)
      mouse(.mouseMoved, p)
      let dy = Int32((x["dy"] as? NSNumber)?.doubleValue ?? 0)
      let dx = Int32((x["dx"] as? NSNumber)?.doubleValue ?? 0)
      let event = CGEvent(
        scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
        wheel1: max(-2000, min(2000, -dy)), wheel2: max(-2000, min(2000, -dx)), wheel3: 0)
      event?.location = p
      event?.post(tap: .cghidEventTap)
    case "text":
      guard let text = x["text"] as? String, text.count <= 8000 else {
        throw PalmError(message: "Text must be 8,000 characters or fewer.")
      }
      type(text)
    case "key":
      guard let key = x["key"] as? String else { throw PalmError(message: "Missing key.") }
      try press(key: key, modifiers: modifiers)
    default:
      throw PalmError(message: "Unsupported screen action.")
    }
    return ["ok": true]
  }
}

// MARK: - Power events (loginwindow Apple events)

enum PalmPower {
  static func code(_ kind: String) -> AEEventID? {
    switch kind {
    case "restart": return AEEventID(kAERestart)
    case "shutdown": return AEEventID(kAEShutDown)
    case "logout": return AEEventID(kAEReallyLogOut)
    default: return nil
    }
  }

  // Ask macOS whether Palm may send this event without prompting. This does not
  // send anything, so it is safe to run as a capability check.
  static func check(_ kind: String) -> [String: Any] {
    guard code(kind) != nil else { return ["allowed": false, "detail": "Unsupported power action."] }
    let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.loginwindow")
    let status = AEDeterminePermissionToAutomateTarget(
      target.aeDesc, AEEventClass(kCoreEventClass), code(kind)!, false)
    switch status {
    case noErr: return ["allowed": true, "status": Int(status)]
    case OSStatus(errAEEventWouldRequireUserConsent):
      return [
        "allowed": true, "status": Int(status), "prompt": true,
        "detail": "macOS may ask on the Mac to let Palm control the system the first time.",
      ]
    case OSStatus(errAEEventNotPermitted):
      return [
        "allowed": false, "status": Int(status),
        "detail": "macOS has not allowed Palm to control the system. Enable it in System Settings › Privacy & Security › Automation.",
      ]
    default:
      return ["allowed": true, "status": Int(status)]
    }
  }

  static func send(_ kind: String) throws {
    guard let id = code(kind) else { throw PalmError(message: "Unsupported power action.") }
    let target = NSAppleEventDescriptor(bundleIdentifier: "com.apple.loginwindow")
    let event = NSAppleEventDescriptor(
      eventClass: AEEventClass(kCoreEventClass), eventID: id, targetDescriptor: target,
      returnID: AEReturnID(kAutoGenerateReturnID), transactionID: AETransactionID(kAnyTransactionID))
    do {
      _ = try event.sendEvent(options: [.noReply], timeout: 10)
    } catch {
      throw PalmError(message: "macOS did not accept the \(kind) request.")
    }
  }
}
