@preconcurrency import AVFoundation
import SwiftUI
import UIKit

enum PalmInputMode: String, CaseIterable, Identifiable {
  case touch = "Touch"
  case trackpad = "Trackpad"
  case drag = "Drag"
  var id: Self { self }
}

enum PalmRemoteFraming: String, CaseIterable {
  case fit, readable

  func zoomScale(source: CGSize, viewport: CGSize) -> CGFloat {
    guard source.width.isFinite, source.height.isFinite, viewport.width.isFinite,
      viewport.height.isFinite,
      source.width > 0, source.height > 0, viewport.width > 0, viewport.height > 0
    else { return 1 }
    let fit = min(viewport.width / source.width, viewport.height / source.height)
    guard self == .readable else { return 1 }
    // Use the whole viewport in either orientation without stretching the image.
    // Extra image area is deliberately cropped and remains reachable by panning.
    let readable = max(viewport.width / source.width, viewport.height / source.height)
    return min(8, max(1, readable / fit))
  }
}

/// The zoomed view is exactly the video rectangle. UIKit converts each gesture location back
/// into that rectangle before normalization, so letterboxing and zoom never shift a click.
struct PalmRemoteSurface: UIViewRepresentable {
  let displayLayer: AVSampleBufferDisplayLayer
  let videoSize: CGSize
  let enabled: Bool
  let mode: PalmInputMode
  let resetZoomID: Int
  let framing: PalmRemoteFraming
  let reframeID: Int
  let pointer: (String, Double, Double) -> Void
  let scroll: (Double, Double) -> Void
  var cancelSession: () -> Void = {}
  /// While the phone keyboard is up, keep the area around the last tap readable.
  var typing = false
  /// Reports the zoom once it settles, so the Mac can send a sharper stream.
  var zoomChanged: (CGFloat) -> Void = { _ in }
  /// Where the floating controls (and the screen's rounded edges) cover the
  /// picture, in the surface's points.
  var obscured: UIEdgeInsets = .zero
  /// The zoom map's top-right corner, measured in from the surface's right
  /// and top edges (in the corner, not central).
  var mapCorner: CGPoint? = nil
  /// Called with the place a word or a dragged selection was made on the Mac
  /// (so Copy and Paste can appear there), and with nil for other input.
  var selected: (CGPoint?) -> Void = { _ in }
  /// A place to show at a readable size (the Dock, the menu bar), in the Mac
  /// screen's 0...1 coordinates; applied each time `edgeID` changes.
  var edgeFocus: CGPoint? = nil
  var edgeID = 0

  init(
    displayLayer: AVSampleBufferDisplayLayer, videoSize: CGSize, enabled: Bool,
    mode: PalmInputMode, resetZoomID: Int = 0, pointer: @escaping (String, Double, Double) -> Void,
    scroll: @escaping (Double, Double) -> Void, cancelSession: @escaping () -> Void = {},
    framing: PalmRemoteFraming = .fit, reframeID: Int = 0, typing: Bool = false,
    zoomChanged: @escaping (CGFloat) -> Void = { _ in }, obscured: UIEdgeInsets = .zero,
    mapCorner: CGPoint? = nil, selected: @escaping (CGPoint?) -> Void = { _ in },
    edgeFocus: CGPoint? = nil, edgeID: Int = 0
  ) {
    self.edgeFocus = edgeFocus
    self.edgeID = edgeID
    self.obscured = obscured
    self.mapCorner = mapCorner
    self.selected = selected
    self.typing = typing
    self.zoomChanged = zoomChanged
    self.displayLayer = displayLayer
    self.videoSize = videoSize
    self.enabled = enabled
    self.mode = mode
    self.resetZoomID = resetZoomID
    self.framing = framing
    self.reframeID = reframeID
    self.pointer = pointer
    self.scroll = scroll
    self.cancelSession = cancelSession
  }

  func makeUIView(context: Context) -> PalmSurfaceView {
    let view = PalmSurfaceView()
    updateUIView(view, context: context)
    return view
  }

  func updateUIView(_ view: PalmSurfaceView, context: Context) {
    view.configure(
      layer: displayLayer, size: videoSize, enabled: enabled, mode: mode,
      resetZoomID: resetZoomID, framing: framing, reframeID: reframeID,
      pointer: pointer, scroll: scroll, cancelSession: cancelSession, typing: typing,
      zoomChanged: zoomChanged, obscured: obscured, mapCorner: mapCorner, selected: selected)
    view.focusEdge(edgeFocus, id: edgeID)
  }

