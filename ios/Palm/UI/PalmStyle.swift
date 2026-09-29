import SwiftUI
import UIKit

enum PalmStyle {
  // Neutral graphite and white, without a coloured accent.
  static let background = Color(red: 22 / 255, green: 22 / 255, blue: 24 / 255)
  static let panel = Color(red: 34 / 255, green: 34 / 255, blue: 37 / 255)
  static let raised = Color(red: 46 / 255, green: 46 / 255, blue: 50 / 255)
  static let line = Color.white.opacity(0.1)
  // Neutral accent (no blue):
  // near-white for actions and selection, dark text on it, grey switches.
  static let accent = Color(white: 0.93)
  static let muted = Color(red: 152 / 255, green: 152 / 255, blue: 158 / 255)
  static let onAccent = Color(white: 0.07)
  static let switchTint = Color(white: 0.56)
  static let success = Color(red: 48 / 255, green: 209 / 255, blue: 88 / 255)
}

extension View {
  /// Liquid Glass on iOS 26 and later; a material on older systems.
  @ViewBuilder func palmGlass(cornerRadius: CGFloat = 18, interactive: Bool = false) -> some View {
    if #available(iOS 26.0, *) {
      self.glassEffect(interactive ? .regular.interactive() : .regular, in: RoundedRectangle(cornerRadius: cornerRadius))
    } else {
      self.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: cornerRadius))
    }
  }

  @ViewBuilder func palmGlassCapsule(interactive: Bool = false) -> some View {
    if #available(iOS 26.0, *) {
      self.glassEffect(interactive ? .regular.interactive() : .regular, in: Capsule())
    } else {
      self.background(.ultraThinMaterial, in: Capsule())
    }
  }

  /// Glass over the live Mac picture. Plain glass turns milky over a white
  /// window and hides white icons, so this one is
  /// darkened: the controls read the same over light and dark content.
  @ViewBuilder func palmVideoGlass<S: Shape>(_ shape: S, interactive: Bool = false) -> some View {
    if #available(iOS 26.0, *) {
      self.background(Color.black.opacity(0.62), in: shape)
        .glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
    } else {
      self.background(Color.black.opacity(0.62), in: shape).background(.ultraThinMaterial, in: shape)
    }
  }

  @ViewBuilder func palmGlassButton(prominent: Bool = false) -> some View {
    if #available(iOS 26.0, *) {
      if prominent { self.buttonStyle(.glassProminent).foregroundStyle(PalmStyle.onAccent) } else { self.buttonStyle(.glass) }
    } else {
      if prominent { self.buttonStyle(.borderedProminent).foregroundStyle(PalmStyle.onAccent) } else { self.buttonStyle(.bordered) }
    }
  }
}

/// Palm's hand on its graphite tile, as the app icon (the glyph comes from
/// scripts/render-brand.swift, like every other copy of the mark).
struct PalmMark: View {
  var size: CGFloat = 40

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: size * 0.28)
        .fill(LinearGradient(colors: [Color(white: 0.27), Color(white: 0.07)], startPoint: .top, endPoint: .bottom))
      Image("PalmHand").resizable().renderingMode(.template).foregroundStyle(.white)
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

struct PalmPrimaryButton: ButtonStyle {
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.semibold))
      .foregroundStyle(PalmStyle.onAccent)
      .frame(maxWidth: .infinity, minHeight: 52)
      .padding(.horizontal, 14)
      .background(PalmStyle.accent, in: RoundedRectangle(cornerRadius: 16))
      .opacity(enabled ? (configuration.isPressed ? 0.78 : 1) : 0.38)
      .scaleEffect(configuration.isPressed ? 0.985 : 1)
  }
}

struct PalmSecondaryButton: ButtonStyle {
  @Environment(\.isEnabled) private var enabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body.weight(.medium))
      .foregroundStyle(.white)
      .frame(maxWidth: .infinity, minHeight: 48)
      .padding(.horizontal, 12)
      .background(PalmStyle.raised, in: RoundedRectangle(cornerRadius: 14))
      .opacity(enabled ? (configuration.isPressed ? 0.65 : 1) : 0.38)
  }
}

struct PalmCard<Content: View>: View {
  @ViewBuilder var content: Content

  var body: some View {
    content
      .padding(20)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 24))
      .overlay {
        RoundedRectangle(cornerRadius: 24).stroke(PalmStyle.line.opacity(0.65), lineWidth: 1)
      }
  }
}

