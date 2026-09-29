import Cocoa

final class Delegate: NSObject, NSApplicationDelegate, NSTextFieldDelegate {
  var window: NSWindow!
  var field: NSTextField!
  var count = 0
  var label: NSTextField!
  let latencyMarker = NSView()
  func applicationDidFinishLaunching(_ notification: Notification) {
    let menu = NSMenu()
    let item = NSMenuItem()
    menu.addItem(item)
    let appMenu = NSMenu()
    appMenu.addItem(
      withTitle: "Quit Palm Test Pad", action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q")
    item.submenu = appMenu
    NSApplication.shared.mainMenu = menu
    window = NSWindow(
      contentRect: NSRect(x: 100, y: 150, width: 640, height: 440),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false
    )
    window.title = "Palm — isolated input test"
    window.contentMinSize = NSSize(width: 400, height: 360)
    window.backgroundColor = NSColor(calibratedRed: 0.10, green: 0.17, blue: 0.12, alpha: 1)
    let heading = NSTextField(wrappingLabelWithString: "Palm test canvas")
    heading.font = .systemFont(ofSize: 28, weight: .semibold)
    heading.textColor = .white
    let sub = NSTextField(wrappingLabelWithString: "This window contains test data only.")
    sub.font = .systemFont(ofSize: 16)
    sub.textColor = .lightGray
    field = NSTextField()
    field.placeholderString = "Type into this test field"
    field.font = .systemFont(ofSize: 20)
    field.delegate = self
    field.setAccessibilityLabel("Test text")
    let button = NSButton(title: "Add note", target: self, action: #selector(addNote))
    button.font = .systemFont(ofSize: 18)
    button.bezelStyle = .rounded
    label = NSTextField(labelWithString: "Notes added: 0")
    label.font = .systemFont(ofSize: 18)
    label.textColor = .white
    if let content = window.contentView {
      // Isolated fixture only: a visible color change measures the existing
      // named action through capture, transport and the phone's displayed frame.
      latencyMarker.translatesAutoresizingMaskIntoConstraints = false
      latencyMarker.wantsLayer = true
      updateLatencyMarker()
      content.addSubview(latencyMarker)
      for view in [heading, sub, field!, button, label!] {
        view.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(view)
      }
      NSLayoutConstraint.activate([
        latencyMarker.widthAnchor.constraint(equalToConstant: 96),
        latencyMarker.heightAnchor.constraint(equalToConstant: 64),
        latencyMarker.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
        latencyMarker.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),
        heading.topAnchor.constraint(equalTo: content.topAnchor, constant: 28),
        heading.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 28),
        heading.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -28),
        sub.topAnchor.constraint(equalTo: heading.bottomAnchor, constant: 12),
        sub.leadingAnchor.constraint(equalTo: heading.leadingAnchor),
        sub.trailingAnchor.constraint(equalTo: heading.trailingAnchor),
        field.topAnchor.constraint(equalTo: sub.bottomAnchor, constant: 28),
        field.leadingAnchor.constraint(equalTo: heading.leadingAnchor),
        field.trailingAnchor.constraint(equalTo: heading.trailingAnchor),
        field.heightAnchor.constraint(equalToConstant: 48),
        button.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 28),
        button.leadingAnchor.constraint(equalTo: heading.leadingAnchor),
        button.widthAnchor.constraint(equalToConstant: 140),
        button.heightAnchor.constraint(equalToConstant: 46),
        label.leadingAnchor.constraint(equalTo: button.trailingAnchor, constant: 16),
        label.centerYAnchor.constraint(equalTo: button.centerYAnchor),
        label.trailingAnchor.constraint(lessThanOrEqualTo: heading.trailingAnchor),
      ])
    }
    window.makeKeyAndOrderFront(nil)
    NSApplication.shared.activate(ignoringOtherApps: true)
    window.makeFirstResponder(field)
    save()
  }
  @objc func addNote() {
    count += 1
    label.stringValue = "Notes added: \(count)"
    updateLatencyMarker()
    save()
  }
  func updateLatencyMarker() {
    latencyMarker.layer?.backgroundColor =
      NSColor(
        srgbRed: count % 2 == 0 ? 0 : 1, green: count % 2 == 0 ? 1 : 0,
        blue: 1, alpha: 1
      ).cgColor
  }
  func controlTextDidChange(_ obj: Notification) { save() }
  func save() {
    guard let file = ProcessInfo.processInfo.environment["PALM_TEST_STATE"] else { return }
    let data = try! JSONSerialization.data(withJSONObject: [
      "text": field?.stringValue ?? "", "notes": count,
    ])
    try? data.write(to: URL(fileURLWithPath: file), options: .atomic)
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
