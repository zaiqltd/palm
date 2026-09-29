import Photos
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// The phone–Mac file bridge: send anything from the iPhone to a chosen Mac
/// folder, save anything from the Mac to the iPhone, every transfer verified.
struct PalmMacFilesView: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var transfers: PalmTransfers
  @ObservedObject var navigator: PalmNavigator
  @State private var path: [String] = []
  @State private var places: [PalmPlace] = []
  @State private var error: String?
  @State private var sending = false
  @State private var showingTransfers = false
  @State private var saved: URL?

  private func openRequestedFolder() {
    guard let folder = navigator.filesFolder else { return }
    navigator.filesFolder = nil
    path = [folder]
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        Section {
          HStack(spacing: 10) {
            bridgeButton("Send to Mac", detail: "Photos, files, copied items", icon: "arrow.up.circle.fill") {
              sending = true
            }
            .accessibilityIdentifier("files.send")
            bridgeButton("Save to iPhone", detail: "Pick any file on the Mac", icon: "arrow.down.circle.fill") {
              path = [home]
            }
            .accessibilityIdentifier("files.save")
          }
          .listRowInsets(EdgeInsets())
          .listRowBackground(Color.clear)
        }
        if !transfers.items.isEmpty {
          Section {
            ForEach(transfers.items.prefix(5)) { item in
              PalmTransferRow(item: item) { if let url = item.localURL { saved = url } }
            }
            if transfers.items.count > 5 {
              Button("All transfers (\(transfers.items.count))") { showingTransfers = true }
            }
          } header: { Text("Recent transfers") }
          .listRowBackground(PalmStyle.panel)
        }
        Section("On your Mac") {
          ForEach(places) { place in
            NavigationLink(value: place.path) { Label(place.name, systemImage: place.symbol) }
          }
        }
        .listRowBackground(PalmStyle.panel)
      }
      .scrollContentBackground(.hidden)
      .navigationTitle("Files")
      .palmDeviceSubtitle(connection)
      .palmComputerMenu(connection, navigator)
      // The assistant's "Show in Files" opens that folder here.
      .onAppear { openRequestedFolder() }
      .onChange(of: navigator.filesFolder) { _, _ in openRequestedFolder() }
      // Another computer: its own folders, from the top.
      .onChange(of: connection.deviceEpoch) { _, _ in
        path = []
        places = []
        Task { await load() }
      }
      .palmRootTitle()
      .navigationDestination(for: String.self) { folder in
        PalmFolderView(folder: folder, connection: connection, transfers: transfers, path: $path)
      }
      .sheet(isPresented: $sending) {
        PalmSendSheet(connection: connection, transfers: transfers) { folder in
          sending = false
          if let folder { path = [folder] }
        }
      }
      .sheet(isPresented: $showingTransfers) { PalmTransfersSheet(transfers: transfers) }
      .sheet(item: Binding(get: { saved.map(PalmShareItem.init) }, set: { if $0 == nil { saved = nil } })) { item in
        PalmSavedFileSheet(url: item.url)
      }
      .palmToast($error, warning: true)
      .palmScreen()
      .task { await load() }
      .refreshable { await load() }
    }
  }

  private func bridgeButton(_ title: String, detail: String, icon: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 8) {
        Image(systemName: icon).font(.title2)
        Text(title).font(.headline)
        Text(detail).font(.caption).foregroundStyle(PalmStyle.muted).multilineTextAlignment(.leading)
      }
      .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
      .padding(14)
      .background(PalmStyle.panel, in: RoundedRectangle(cornerRadius: 18))
      .foregroundStyle(.white)
    }
    .buttonStyle(.plain)
  }

  /// Browsing starts in the Mac user's home folder.
  private var home: String { places.first { $0.symbol == "house" }?.path ?? connection.macHome ?? "~" }

  private func load() async {
    do {
      places = try await (connection.get("/api/fs/places") as PalmPlaces).places
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }
}