struct PalmSectionHeading: View {
  let title: String
  var detail: String? = nil

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      Text(title).font(.title3.weight(.semibold)).foregroundStyle(.white)
      if let detail {
        Text(detail).font(.subheadline).foregroundStyle(PalmStyle.muted)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct PalmStatusPill: View {
  let title: String
  var connected = false

  var body: some View {
    HStack(spacing: 7) {
      Circle().fill(connected ? PalmStyle.accent : PalmStyle.muted).frame(width: 6, height: 6)
      Text(title).font(.caption.weight(.semibold))
    }
    .foregroundStyle(connected ? PalmStyle.accent : PalmStyle.muted)
    .padding(.horizontal, 11)
    .padding(.vertical, 7)
    .background(PalmStyle.raised, in: Capsule())
    .accessibilityElement(children: .combine)
  }
}

struct PalmNotice: View {
  var symbol = "info.circle"
  let text: String
  var warning = false

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: symbol).padding(.top, 2).accessibilityHidden(true)
      Text(text).fixedSize(horizontal: false, vertical: true)
    }
    .font(.subheadline)
    .foregroundStyle(warning ? Color.orange : PalmStyle.muted)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(15)
    .background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 16))
    .accessibilityElement(children: .combine)
  }
}

struct PalmAppIcon: View {
  let name: String
  /// A PNG data URL from the Mac.
  let dataURL: String
  var size: CGFloat = 48

  init(app: PalmRemoteApp, size: CGFloat = 48) { self.init(name: app.name, icon: app.icon, size: size) }
  init(name: String, icon: String, size: CGFloat = 48) {
    self.name = name
    self.dataURL = icon
    self.size = size
  }

  private static let decoded = NSCache<NSString, UIImage>()

  private var icon: UIImage? {
    if let cached = Self.decoded.object(forKey: dataURL as NSString) { return cached }
    guard let separator = dataURL.firstIndex(of: ","),
      let data = Data(base64Encoded: String(dataURL[dataURL.index(after: separator)...])),
      let image = UIImage(data: data)
    else { return nil }
    Self.decoded.setObject(image, forKey: dataURL as NSString)
    return image
  }

  var body: some View {
    Group {
      if let icon {
        Image(uiImage: icon).resizable().scaledToFit()
      } else {
        Text(String(name.prefix(1)))
          .font(.system(size: size * 0.48, weight: .medium))
          .foregroundStyle(PalmStyle.accent)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(PalmStyle.raised, in: RoundedRectangle(cornerRadius: size * 0.24))
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

extension View {
  /// Top-level screens: a large title on the same row as the toolbar
  /// buttons, instead of a separate row of buttons above a large title.
  func palmRootTitle() -> some View {
    self.toolbarTitleDisplayMode(.inlineLarge)
  }

  func palmScreen() -> some View {
    // No custom bar backgrounds: iOS 26 draws Liquid Glass navigation bars.
    self.background(PalmStyle.background.ignoresSafeArea())
  }

  func palmPrivacyShield() -> some View { modifier(PalmPrivacyShield()) }
}

private struct PalmPrivacyShield: ViewModifier {
  @Environment(\.scenePhase) private var scenePhase

  func body(content: Content) -> some View {
    content.overlay {
      if scenePhase != .active {
        ZStack {
          PalmStyle.background.ignoresSafeArea()
          VStack(spacing: 15) {
            PalmMark(size: 58)
            Text("Palm").font(.title2.weight(.semibold))
          }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("Palm privacy screen")
      }
    }
  }
}

/// A short result or error that floats above the tab bar and fades after a
/// few seconds, so it is seen wherever the list is scrolled.
struct PalmToast: ViewModifier {
  @Binding var message: String?
  var warning = false
  @State private var hideTask: Task<Void, Never>?

  func body(content: Content) -> some View {
    // At the top, under the title bar: after an action lower in a list, the
    // next thing to tap is rarely there. Only the close button takes taps;
    // everything else passes through to the row underneath.
    content.overlay(alignment: .top) {
      if let message {
        HStack(alignment: .center, spacing: 10) {
          Image(systemName: warning ? "exclamationmark.circle" : "checkmark.circle")
            .foregroundStyle(warning ? Color.orange : PalmStyle.accent)
            .accessibilityHidden(true)
            .allowsHitTesting(false)
          Text(message).font(.subheadline).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .allowsHitTesting(false)
          Button {
            self.message = nil
          } label: {
            Image(systemName: "xmark").font(.footnote.weight(.semibold)).frame(width: 32, height: 32)
          }
          .accessibilityLabel("Dismiss")
        }
        .foregroundStyle(.white)
        .padding(.leading, 14).padding(.trailing, 6).padding(.vertical, 6)
        .palmGlass(cornerRadius: 18)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .transition(.move(edge: .top).combined(with: .opacity))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(warning ? "toast.warning" : "toast.notice")
        .onAppear { schedule() }
        .onChange(of: message) { _, _ in schedule() }
      }
    }
    .animation(.easeOut(duration: 0.2), value: message)
  }

  private func schedule() {
    hideTask?.cancel()
    let shown = message
    hideTask = Task {
      try? await Task.sleep(nanoseconds: (warning ? 8 : 4) * 1_000_000_000)
      if !Task.isCancelled, message == shown { message = nil }
    }
  }
}

extension View {
  func palmToast(_ message: Binding<String?>, warning: Bool = false) -> some View {
    modifier(PalmToast(message: message, warning: warning))
  }
}
