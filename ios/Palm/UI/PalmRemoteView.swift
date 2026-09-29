import PhotosUI
import SwiftUI

/// The live Mac screen, full size, with controls floating on top.
struct PalmRemoteView: View {
  @ObservedObject var connection: PalmConnection
  @Environment(\.dismiss) private var dismiss
  @Environment(\.scenePhase) private var scenePhase
  @AppStorage("palm.remote.mode") private var modeName = PalmInputMode.touch.rawValue
  /// Landscape puts the controls in a rail in the side margin: "right" or "left".
  @AppStorage("palm.remote.railSide") private var railSide = "right"
  /// The landscape rail tucked away to a small tab at the edge.
  @AppStorage("palm.remote.railCollapsed") private var railCollapsed = false
  @AppStorage(PalmConnection.invertScrollKey) private var invertScroll = false
  /// Which side the Dynamic Island (or notch) is on in landscape.
  @State private var islandSide: HorizontalEdge?
  /// Where Copy / Paste / Select All show, after a word or a selection is made.
  @State private var editAt: CGPoint?
  @State private var editHide: Task<Void, Never>?
  @State private var flash: String?
  @State private var framingOverride: PalmRemoteFraming?
  @State private var reframeID = 0
  @State private var typing = false
  @State private var showingActions = false
  @State private var showingOptions = false
  @State private var showingApps = false
  @State private var edgeFocus: CGPoint?
  @State private var edgeID = 0
  @State private var pickingPhoto = false
  @State private var photoItem: PhotosPickerItem?
  @State private var showingDock = false
  @State private var localError: String?
  @State private var actionBusy = false
  @ObservedObject private var voice = PalmVoice.shared
  @ObservedObject private var alerts = PalmWatchAlerts.shared

  private var mode: PalmInputMode { modeName == PalmInputMode.trackpad.rawValue ? .trackpad : .touch }
  private var canControl: Bool {
    scenePhase == .active && connection.isStreaming
      && connection.hostStatus?.controlPermission == true
      && connection.video.hasPicture && !connection.isBusy
      && connection.screenOwner?.agentHasScreen != true
  }
  private var starting: Bool {
    connection.connectionState == .connecting || connection.connectionState == .reconnecting
  }
  /// An app's window shows whole (tapping an app should
  /// open it in full); the whole Mac screen starts out filling the phone.
  private var framing: PalmRemoteFraming {
    framingOverride ?? (connection.targetWindowID > 0 ? .fit : .readable)
  }
  private var statusColor: Color {
    guard connection.isStreaming else { return PalmStyle.muted }
    return connection.screenOwner?.agentHasScreen == true ? .orange : PalmStyle.success
  }
  private var statusLine: String {
    if starting { return "Connecting" }
    guard connection.isStreaming else { return "Stopped" }
    if connection.screenOwner?.agentHasScreen == true { return "Agent has control" }
    if connection.hostStatus?.controlPermission == false { return "View only" }
    return "Live"
  }

