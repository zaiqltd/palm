import SwiftUI
import UIKit

/// More › Shared: links, notes and files the Mac passed to this phone, newest
/// first, kept until removed. Tap a link to open it, a note to read and copy
/// it, a file to bring it to this iPhone.
struct PalmSharedView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var transfers: PalmTransfers
  @ObservedObject private var store = PalmSharedStore.shared
  @Environment(\.openURL) private var openURL
  @State private var reading: PalmSharedItem?
  @State private var writing = false
  @State private var savedSheet: URL?
  @State private var sensitive: PalmSharedItem?
  @State private var busy: String?
  @State private var notice: String?
  @State private var error: String?

  private var macName: String { connection.hostStatus?.name ?? "Mac" }

  var body: some View {
    List {
      ForEach(store.items) { item in
        Button { Task { await open(item) } } label: { row(item) }
          .buttonStyle(.plain)
          .listRowBackground(PalmStyle.panel)
          .accessibilityIdentifier("shared.\(item.kind).\(store.items.firstIndex(of: item) ?? 0)")
          .contextMenu { menu(item) }
          .swipeActions(edge: .trailing) {
            Button(role: .destructive) { Task { await store.remove(connection, item) } } label: { Label("Remove", systemImage: "trash") }
          }
          .swipeActions(edge: .leading) {
            if item.kind != "file" {
              Button { Task { await copy(item) } } label: { Label("Copy", systemImage: "doc.on.doc") }.tint(Color(white: 0.42))
            }
          }
      }
    }
    .scrollContentBackground(.hidden)
    .overlay {
      if store.items.isEmpty && store.loaded {
        ContentUnavailableView {
          Label("Nothing shared yet", systemImage: "tray")
        } description: {
          Text("Links, notes and files sent from \(macName) wait here until you remove them. On the Mac, run palm-share with a link, some text or a file, or ask an agent to share it to your phone.")
        } actions: {
          Button("Add the Mac's clipboard") { Task { await addMacClipboard() } }
            .palmGlassButton(prominent: true)
            .accessibilityIdentifier("shared.empty.clipboard")
        }
      }
    }
    .navigationTitle("Shared")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button { writing = true } label: { Label("Write a note or link", systemImage: "square.and.pencil") }
            .accessibilityIdentifier("shared.add.note")
          Button { Task { await addMacClipboard() } } label: { Label("Add the Mac's clipboard", systemImage: "doc.on.clipboard") }
            .accessibilityIdentifier("shared.add.clipboard")
        } label: { Image(systemName: "plus").frame(width: 44, height: 44) }
          .accessibilityLabel("Add")
          .accessibilityIdentifier("shared.add")
      }
    }
    .palmScreen()
    .refreshable { await store.refresh(connection) }
    .onAppear { store.isOpen = true }
    .onDisappear { store.isOpen = false }
    .task { await store.refresh(connection) }
    .sheet(item: $reading) { item in PalmSharedNoteView(connection: connection, item: item) }
    .sheet(isPresented: $writing) {
      PalmSharedComposer(connection: connection) { text in
        try await store.add(connection, ["text": text])
      }
    }
    .sheet(item: Binding(get: { savedSheet.map(PalmShareItem.init) }, set: { if $0 == nil { savedSheet = nil } })) { item in
      PalmSavedFileSheet(url: item.url)
    }
    .confirmationDialog("\(sensitive?.name ?? "This file") holds credentials.",
      isPresented: Binding(get: { sensitive != nil }, set: { if !$0 { sensitive = nil } }), titleVisibility: .visible) {
      Button("Download to this iPhone") { if let item = sensitive { Task { await download(item, confirm: true) } } }
    } message: {
      Text("It will be copied to this iPhone.")
    }
    .palmToast($notice)
    .palmToast($error, warning: true)
    .onChange(of: store.error) { _, message in
      if let message {
        error = message
        store.error = nil
      }
    }
  }

  private func row(_ item: PalmSharedItem) -> some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: Self.icon(item)).font(.title3).foregroundStyle(PalmStyle.muted).frame(width: 28).padding(.top, 2)
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 4) {
          Text(Self.headline(item)).foregroundStyle(item.kind == "file" && item.exists == false ? PalmStyle.muted : .white)
            .multilineTextAlignment(.leading)
          if item.sensitive == true { Image(systemName: "key.fill").font(.caption2).foregroundStyle(.orange) }
        }
        if let detail = Self.detail(item) {
          Text(detail).font(.caption).foregroundStyle(PalmStyle.muted).multilineTextAlignment(.leading)
        }
        HStack(spacing: 6) {
          Text(origin(item))
          if busy == item.id { ProgressView().controlSize(.mini) }
        }
        .font(.caption).foregroundStyle(PalmStyle.muted)
      }
      Spacer(minLength: 0)
    }
    .frame(minHeight: 44)
    .contentShape(Rectangle())
  }

  private func origin(_ item: PalmSharedItem) -> String {
    let from = item.isFromMac ? "From \(macName)" : "From \(item.device ?? "this phone")"
    return [from, PalmTime.relative(item.created)].filter { !$0.isEmpty }.joined(separator: " · ")
  }

  @ViewBuilder private func menu(_ item: PalmSharedItem) -> some View {
    switch item.kind {
    case "link":
      Button { if let url = URL(string: item.url ?? "") { openURL(url) } } label: { Label("Open", systemImage: "safari") }
      Button { Task { await copy(item) } } label: { Label("Copy link", systemImage: "doc.on.doc") }
      if let url = URL(string: item.url ?? "") { ShareLink(item: url) { Label("Share", systemImage: "square.and.arrow.up") } }
    case "text":
      Button { Task { await copy(item) } } label: { Label("Copy", systemImage: "doc.on.doc") }
      Button { reading = item } label: { Label("Read", systemImage: "text.alignleft") }
    default:
      Button { Task { await open(item) } } label: { Label("Save to iPhone", systemImage: "arrow.down.circle") }
      Button { UIPasteboard.general.string = item.path } label: { Label("Copy path", systemImage: "link") }
    }
    Button(role: .destructive) { Task { await store.remove(connection, item) } } label: { Label("Remove", systemImage: "trash") }
  }

  private func open(_ item: PalmSharedItem) async {
    switch item.kind {
    case "link":
      if let url = URL(string: item.url ?? "") { openURL(url) }
    case "text":
      reading = item
    default:
      if item.exists == false {
        error = "\(item.name ?? "The file") is no longer at \(PalmPath.display(item.path ?? "")) on \(macName)."
        return
      }
      if item.sensitive == true { sensitive = item; return }
      await download(item, confirm: false)
    }
  }

  private func download(_ item: PalmSharedItem, confirm: Bool) async {
    guard let path = item.path else { return }
    busy = item.id
    defer { busy = nil }
    guard let local = await transfers.download(path, confirmSensitive: confirm) else {
      error = transfers.items.first.flatMap { if case .failed(let message) = $0.state { return message } else { return nil } }
      return
    }
    savedSheet = local
  }

  private func copy(_ item: PalmSharedItem) async {
    if item.kind == "link" {
      UIPasteboard.general.string = item.url
      notice = "Link copied."
      return
    }
    do {
      let whole = try await store.full(connection, item)
      UIPasteboard.general.string = whole.text
      notice = "Copied (\(whole.text?.count ?? 0) characters)."
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func addMacClipboard() async {
    do {
      try await store.add(connection, ["macClipboard": true])
      notice = "Added the Mac's clipboard."
    } catch { self.error = connection.friendlyMessage(error) }
  }

  static func icon(_ item: PalmSharedItem) -> String {
    switch item.kind {
    case "link": return "link"
    case "text": return "text.alignleft"
    default:
      switch ((item.name ?? "") as NSString).pathExtension.lowercased() {
      case "pdf": return "doc.richtext"
      case "png", "jpg", "jpeg", "heic", "gif", "webp": return "photo"
      case "mp4", "mov", "m4v": return "film"
      case "zip", "gz", "tar": return "doc.zipper"
      default: return "doc"
      }
    }
  }

  /// The first line people read: a link's title or address, a note's opening
  /// lines (cut at a word, never with a truncation mark), a file's name.
  static func headline(_ item: PalmSharedItem) -> String {
    switch item.kind {
    case "link":
      if let title = item.title, !title.isEmpty { return title }
      return address(item.url ?? "")
    case "text":
      if let title = item.title, !title.isEmpty { return title }
      return opening(item.text ?? "")
    default:
      return item.title?.isEmpty == false ? item.title! : (item.name ?? "File")
    }
  }

  static func detail(_ item: PalmSharedItem) -> String? {
    switch item.kind {
    case "link":
      return item.title?.isEmpty == false ? address(item.url ?? "") : nil
    case "text":
      let total = item.length ?? item.text?.count ?? 0
      let shown = item.title?.isEmpty == false ? opening(item.text ?? "") : nil
      let cut = (item.title?.isEmpty == false ? shown : opening(item.text ?? "")).map { $0.count < total } ?? false
      return [shown, cut ? "Tap to read all \(total.formatted()) characters" : nil].compactMap { $0 }.joined(separator: "\n").nilIfEmpty
    default:
      if item.exists == false { return "No longer at \(PalmPath.display(item.path ?? ""))" }
      let size = item.size.map { $0.palmBytes }
      return [size, item.title?.isEmpty == false ? item.name : nil].compactMap { $0 }.joined(separator: " · ").nilIfEmpty
    }
  }

  /// A web address without its scheme, at most 90 characters.
  static func address(_ url: String) -> String {
    let bare = url.replacingOccurrences(of: #"^https?://(www\.)?"#, with: "", options: .regularExpression)
    return bare.count > 90 ? String(bare.prefix(90)) : bare
  }

  /// A note's first three lines, at most 180 characters, cut at a word.
  static func opening(_ text: String) -> String {
    let lines = text.split(separator: "\n", omittingEmptySubsequences: true).prefix(3).joined(separator: "\n")
    guard lines.count > 180 else { return lines }
    let head = lines.prefix(180)
    if let space = head.lastIndex(where: { $0 == " " || $0 == "\n" }), head.distance(from: head.startIndex, to: space) > 100 {
      return String(head[..<space])
    }
    return String(head)
  }
}

private extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}

/// A note in full: selectable, with Copy and Share.
struct PalmSharedNoteView: View {
  @ObservedObject var connection: PalmConnection
  let item: PalmSharedItem
  @ObservedObject private var store = PalmSharedStore.shared
  @Environment(\.dismiss) private var dismiss
  @State private var text: String?
  @State private var copied = false
  @State private var error: String?

  var body: some View {
    NavigationStack {
      ScrollView {
        Text(text ?? item.text ?? "").textSelection(.enabled).padding()
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("shared.note.text")
        if let error { Text(error).font(.footnote).foregroundStyle(.orange).padding(.horizontal) }
      }
      .navigationTitle(item.title ?? "Note")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          Button(copied ? "Copied" : "Copy") {
            UIPasteboard.general.string = text ?? item.text
            copied = true
          }
          .disabled(text == nil && item.partial == true)
          .accessibilityIdentifier("shared.note.copy")
        }
        ToolbarItem(placement: .bottomBar) {
          ShareLink(item: text ?? item.text ?? "") { Label("Share", systemImage: "square.and.arrow.up") }
        }
      }
      .background(PalmStyle.background.ignoresSafeArea())
      .task {
        do { text = try await store.full(connection, item).text } catch { self.error = connection.friendlyMessage(error) }
      }
    }
    .preferredColorScheme(.dark)
  }
}

/// A note or link written on the phone, kept in Shared on the Mac.
struct PalmSharedComposer: View {
  @ObservedObject var connection: PalmConnection
  let save: (String) async throws -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var text = ""
  @State private var saving = false
  @State private var error: String?
  @FocusState private var focused: Bool

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 8) {
        TextEditor(text: $text)
          .focused($focused)
          .scrollContentBackground(.hidden)
          .padding(8)
          .background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 12))
          .accessibilityIdentifier("shared.compose.text")
        Text(error ?? "A single web address is kept as a link.").font(.footnote)
          .foregroundStyle(error == nil ? PalmStyle.muted : .orange)
      }
      .padding()
      .navigationTitle("New note")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        ToolbarItem(placement: .confirmationAction) {
          if saving { ProgressView() } else {
            Button("Add") {
              let value = text
              Task {
                saving = true
                defer { saving = false }
                do {
                  try await save(value)
                  dismiss()
                } catch { self.error = connection.friendlyMessage(error) }
              }
            }
            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("shared.compose.add")
          }
        }
      }
      .background(PalmStyle.background.ignoresSafeArea())
      .onAppear { focused = true }
    }
    .preferredColorScheme(.dark)
  }
}