struct PalmTransferRow: View {
  let item: PalmTransfers.Item
  var open: () -> Void
  var body: some View {
    Button(action: open) {
      HStack(spacing: 10) {
        Image(systemName: item.direction == .toMac ? "arrow.up.circle" : "arrow.down.circle")
          .foregroundStyle(PalmStyle.muted)
        VStack(alignment: .leading, spacing: 2) {
          Text(item.name).foregroundStyle(.white)
          Text(item.direction == .toMac ? "To \(PalmPath.display((item.macPath ?? item.destination)))" : "To this iPhone")
            .font(.caption).foregroundStyle(PalmStyle.muted)
        }
        Spacer(minLength: 6)
        switch item.state {
        case .verified: Image(systemName: "checkmark.seal.fill").foregroundStyle(PalmStyle.success).accessibilityLabel("Verified")
        case .failed: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange).accessibilityLabel("Failed")
        case .transferring(let f): Text("\(Int(f * 100))%").font(.caption.monospacedDigit()).foregroundStyle(PalmStyle.muted)
        default: ProgressView().controlSize(.small)
        }
      }
    }
    .disabled(item.direction == .toMac || item.localURL == nil)
  }
}

/// Send items from the iPhone to one Mac folder.
struct PalmSendSheet: View {
  @ObservedObject var connection: PalmConnection
  @ObservedObject var transfers: PalmTransfers
  var done: (String?) -> Void
  @AppStorage("palm.send.lastFolder") private var destination = ""
  @State private var choosing = false
  @State private var photos: [PhotosPickerItem] = []
  @State private var importing = false
  @State private var sent: [UUID] = []
  @State private var busy = false
  @State private var note: String?

  private var batch: [PalmTransfers.Item] { transfers.items.filter { sent.contains($0.id) } }

  var body: some View {
    NavigationStack {
      List {
        Section("To this Mac folder") {
          Button { choosing = true } label: {
            HStack {
              Label(destination.isEmpty ? "Choose a folder" : (destination as NSString).lastPathComponent, systemImage: "folder")
              Spacer()
              Text(PalmPath.display(destination)).font(.caption).foregroundStyle(PalmStyle.muted)
                .multilineTextAlignment(.trailing)
            }
          }
        }
        Section("From this iPhone") {
          PhotosPicker(selection: $photos, maxSelectionCount: 30, matching: .any(of: [.images, .videos])) {
            Label("Photos and videos", systemImage: "photo.on.rectangle")
          }
          .disabled(destination.isEmpty || busy)
          Button { importing = true } label: { Label("Files", systemImage: "doc") }
            .disabled(destination.isEmpty || busy)
          PasteButton(supportedContentTypes: [.image, .plainText, .url]) { providers in
            Task { await sendPasted(providers) }
          }
          .disabled(destination.isEmpty || busy)
        }
        if let note { Text(note).font(.footnote).foregroundStyle(PalmStyle.muted) }
        if !batch.isEmpty {
          Section("Sent") {
            ForEach(batch) { item in PalmTransferRow(item: item) {} }
          }
        }
      }
      .navigationTitle("Send to Mac")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Close") { done(nil) } }
        ToolbarItem(placement: .confirmationAction) {
          if !batch.isEmpty, batch.allSatisfy({ $0.state == .verified }) {
            Button("Show on Mac") { done(destination) }
          }
        }
      }
      .sheet(isPresented: $choosing) {
        PalmFolderPicker(connection: connection, title: "Send to", start: destination.isEmpty ? (connection.hostStatus?.inbox ?? "~") : destination) { folder in
          destination = folder
        }
      }
      .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
        guard case .success(let urls) = result else { return }
        Task {
          busy = true
          defer { busy = false }
          for url in urls {
            let access = url.startAccessingSecurityScopedResource()
            await track { await transfers.upload(url, to: destination) }
            if access { url.stopAccessingSecurityScopedResource() }
          }
        }
      }
      .onChange(of: photos) { _, picked in
        guard !picked.isEmpty else { return }
        Task {
          busy = true
          defer { busy = false }
          for item in picked {
            if let media = try? await item.loadTransferable(type: PalmPickedMedia.self) {
              await track { await transfers.upload(PalmMedia.jpegIfNeeded(media.url), to: destination) }
            }
          }
          photos = []
        }
      }
      .task {
        if destination.isEmpty, let places: PalmPlaces = try? await connection.get("/api/fs/places") { destination = places.inbox }
      }
    }
    .preferredColorScheme(.dark)
  }

  private func track(_ upload: () async -> PalmUploadResult?) async {
    let before = Set(transfers.items.map(\.id))
    async let result = upload()
    // The transfer appears in the list as soon as it starts.
    try? await Task.sleep(nanoseconds: 50_000_000)
    if let new = transfers.items.first(where: { !before.contains($0.id) }) { sent.append(new.id) }
    _ = await result
    if let new = transfers.items.first(where: { !before.contains($0.id) }), !sent.contains(new.id) { sent.append(new.id) }
  }

  private func sendPasted(_ providers: [NSItemProvider]) async {
    guard let provider = providers.first else { return }
    busy = true
    defer { busy = false }
    let stamp = Date.now.formatted(.iso8601.year().month().day().time(includingFractionalSeconds: false)).replacingOccurrences(of: ":", with: ".")
    if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
      let data = try? await load(provider, .image), let image = UIImage(data: data), let png = image.pngData()
    {
      await track { await transfers.upload(data: png, name: "Pasted \(stamp).png", to: destination) }
    } else if let data = try? await load(provider, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) ? .url : .plainText) {
      await track { await transfers.upload(data: data, name: "Pasted \(stamp).txt", to: destination) }
    } else {
      note = "Nothing Palm can send was on the iPhone clipboard."
    }
  }

  private func load(_ provider: NSItemProvider, _ type: UTType) async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      _ = provider.loadDataRepresentation(for: type) { data, error in
        if let data { continuation.resume(returning: data) }
        else { continuation.resume(throwing: error ?? PalmFailure.message("Nothing to paste.")) }
      }
    }
  }
}

