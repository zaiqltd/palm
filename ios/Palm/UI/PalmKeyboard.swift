import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Types straight into the Mac as you press keys: no text box, no Send button.
/// Letters go as text; Return, Backspace, arrows and shortcuts go as keys.
/// Sticky ⌘ ⌥ ⌃ ⇧ apply to the next key, like a hardware keyboard.
struct PalmKeyCatcher: UIViewRepresentable {
  @Binding var active: Bool
  /// The key bar's microphone: speak instead of typing.
  var speak: (() -> Void)?
  /// The key bar's Paste (this iPhone's copied text or picture) and Photo keys.
  var paste: ((String?, UIImage?) -> Void)?
  var photo: (() -> Void)?
  let send: (PalmKeystroke) -> Void

  func makeUIView(context: Context) -> PalmKeyCatcherView {
    let view = PalmKeyCatcherView()
    view.send = send
    view.onSpeak = speak
    view.onPaste = paste
    view.onPhoto = photo
    view.onDismiss = { active = false }
    return view
  }

  func updateUIView(_ view: PalmKeyCatcherView, context: Context) {
    view.send = send
    view.onSpeak = speak
    view.onPaste = paste
    view.onPhoto = photo
    view.onDismiss = { active = false }
    if active, !view.isFirstResponder {
      DispatchQueue.main.async { _ = view.becomeFirstResponder() }
    } else if !active, view.isFirstResponder {
      DispatchQueue.main.async { _ = view.resignFirstResponder() }
    }
  }
}

enum PalmKeystroke: Equatable {
  case text(String)
  case key(String, [String])
}

final class PalmKeyCatcherView: UIView, UIKeyInput {
  var send: ((PalmKeystroke) -> Void)?
  var onDismiss: (() -> Void)?
  var onSpeak: (() -> Void)?
  var onPaste: ((String?, UIImage?) -> Void)?
  var onPhoto: (() -> Void)?
  private(set) var modifiers: Set<String> = []
  private var pending = ""
  private var flushTimer: Timer?
  private lazy var bar = PalmKeyBar(owner: self)

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = false
    backgroundColor = .clear
    // What the key bar's Paste takes from this iPhone: text or a picture.
    pasteConfiguration = UIPasteConfiguration(acceptableTypeIdentifiers: [UTType.image.identifier, UTType.text.identifier])
  }

  /// The key bar's Paste (Apple's paste button: iOS does not ask "Allow Paste?",
  /// and the app never waits on that question).
  override func paste(itemProviders: [NSItemProvider]) {
    flush()
    guard let provider = itemProviders.first else { return }
    if provider.canLoadObject(ofClass: UIImage.self) {
      provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
        guard let image = object as? UIImage else { return }
        DispatchQueue.main.async { self?.onPaste?(nil, image) }
      }
    } else if provider.canLoadObject(ofClass: NSString.self) {
      provider.loadObject(ofClass: NSString.self) { [weak self] object, _ in
        guard let text = object as? String, !text.isEmpty else { return }
        DispatchQueue.main.async {
          guard let self else { return }
          if let onPaste = self.onPaste { onPaste(text, nil) } else { self.send?(.text(String(text.prefix(4000)))) }
        }
      }
    }
  }

  required init?(coder: NSCoder) { nil }

  override var canBecomeFirstResponder: Bool { true }
  override var inputAccessoryView: UIView? { bar }

  override func resignFirstResponder() -> Bool {
    flush()
    let result = super.resignFirstResponder()
    if result { onDismiss?() }
    return result
  }

  // MARK: UIKeyInput / text input traits
  var hasText: Bool { true }
  var autocorrectionType: UITextAutocorrectionType = .no
  var autocapitalizationType: UITextAutocapitalizationType = .none
  var spellCheckingType: UITextSpellCheckingType = .no
  var smartQuotesType: UITextSmartQuotesType = .no
  var smartDashesType: UITextSmartDashesType = .no
  var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
  var keyboardAppearance: UIKeyboardAppearance = .dark
  var returnKeyType: UIReturnKeyType = .default

  func insertText(_ text: String) {
    if !modifiers.isEmpty {
      flush()
      for character in text.lowercased() { press(String(character)) }
      return
    }
    if text == "\n" {
      flush()
      send?(.key("enter", []))
      return
    }
    // Coalesce fast typing into small chunks; each still arrives in order.
    pending += text
    flushTimer?.invalidate()
    if pending.count >= 24 { flush() }
    else { flushTimer = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: false) { [weak self] _ in self?.flush() } }
  }

  func deleteBackward() {
    flush()
    press("backspace")
  }

  func flush() {
    flushTimer?.invalidate()
    flushTimer = nil
    guard !pending.isEmpty else { return }
    let text = pending
    pending = ""
    send?(.text(text))
  }

  func press(_ key: String) {
    flush()
    send?(.key(key, Array(modifiers).sorted()))
    if !modifiers.isEmpty {
      modifiers.removeAll()
      bar.show(modifiers)
    }
  }

  func toggle(_ modifier: String) {
    if modifiers.contains(modifier) { modifiers.remove(modifier) } else { modifiers.insert(modifier) }
    bar.show(modifiers)
    UISelectionFeedbackGenerator().selectionChanged()
  }

  func shortcut(_ key: String, _ mods: [String]) {
    flush()
    send?(.key(key, mods))
  }


}