  var body: some View {
    GeometryReader { geometry in
      let landscape = geometry.size.width > geometry.size.height
      let safe = geometry.safeAreaInsets
      // The whole screen's height; the keyboard only moves the bottom inset.
      let screenHeight = geometry.size.height + safe.top + safe.bottom
      // Twelve buttons down the rail, plus its status and gaps.
      let railKey = min(44, max(28, ((screenHeight - 98) / 12).rounded(.down)))
      let covered = obscured(safe: safe, landscape: landscape, railKey: railKey)
      let layoutCovered = obscured(safe: safe, landscape: landscape, railKey: railKey, forLayout: true)
      // The zoom map sits in the top-right corner: beside the rail when the
      // rail is open on that side, below the top bar while typing in portrait.
      let mapCorner =
        landscape
        ? CGPoint(x: railSide != "left" && !railCollapsed ? railEdge(safe) + railKey + 14 + 10 : 18, y: 18)
        : typing ? CGPoint(x: 16, y: safe.top + 64) : CGPoint(x: 18, y: 18)
      ZStack {
        Color.black.ignoresSafeArea()
        // The Mac picture always uses the whole screen and the controls float
        // over it ("they are glass controls, dont need to
        // waste the screen").
        measuredStage(covered, layout: layoutCovered, map: mapCorner).ignoresSafeArea(.container)
        if let editAt, canControl {
          editBar(at: editAt, safe: safe, size: geometry.size)
        }
        if let flash {
          Text(flash).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 8)
            .palmVideoGlass(Capsule())
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, landscape ? 24 : 86)
            .transition(.opacity)
            .allowsHitTesting(false)
        }
        if landscape {
          // A glass rail down one side, close to the edge (
          // "move it more to the right"), its buttons sized so
          // every control fits the screen's height. It tucks away to a tab.
          HStack(spacing: 0) {
            if railSide != "left" { Spacer(minLength: 0) }
            if railCollapsed { railTab } else { sideRail(key: railKey) }
            if railSide == "left" { Spacer(minLength: 0) }
          }
          .padding(railSide == "left" ? .leading : .trailing, railEdge(safe))
          .padding(.vertical, 14)
          .ignoresSafeArea()
          landscapeNotice
            .padding(railSide == "left" ? .leading : .trailing, railCollapsed ? 60 : railKey + 30)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        } else {
          VStack(spacing: 8) {
            topBar(landscape: false)
            Spacer(minLength: 0)
            if voice.isActive(for: "screen") {
              voicePill.frame(maxWidth: 440).padding(.bottom, 10)
            } else if !typing {
              // Ten buttons across: sized so they fit the narrowest iPhone.
              controlBar(key: min(44, ((geometry.size.width - 70) / 10).rounded(.down))).padding(.bottom, 10)
            }
          }
          .padding(.horizontal, 10)
        }
        // An agent finished or needs you, even while watching the screen.
        if let alert = alerts.banner {
          PalmWatchBanner(alert: alert) { alerts.dismissBanner() } dismiss: { alerts.dismissBanner() }
            .frame(maxWidth: 440)
            .padding(.top, landscape ? 10 : safe.top + 62)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .ignoresSafeArea()
            .transition(.move(edge: .top).combined(with: .opacity))
        }
        if landscape && voice.isActive(for: "screen") {
          voicePill.frame(maxWidth: 440)
            .padding(railSide == "left" ? .leading : .trailing, railCollapsed ? 60 : railKey + 40)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .padding(.bottom, 16)
        }
        if ProcessInfo.processInfo.environment["PALM_LIVE_TEST"] == "1" {
          // Read by the live device tests only.
          Color.clear.frame(width: 1, height: 1)
            .accessibilityElement()
            .accessibilityLabel("Stream health")
            .accessibilityValue(connection.healthSummary)
            .accessibilityIdentifier("remote.health")
        }
        PalmKeyCatcher(active: $typing, speak: { startVoice() }, paste: { pasteFromPhone($0, $1) }, photo: {
          typing = false
          pickingPhoto = true
        }) { stroke in
          switch stroke {
          case .text(let text): connection.sendText(text)
          case .key(let key, let modifiers): connection.sendKey(key, modifiers: modifiers)
          }
        }
        .frame(width: 1, height: 1)
        .opacity(0.02)
        .accessibilityHidden(true)
      }
    }
    .statusBarHidden()
    .defersSystemGestures(on: .all)
    .onAppear {
      UIDevice.current.beginGeneratingDeviceOrientationNotifications()
      islandSide = Self.currentIslandSide()
    }
    .onReceive(NotificationCenter.default.publisher(for: UIDevice.orientationDidChangeNotification)) { _ in
      islandSide = Self.currentIslandSide()
    }
    .sheet(isPresented: $showingActions) { actionsSheet }
    .sheet(isPresented: $showingOptions) { optionsSheet }
    .sheet(isPresented: $showingDock) { PalmDockSheet(connection: connection) { show(.dock) } }
    .photosPicker(isPresented: $pickingPhoto, selection: $photoItem, matching: .images)
    .onChange(of: photoItem) { _, item in
      guard let item else { return }
      photoItem = nil
      Task {
        guard let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
          localError = "That photo could not be read."
          return
        }
        pasteFromPhone(nil, image)
      }
    }
    .sheet(isPresented: $showingApps) {
      PalmScreenAppsSheet(connection: connection,
        open: { app in try await connection.open(app: app) },
        launch: { app in try await launch(app) },
        shortcut: { press($0) })
    }
    .onDisappear {
      typing = false
      connection.stop()
      UIDevice.current.endGeneratingDeviceOrientationNotifications()
    }
    .onChange(of: connection.connectionState) { _, state in
      if state == .live {
        localError = nil
        if showingActions { refreshActions() }
      }
    }
    .onChange(of: connection.targetWindowID) { _, _ in
      framingOverride = nil
      reframeID += 1
    }
    .onChange(of: canControl) { _, value in if !value { typing = false } }
    .onChange(of: typing) { _, _ in showEditBar(nil) }
    .palmPrivacyShield()
  }

  // MARK: Stage

  private func measuredStage(_ covered: UIEdgeInsets, layout: UIEdgeInsets, map: CGPoint) -> some View {
    stage(covered, map: map).background {
      GeometryReader { inner in
        Color.clear
          .onAppear { reportViewport(inner.size, layout) }
          .onChange(of: inner.size) { _, size in reportViewport(size, layout) }
      }
      .allowsHitTesting(false)
    }
  }

  /// Where the floating controls cover the picture: the zoom map and a picture
  /// that fits keep clear of them, and phone layout shapes the Mac window for
  /// the space they leave.
  /// `forLayout` always counts the open rail, so tucking it away never
  /// reshapes a phone-shaped Mac window.
  private func obscured(
    safe: EdgeInsets, landscape: Bool, railKey: CGFloat, forLayout: Bool = false
  ) -> UIEdgeInsets {
    if landscape {
      // The rail, its distance from the edge and a gap beside it.
      let rail = forLayout || !railCollapsed ? railEdge(safe) + railKey + 14 + 8 : 0
      return UIEdgeInsets(
        top: safe.top, left: railSide == "left" ? max(safe.leading, rail) : safe.leading,
        bottom: typing ? 0 : safe.bottom, right: railSide == "left" ? safe.trailing : max(safe.trailing, rail))
    }
    return UIEdgeInsets(
      top: safe.top + 64, left: safe.leading, bottom: typing ? 0 : safe.bottom + 64,
      right: safe.trailing)
  }

  private func stage(_ covered: UIEdgeInsets, map: CGPoint) -> some View {
    ZStack {
      PalmRemoteSurface(
        displayLayer: connection.video.displayLayer, videoSize: connection.videoSize,
        enabled: canControl && !actionBusy, mode: mode, resetZoomID: 0,
        pointer: { connection.sendPointer(action: $0, x: $1, y: $2) },
        scroll: { connection.sendScroll(dx: $0, dy: $1) },
        cancelSession: { Task { @MainActor in connection.stop() } },
        framing: framing, reframeID: reframeID, typing: typing,
        zoomChanged: { connection.setStreamQuality(zoom: $0) }, obscured: covered,
        mapCorner: map, selected: { showEditBar($0) }, edgeFocus: edgeFocus, edgeID: edgeID
      )
      .accessibilityIdentifier("remote.surface")
      if !connection.isStreaming {
        VStack(spacing: 16) {
          if starting {
            ProgressView().controlSize(.large).tint(.white)
            Text("Opening on your Mac").font(.headline)
          } else {
            Image(systemName: "macwindow").font(.system(size: 38)).foregroundStyle(.white)
            Text("Session stopped").font(.title3.weight(.semibold))
            Button("Start again") {
              Task {
                do {
                  try await connection.start(
                    windowID: connection.targetWindowID,
                    name: connection.targetName, layout: connection.windowLayout)
                } catch { localError = error.localizedDescription }
              }
            }
            .buttonStyle(PalmPrimaryButton())
            .disabled(connection.hostStatus?.screenPermission == false || connection.isBusy)
            .accessibilityIdentifier("remote.start")
          }
        }
        .padding(24)
        .frame(maxWidth: 340)
      }
    }
  }

  private func reportViewport(_ size: CGSize, _ covered: UIEdgeInsets) {
    guard !typing else { return }
    connection.updateViewport(CGSize(
      width: size.width - covered.left - covered.right,
      height: size.height - covered.top - covered.bottom))
  }

  // MARK: Floating controls

  private func topBar(landscape: Bool) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Button {
        typing = false
        connection.stop()
        dismiss()
      } label: {
        Image(systemName: "chevron.left").font(.body.weight(.semibold)).foregroundStyle(.white)
          .frame(width: 48, height: 48)
      }
      .palmVideoGlass(Circle(), interactive: true)
      .accessibilityLabel("Back")
      .accessibilityIdentifier("remote.back")
      VStack(alignment: .leading, spacing: 6) {
        // With several monitors, the name opens the list of screens.
        displaysMenu {
          HStack(spacing: 7) {
            Circle().fill(connection.isStreaming ? (connection.screenOwner?.agentHasScreen == true ? Color.orange : PalmStyle.success) : PalmStyle.muted)
              .frame(width: 7, height: 7)
            Text(connection.targetName.isEmpty ? "Desktop" : connection.targetName)
              .font(.subheadline.weight(.semibold)).lineLimit(2).minimumScaleFactor(0.8)
            Text(statusLine).font(.caption).foregroundStyle(PalmStyle.muted).lineLimit(1).fixedSize()
            if let latency = connection.latencyMilliseconds, connection.isStreaming {
              Text(verbatim: "\(latency) ms").font(.caption.monospacedDigit()).foregroundStyle(PalmStyle.muted).fixedSize()
            }
            if connection.displays.count > 1 {
              Image(systemName: "chevron.down").font(.caption.weight(.bold)).foregroundStyle(PalmStyle.muted)
            }
          }
          .padding(.horizontal, 12).padding(.vertical, 9)
          .foregroundStyle(.white)
          .palmVideoGlass(Capsule())
        }
        // The zoom map lives in the top-right corner.
        .padding(.trailing, landscape ? 0 : 60)
        if let error = connection.errorMessage ?? localError {
          HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
            Text(error).font(.caption).fixedSize(horizontal: false, vertical: true)
            Button {
              connection.errorMessage = nil
              localError = nil
            } label: { Image(systemName: "xmark").font(.caption.weight(.bold)).frame(width: 28, height: 28) }
            .accessibilityLabel("Dismiss")
          }
          .padding(.horizontal, 12).padding(.vertical, 8)
          .frame(maxWidth: 460, alignment: .leading)
          .foregroundStyle(.white)
          .palmVideoGlass(RoundedRectangle(cornerRadius: 16))
          .accessibilityIdentifier("remote.error")
        }
      }
      Spacer(minLength: 0)
      if typing {
        // The same height as Back, opposite it: hides the keyboard.
        Button { typing = false } label: {
          Text("Done").font(.body.weight(.semibold)).foregroundStyle(PalmStyle.onAccent)
            .padding(.horizontal, 16).frame(height: 48)
            .background(PalmStyle.accent, in: Capsule())
        }
        .accessibilityIdentifier("remote.done")
      }
    }
    .padding(.top, landscape ? 6 : 2)
  }

  // MARK: Landscape rail

  /// Every control in one column; `key` is each button's size, worked out
  /// from the screen's height so the column always fits.
  private func sideRail(key: CGFloat) -> some View {
    VStack(spacing: 2) {
      Button { withAnimation(.snappy) { railCollapsed = true } } label: {
        Image(systemName: railSide == "left" ? "sidebar.left" : "sidebar.right")
          .font(.system(size: 16, weight: .medium)).frame(width: key, height: key)
      }
      .foregroundStyle(.white)
      .accessibilityLabel("Hide controls")
      .accessibilityIdentifier("remote.hideControls")
      Button {
        typing = false
        connection.stop()
        dismiss()
      } label: {
        Image(systemName: "chevron.left").font(.body.weight(.semibold)).frame(width: key, height: key)
      }
      .foregroundStyle(.white)
      .accessibilityLabel("Back")
      .accessibilityIdentifier("remote.back")
      // With several monitors, the status also opens the list of screens.
      displaysMenu {
        VStack(spacing: 3) {
          Circle().fill(statusColor).frame(width: 7, height: 7)
          if let latency = connection.latencyMilliseconds, connection.isStreaming {
            Text(verbatim: "\(latency)").font(.caption2.monospacedDigit()).foregroundStyle(Color(white: 0.75))
          } else if connection.displays.count > 1 {
            Image(systemName: "display.2").font(.system(size: 10, weight: .semibold)).foregroundStyle(Color(white: 0.75))
          }
        }
        .frame(width: key, height: 22)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(statusLine)
      }
      Spacer(minLength: 2)
      VStack(spacing: 2) {
        modeButton(.touch, icon: "hand.tap", title: "Touch", size: key)
        modeButton(.trackpad, icon: "cursorarrow", title: "Mouse", size: key)
      }
      .padding(3)
      .background(Color.white.opacity(0.08), in: Capsule())
      barButton(typing ? "keyboard.chevron.compact.down" : "keyboard",
        label: typing ? "Hide keyboard" : "Type on the Mac", id: "remote.keyboard", size: key) { typing.toggle() }
        .disabled(!canControl)
      barButton("mic.fill", label: "Speak to type on the Mac", id: "remote.mic", size: key) { startVoice() }
        .disabled(!canControl)
      barButton("square.grid.2x2", label: "Apps and Spotlight", id: "remote.apps", size: key) { showingApps = true }
        .disabled(!canControl)
      PalmMacEdgesMenu(size: key) { edge in if edge == .dock { showingDock = true } else { show(edge) } }
        .disabled(!canControl)
      barButton(framing == .fit ? "plus.magnifyingglass" : "arrow.up.left.and.arrow.down.right",
        label: framing == .fit ? "Zoom in" : "Show all", id: "remote.zoom", size: key) {
        framingOverride = framing == .fit ? .readable : .fit
        reframeID += 1
      }
      barButton("slider.horizontal.3", label: "App controls", id: "remote.controls", size: key) {
        showingActions = true
        refreshActions()
      }
      barButton("gearshape", label: "Session options", id: "remote.options", size: key) { showingOptions = true }
      Spacer(minLength: 2)
      Button {
        typing = false
        connection.stop()
      } label: {
        Image(systemName: "stop.fill").font(.system(size: 15, weight: .semibold)).foregroundStyle(.red)
          .frame(width: key, height: key)
      }
      .accessibilityLabel("Stop sharing")
      .accessibilityIdentifier("remote.stop")
      .disabled(!connection.isStreaming && !starting)
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 4)
    .palmVideoGlass(Capsule(), interactive: true)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("remote.rail")
  }

  /// The rail tucked away: a small tab at the same edge brings it back.
  private var railTab: some View {
    Button { withAnimation(.snappy) { railCollapsed = false } } label: {
      VStack(spacing: 9) {
        Circle().fill(statusColor).frame(width: 7, height: 7)
        Image(systemName: railSide == "left" ? "sidebar.left" : "sidebar.right")
          .font(.system(size: 16, weight: .medium))
      }
      .foregroundStyle(.white)
      .frame(width: 44, height: 72)
    }
    .palmVideoGlass(Capsule(), interactive: true)
    .accessibilityLabel("Show controls")
    .accessibilityIdentifier("remote.showControls")
  }

  /// How far the rail sits from the screen's edge: close to it, unless the
  /// Dynamic Island (or notch) is on that side.
  private func railEdge(_ safe: EdgeInsets) -> CGFloat {
    let inset = railSide == "left" ? safe.leading : safe.trailing
    guard inset > 20 else { return 10 }  // no island or notch, as on an iPhone SE
    guard let islandSide else { return inset + 4 }
    return islandSide == (railSide == "left" ? .leading : .trailing) ? inset + 4 : 12
  }

  private static func currentIslandSide() -> HorizontalEdge? {
    // Turned with the top of the phone to the left, the island is on the left.
    switch UIDevice.current.orientation {
    case .landscapeLeft: return .leading
    case .landscapeRight: return .trailing
    default: break
    }
    let scene = UIApplication.shared.connectedScenes.lazy.compactMap { $0 as? UIWindowScene }.first
    switch scene?.effectiveGeometry.interfaceOrientation {
    case .landscapeRight?: return .leading
    case .landscapeLeft?: return .trailing
    default: return nil
    }
  }

  /// Errors and the "starting" state in landscape sit over the top of the picture.
  @ViewBuilder private var landscapeNotice: some View {
    if let error = connection.errorMessage ?? localError {
      HStack(alignment: .top, spacing: 8) {
        Image(systemName: "exclamationmark.circle").foregroundStyle(.orange)
        Text(error).font(.caption).fixedSize(horizontal: false, vertical: true)
        Button {
          connection.errorMessage = nil
          localError = nil
        } label: { Image(systemName: "xmark").font(.caption.weight(.bold)).frame(width: 28, height: 28) }
        .accessibilityLabel("Dismiss")
      }
      .padding(.horizontal, 12).padding(.vertical, 8)
      .frame(maxWidth: 460, alignment: .leading)
      .foregroundStyle(.white)
      .palmVideoGlass(RoundedRectangle(cornerRadius: 16))
      .padding(.top, 8)
      .accessibilityIdentifier("remote.error")
    }
  }

  private func controlBar(key: CGFloat) -> some View {
    HStack(spacing: 4) {
      HStack(spacing: 2) {
        modeButton(.touch, icon: "hand.tap", title: "Touch", size: key)
        modeButton(.trackpad, icon: "cursorarrow", title: "Mouse", size: key)
      }
      .padding(3)
      .background(Color.white.opacity(0.08), in: Capsule())
      barButton("keyboard", label: "Type on the Mac", id: "remote.keyboard", size: key) {
        typing = true
      }
      .disabled(!canControl)
      barButton("mic.fill", label: "Speak to type on the Mac", id: "remote.mic", size: key) { startVoice() }
        .disabled(!canControl)
      barButton("square.grid.2x2", label: "Apps and Spotlight", id: "remote.apps", size: key) { showingApps = true }
        .disabled(!canControl)
      PalmMacEdgesMenu(size: key) { edge in if edge == .dock { showingDock = true } else { show(edge) } }
        .disabled(!canControl)
      barButton(framing == .fit ? "plus.magnifyingglass" : "arrow.up.left.and.arrow.down.right",
        label: framing == .fit ? "Zoom in" : "Show all", id: "remote.zoom", size: key) {
        framingOverride = framing == .fit ? .readable : .fit
        reframeID += 1
      }
      barButton("slider.horizontal.3", label: "App controls", id: "remote.controls", size: key) {
        showingActions = true
        refreshActions()
      }
      barButton("gearshape", label: "Session options", id: "remote.options", size: key) {
        showingOptions = true
      }
      Button {
        typing = false
        connection.stop()
      } label: {
        Image(systemName: "stop.fill").font(.system(size: 15, weight: .semibold)).foregroundStyle(.red)
          .frame(width: key, height: key)
      }
      .accessibilityLabel("Stop sharing")
      .accessibilityIdentifier("remote.stop")
      .disabled(!connection.isStreaming && !starting)
    }
    .padding(5)
    .palmVideoGlass(Capsule(), interactive: true)
    .frame(maxWidth: .infinity)
  }

  private func modeButton(_ value: PalmInputMode, icon: String, title: String, size: CGFloat = 44) -> some View {
    Button {
      modeName = value.rawValue
      UISelectionFeedbackGenerator().selectionChanged()
    } label: {
      Label(title, systemImage: icon).labelStyle(.iconOnly)
        .font(.system(size: 16, weight: .semibold))
        .frame(width: size, height: size)
        .foregroundStyle(mode == value ? PalmStyle.onAccent : .white)
        .background(mode == value ? PalmStyle.accent : .clear, in: Capsule())
    }
    .accessibilityLabel("\(title) mode")
    .accessibilityAddTraits(mode == value ? .isSelected : [])
    .accessibilityIdentifier("remote.mode.\(title.lowercased())")
  }

  // MARK: Screens

  /// The Mac's screens, when it has more than one: pick one to see and control.
  @ViewBuilder private func displaysMenu<Content: View>(@ViewBuilder label: () -> Content) -> some View {
    if connection.displays.count > 1 {
      Menu {
        ForEach(connection.displays) { display in
          Button {
            Task {
              do { try await connection.show(display: display) } catch { localError = connection.friendlyMessage(error) }
            }
          } label: {
            if connection.currentDisplay == display { Label(display.name, systemImage: "checkmark") } else { Text(display.name) }
          }
        }
      } label: { label() }
      .accessibilityLabel("Choose which Mac screen to show")
      .accessibilityValue(connection.targetName)
      .accessibilityIdentifier("remote.displays")
    } else {
      label()
    }
  }

  // MARK: Apps and shortcuts

  /// The Dock or the menu bar: the whole screen first (they are outside any
  /// app's window), then that edge at a readable size, with the pointer moved
  /// there so an auto-hidden bar slides out.
  private func show(_ edge: PalmMacEdge) {
    Task {
      if !connection.showsWholeScreen {
        do { try await connection.start(windowID: 0, name: "Desktop") } catch {
          localError = connection.friendlyMessage(error)
          return
        }
      }
      guard await connection.waitUntilControllable() else { return }
      edgeFocus = edge.focus
      edgeID += 1
      await connection.revealEdge(edge == .menuBar)
    }
  }

  /// Opens an app that is not running and shows its window (or the whole
  /// screen, for an app without one).
  private func launch(_ app: PalmInstalledApp) async throws {
    struct Launched: Decodable { let ok: Bool; let windowId: Int }
    let result: Launched = try await connection.post("/api/command", ["op": "launch", "bundleId": app.bundleId])
    try await connection.start(
      windowID: result.windowId, name: result.windowId > 0 ? app.name : "Desktop",
      layout: result.windowId > 0 ? .fill : .original)
  }

  /// Spotlight, the app switcher and Mission Control draw over the whole
  /// screen, so the view shows the whole screen first. Spotlight waits for
  /// words: the keyboard comes up.
  private func press(_ shortcut: PalmMacShortcut) {
    Task {
      if !connection.showsWholeScreen {
        do { try await connection.start(windowID: 0, name: "Desktop") } catch {
          localError = connection.friendlyMessage(error)
          return
        }
      }
      guard await connection.waitUntilControllable() else { return }
      connection.sendKey(shortcut.keys.key, modifiers: shortcut.keys.modifiers)
      if let focus = shortcut.focus {
        edgeFocus = focus
        edgeID += 1
      }
      if shortcut == .spotlight { typing = true }
    }
  }

  /// This iPhone's copied text or a photo, pasted where the Mac's cursor is.
  private func pasteFromPhone(_ text: String?, _ image: UIImage?) {
    Task {
      do {
        try await connection.pasteOnMac(text: text, image: image)
        showFlash(image != nil ? "Picture pasted on the Mac" : "Pasted on the Mac")
      } catch { localError = connection.friendlyMessage(error) }
    }
  }

  // MARK: Voice

  /// Spoken words typed at the Mac's cursor, as said or polished first. Never
  /// presses Return.
  /// Spoken words are pasted at the Mac's cursor and stay on both clipboards
  /// (dictation should also be on the clipboard).
  private var voicePill: some View {
    PalmVoicePill(overVideo: true) { polish in
      Task {
        guard let heard = await voice.finish(connection, polish: polish), canControl else { return }
        UIPasteboard.general.string = heard
        do {
          try await connection.pasteOnMac(text: heard, image: nil)
          showFlash("Pasted on the Mac and copied")
        } catch { localError = connection.friendlyMessage(error) }
      }
    }
  }

  private func startVoice() {
    typing = false
    Task {
      if !(await voice.start(for: "screen")), let error = voice.error { localError = error }
    }
  }

  private func barButton(
    _ icon: String, label: String, id: String, size: CGFloat = 44, action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Image(systemName: icon).font(.system(size: 17, weight: .medium)).frame(width: size, height: size)
    }
    .foregroundStyle(.white)
    .accessibilityLabel(label)
    .accessibilityIdentifier(id)
  }

  private var actionsSheet: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 10) {
          Text("Buttons exposed by the selected Mac app.")
            .font(.subheadline).foregroundStyle(PalmStyle.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
          if let localError { PalmNotice(text: localError, warning: true) }
          ForEach(connection.actions) { action in
            Button {
              guard canControl && !actionBusy else { return }
              actionBusy = true
              Task {
                defer { actionBusy = false }
                do { try await connection.performAction(id: action.id) } catch {
                  localError = error.localizedDescription
                }
              }
            } label: {
              HStack {
                Text(action.title).multilineTextAlignment(.leading)
                Spacer()
                Image(systemName: "chevron.right").font(.caption)
              }
            }.buttonStyle(PalmSecondaryButton()).disabled(!canControl || actionBusy)
          }
          if actionBusy { ProgressView().tint(PalmStyle.accent) }
          if connection.actions.isEmpty && !actionBusy {
            ContentUnavailableView(
              "No app controls available", systemImage: "hand.tap",
              description: Text("Use the live view to interact with this app."))
          }
        }.padding(16)
      }
      .navigationTitle("App controls").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(action: refreshActions) { Image(systemName: "arrow.clockwise") }
            .accessibilityLabel("Refresh app controls").disabled(actionBusy || !canControl)
        }
        ToolbarItem(placement: .confirmationAction) { Button("Done") { showingActions = false } }
      }.palmScreen()
    }
    .palmPrivacyShield()
    .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
    .presentationBackgroundInteraction(.enabled(upThrough: .medium))
  }

  private var optionsSheet: some View {
    NavigationStack {
      Form {
        Section("View") {
          LabeledContent("App", value: connection.targetName)
          Text(statusLine).font(.footnote).foregroundStyle(PalmStyle.muted)
          Button("Readable view", systemImage: "plus.magnifyingglass") {
            framingOverride = .readable
            reframeID += 1
            showingOptions = false
          }
          Button("Whole window", systemImage: "arrow.up.left.and.arrow.down.right") {
            framingOverride = .fit
            reframeID += 1
            showingOptions = false
          }
          Toggle("Invert scrolling", isOn: $invertScroll)
            .accessibilityIdentifier("remote.invertScroll")
          Picker("Controls in landscape", selection: $railSide) {
            Text("Right side").tag("right")
            Text("Left side").tag("left")
          }
          .accessibilityIdentifier("remote.railSide")
        }
        if connection.targetWindowID > 0 {
          Section {
            Picker("Window size", selection: Binding(
              get: { connection.windowLayout }, set: { switchLayout($0) })
            ) {
              Text("Fill the Mac screen").tag(PalmWindowLayout.fill)
              Text("Phone shaped").tag(PalmWindowLayout.phone)
              Text("As it was").tag(PalmWindowLayout.original)
            }
            .disabled(connection.isBusy)
            .accessibilityIdentifier("remote.windowLayout")
          } header: {
            Text("Window layout")
          } footer: {
            Text(layoutNote)
          }
        }
        Section("Using the live view") {
          Text("Touch: tap to click, double-tap to open, drag one finger to scroll, hold to right-click, hold then move to drag. Pinch or use two fingers to zoom and move the view.")
          Text("Mouse: slide one finger to move the pointer, tap to click, two fingers to scroll, hold then move to drag.")
          Text("Keyboard: keys go to the Mac as you type. ⌘ ⌥ ⌃ ⇧ in the key bar apply to the next key.")
        }
        Section("Connection") {
          LabeledContent("Received frames", value: "\(connection.fps) fps")
          if let latency = connection.latencyMilliseconds {
            LabeledContent("Network round trip", value: "\(latency) ms")
          }
          Text("Network round trip does not measure the delay before a change appears on screen.")
            .font(.footnote).foregroundStyle(PalmStyle.muted)
          if connection.hostStatus?.controlPermission == false {
            Text("View only. Enable Palm in Accessibility on your Mac to control apps.")
          }
        }
      }
      .navigationTitle("Session options").navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) { Button("Done") { showingOptions = false } }
      }
      .scrollContentBackground(.hidden).palmScreen()
    }.palmPrivacyShield()
      .presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
  }

  // MARK: Copy and paste

  /// Copy / Paste / Select All, by the finger, after a word or a dragged
  /// selection is made on the Mac (copy and paste must be
  /// ultra simple). Copy also puts the text on the iPhone; Paste sends the
  /// iPhone's clipboard to the Mac first.
  private func editBar(at point: CGPoint, safe: EdgeInsets, size: CGSize) -> some View {
    let x = min(max(point.x - safe.leading, 150), max(150, size.width - 150))
    let above = point.y - safe.top - 60
    let y = above > 28 ? above : point.y - safe.top + 60
    return HStack(spacing: 2) {
      Button { Task { await copyOnMac() } } label: { editLabel("Copy") }
        .accessibilityIdentifier("remote.copy")
      PasteButton(payloadType: String.self) { strings in
        Task { @MainActor in await pasteOnMac(strings.first) }
      }
      .labelStyle(.titleOnly)
      .buttonBorderShape(.capsule)
      .tint(Color(white: 0.16))
      .accessibilityIdentifier("remote.paste")
      Button {
        showEditBar(nil)
        connection.sendKey("a", modifiers: ["cmd"])
      } label: { editLabel("Select All") }
      .accessibilityIdentifier("remote.selectAll")
    }
    .padding(4)
    .palmVideoGlass(Capsule())
    .position(x: x, y: y)
    .transition(.opacity)
  }

  private func editLabel(_ title: String) -> some View {
    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.white)
      .padding(.horizontal, 14).frame(height: 38)
      .contentShape(Capsule())
  }

  private func showEditBar(_ point: CGPoint?) {
    editHide?.cancel()
    withAnimation(.easeOut(duration: 0.15)) { editAt = point }
    guard point != nil else { return }
    editHide = Task { @MainActor in
      try? await Task.sleep(nanoseconds: 6_000_000_000)
      guard !Task.isCancelled else { return }
      withAnimation(.easeOut(duration: 0.2)) { editAt = nil }
    }
  }

  private func copyOnMac() async {
    showEditBar(nil)
    connection.sendKey("c", modifiers: ["cmd"])
    // Give the Mac app a moment to fill its clipboard, then bring it here too.
    try? await Task.sleep(nanoseconds: 350_000_000)
    do {
      let value: PalmClipboard = try await connection.get("/api/clipboard")
      if let png = value.imagePNG, let data = Data(base64Encoded: png), let image = UIImage(data: data) {
        UIPasteboard.general.image = image
      } else if let text = value.text, !text.isEmpty {
        UIPasteboard.general.string = text
      }
      showFlash("Copied")
    } catch { localError = connection.friendlyMessage(error) }
  }

  private func pasteOnMac(_ text: String?) async {
    showEditBar(nil)
    if let text, !text.isEmpty {
      do { try await connection.send("/api/clipboard", ["text": text]) } catch {
        localError = connection.friendlyMessage(error)
        return
      }
    }
    connection.sendKey("v", modifiers: ["cmd"])
    showFlash("Pasted")
  }

  private func showFlash(_ text: String) {
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    withAnimation(.easeOut(duration: 0.15)) { flash = text }
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 1_300_000_000)
      withAnimation(.easeOut(duration: 0.25)) { if flash == text { flash = nil } }
    }
  }

  private var layoutNote: String {
    if connection.windowLayout == .original { return "The window keeps its size on the Mac." }
    guard let layout = connection.phoneLayout, layout.applied else {
      return connection.phoneLayout?.reason ?? "This app keeps its size."
    }
    return connection.windowLayout == .fill
      ? "The window fills your Mac screen while you view it here. Its previous size comes back when you leave, unless you change it on the Mac."
      : "The window takes the phone's shape while you view it here. Its previous size comes back when you leave, unless you change it on the Mac."
  }

  private func switchLayout(_ layout: PalmWindowLayout) {
    guard layout != connection.windowLayout else { return }
    showingOptions = false
    Task {
      do {
        try await connection.start(
          windowID: connection.targetWindowID, name: connection.targetName, layout: layout)
        framingOverride = nil
        reframeID += 1
      } catch { localError = error.localizedDescription }
    }
  }

  private func refreshActions() {
    guard canControl && !actionBusy else { return }
    actionBusy = true
    Task {
      defer { actionBusy = false }
      do { try await connection.refreshActions() } catch { localError = error.localizedDescription }
    }
  }

}
