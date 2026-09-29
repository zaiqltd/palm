import SwiftUI
import UIKit

struct PalmSettingsView: View {
  @ObservedObject var connection: PalmConnection
  @State private var confirmingDisconnect = false
  @State private var checking = false
  @State private var error: String?
  @State private var checkSucceeded = false

  var body: some View {
    List {
      Section {
        LabeledContent("Mac", value: connection.hostStatus?.name ?? "Your Mac")
        VStack(alignment: .leading, spacing: 4) {
          Text("Address").font(.subheadline).foregroundStyle(PalmStyle.muted)
          Text(connection.hostURL).font(.subheadline.monospaced()).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        if let expiry = connection.pairedUntil {
          LabeledContent("Pairing valid until", value: expiry.formatted(date: .abbreviated, time: .shortened))
        }
        Button {
          checking = true
          checkSucceeded = false
          error = nil
          Task {
            defer { checking = false }
            do {
              try await connection.refresh()
              checkSucceeded = true
            } catch { self.error = connection.friendlyMessage(error) }
          }
        } label: {
          HStack {
            Label(checking ? "Checking your Mac" : checkSucceeded ? "Mac is reachable" : "Check connection",
              systemImage: checkSucceeded ? "checkmark.circle" : "arrow.clockwise")
            Spacer()
            if checking { ProgressView() }
          }
        }
        .disabled(checking)
        if let error { Text(error).font(.footnote).foregroundStyle(.orange) }
      } header: {
        Text("Paired Mac")
      }

      Section {
        permissionRow("Screen recording", symbol: "record.circle", granted: connection.hostStatus?.screenPermission)
        permissionRow("Accessibility (touch and typing)", symbol: "hand.tap", granted: connection.hostStatus?.controlPermission)
      } header: {
        Text("Mac permissions")
      } footer: {
        Text("Change these in System Settings › Privacy & Security on the Mac. Palm never changes them itself.")
      }

      Section {
        LabeledContent("Network", value: "Your private Tailscale network")
        LabeledContent("Transport", value: "HTTPS and secure WebSocket")
        LabeledContent("Video", value: "H.264")
        if let latency = connection.latencyMilliseconds, connection.isStreaming {
          LabeledContent("Round trip now", value: "\(latency) ms")
          LabeledContent("Frames received", value: "\(connection.fps) per second")
        }
      } header: {
        Text("Connection")
      } footer: {
        Text("The pairing is kept in this iPhone's Keychain. You can revoke this iPhone from Palm's setup page on the Mac.")
      }

      Section {
        Button(role: .destructive) {
          confirmingDisconnect = true
        } label: {
          Label("Remove this iPhone's pairing", systemImage: "rectangle.portrait.and.arrow.right")
        }
        .confirmationDialog("Remove this iPhone's pairing?", isPresented: $confirmingDisconnect, titleVisibility: .visible) {
          Button("Remove pairing", role: .destructive) {
            Task {
              do { try await connection.disconnect() } catch {
                connection.errorMessage = error.localizedDescription
              }
            }
          }
        } message: {
          Text("This ends the session and removes this iPhone's access. You'll need a new code from the Mac to connect again.")
        }
      }

      Section {
        LabeledContent("Palm for iPhone", value: version)
        if let server = connection.hostStatus?.version {
          LabeledContent("Palm on the Mac", value: server)
        }
      }
    }
    .scrollContentBackground(.hidden)
    .navigationTitle("Settings")
    .navigationBarTitleDisplayMode(.inline)
    .palmScreen()
  }

  private var version: String {
    let short = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
    return "\(short) (\(build))"
  }

  private func permissionRow(_ title: String, symbol: String, granted: Bool?) -> some View {
    HStack(spacing: 12) {
      Label(title, systemImage: symbol)
      Spacer()
      Text(granted == true ? "Allowed" : granted == false ? "Needs setup" : "Unknown")
        .font(.subheadline)
        .foregroundStyle(granted == false ? Color.orange : PalmStyle.muted)
    }
    .accessibilityElement(children: .combine)
  }
}
