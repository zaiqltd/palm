import Foundation
import SwiftUI

/// Timings measured on this iPhone, for the physical-phone checks (the brief:
/// measure screen startup and input-to-visible response on the real phone,
/// with conditions, not best cases). Each sample notes whether the phone was
/// on Wi-Fi or cellular. Kept on the phone only (the last 500), never sent.
@MainActor
final class PalmTimings: ObservableObject {
  static let shared = PalmTimings()

  enum Kind: String, CaseIterable, Codable {
    case screenStart, inputToPicture, inputAck, assistantReply, filesFolder

    var title: String {
      switch self {
      case .screenStart: return "Screen: tap to first picture"
      case .inputToPicture: return "Input to the next picture"
      case .inputAck: return "Input reaches the Mac (round trip)"
      case .assistantReply: return "Assistant reply"
      case .filesFolder: return "Files: folder opens"
      }
    }

    var explanation: String {
      switch self {
      case .screenStart: return "From starting the live screen to the first picture shown."
      case .inputToPicture: return "From a tap or typed key to the next picture from the Mac (a change it caused, if the screen was still)."
      case .inputAck: return "From sending a tap or key to the Mac confirming it."
      case .assistantReply: return "From sending a request to its answer on the phone."
      case .filesFolder: return "From opening a folder to its list on the phone."
      }
    }
  }

  struct Sample: Codable, Hashable {
    let kind: Kind
    let ms: Double
    let at: Date
    let network: String
  }

  struct Summary {
    let count: Int
    let median: Double
    let p90: Double
    let last: Double
  }

  @Published private(set) var samples: [Sample] = []
  /// Wi-Fi, cellular or other: set from the phone's own network monitor.
  var network = "unknown"
  private let key = "palm.timings.samples"

  init() {
    if let data = UserDefaults.standard.data(forKey: key), let saved = try? JSONDecoder().decode([Sample].self, from: data) {
      samples = saved
    }
  }

  func record(_ kind: Kind, ms: Double) {
    guard ms.isFinite, ms >= 0, ms < 120_000 else { return }
    samples.append(Sample(kind: kind, ms: ms.rounded(), at: Date(), network: network))
    if samples.count > 500 { samples.removeFirst(samples.count - 500) }
    if let data = try? JSONEncoder().encode(samples) { UserDefaults.standard.set(data, forKey: key) }
  }

  func summary(_ kind: Kind, network: String? = nil) -> Summary? {
    let values = samples.filter { $0.kind == kind && (network == nil || $0.network == network) }.map(\.ms)
    guard let last = values.last else { return nil }
    let sorted = values.sorted()
    func at(_ fraction: Double) -> Double { sorted[min(sorted.count - 1, Int((Double(sorted.count - 1) * fraction).rounded()))] }
    return Summary(count: values.count, median: at(0.5), p90: at(0.9), last: last)
  }

  var networks: [String] { Array(Set(samples.map(\.network))).sorted() }

  func clear() {
    samples = []
    UserDefaults.standard.removeObject(forKey: key)
  }

  /// Plain text to paste into a message.
  func report(device: String, path: String?) -> String {
    var lines = ["Palm timings on this iPhone, \(Date().formatted(date: .abbreviated, time: .shortened))", "Mac: \(device)\(path.map { ", \($0)" } ?? "")"]
    for kind in Kind.allCases {
      for network in networks {
        guard let s = summary(kind, network: network) else { continue }
        lines.append("\(kind.title) [\(network)]: median \(Int(s.median)) ms, 90% \(Int(s.p90)) ms, \(s.count) samples")
      }
    }
    return lines.joined(separator: "\n")
  }
}

/// More › Timings: what was measured on this phone, by kind and network.
struct PalmTimingsView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject private var timings = PalmTimings.shared
  @State private var path: String?
  @State private var copied = false

  var body: some View {
    List {
      Section {
        LabeledContent("Mac", value: connection.hostStatus?.name ?? "Not connected")
        LabeledContent("Connection", value: path ?? "Unknown")
        LabeledContent("This phone", value: timings.network)
      } footer: {
        Text("Use Palm normally (the live screen, typing, the Assistant, Files); each action is timed here, on this phone. Direct is fastest; Relayed goes through Tailscale's relay.")
      }
      .listRowBackground(PalmStyle.panel)
      ForEach(PalmTimings.Kind.allCases, id: \.self) { kind in
        Section {
          let networks = timings.networks.filter { timings.summary(kind, network: $0) != nil }
          if networks.isEmpty {
            Text("Not measured yet").foregroundStyle(PalmStyle.muted)
          }
          ForEach(networks, id: \.self) { network in
            if let s = timings.summary(kind, network: network) {
              HStack {
                Text(network)
                Spacer()
                Text("median \(Int(s.median)) ms · 90% \(Int(s.p90)) ms · \(s.count)")
                  .font(.subheadline.monospacedDigit()).foregroundStyle(PalmStyle.muted)
              }
              .accessibilityElement(children: .combine)
              .accessibilityIdentifier("timings.\(kind.rawValue)")
            }
          }
        } header: {
          Text(kind.title)
        } footer: {
          Text(kind.explanation)
        }
        .listRowBackground(PalmStyle.panel)
      }
      Section {
        Button(copied ? "Copied" : "Copy as text") {
          UIPasteboard.general.string = timings.report(device: connection.hostStatus?.name ?? "Mac", path: path)
          copied = true
        }
        .accessibilityIdentifier("timings.copy")
        Button("Clear", role: .destructive) { timings.clear() }
      }
      .listRowBackground(PalmStyle.panel)
    }
    .scrollContentBackground(.hidden)
    .background(PalmStyle.background.ignoresSafeArea())
    .navigationTitle("Timings")
    .navigationBarTitleDisplayMode(.inline)
    .task {
      if let status: PalmSystemStatus = try? await connection.get("/api/system"), let p = status.network?.path {
        path = p.direct ? "Direct" : "Relayed through \(p.via)"
      }
    }
  }
}