// MARK: - Shared key bar

/// A row of keys shown above the iPhone keyboard, or along the bottom of the
/// screen when a hardware keyboard is in use (iPhone Mirroring, a Bluetooth
/// keyboard). Its keys stay inside the safe area, so they never sit under the
/// home indicator or the rounded corners of the screen. Keys scroll
/// sideways; the trailing keys stay put.
class PalmAccessoryBar: UIInputView, UIInputViewAudioFeedback {
  static let keyHeight: CGFloat = 40
  let keys = UIStackView()
  let fixedKeys = UIStackView()
  private let scroll = PalmKeyScroll()
  private var repeatTimer: Timer?

  init() {
    super.init(frame: CGRect(x: 0, y: 0, width: 390, height: Self.keyHeight + 12), inputViewStyle: .keyboard)
    allowsSelfSizing = true
    autoresizingMask = .flexibleHeight
    scroll.showsHorizontalScrollIndicator = false
    scroll.alwaysBounceHorizontal = true
    scroll.translatesAutoresizingMaskIntoConstraints = false
    keys.axis = .horizontal
    keys.spacing = 5
    keys.translatesAutoresizingMaskIntoConstraints = false
    fixedKeys.axis = .horizontal
    fixedKeys.spacing = 5
    fixedKeys.translatesAutoresizingMaskIntoConstraints = false
    addSubview(scroll)
    addSubview(fixedKeys)
    scroll.addSubview(keys)
    let guide = safeAreaLayoutGuide
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
      scroll.topAnchor.constraint(equalTo: topAnchor, constant: 6),
      scroll.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -6),
      scroll.heightAnchor.constraint(equalToConstant: Self.keyHeight),
      fixedKeys.leadingAnchor.constraint(equalTo: scroll.trailingAnchor, constant: 6),
      fixedKeys.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -10),
      fixedKeys.centerYAnchor.constraint(equalTo: scroll.centerYAnchor),
      keys.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 10),
      keys.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -4),
      keys.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
      keys.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
      keys.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
    ])
  }

  required init?(coder: NSCoder) { nil }

  override var intrinsicContentSize: CGSize { CGSize(width: UIView.noIntrinsicMetric, height: UIView.noIntrinsicMetric) }

  var enableInputClicksWhenVisible: Bool { true }

  /// A key: a word or symbol (`title`) or an SF Symbol (`symbol`).
  @discardableResult
  func key(_ title: String? = nil, symbol: String? = nil, label: String, fixed: Bool = false,
    repeats: Bool = false, id: String? = nil, action: @escaping () -> Void) -> UIButton {
    var config = UIButton.Configuration.filled()
    config.title = title
    if let symbol {
      config.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold))
    }
    config.baseBackgroundColor = Self.keyColour
    config.baseForegroundColor = .white
    config.background.cornerRadius = 9
    config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8)
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
      var outgoing = incoming
      outgoing.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
      return outgoing
    }
    let button = UIButton(configuration: config)
    button.accessibilityLabel = label
    button.accessibilityIdentifier = id
    button.heightAnchor.constraint(equalToConstant: Self.keyHeight).isActive = true
    button.widthAnchor.constraint(greaterThanOrEqualToConstant: 40).isActive = true
    if repeats {
      // Arrow keys repeat while held, like the hardware keys.
      button.addAction(UIAction { [weak self] _ in
        UIDevice.current.playInputClick()
        action()
        self?.repeatTimer?.invalidate()
        self?.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { _ in
          self?.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.07, repeats: true) { _ in action() }
        }
      }, for: .touchDown)
      for event: UIControl.Event in [.touchUpInside, .touchUpOutside, .touchCancel] {
        button.addAction(UIAction { [weak self] _ in self?.stopRepeating() }, for: event)
      }
    } else {
      button.addAction(UIAction { _ in
        UIDevice.current.playInputClick()
        action()
      }, for: .primaryActionTriggered)
    }
    (fixed ? fixedKeys : keys).addArrangedSubview(button)
    return button
  }

  func stopRepeating() {
    repeatTimer?.invalidate()
    repeatTimer = nil
  }

  /// Shows a sticky modifier as on (white key, dark symbol) or off.
  static func setLatched(_ button: UIButton, _ on: Bool) {
    var config = button.configuration
    config?.baseBackgroundColor = on ? UIColor(PalmStyle.accent) : keyColour
    config?.baseForegroundColor = on ? UIColor(PalmStyle.onAccent) : .white
    button.configuration = config
    button.accessibilityValue = on ? "On" : "Off"
    if on { button.accessibilityTraits.insert(.selected) } else { button.accessibilityTraits.remove(.selected) }
  }

  static let keyColour = UIColor(white: 1, alpha: 0.16)

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { stopRepeating() }
  }
}