  static func dismantleUIView(_ view: PalmSurfaceView, coordinator: ()) {
    view.detach()
  }
}

final class PalmSurfaceView: UIView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
  private let viewport = UIScrollView()
  private let content = UIView()
  private let overview = PalmViewportOverview()
  private var videoLayer: AVSampleBufferDisplayLayer?
  private var sourceSize = CGSize(width: 1280, height: 800)
  private var controlEnabled = false
  private var mode = PalmInputMode.touch
  private var resetID = 0
  private var reframeID = 0
  private var framing = PalmRemoteFraming.fit
  private var pendingFraming: PalmRemoteFraming?
  private var edgeID = 0
  private var pendingEdge: CGPoint?

  /// Shows a place on the Mac screen (the Dock, the menu bar) at a readable size.
  func focusEdge(_ point: CGPoint?, id: Int) {
    guard id != edgeID else { return }
    edgeID = id
    pendingEdge = point
    // It is also where typing goes next (Spotlight's box): the keyboard's
    // re-layout keeps it in view instead of the last tap.
    if let point { focus = point }
    setNeedsLayout()
  }
  private var inspectionGestureActive = false
  private var touchScrollActive = false
  private var pointer: ((String, Double, Double) -> Void)?
  private var remoteScroll: ((Double, Double) -> Void)?
  private var cancelSession: (() -> Void)?
  private var dragPoint: CGPoint?
  private var cursor = CGPoint(x: 0.5, y: 0.5)
  private var previousBounds = CGRect.zero
  private var previousTap: (point: CGPoint, time: TimeInterval)?
  private let feedback = CALayer()
  private let cursorView = UIImageView(image: UIImage(systemName: "cursorarrow"))
  private var holdStart: CGPoint?
  private var holdDragging = false
  private var typing = false
  private var focus: CGPoint?  // normalized point of the last tap or cursor
  private var zoomChanged: ((CGFloat) -> Void)?
  private var reportedZoom: CGFloat = 0
  private var obscured = UIEdgeInsets.zero
  private var mapCorner: CGPoint?
  private var selected: ((CGPoint?) -> Void)?
  private lazy var tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
  private lazy var hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
  private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
  private lazy var twoFingerScroll = UIPanGestureRecognizer(
    target: self, action: #selector(panned(_:)))

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    backgroundColor = .black
    viewport.delegate = self
    viewport.minimumZoomScale = 1
    viewport.maximumZoomScale = 4
    viewport.bouncesZoom = true
    viewport.showsVerticalScrollIndicator = false
    viewport.showsHorizontalScrollIndicator = false
    viewport.panGestureRecognizer.minimumNumberOfTouches = 2
    viewport.panGestureRecognizer.maximumNumberOfTouches = 2
    viewport.contentInsetAdjustmentBehavior = .never
    viewport.backgroundColor = .black
    content.backgroundColor = .black
    viewport.addSubview(content)
    addSubview(viewport)
    overview.accessibilityIdentifier = "remote.overview"
    addSubview(overview)
    feedback.zPosition = 10
    layer.addSublayer(feedback)
    // A local pointer drawn on the phone moves instantly, before video catches up.
    cursorView.tintColor = .white
    cursorView.contentMode = .scaleAspectFit
    cursorView.frame.size = CGSize(width: 22, height: 22)
    cursorView.layer.shadowColor = UIColor.black.cgColor
    cursorView.layer.shadowOpacity = 0.9
    cursorView.layer.shadowRadius = 2
    cursorView.layer.shadowOffset = .zero
    cursorView.isHidden = true
    cursorView.isUserInteractionEnabled = false
    addSubview(cursorView)
    hold.minimumPressDuration = 0.45
    hold.allowableMovement = 12
    pan.maximumNumberOfTouches = 1
    twoFingerScroll.minimumNumberOfTouches = 2
    twoFingerScroll.maximumNumberOfTouches = 2
    tap.require(toFail: hold)
    // A first click must not wait through UIKit's double-tap recognition window.
    // A nearby second tap sends only the second Mac click, with clickState 2.
    for gesture in [tap, hold, pan, twoFingerScroll] {
      gesture.delegate = self
      // The whole surface acts as a trackpad, including any letterboxing.
      addGestureRecognizer(gesture)
    }
    content.isAccessibilityElement = true
    content.accessibilityLabel = "Live Mac screen"
    content.accessibilityHint =
      "Pinch to zoom. In Touch or Drag mode, use two fingers to move the enlarged screen."
    content.accessibilityTraits = [.image, .allowsDirectInteraction]
  }

  required init?(coder: NSCoder) { nil }

  func configure(
    layer: AVSampleBufferDisplayLayer, size: CGSize, enabled: Bool, mode: PalmInputMode,
    resetZoomID: Int = 0, framing: PalmRemoteFraming = .fit, reframeID: Int = 0,
    pointer: @escaping (String, Double, Double) -> Void,
    scroll: @escaping (Double, Double) -> Void, cancelSession: @escaping () -> Void = {},
    typing: Bool = false, zoomChanged: @escaping (CGFloat) -> Void = { _ in },
    obscured: UIEdgeInsets = .zero, mapCorner: CGPoint? = nil, selected: @escaping (CGPoint?) -> Void = { _ in }
  ) {
    self.zoomChanged = zoomChanged
    self.selected = selected
    if self.obscured != obscured || self.mapCorner != mapCorner {
      self.obscured = obscured
      self.mapCorner = mapCorner
      setNeedsLayout()
    }
    if self.typing != typing {
      self.typing = typing
      previousBounds = .zero
      setNeedsLayout()
    }
    if self.mode != mode {
      finishDrag()
      touchScrollActive = false
      previousTap = nil
    }
    if !enabled {
      touchScrollActive = false
      previousTap = nil
    }
    if !enabled && dragPoint != nil {
      dragPoint = nil
      self.cancelSession?()
    }
    if videoLayer !== layer {
      previousTap = nil
      if videoLayer?.superlayer === content.layer { videoLayer?.removeFromSuperlayer() }
      videoLayer = layer
      layer.videoGravity = .resizeAspect
    }
    if layer.superlayer !== content.layer {
      content.layer.addSublayer(layer)
      previousBounds = .zero
      setNeedsLayout()
    }
    let validSize =
      size.width.isFinite && size.height.isFinite && size.width > 0 && size.height > 0
      ? size : CGSize(width: 1280, height: 800)
    if validSize != sourceSize {
      // A sharper stream of the same shape (zoom quality) keeps the zoom and
      // position; only a different shape starts the framing again.
      let reshaped = abs(validSize.width / validSize.height - sourceSize.width / sourceSize.height) > 0.01
      sourceSize = validSize
      if reshaped {
        previousBounds = .zero
        setNeedsLayout()
      }
    }
    controlEnabled = enabled
    self.mode = mode
    self.pointer = pointer
    remoteScroll = scroll
    self.cancelSession = cancelSession
    tap.isEnabled = enabled
    hold.isEnabled = enabled
    pan.isEnabled = enabled
    twoFingerScroll.isEnabled = enabled && mode == .trackpad
    viewport.panGestureRecognizer.isEnabled = mode != .trackpad
    cursorView.isHidden = mode != .trackpad
    content.accessibilityHint =
      mode == .trackpad
      ? "Mouse: slide one finger to move the pointer, tap to click, two fingers to scroll. Hold, then move, to drag."
      : "Touch: tap to click, drag to scroll, hold to right-click, hold then move to drag. Pinch to zoom."
    if framing != self.framing || reframeID != self.reframeID {
      self.framing = framing
      self.reframeID = reframeID
      pendingFraming = framing
      setNeedsLayout()
    }
    if resetZoomID != resetID {
      resetID = resetZoomID
      pendingFraming = .fit
      setNeedsLayout()
    }
    updateOverview()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard bounds.width > 0, bounds.height > 0 else { return }
    viewport.frame = bounds
    if bounds != previousBounds || pendingFraming != nil {
      finishDrag()
      touchScrollActive = false
      previousTap = nil
      previousBounds = bounds
      viewport.setZoomScale(1, animated: false)
      let ratio = min(bounds.width / sourceSize.width, bounds.height / sourceSize.height)
      content.bounds = CGRect(
        origin: .zero,
        size: CGSize(width: sourceSize.width * ratio, height: sourceSize.height * ratio))
      content.frame.origin = .zero
      viewport.contentSize = content.bounds.size
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      if videoLayer?.superlayer === content.layer { videoLayer?.frame = content.bounds }
      CATransaction.commit()
      let desired = pendingFraming ?? framing
      pendingFraming = nil
      let zoom = desired.zoomScale(source: sourceSize, viewport: bounds.size)
      viewport.maximumZoomScale = max(
        4,
        min(16, PalmRemoteFraming.readable.zoomScale(source: sourceSize, viewport: bounds.size) * 2)
      )
      if typing, let focus {
        // Keyboard up: zoom until the source fills the width, at least 1.6x,
        // and centre the last tap so the field being typed into stays visible.
        let fill = PalmRemoteFraming.readable.zoomScale(source: sourceSize, viewport: bounds.size)
        let typingZoom = min(viewport.maximumZoomScale, max(zoom, fill, 1.6))
        viewport.setZoomScale(typingZoom, animated: false)
        centerContent()
        viewport.contentOffset = offset(showing: focus, zoom: typingZoom)
      } else {
        viewport.setZoomScale(zoom, animated: false)
        centerContent()
        viewport.contentOffset = CGPoint(
          x: max(-viewport.contentInset.left, (content.bounds.width * zoom - bounds.width) / 2),
          y: max(-viewport.contentInset.top, (content.bounds.height * zoom - bounds.height) / 2))
      }
    }
    if let edge = pendingEdge {
      pendingEdge = nil
      // The Mac screen at least as wide as the phone's view, scrolled to that edge.
      let fill = PalmRemoteFraming.readable.zoomScale(source: sourceSize, viewport: bounds.size)
      let zoom = min(viewport.maximumZoomScale, max(fill, 1))
      viewport.setZoomScale(zoom, animated: false)
      centerContent()
      viewport.contentOffset = offset(showing: edge, zoom: zoom)
    }
    centerContent()
    reportZoom()
    // The top corner of the space the floating controls leave free: below the
    // top bar in portrait, beside the rail in landscape.
    if let corner = mapCorner {
      overview.frame = CGRect(x: bounds.maxX - corner.x - 100, y: bounds.minY + corner.y, width: 100, height: 66)
    } else {
      let free = freeArea
      overview.frame = CGRect(x: free.maxX - 108, y: free.minY + 8, width: 100, height: 66)
    }
    updateOverview()
    positionCursor()
  }

  /// The Mac image's size on the phone right now, in points, including zoom.
  private var shownContentSize: CGSize {
    CGSize(
      width: max(1, content.bounds.width * viewport.zoomScale),
      height: max(1, content.bounds.height * viewport.zoomScale))
  }

  /// Where to scroll so a place on the Mac screen (0...1) is in the space the
  /// controls leave free: an edge against that side of it (the Dock just
  /// above the controls, the menu bar and Spotlight just below the top bar),
  /// anything else in its middle.
  private func offset(showing point: CGPoint, zoom: CGFloat) -> CGPoint {
    let visible = freeArea
    let width = content.bounds.width * zoom
    let height = content.bounds.height * zoom
    return clampedOffset(CGPoint(
      x: point.x <= 0.01 ? -visible.minX : point.x >= 0.99 ? width - visible.maxX : point.x * width - visible.midX,
      y: point.y <= 0.01 ? -visible.minY : point.y >= 0.99 ? height - visible.maxY : point.y * height - visible.midY))
  }

  private func clampedOffset(_ offset: CGPoint) -> CGPoint {
    let insets = viewport.contentInset
    return CGPoint(
      x: min(max(-insets.left, viewport.contentSize.width - bounds.width + insets.right),
        max(-insets.left, offset.x)),
      y: min(max(-insets.top, viewport.contentSize.height - bounds.height + insets.bottom),
        max(-insets.top, offset.y)))
  }

  private func positionCursor() {
    guard mode == .trackpad else { return }
    let point = content.convert(
      CGPoint(x: cursor.x * content.bounds.width, y: cursor.y * content.bounds.height), to: self)
    // The arrow's hotspot is its top-left tip.
    cursorView.frame.origin = CGPoint(x: point.x - 5, y: point.y - 3)
  }

  /// A brief ring where input landed, so every tap is visibly acknowledged.
  func showFeedback(at point: CGPoint, color: UIColor = .white) {
    let ring = CAShapeLayer()
    let radius: CGFloat = 18
    ring.path = UIBezierPath(ovalIn: CGRect(x: -radius, y: -radius, width: radius * 2, height: radius * 2)).cgPath
    ring.position = point
    ring.fillColor = color.withAlphaComponent(0.18).cgColor
    ring.strokeColor = color.withAlphaComponent(0.9).cgColor
    ring.lineWidth = 2
    feedback.addSublayer(ring)
    let scale = CABasicAnimation(keyPath: "transform.scale")
    scale.fromValue = 0.5
    scale.toValue = 1.35
    let fade = CABasicAnimation(keyPath: "opacity")
    fade.fromValue = 1
    fade.toValue = 0
    let group = CAAnimationGroup()
    group.animations = [scale, fade]
    group.duration = 0.38
    group.timingFunction = CAMediaTimingFunction(name: .easeOut)
    ring.opacity = 0
    CATransaction.begin()
    CATransaction.setCompletionBlock { ring.removeFromSuperlayer() }
    ring.add(group, forKey: "tap")
    CATransaction.commit()
  }

  func detach() {
    touchScrollActive = false
    previousTap = nil
    if dragPoint != nil {
      dragPoint = nil
      cancelSession?()
    }
    pointer = nil
    remoteScroll = nil
    cancelSession = nil
    if videoLayer?.superlayer === content.layer { videoLayer?.removeFromSuperlayer() }
    videoLayer = nil
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { content }

  func scrollViewWillBeginZooming(_ scrollView: UIScrollView, with view: UIView?) {
    finishDrag()
    touchScrollActive = false
    previousTap = nil
    inspectionGestureActive = true
  }

  func scrollViewDidEndZooming(
    _ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat
  ) {
    inspectionGestureActive = false
    updateOverview()
    reportZoom()
  }

  private func reportZoom() {
    let zoom = viewport.zoomScale
    guard zoom.isFinite, abs(zoom - reportedZoom) > 0.05 else { return }
    reportedZoom = zoom
    zoomChanged?(zoom)
  }

  func scrollViewDidZoom(_ scrollView: UIScrollView) {
    centerContent()
    updateOverview()
    positionCursor()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) {
    updateOverview()
    positionCursor()
  }

  var visibleNormalizedRect: CGRect {
    guard content.bounds.width > 0, content.bounds.height > 0 else { return .zero }
    let visible = content.convert(bounds, from: self).intersection(content.bounds)
    guard !visible.isNull else { return .zero }
    return CGRect(
      x: visible.minX / content.bounds.width, y: visible.minY / content.bounds.height,
      width: visible.width / content.bounds.width, height: visible.height / content.bounds.height)
  }

  private func updateOverview() {
    let rect = visibleNormalizedRect
    overview.isHidden = rect.isEmpty || (rect.width >= 0.995 && rect.height >= 0.995)
    overview.sourceSize = sourceSize
    overview.visibleRect = rect
    overview.cursor = mode == .trackpad ? cursor : nil
    overview.setNeedsDisplay()
  }

  /// Centres the picture when it is smaller than the screen. Zoomed in, the
  /// picture can also be moved past its edges (up to 45% of the screen), so a
  /// corner of the Mac can be brought to the middle of the phone.
  /// The part of the surface no floating control covers.
  private var freeArea: CGRect {
    let free = bounds.inset(by: obscured)
    return free.width > 120 && free.height > 120 ? free : bounds
  }

  private func centerContent() {
    let width = content.bounds.width * viewport.zoomScale
    let height = content.bounds.height * viewport.zoomScale
    let free = freeArea
    // A picture that fits beside the floating controls is centred in the
    // space they leave; a larger one is centred on the whole surface.
    func pads(_ size: CGFloat, _ total: CGFloat, _ start: CGFloat, _ end: CGFloat) -> (CGFloat, CGFloat) {
      let open = end - start
      if size <= open + 0.5 {
        let lead = start + (open - size) / 2
        return (lead, max(0, total - size - lead))
      }
      let pad = max(0, (total - size) / 2)
      return (pad, pad)
    }
    var (left, right) = pads(width, bounds.width, free.minX, free.maxX)
    var (top, bottom) = pads(height, bounds.height, free.minY, free.maxY)
    if viewport.zoomScale > 1.01 {
      // Zoomed in, any corner can still be dragged to the middle.
      left = max(left, bounds.width * 0.45)
      right = max(right, bounds.width * 0.45)
      top = max(top, bounds.height * 0.45)
      bottom = max(bottom, bounds.height * 0.45)
    }
    viewport.contentInset = UIEdgeInsets(top: top, left: left, bottom: bottom, right: right)
  }

  private func normalized(_ point: CGPoint) -> CGPoint? {
    guard point.x.isFinite, point.y.isFinite,
      content.bounds.width > 0, content.bounds.height > 0,
      point.x >= 0, point.y >= 0,
      point.x <= content.bounds.width, point.y <= content.bounds.height
    else { return nil }
    return CGPoint(x: point.x / content.bounds.width, y: point.y / content.bounds.height)
  }

  /// Accepts a point in the visible surface, including letterboxing, zoom and scroll offset.
  func normalizedPoint(at point: CGPoint) -> CGPoint? {
    normalized(content.convert(point, from: self))
  }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    guard controlEnabled, gesture.state == .ended else { return }
    tapInput(at: gesture.location(in: self), time: ProcessInfo.processInfo.systemUptime)
  }

  /// Dispatches the first click synchronously; no timer or deferred input is retained.
  func tapInput(at point: CGPoint, time: TimeInterval) {
    guard controlEnabled, !inspectionGestureActive, time.isFinite,
      point.x.isFinite, point.y.isFinite,
      let location = mode == .trackpad ? cursor : normalizedPoint(at: point)
    else {
      previousTap = nil
      return
    }
    let second =
      previousTap.map {
        let elapsed = time - $0.time
        // As forgiving as iOS's own double-tap: a relaxed second tap still
        // selects the word on the Mac.
        return elapsed >= 0 && elapsed <= 0.45
          && hypot(point.x - $0.point.x, point.y - $0.point.y) <= 32
      } ?? false
    previousTap = second ? nil : (point, time)
    focus = location
    pointer?(second ? "doubleSecond" : "click", location.x, location.y)
    let shown = mode == .trackpad ? cursorView.frame.origin.applying(CGAffineTransform(translationX: 5, y: 3)) : point
    showFeedback(at: shown)
    selected?(second ? shown : nil)
  }

  /// Hold still, then lift: right-click. Hold, then move: drag (select text,
  /// move a window). In Mouse mode both act at the pointer.
  @objc private func held(_ gesture: UILongPressGestureRecognizer) {
    guard controlEnabled else { return }
    let point = gesture.location(in: self)
    switch gesture.state {
    case .began:
      previousTap = nil
      holdStart = point
      holdDragging = false
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
    case .changed:
      guard let start = holdStart else { return }
      if !holdDragging, hypot(point.x - start.x, point.y - start.y) > 8 {
        holdDragging = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        if mode == .trackpad {
          dragPoint = cursor
          pointer?("down", Double(cursor.x), Double(cursor.y))
        } else if let normalized = normalizedPoint(at: start) {
          dragPoint = normalized
          pointer?("down", normalized.x, normalized.y)
        }
      }
      if holdDragging {
        if mode == .trackpad {
          let shown = shownContentSize
          cursor.x = min(1, max(0, cursor.x + (point.x - start.x) / shown.width))
          cursor.y = min(1, max(0, cursor.y + (point.y - start.y) / shown.height))
          holdStart = point
          dragPoint = cursor
          pointer?("move", Double(cursor.x), Double(cursor.y))
          positionCursor()
        } else {
          moveDragPoint(to: point)
        }
      }
    case .ended:
      if holdDragging {
        finishDrag()
        // Dragging usually selects text: offer Copy where the finger lifted.
        selected?(mode == .trackpad ? cursorView.frame.origin : point)
      } else if let start = holdStart {
        activatePointer(at: start, action: "right")
        showFeedback(at: mode == .trackpad ? cursorView.frame.origin : start, color: UIColor(PalmStyle.accent))
      }
      holdStart = nil
      holdDragging = false
    default:
      if holdDragging { finishDrag() }
      holdStart = nil
      holdDragging = false
    }
  }

  private func moveDragPoint(to point: CGPoint) {
    let local = content.convert(point, from: self)
    guard dragPoint != nil, local.x.isFinite, local.y.isFinite, content.bounds.width > 0, content.bounds.height > 0
    else { return }
    let normalized = CGPoint(
      x: min(1, max(0, local.x / content.bounds.width)),
      y: min(1, max(0, local.y / content.bounds.height)))
    dragPoint = normalized
    pointer?("move", normalized.x, normalized.y)
  }

  func activatePointer(at point: CGPoint, action: String) {
    guard controlEnabled, !inspectionGestureActive, ["click", "double", "right"].contains(action)
    else { return }
    let location = mode == .trackpad ? cursor : normalizedPoint(at: point)
    guard let location else { return }
    pointer?(action, location.x, location.y)
  }

  func beginDrag(at point: CGPoint) {
    guard controlEnabled, !inspectionGestureActive, mode == .drag, dragPoint == nil,
      let normalized = normalizedPoint(at: point)
    else { return }
    previousTap = nil
    dragPoint = normalized
    pointer?("down", normalized.x, normalized.y)
  }

  func moveDrag(to point: CGPoint) {
    guard controlEnabled, mode == .drag, dragPoint != nil else { return }
    let local = content.convert(point, from: self)
    guard local.x.isFinite, local.y.isFinite, content.bounds.width > 0, content.bounds.height > 0
    else { return }
    let normalized = CGPoint(
      x: min(1, max(0, local.x / content.bounds.width)),
      y: min(1, max(0, local.y / content.bounds.height)))
    dragPoint = normalized
    pointer?("move", normalized.x, normalized.y)
  }

  func finishDrag() {
    guard let point = dragPoint else { return }
    dragPoint = nil
    if controlEnabled { pointer?("up", point.x, point.y) } else { cancelSession?() }
  }

  @objc private func panned(_ gesture: UIPanGestureRecognizer) {
    let delta = gesture.translation(in: self)
    gesture.setTranslation(.zero, in: self)
    panInput(
      delta: delta, at: gesture.location(in: self), touches: gesture.numberOfTouches,
      state: gesture.state)
  }

  /// Shared by recognizers and fixture tests; all gesture routes pass through the same gate.
  func panInput(delta: CGPoint, at point: CGPoint, touches: Int, state: UIGestureRecognizer.State) {
    if state == .began {
      previousTap = nil
      selected?(nil)
    }
    if state == .ended || state == .cancelled || state == .failed {
      touchScrollActive = false
      finishDrag()
      return
    }
    let pinchState = viewport.pinchGestureRecognizer?.state
    guard controlEnabled, !inspectionGestureActive, pinchState != .began, pinchState != .changed,
      delta.x.isFinite, delta.y.isFinite,
      touches == 1 || (mode == .trackpad && touches == 2)
    else {
      touchScrollActive = false
      finishDrag()
      return
    }
    if mode == .drag {
      if state == .began {
        beginDrag(at: CGPoint(x: point.x - delta.x, y: point.y - delta.y))
      } else if state == .changed {
        moveDrag(to: point)
      }
      return
    }
    if mode == .touch, state == .began {
      touchScrollActive = false
      // Pan recognition begins after a movement threshold. Validate the actual
      // start, not a finger that has already crossed from a letterbox into video.
      guard let start = normalizedPoint(at: CGPoint(x: point.x - delta.x, y: point.y - delta.y))
      else { return }
      touchScrollActive = true
      pointer?("move", start.x, start.y)
    }
    guard state == .changed || (mode == .trackpad && state == .began) else { return }
    if mode == .touch && !touchScrollActive { return }
    if mode == .touch || touches == 2 {
      remoteScroll?(Double(delta.x), Double(delta.y))
    } else {
      // Pointer acceleration: slow finger movement is precise, a flick
      // crosses the screen. Distance is measured against the visible width.
      let speed = hypot(delta.x, delta.y)
      let gain = min(3.2, 1 + speed / 16)
      let shown = shownContentSize
      cursor.x = min(1, max(0, cursor.x + delta.x * gain / shown.width))
      cursor.y = min(1, max(0, cursor.y + delta.y * gain / shown.height))
      focus = cursor
      pointer?("move", Double(cursor.x), Double(cursor.y))
      positionCursor()
      revealCursor()
    }
  }

  private func revealCursor() {
    let point = content.convert(
      CGPoint(x: cursor.x * content.bounds.width, y: cursor.y * content.bounds.height), to: self)
    let margin = min(36, min(bounds.width, bounds.height) / 4)
    let safe = bounds.insetBy(dx: margin, dy: margin)
    var offset = viewport.contentOffset
    offset.x += point.x - min(safe.maxX, max(safe.minX, point.x))
    offset.y += point.y - min(safe.maxY, max(safe.minY, point.y))
    viewport.setContentOffset(clampedOffset(offset), animated: false)
    updateOverview()
    positionCursor()
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    // Permit the trackpad's two-finger recognizer to yield to a pinch mid-gesture.
    // panInput suppresses remote effects for the entire active pinch.
    let pinch = viewport.pinchGestureRecognizer
    return (gestureRecognizer === twoFingerScroll && otherGestureRecognizer === pinch)
      || (otherGestureRecognizer === twoFingerScroll && gestureRecognizer === pinch)
  }
}

