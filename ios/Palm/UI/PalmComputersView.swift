import SwiftUI

// Several computers (the brief, priority 3): each paired on its own, with its
// own pairing in the Keychain and its own sessions, files and screen. One is
// selected at a time; switching never moves work between them.

/// More › Computers: switch, add, rename and forget.
struct PalmComputersView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var navigator: PalmNavigator
  @State private var renaming: PalmDevice?
  @State private var newName = ""
  @State private var forgetting: PalmDevice?
  @State private var summaries: [String: String] = [:]

  var body: some View {
    List {
      Section {
        ForEach(connection.devices) { device in
          Button {
            Task { await connection.switchTo(device.id) }
          } label: {
            HStack(spacing: 12) {
              Image(systemName: "laptopcomputer").frame(width: 28)
              VStack(alignment: .leading, spacing: 2) {
                Text(device.name).font(.body.weight(.semibold)).foregroundStyle(.white)
                Text(summaries[device.id] ?? PalmDevice.label(for: device.host))
                  .font(.caption).foregroundStyle(PalmStyle.muted)
              }
              Spacer()
              if device.id == connection.currentDeviceId {
                Image(systemName: "checkmark").foregroundStyle(PalmStyle.accent)
                  .accessibilityLabel("Selected")
              }
            }
          }
          .accessibilityIdentifier("computers.device")
          .swipeActions {
            Button(role: .destructive) { forgetting = device } label: { Label("Forget", systemImage: "trash") }
          }
          .contextMenu {
            Button {
              newName = device.name
              renaming = device
            } label: { Label("Rename", systemImage: "pencil") }
            Button(role: .destructive) { forgetting = device } label: { Label("Forget this computer", systemImage: "trash") }
          }
        }
        Button {
          navigator.addingComputer = true
        } label: { Label("Add a computer", systemImage: "plus") }
        .accessibilityIdentifier("computers.add")
      } footer: {
        Text("Each computer has its own pairing. Sessions, files and the screen belong to the computer they are on; switching never moves them. Forgetting a computer removes this iPhone's access to it; its sessions keep running there.")
      }
      .listRowBackground(PalmStyle.panel)
    }
    .scrollContentBackground(.hidden)
    .background(PalmStyle.background.ignoresSafeArea())
    .navigationTitle("Computers")
    .navigationBarTitleDisplayMode(.inline)
    .task { await summarise() }
    .onChange(of: connection.devices) { _, _ in Task { await summarise() } }
    .alert("Rename computer", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Name", text: $newName)
      Button("Save") {
        if let device = renaming { connection.rename(device.id, to: newName) }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("A name on this iPhone only.")
    }
    .confirmationDialog("Forget \(forgetting?.name ?? "this computer")?",
      isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } }), titleVisibility: .visible
    ) {
      Button("Forget", role: .destructive) {
        if let device = forgetting { Task { await connection.forget(device.id) } }
      }
    } message: {
      Text("This iPhone's access is revoked. Its sessions keep running on it; pair again with a new code to come back.")
    }
  }

  /// What each computer is doing, read with its own pairing.
  private func summarise() async {
    struct Tasks: Decodable { let tasks: [PalmTaskSummary] }
    for device in connection.devices {
      if let result: Tasks = try? await connection.peek("/api/tasks", on: device.id) {
        let working = result.tasks.filter(\.isWorking).count
        summaries[device.id] = working > 0 ? "\(working) session\(working == 1 ? "" : "s") working" : "Nothing running"
      } else {
        summaries[device.id] = "Not reachable now"
      }
    }
  }
}

extension View {
  /// Tapping a tab's title switches computer, adds one or manages them.
  func palmComputerMenu(_ connection: PalmConnection, _ navigator: PalmNavigator) -> some View {
    toolbarTitleMenu {
      ForEach(connection.devices) { device in
        Button {
          Task { await connection.switchTo(device.id) }
        } label: {
          if device.id == connection.currentDeviceId {
            Label(device.name, systemImage: "checkmark")
          } else {
            Label(device.name, systemImage: "laptopcomputer")
          }
        }
      }
      Divider()
      Button { navigator.addingComputer = true } label: { Label("Add a computer", systemImage: "plus") }
      Button { navigator.managingComputers = true } label: { Label("Computers", systemImage: "laptopcomputer") }
    }
  }
}
