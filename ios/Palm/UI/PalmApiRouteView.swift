import SwiftUI

// The optional OpenRouter route (the brief, priority 4), in Preferences: on or
// off, the model, the daily and per-session limits, and what the key has spent.
// The work itself is OpenCode's, on the Mac, with the user's key.

struct PalmApiRouteSection: View {
  @ObservedObject var connection: PalmConnection
  @State private var route: PalmApiRoute?
  @State private var error: String?

  var body: some View {
    Section {
      Toggle("Agents through OpenRouter", isOn: Binding(
        get: { route?.enabled ?? false },
        set: { on in Task { await update(["enabled": on]) } }))
        .disabled(route == nil)
        .accessibilityIdentifier("prefs.route.enabled")
      if let route, route.enabled {
        NavigationLink {
          PalmRouteModelsView(connection: connection, selected: route.model) { id in
            Task { await update(["model": id]) }
          }
        } label: {
          LabeledContent("Model", value: route.model)
        }
        .accessibilityIdentifier("prefs.route.model")
        Picker("Daily limit", selection: Binding(
          get: { route.dailyLimitUsd },
          set: { value in Task { await update(["dailyLimitUsd": value]) } })
        ) {
          ForEach(Self.choices([1, 2, 5, 10, 20, 50, 100], route.dailyLimitUsd), id: \.self) { Text(Self.dollars($0)).tag($0) }
        }
        .accessibilityIdentifier("prefs.route.daily")
        Picker("Each session", selection: Binding(
          get: { route.taskLimitUsd },
          set: { value in Task { await update(["taskLimitUsd": value]) } })
        ) {
          ForEach(Self.choices([0.5, 1, 2, 5, 10, 20], route.taskLimitUsd), id: \.self) { Text(Self.dollars($0)).tag($0) }
        }
        .accessibilityIdentifier("prefs.route.session")
        if let usage = route.usage {
          Text(PalmPreferencesView.spending(usage)).font(.footnote).foregroundStyle(PalmStyle.muted)
            .accessibilityIdentifier("prefs.route.usage")
        }
        if !route.keySet {
          Text("Add your OpenRouter key under Voice first.").font(.footnote).foregroundStyle(.orange)
        }
        if !route.installed {
          Text("OpenCode is not installed on \(connection.hostStatus?.name ?? "the Mac"). Install it there (npm i -g opencode-ai) to use this route.")
            .font(.footnote).foregroundStyle(.orange)
        }
      }
      if let error { Text(error).font(.footnote).foregroundStyle(.orange) }
    } header: {
      Text("Paid agent route")
    } footer: {
      Text("When on, “OpenCode · OpenRouter” is one of the agents you can start, marked paid per use. It runs only when you choose it; Claude Code and Codex never switch to it. OpenCode works on the Mac with your OpenRouter key, which stays on the Mac and goes only to that agent. Nothing starts once today's limit is reached, and a session is stopped when it passes its own limit. The amounts are the key's usage at OpenRouter, so they include anything else using the key, and they are checked every 15 seconds, so a session can go slightly over.")
    }
    .listRowBackground(PalmStyle.panel)
    .task { await load() }
  }

  /// The usual amounts, plus the current one if it was set to something else.
  static func choices(_ usual: [Double], _ current: Double) -> [Double] {
    usual.contains(current) ? usual : (usual + [current]).sorted()
  }

  static func dollars(_ value: Double) -> String {
    value == value.rounded() ? String(format: "$%.0f", value) : String(format: "$%.2f", value)
  }

  private func load() async {
    do {
      route = try await connection.get("/api/agents/api-route")
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func update(_ patch: [String: Any]) async {
    struct Saved: Decodable { let enabled: Bool }
    do {
      let _: Saved = try await connection.post("/api/agents/api-route", patch)
      await load()
    } catch { self.error = connection.friendlyMessage(error) }
  }
}

/// Models that can use tools (an agent needs them), from OpenRouter's list, with prices.
struct PalmRouteModelsView: View {
  @ObservedObject var connection: PalmConnection
  let selected: String
  let choose: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var models: [PalmRouteModel] = []
  @State private var query = ""
  @State private var loaded = false
  @State private var error: String?

  private var shown: [PalmRouteModel] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    return q.isEmpty ? models : models.filter { $0.name.lowercased().contains(q) || $0.id.lowercased().contains(q) }
  }

  var body: some View {
    List {
      Section {
        if !loaded { ProgressView().frame(maxWidth: .infinity) }
        if let error { Text(error).foregroundStyle(.orange) }
        if loaded && models.isEmpty && error == nil {
          Text("OpenRouter's list of models could not be read. Try again later.").foregroundStyle(PalmStyle.muted)
        }
        ForEach(shown) { model in
          Button {
            choose(model.id)
            dismiss()
          } label: {
            HStack(spacing: 12) {
              VStack(alignment: .leading, spacing: 2) {
                Text(model.name).foregroundStyle(.white)
                Text("\(model.id) · \(Self.price(model))").font(.caption).foregroundStyle(PalmStyle.muted)
              }
              Spacer()
              if model.id == selected {
                Image(systemName: "checkmark").foregroundStyle(PalmStyle.accent).accessibilityLabel("Selected")
              }
            }
          }
          .accessibilityIdentifier("route.model")
        }
      } footer: {
        Text("Models that can use tools, which an agent needs. Prices are OpenRouter's, per million tokens.")
      }
      .listRowBackground(PalmStyle.panel)
    }
    .scrollContentBackground(.hidden)
    .searchable(text: $query, prompt: "Search models")
    .navigationTitle("Model")
    .navigationBarTitleDisplayMode(.inline)
    .palmScreen()
    .task { await load() }
  }

  static func price(_ model: PalmRouteModel) -> String {
    guard let input = model.inputPerMillion, let output = model.outputPerMillion else { return "price not listed" }
    if input == 0 && output == 0 { return "free" }
    return String(format: "$%.2f in, $%.2f out", input, output)
  }

  private func load() async {
    struct Models: Decodable { let models: [PalmRouteModel] }
    do {
      models = (try await connection.get("/api/agents/api-route/models") as Models).models
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
    loaded = true
  }
}