private final class PalmViewportOverview: UIView {
  var sourceSize = CGSize(width: 1280, height: 800)
  var visibleRect = CGRect(x: 0, y: 0, width: 1, height: 1)
  var cursor: CGPoint?

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor.black.withAlphaComponent(0.65)
    layer.cornerRadius = 8
    isUserInteractionEnabled = false
    isAccessibilityElement = true
    accessibilityLabel = "Zoom map"
    accessibilityTraits = .image
  }

  required init?(coder: NSCoder) { nil }

  override func draw(_ rect: CGRect) {
    guard sourceSize.width > 0, sourceSize.height > 0 else { return }
    let available = bounds.insetBy(dx: 7, dy: 7)
    let scale = min(available.width / sourceSize.width, available.height / sourceSize.height)
    let size = CGSize(width: sourceSize.width * scale, height: sourceSize.height * scale)
    let desktop = CGRect(
      x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width,
      height: size.height)
    UIColor.white.withAlphaComponent(0.45).setStroke()
    UIBezierPath(rect: desktop).stroke()
    let visible = CGRect(
      x: desktop.minX + visibleRect.minX * desktop.width,
      y: desktop.minY + visibleRect.minY * desktop.height,
      width: visibleRect.width * desktop.width, height: visibleRect.height * desktop.height)
    UIColor(PalmStyle.accent).withAlphaComponent(0.22).setFill()
    UIColor(PalmStyle.accent).setStroke()
    let path = UIBezierPath(rect: visible)
    path.fill()
    path.stroke()
    if let cursor {
      UIColor.white.setFill()
      UIBezierPath(
        ovalIn: CGRect(
          x: desktop.minX + cursor.x * desktop.width - 2,
          y: desktop.minY + cursor.y * desktop.height - 2, width: 4, height: 4)
      ).fill()
    }
  }
}