/// After a verified download: open it, or put it in Files or Photos.
struct PalmSavedFileSheet: View {
  let url: URL
  @Environment(\.dismiss) private var dismiss
  @State private var preview: URL?
  @State private var exporting = false
  @State private var sharing = false
  @State private var note: String?

  private var type: UTType? { UTType(filenameExtension: url.pathExtension) }
  private var isMedia: Bool { type?.conforms(to: .image) == true || type?.conforms(to: .movie) == true }

  var body: some View {
    NavigationStack {
      List {
        Section {
          HStack(spacing: 12) {
            Image(systemName: isMedia ? "photo" : "doc").font(.title2)
            VStack(alignment: .leading, spacing: 3) {
              Text(url.lastPathComponent).font(.headline)
              Label("On this iPhone, verified", systemImage: "checkmark.seal.fill").font(.caption).foregroundStyle(PalmStyle.success)
            }
          }
        } footer: {
          Text("Also in the Files app: On My iPhone › Palm › From Mac.")
        }
        Section {
          Button { preview = url } label: { Label("Open", systemImage: "eye") }
          Button { exporting = true } label: { Label("Save to Files", systemImage: "folder") }
          if isMedia {
            Button { Task { await saveToPhotos() } } label: { Label("Save to Photos", systemImage: "photo.badge.plus") }
          }
          Button { sharing = true } label: { Label("Share", systemImage: "square.and.arrow.up") }
        }
        if let note { Text(note).font(.footnote).foregroundStyle(PalmStyle.muted) }
      }
      .navigationTitle("Saved to iPhone")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .quickLookPreview($preview)
      .sheet(isPresented: $exporting) { PalmDocumentExporter(url: url) }
      .sheet(isPresented: $sharing) { PalmActivitySheet(items: [url]) }
    }
    .preferredColorScheme(.dark)
  }

