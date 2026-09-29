import SwiftUI
import UIKit

struct PalmPairingView: View {
  @ObservedObject var connection: PalmConnection
  var incomingURL: URL?
  /// Pairing another computer while one is already paired.
  var adding = false
  var onPaired: (() -> Void)? = nil
  @State private var host = ""
  @State private var code = ""
  @State private var deviceName = "My iPhone"
  @State private var showingScanner = false
  @State private var pairing = false
  @State private var error: String?
  @FocusState private var field: Field?
  enum Field { case host, code }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 24) {
          VStack(alignment: .leading, spacing: 10) {
            PalmMark(size: 48)
            Text(adding ? "Add a computer" : "Pair with your Mac").font(.title.weight(.bold))
            Text("On your Mac, open Palm and choose Pair an iPhone. Scan the code it shows, or enter the address and code.")
              .font(.body).foregroundStyle(PalmStyle.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
          .padding(.top, 12)
          PalmCard {
            VStack(alignment: .leading, spacing: 20) {
              Button {
                showingScanner = true
              } label: {
                Label("Scan the Mac’s QR code", systemImage: "qrcode.viewfinder")
              }.buttonStyle(PalmPrimaryButton())
              HStack(spacing: 12) {
                Rectangle().fill(PalmStyle.line).frame(height: 1)
                Text("or enter the details").font(.footnote).foregroundStyle(PalmStyle.muted)
                  .fixedSize()
                Rectangle().fill(PalmStyle.line).frame(height: 1)
              }
              VStack(alignment: .leading, spacing: 8) {
                Text("Mac address").font(.subheadline.weight(.medium))
                TextField("https://your-mac.ts.net:8443", text: $host)
                  .textContentType(.URL).keyboardType(.URL)
                  .textInputAutocapitalization(.never).autocorrectionDisabled()
                  .font(.subheadline.monospaced()).focused($field, equals: .host)
                  .submitLabel(.next).onSubmit { field = .code }
                  .padding(14).background(
                    PalmStyle.background, in: RoundedRectangle(cornerRadius: 12)
                  )
                  .accessibilityIdentifier("pair.host")
              }
              VStack(alignment: .leading, spacing: 8) {
                Text("Pairing code").font(.subheadline.weight(.medium))
                TextField("10-character code", text: $code)
                  .textContentType(.oneTimeCode).keyboardType(.asciiCapable)
                  .textInputAutocapitalization(.characters).autocorrectionDisabled()
                  .font(.title3.monospaced()).focused($field, equals: .code)
                  .submitLabel(.go).onSubmit { pair() }
                  .padding(14).background(
                    PalmStyle.background, in: RoundedRectangle(cornerRadius: 12)
                  )
                  .accessibilityIdentifier("pair.code")
                Text("Codes work once and expire after two minutes.")
                  .font(.caption).foregroundStyle(PalmStyle.muted)
              }
              DisclosureGroup("Name this iPhone") {
                TextField("My iPhone", text: $deviceName)
                  .textContentType(.nickname).font(.body)
                  .padding(14).background(
                    PalmStyle.background, in: RoundedRectangle(cornerRadius: 12)
                  )
                  .padding(.top, 8)
                  .accessibilityLabel("Name shown on your Mac")
              }.font(.subheadline).foregroundStyle(PalmStyle.muted)
              if let error {
                PalmNotice(symbol: "exclamationmark.circle", text: error, warning: true)
                  .accessibilityIdentifier("pair.error")
              }
              Button(action: pair) {
                HStack(spacing: 10) {
                  if pairing { ProgressView().tint(PalmStyle.accent) }
                  Text(pairing ? "Connecting to your Mac" : "Connect to my Mac")
                  if !pairing { Image(systemName: "arrow.right") }
                }
              }
              .buttonStyle(PalmSecondaryButton())
              .disabled(
                pairing || cleanedCode.count != 10
                  || host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
              )
              .accessibilityIdentifier("pair.connect")
            }
          }
          PalmNotice(
            symbol: "lock.shield",
            text:
              "Keep Tailscale connected on both devices. Check the Mac address before connecting; a scanned code never connects by itself."
          )
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .padding(.bottom, 20)
      }
      .scrollDismissesKeyboard(.interactively)
      .navigationBarHidden(true)
      .palmScreen()
      .sheet(isPresented: $showingScanner) {
        PalmQRScannerView { result in
          showingScanner = false
          applyPairingLink(result)
        }
      }
      .onAppear {
        // Pairing again fills in this Mac's address; adding a computer starts empty.
        if host.isEmpty && !adding { host = connection.hostURL }
        if let incomingURL { applyPairingLink(incomingURL.absoluteString) }
      }
      .onChange(of: incomingURL) { _, url in
        if let url { applyPairingLink(url.absoluteString) }
      }
    }.palmPrivacyShield()
  }

  private var cleanedCode: String {
    code.filter { !$0.isWhitespace && $0 != "-" }.uppercased()
  }

  private func pair() {
    guard !pairing, cleanedCode.count == 10 else { return }
    field = nil
    error = nil
    pairing = true
    Task {
      do {
        try await connection.pair(
          host: host.trimmingCharacters(in: .whitespacesAndNewlines),
          code: cleanedCode, name: deviceName.isEmpty ? "My iPhone" : deviceName)
        onPaired?()
      } catch { self.error = error.localizedDescription }
      pairing = false
    }
  }

  private func applyPairingLink(_ value: String) {
    do {
      let link = try PalmPairingLink.parse(value)
      host = link.host
      code = link.code
      error = nil
    } catch { self.error = error.localizedDescription }
  }
}

/// Parsing only. The connection model validates the destination before any network request.
struct PalmPairingLink {
  let host: String
  let code: String

  static func parse(_ raw: String) throws -> PalmPairingLink {
    guard var components = URLComponents(string: raw), components.scheme == "https",
      components.user == nil, components.password == nil, components.host != nil,
      components.query == nil, components.path.isEmpty || components.path == "/",
      let fragment = components.fragment, fragment.hasPrefix("pair=")
    else { throw LinkError.invalid }
    let code = String(fragment.dropFirst(5)).uppercased()
    guard code.count == 10, code.allSatisfy({ $0.isASCII && $0.isHexDigit }) else {
      throw LinkError.invalid
    }
    components.path = ""
    components.fragment = nil
    guard let host = components.string else { throw LinkError.invalid }
    return PalmPairingLink(host: host, code: code)
  }

  enum LinkError: LocalizedError {
    case invalid
    var errorDescription: String? {
      "That is not a Palm pairing QR code. Open Palm on your Mac and choose New pairing code."
    }
  }
}