struct PalmTrackpad: UIViewRepresentable {
  let enabled: Bool
  let pointer: (String, Double, Double) -> Void
  let scroll: (Double, Double) -> Void

  func makeUIView(context: Context) -> PalmTrackpadView { PalmTrackpadView() }

  func updateUIView(_ view: PalmTrackpadView, context: Context) {
    view.isUserInteractionEnabled = enabled
    view.pointer = pointer
    view.remoteScroll = scroll
  }
}

final class PalmTrackpadView: UIView, UIGestureRecognizerDelegate {
  var pointer: ((String, Double, Double) -> Void)?
  var remoteScroll: ((Double, Double) -> Void)?
  private var cursor = CGPoint(x: 0.5, y: 0.5)
  private let cursorDot = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor(PalmStyle.raised)
    layer.cornerRadius = 18
    let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
    doubleTap.numberOfTapsRequired = 2
    let hold = UILongPressGestureRecognizer(target: self, action: #selector(held(_:)))
    let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
    tap.require(toFail: hold)
    tap.require(toFail: doubleTap)
    pan.maximumNumberOfTouches = 2
    for gesture in [tap, doubleTap, hold, pan] { addGestureRecognizer(gesture) }
    cursorDot.backgroundColor = UIColor(PalmStyle.accent)
    cursorDot.layer.cornerRadius = 4
    cursorDot.frame.size = CGSize(width: 8, height: 8)
    addSubview(cursorDot)
    isAccessibilityElement = true
    accessibilityLabel = "Remote trackpad"
    accessibilityHint =
      "One finger moves the Mac pointer. Tap to click. Hold to right-click. Two fingers scroll."
    accessibilityTraits = [.allowsDirectInteraction]
  }

  required init?(coder: NSCoder) { nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    cursorDot.center = CGPoint(x: bounds.width * cursor.x, y: bounds.height * cursor.y)
  }

  @objc private func tapped() { pointer?("click", cursor.x, cursor.y) }
  @objc private func doubleTapped() { pointer?("double", cursor.x, cursor.y) }

  @objc private func held(_ gesture: UILongPressGestureRecognizer) {
    if gesture.state == .began { pointer?("right", cursor.x, cursor.y) }
  }

  @objc private func panned(_ gesture: UIPanGestureRecognizer) {
    let delta = gesture.translation(in: self)
    gesture.setTranslation(.zero, in: self)
    guard gesture.state == .changed else { return }
    if gesture.numberOfTouches == 2 {
      remoteScroll?(delta.x, delta.y)
    } else if gesture.numberOfTouches == 1 {
      cursor.x = min(1, max(0, cursor.x + delta.x / 600))
      cursor.y = min(1, max(0, cursor.y + delta.y / 600))
      pointer?("move", cursor.x, cursor.y)
      setNeedsLayout()
    }
  }
}