  private func saveToPhotos() async {
    let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
    guard status == .authorized || status == .limited else {
      note = "Allow Palm to add to Photos in iOS Settings to save here."
      return
    }
    do {
      try await PHPhotoLibrary.shared().performChanges {
        let request = PHAssetCreationRequest.forAsset()
        request.addResource(with: type?.conforms(to: .movie) == true ? .video : .photo, fileURL: url, options: nil)
      }
      note = "Saved to Photos."
    } catch { note = "Photos could not save this file." }
  }
}

struct PalmDocumentExporter: UIViewControllerRepresentable {
  let url: URL
  func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
    UIDocumentPickerViewController(forExporting: [url], asCopy: true)
  }
  func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}
}

struct PalmFolderView: View {
  let folder: String
  @ObservedObject var connection: PalmConnection
  @ObservedObject var transfers: PalmTransfers
  @Binding var path: [String]
  @State private var listing: PalmFSListing?
  @State private var error: String?
  @State private var showHidden = false
  @State private var search = ""
  @State private var results: [PalmFSItem]?
  @State private var photos: [PhotosPickerItem] = []
  @State private var pickingPhotos = false
  @State private var importing = false
  @State private var renaming: PalmFSItem?
  @State private var newName = ""
  @State private var creatingFolder = false
  @State private var moving: (PalmFSItem, String)?
  @State private var preview: URL?
  @State private var textPreview: PalmTextPreview?
  @State private var sharing: URL?
  @State private var savedSheet: URL?
  @State private var confirmTrash: PalmFSItem?
  @State private var sensitive: PalmFSItem?
  @State private var dropTargeted = false
  /// Newest first by default, like a Downloads folder (
  /// "sorted smart, by recent"). Remembered across folders.
  @AppStorage("palm.files.sort") private var sortOrder = "recent"

  private var items: [PalmFSItem] { PalmFileSort.sorted(results ?? listing?.items ?? [], by: sortOrder) }
  private var isHome: Bool { (listing?.path ?? folder) == PalmPath.home || folder == "~" }
  private var title: String {
    if isHome { return "Home" }
    if let name = listing?.name { return name }
    return (folder as NSString).lastPathComponent
  }