/// The keys scroll sideways even when the swipe starts on a key held for a
/// moment: a key's touch gives way to the swipe (E2E, 23 September: a drag
/// that began on a key never moved the row, so ⌘ stayed out of reach).
final class PalmKeyScroll: UIScrollView {
  override func touchesShouldCancel(in view: UIView) -> Bool { true }
}

/// The key bar for typing on the Mac from the live screen.
final class PalmKeyBar: PalmAccessoryBar {
  private weak var owner: PalmKeyCatcherView?
  private var modifierButtons: [String: UIButton] = [:]

  init(owner: PalmKeyCatcherView) {
    self.owner = owner
    super.init()
    // First, where they are seen: this iPhone's clipboard and photos, onto the
    // Mac. Symbols only, so ⌘, ⌥ and ⌃ fit beside them without scrolling.
    var paste = UIPasteControl.Configuration()
    paste.displayMode = .iconOnly
    paste.cornerStyle = .medium
    paste.baseBackgroundColor = Self.keyColour
    paste.baseForegroundColor = .white
    let pasteKey = UIPasteControl(configuration: paste)
    pasteKey.target = owner
    pasteKey.accessibilityIdentifier = "keybar.paste"
    pasteKey.heightAnchor.constraint(equalToConstant: Self.keyHeight).isActive = true
    pasteKey.widthAnchor.constraint(equalToConstant: 44).isActive = true
    keys.addArrangedSubview(pasteKey)
    key(symbol: "photo", label: "Paste a photo from this iPhone on the Mac", id: "keybar.photo") { [weak owner] in
      owner?.flush()
      owner?.onPhoto?()
    }
    key("esc", label: "Escape") { [weak owner] in owner?.press("escape") }
    key("tab", label: "Tab") { [weak owner] in owner?.press("tab") }
    for (symbol, name, label) in [("⌘", "cmd", "Command"), ("⌥", "opt", "Option"), ("⌃", "ctrl", "Control"), ("⇧", "shift", "Shift")] {
      modifierButtons[name] = key(symbol, label: label, id: "keybar.\(name)") { [weak owner] in owner?.toggle(name) }
    }
    key(symbol: "arrow.left", label: "Left arrow", repeats: true) { [weak owner] in owner?.press("left") }
    key(symbol: "arrow.up", label: "Up arrow", repeats: true) { [weak owner] in owner?.press("up") }
    key(symbol: "arrow.down", label: "Down arrow", repeats: true) { [weak owner] in owner?.press("down") }
    key(symbol: "arrow.right", label: "Right arrow", repeats: true) { [weak owner] in owner?.press("right") }
    key("⌘C", label: "Copy on the Mac") { [weak owner] in owner?.shortcut("c", ["cmd"]) }
    key("⌘V", label: "Paste on the Mac") { [weak owner] in owner?.shortcut("v", ["cmd"]) }
    key("⌘Z", label: "Undo on the Mac") { [weak owner] in owner?.shortcut("z", ["cmd"]) }
    key("⌘A", label: "Select all on the Mac") { [weak owner] in owner?.shortcut("a", ["cmd"]) }
    key("⌘S", label: "Save on the Mac") { [weak owner] in owner?.shortcut("s", ["cmd"]) }
    key(symbol: "mic.fill", label: "Speak instead of typing", fixed: true, id: "keybar.mic") { [weak owner] in
      owner?.flush()
      owner?.onSpeak?()
    }
    key(symbol: "keyboard.chevron.compact.down", label: "Hide keyboard", fixed: true, id: "keybar.hide") { [weak owner] in
      _ = owner?.resignFirstResponder()
    }
  }

  required init?(coder: NSCoder) { nil }

  func show(_ active: Set<String>) {
    for (name, button) in modifierButtons { Self.setLatched(button, active.contains(name)) }
  }
}