  var body: some View {
    List {
      if let listing, listing.hiddenCount > 0, !showHidden, results == nil {
        Button("Show \(listing.hiddenCount) hidden item\(listing.hiddenCount == 1 ? "" : "s")") { showHidden = true }
          .font(.footnote).listRowBackground(Color.clear)
      }
      ForEach(items) { item in
        row(item)
          .listRowBackground(PalmStyle.panel)
          .contextMenu { menu(item) }
          .swipeActions(edge: .trailing) {
            Button(role: .destructive) { confirmTrash = item } label: { Label("Trash", systemImage: "trash") }
            Button { renaming = item; newName = item.name } label: { Label("Rename", systemImage: "pencil") }.tint(Color(white: 0.42))
          }
      }
      if items.isEmpty && listing != nil {
        Text(results == nil ? "This folder is empty." : "No matches.").foregroundStyle(PalmStyle.muted)
          .listRowBackground(Color.clear)
      }
    }
    .scrollContentBackground(.hidden)
    .background(dropTargeted ? PalmStyle.raised : PalmStyle.background)
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    .searchable(text: $search, prompt: "Search this folder (Spotlight)")
    .onSubmit(of: .search) { Task { await runSearch() } }
    .onChange(of: search) { _, value in if value.isEmpty { results = nil } }
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Picker("Sort by", selection: $sortOrder) {
            ForEach(PalmFileSort.orders, id: \.id) { order in Label(order.title, systemImage: order.symbol).tag(order.id) }
          }
        } label: { Image(systemName: "arrow.up.arrow.down").frame(width: 44, height: 44) }
          .accessibilityLabel("Sort")
          .accessibilityIdentifier("files.sort")
      }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          // A picker inside a menu closes with the menu and never opens
          // (E2E, 23 September): the menu only asks for it.
          Button { pickingPhotos = true } label: { Label("Upload photos here", systemImage: "photo.on.rectangle") }
            .accessibilityIdentifier("files.uploadPhotos")
          Button { importing = true } label: { Label("Upload files here", systemImage: "doc.badge.plus") }
          Button { creatingFolder = true; newName = "" } label: { Label("New folder", systemImage: "folder.badge.plus") }
          Toggle("Show hidden files", isOn: $showHidden)
          Button { UIPasteboard.general.string = folder } label: { Label("Copy folder path", systemImage: "doc.on.doc") }
        } label: { Image(systemName: "plus.circle").frame(width: 44, height: 44) }
          .accessibilityIdentifier("files.add")
      }
    }
    .refreshable { await load() }
    .task(id: showHidden) { await load() }
    .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 20, matching: .any(of: [.images, .videos]))
    .onChange(of: photos) { _, picked in
      guard !picked.isEmpty else { return }
      Task {
        for item in picked {
          if let media = try? await item.loadTransferable(type: PalmPickedMedia.self) {
            await transfers.upload(PalmMedia.jpegIfNeeded(media.url), to: folder)
          }
        }
        photos = []
        await load()
      }
    }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      guard case .success(let urls) = result else { return }
      Task {
        for url in urls {
          let access = url.startAccessingSecurityScopedResource()
          await transfers.upload(url, to: folder)
          if access { url.stopAccessingSecurityScopedResource() }
        }
        await load()
      }
    }
    .dropDestination(for: URL.self) { urls, _ in
      Task {
        for url in urls where url.isFileURL { await transfers.upload(url, to: folder) }
        await load()
      }
      return true
    } isTargeted: { dropTargeted = $0 }
    .alert("Rename", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
      TextField("Name", text: $newName)
      Button("Rename") { if let item = renaming { Task { await rename(item) } } }
      Button("Cancel", role: .cancel) {}
    }
    .alert("New folder", isPresented: $creatingFolder) {
      TextField("Folder name", text: $newName)
      Button("Create") { Task { await makeFolder() } }
      Button("Cancel", role: .cancel) {}
    }
    .confirmationDialog("Move \(confirmTrash?.name ?? "this") to the Trash on your Mac?",
      isPresented: Binding(get: { confirmTrash != nil }, set: { if !$0 { confirmTrash = nil } }), titleVisibility: .visible) {
      Button("Move to Trash", role: .destructive) { if let item = confirmTrash { Task { await trash(item) } } }
    } message: { Text("You can put it back from the Mac's Trash.") }
    .confirmationDialog("\(sensitive?.name ?? "This file") holds credentials.",
      isPresented: Binding(get: { sensitive != nil }, set: { if !$0 { sensitive = nil } }), titleVisibility: .visible) {
      Button("Download to this iPhone") { if let item = sensitive { Task { await download(item, confirm: true) } } }
    } message: { Text("Only continue if you need this secret on your phone.") }
    .sheet(item: Binding(get: { moving.map { PalmMoveRequest(item: $0.0, mode: $0.1) } }, set: { if $0 == nil { moving = nil } })) { request in
      PalmFolderPicker(connection: connection, title: request.mode == "move" ? "Move to" : "Copy to", start: folder) { destination in
        moving = nil
        Task { await transfer(request.item, to: destination, mode: request.mode) }
      }
    }
    .sheet(item: Binding(get: { sharing.map(PalmShareItem.init) }, set: { if $0 == nil { sharing = nil } })) { item in
      PalmActivitySheet(items: [item.url])
    }
    .sheet(item: Binding(get: { textPreview.map { PalmTextItem(value: $0) } }, set: { if $0 == nil { textPreview = nil } })) { item in
      NavigationStack {
        ScrollView {
          Text(item.value.text ?? "").font(.caption.monospaced()).textSelection(.enabled).padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle((item.value.path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { textPreview = nil } } }
      }
      .preferredColorScheme(.dark)
    }
    .quickLookPreview($preview)
    .sheet(item: Binding(get: { savedSheet.map(PalmShareItem.init) }, set: { if $0 == nil { savedSheet = nil } })) { item in
      PalmSavedFileSheet(url: item.url)
    }
    .palmToast($error, warning: true)
  }

  @ViewBuilder private func row(_ item: PalmFSItem) -> some View {
    if item.isFolder {
      NavigationLink(value: item.path) { label(item) }
        .accessibilityIdentifier("fs.\(item.name)")
    } else {
      Button { Task { await open(item) } } label: { label(item) }.buttonStyle(.plain)
        .accessibilityIdentifier("fs.\(item.name)")
    }
  }

  private func label(_ item: PalmFSItem) -> some View {
    HStack(spacing: 12) {
      Image(systemName: icon(item)).font(.title3).foregroundStyle(item.isFolder ? PalmStyle.accent : PalmStyle.muted)
        .frame(width: 28)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 4) {
          Text(item.name).foregroundStyle(item.hidden ? PalmStyle.muted : .white)
          if item.symlink { Image(systemName: "arrow.turn.up.right").font(.caption2).foregroundStyle(PalmStyle.muted) }
          if item.sensitive { Image(systemName: "key.fill").font(.caption2).foregroundStyle(.orange) }
        }
        Text([item.size.map { $0.palmBytes }, PalmTime.relative(item.modified)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
          .font(.caption).foregroundStyle(PalmStyle.muted)
      }
    }
    .frame(minHeight: 44)
  }

  private func icon(_ item: PalmFSItem) -> String {
    if item.isFolder { return "folder.fill" }
    if item.package { return "shippingbox" }
    if item.isImage { return "photo" }
    switch (item.name as NSString).pathExtension.lowercased() {
    case "pdf": return "doc.richtext"
    case "zip", "gz", "tar": return "doc.zipper"
    case "mp4", "mov", "m4v": return "film"
    case "js", "mjs", "ts", "tsx", "jsx", "swift", "py", "json", "css", "html", "sh", "yml", "md": return "chevron.left.forwardslash.chevron.right"
    default: return "doc"
    }
  }

  @ViewBuilder private func menu(_ item: PalmFSItem) -> some View {
    if !item.isFolder {
      Button { Task { await download(item, confirm: false) } } label: { Label("Save to iPhone", systemImage: "arrow.down.circle") }
    }
    Button { Task { await putOnMacClipboard(item) } } label: { Label("Copy on Mac (for Finder paste)", systemImage: "doc.on.clipboard") }
    Button { UIPasteboard.general.string = item.path } label: { Label("Copy path", systemImage: "link") }
    Button { moving = (item, "copy") } label: { Label("Copy to", systemImage: "plus.square.on.square") }
    Button { moving = (item, "move") } label: { Label("Move to", systemImage: "folder") }
    Button { renaming = item; newName = item.name } label: { Label("Rename", systemImage: "pencil") }
    Button(role: .destructive) { confirmTrash = item } label: { Label("Move to Trash", systemImage: "trash") }
  }

  private func load() async {
    do {
      let asked = Date()
      listing = try await connection.get("/api/fs/list", ["path": folder, "hidden": showHidden ? "1" : "0"])
      PalmTimings.shared.record(.filesFolder, ms: Date().timeIntervalSince(asked) * 1000)
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func runSearch() async {
    struct Results: Decodable { let items: [PalmFSItem] }
    guard !search.isEmpty else { results = nil; return }
    do { results = try await (connection.get("/api/fs/search", ["path": folder, "q": search]) as Results).items }
    catch { self.error = connection.friendlyMessage(error) }
  }

  private func open(_ item: PalmFSItem) async {
    if item.sensitive { sensitive = item; return }
    let ext = (item.name as NSString).pathExtension.lowercased()
    let textLike = ["txt", "md", "json", "js", "mjs", "ts", "tsx", "jsx", "swift", "py", "css", "html", "sh", "yml", "yaml", "toml", "log", "csv", "env", "xml", "plist"].contains(ext) || item.name.hasPrefix(".")
    if textLike, (item.size ?? 0) < 512 * 1024 {
      do { textPreview = try await connection.get("/api/fs/preview", ["path": item.path]); return } catch {}
    }
    await download(item, confirm: false)
  }

  private func download(_ item: PalmFSItem, confirm: Bool, share: Bool = false) async {
    guard let local = await transfers.download(item.path, confirmSensitive: confirm) else {
      error = transfers.items.first.flatMap { if case .failed(let message) = $0.state { return message } else { return nil } }
      return
    }
    if share { sharing = local } else { savedSheet = local }
  }

  private func rename(_ item: PalmFSItem) async {
    do {
      let _: PalmFSItem = try await connection.post("/api/fs/rename", ["path": item.path, "name": newName])
      await load()
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func makeFolder() async {
    do {
      let _: PalmFSItem = try await connection.post("/api/fs/mkdir", ["path": folder, "name": newName])
      await load()
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func trash(_ item: PalmFSItem) async {
    do {
      try await connection.send("/api/fs/trash", ["paths": [item.path]])
      await load()
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func transfer(_ item: PalmFSItem, to destination: String, mode: String) async {
    do {
      try await connection.send("/api/fs/\(mode)", ["paths": [item.path], "to": destination])
      await load()
    } catch { self.error = connection.friendlyMessage(error) }
  }

  private func putOnMacClipboard(_ item: PalmFSItem) async {
    do { try await connection.send("/api/clipboard", ["files": [item.path]]) }
    catch { self.error = connection.friendlyMessage(error) }
  }
}

struct PalmMoveRequest: Identifiable {
  var id: String { item.path + mode }
  let item: PalmFSItem
  let mode: String
}

struct PalmShareItem: Identifiable {
  var id: String { url.path }
  let url: URL
}

struct PalmTextItem: Identifiable {
  var id: String { value.path }
  let value: PalmTextPreview
}

/// Choose a destination folder on the Mac.
struct PalmFolderPicker: View {
  @ObservedObject var connection: PalmConnection
  let title: String
  let start: String
  var choose: (String) -> Void
  @State private var current = ""
  @State private var listing: PalmFSListing?
  @State private var places: [PalmPlace] = []
  @State private var error: String?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      List {
        if let error { Text(error).foregroundStyle(.orange) }
        Section {
          ScrollView(.horizontal, showsIndicators: false) {
            HStack {
              ForEach(places) { place in
                Button(place.name) { Task { await open(place.path) } }.buttonStyle(.bordered)
              }
            }
          }
        }
        if let parent = listing?.parent {
          Button { Task { await open(parent) } } label: { Label("Up to \((parent as NSString).lastPathComponent)", systemImage: "arrow.up") }
        }
        ForEach(listing?.items.filter(\.isFolder) ?? []) { item in
          Button { Task { await open(item.path) } } label: { Label(item.name, systemImage: "folder") }
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .safeAreaInset(edge: .bottom) {
        Button {
          choose(current)
          dismiss()
        } label: {
          Text("Choose \(listing?.name ?? "this folder")").frame(maxWidth: .infinity)
        }
        .buttonStyle(PalmPrimaryButton())
        .padding()
        .background(PalmStyle.panel)
        .disabled(current.isEmpty)
      }
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
      .task {
        places = (try? await (connection.get("/api/fs/places") as PalmPlaces).places) ?? []
        await open(start)
      }
    }
    .preferredColorScheme(.dark)
  }

  private func open(_ folder: String) async {
    do {
      listing = try await connection.get("/api/fs/list", ["path": folder])
      current = listing?.path ?? folder
      error = nil
    } catch { self.error = connection.friendlyMessage(error) }
  }
}

struct PalmTransfersSheet: View {
  @ObservedObject var transfers: PalmTransfers
  @Environment(\.dismiss) private var dismiss
  @State private var sharing: URL?

  var body: some View {
    NavigationStack {
      List {
        if transfers.items.isEmpty { Text("Nothing transferred yet.").foregroundStyle(PalmStyle.muted) }
        ForEach(transfers.items) { item in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Image(systemName: item.direction == .toMac ? "arrow.up.circle" : "arrow.down.circle")
              Text(item.name).font(.body.weight(.medium))
              Spacer()
              state(item.state)
            }
            Text(item.direction == .toMac ? "To \(item.macPath ?? item.destination)" : "From \(item.macPath ?? "")")
              .font(.caption).foregroundStyle(PalmStyle.muted)
            if item.state == .verified, let sha = item.sha256 {
              Text("SHA-256 \(sha.prefix(16)) matches on both devices\(item.size > 0 ? " · \(item.size.palmBytes)" : "")")
                .font(.caption2.monospaced()).foregroundStyle(PalmStyle.accent)
            }
            if case .transferring(let fraction) = item.state { ProgressView(value: fraction).tint(PalmStyle.accent) }
            if item.direction == .toPhone, item.state == .verified, let url = item.localURL {
              Button("Share or save") { sharing = url }.font(.footnote)
            }
          }
          .padding(.vertical, 4)
        }
      }
      .navigationTitle("Transfers")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Clear finished") { transfers.clearFinished() } }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
      }
      .sheet(item: Binding(get: { sharing.map(PalmShareItem.init) }, set: { if $0 == nil { sharing = nil } })) { item in
        PalmActivitySheet(items: [item.url])
      }
    }
    .preferredColorScheme(.dark)
  }

  @ViewBuilder private func state(_ state: PalmTransfers.State) -> some View {
    switch state {
    case .preparing: Text("Preparing").font(.caption).foregroundStyle(PalmStyle.muted)
    case .transferring(let f): Text("\(Int(f * 100))%").font(.caption.monospacedDigit()).foregroundStyle(PalmStyle.muted)
    case .verifying: Text("Verifying").font(.caption).foregroundStyle(PalmStyle.muted)
    case .verified: Label("Verified", systemImage: "checkmark.seal.fill").font(.caption).foregroundStyle(PalmStyle.accent)
    case .failed(let message): Text(message).font(.caption).foregroundStyle(.orange)
    }
  }
}

struct PalmActivitySheet: UIViewControllerRepresentable {
  let items: [Any]
  func makeUIViewController(context: Context) -> UIActivityViewController {
    UIActivityViewController(activityItems: items, applicationActivities: nil)
  }
  func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// How a folder is ordered on the phone.
enum PalmFileSort {
  static let orders: [(id: String, title: String, symbol: String)] = [
    ("recent", "Recent", "clock"),
    ("name", "Name", "textformat"),
    ("size", "Size", "arrow.down.circle"),
    ("kind", "Kind", "doc.on.doc"),
  ]

  static func sorted(_ items: [PalmFSItem], by order: String) -> [PalmFSItem] {
    let byName: (PalmFSItem, PalmFSItem) -> Bool = { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    switch order {
    case "name":
      return items.sorted { $0.isFolder != $1.isFolder ? $0.isFolder : byName($0, $1) }
    case "size":
      // Folders (no size) first by name, then the biggest files.
      return items.sorted {
        if $0.isFolder != $1.isFolder { return $0.isFolder }
        if $0.isFolder { return byName($0, $1) }
        return ($0.size ?? 0) != ($1.size ?? 0) ? ($0.size ?? 0) > ($1.size ?? 0) : byName($0, $1)
      }
    case "kind":
      return items.sorted {
        if $0.isFolder != $1.isFolder { return $0.isFolder }
        let a = ($0.name as NSString).pathExtension.lowercased(), b = ($1.name as NSString).pathExtension.lowercased()
        return a != b ? a < b : byName($0, $1)
      }
    default:
      // Most recently changed first, folders and files together, as Finder
      // does; the Mac sends times in one ISO format, so text order is time order.
      return items.sorted {
        switch ($0.modified, $1.modified) {
        case let (a?, b?) where a != b: return a > b
        case (_?, nil): return true
        case (nil, _?): return false
        default: return byName($0, $1)
        }
      }
    }
  }
}

