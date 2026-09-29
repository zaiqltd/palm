import AVFoundation
import XCTest

@testable import Palm

@MainActor
final class PalmViewportTests: XCTestCase {
  private let source = CGSize(width: 1600, height: 900)

  func testReadableDesktopFillsPortraitHeightAndKeepsCenterMapping() throws {
    let (surface, _) = makeSurface(framing: .readable)
    let scroll = try scrollView(surface)
    XCTAssertGreaterThan(scroll.zoomScale, 3)
    let visible = surface.visibleNormalizedRect
    XCTAssertEqual(visible.height, 1, accuracy: 0.003)
    XCTAssertLessThan(visible.width, 0.35)
    XCTAssertEqual(visible.midX, 0.5, accuracy: 0.003)
    let center = try XCTUnwrap(surface.normalizedPoint(at: CGPoint(x: 195, y: 370)))
    XCTAssertEqual(center.x, 0.5, accuracy: 0.003)
    XCTAssertEqual(center.y, 0.5, accuracy: 0.003)
    XCTAssertFalse(
      try overview(surface).isUserInteractionEnabled,
      "The overview must never swallow remote input.")
    XCTAssertFalse(try overview(surface).isHidden)
  }

  func testFitDefaultStillShowsWholeDesktopAndRejectsLetterboxTaps() throws {
    let (surface, _) = makeSurface()
    XCTAssertEqual(try scrollView(surface).zoomScale, 1)
    XCTAssertEqual(surface.visibleNormalizedRect.width, 1, accuracy: 0.003)
    XCTAssertEqual(surface.visibleNormalizedRect.height, 1, accuracy: 0.003)
    XCTAssertNil(surface.normalizedPoint(at: CGPoint(x: 195, y: 2)))
    XCTAssertTrue(try overview(surface).isHidden)
  }

  func testReadableLandscapeFillsViewportWithoutStretchingOrLetterboxes() throws {
    let (surface, _) = makeSurface(framing: .readable)
    surface.frame = CGRect(x: 0, y: 0, width: 844, height: 330)
    surface.setNeedsLayout()
    surface.layoutIfNeeded()
    let scroll = try scrollView(surface)
    let content = try XCTUnwrap(scroll.subviews.first)
    let pixelScale = content.bounds.width * scroll.zoomScale / source.width
    XCTAssertEqual(pixelScale, 844.0 / 1600, accuracy: 0.003)
    XCTAssertGreaterThan(scroll.zoomScale, 1)
    XCTAssertLessThan(scroll.zoomScale, 2)
    let middle = try XCTUnwrap(surface.normalizedPoint(at: CGPoint(x: 422, y: 165)))
    XCTAssertEqual(middle.x, 0.5, accuracy: 0.003)
    XCTAssertEqual(middle.y, 0.5, accuracy: 0.003)
    XCTAssertNotNil(surface.normalizedPoint(at: CGPoint(x: 1, y: 1)))
    XCTAssertNotNil(surface.normalizedPoint(at: CGPoint(x: 843, y: 329)))
  }

  func testReadablePortraitSourceFillsLandscapeAndFitStillOffersWholeWindow() throws {
    let (surface, layer) = makeSurface(framing: .readable)
    surface.frame = CGRect(x: 0, y: 0, width: 844, height: 330)
    surface.configure(
      layer: layer, size: CGSize(width: 460, height: 800), enabled: true,
      mode: .touch, framing: .readable, pointer: { _, _, _ in }, scroll: { _, _ in })
    surface.layoutIfNeeded()
    let shown = layer.convert(layer.bounds, to: surface.layer)
    XCTAssertEqual(shown.intersection(surface.bounds).width, 844, accuracy: 0.01)
    XCTAssertEqual(shown.intersection(surface.bounds).height, 330, accuracy: 0.01)
    XCTAssertEqual(shown.width / 460, shown.height / 800, accuracy: 0.001)
    XCTAssertLessThan(surface.visibleNormalizedRect.height, 0.3)
    surface.configure(
      layer: layer, size: CGSize(width: 460, height: 800), enabled: true,
      mode: .touch, framing: .fit, pointer: { _, _, _ in }, scroll: { _, _ in })
    surface.layoutIfNeeded()
    XCTAssertEqual(surface.visibleNormalizedRect.height, 1, accuracy: 0.001)
    XCTAssertEqual(surface.visibleNormalizedRect.width, 1, accuracy: 0.001)
    XCTAssertNil(surface.normalizedPoint(at: CGPoint(x: 1, y: 165)))
  }

  func testFirstTapDispatchesImmediatelyAndSecondTapAddsExactlyOneClick() throws {
    let (surface, layer) = makeSurface()
    var events: [String] = []
    surface.configure(
      layer: layer, size: source, enabled: true, mode: .touch,
      pointer: { action, _, _ in events.append(action) }, scroll: { _, _ in })
    let point = CGPoint(x: 195, y: 370)
    surface.tapInput(at: point, time: 10)
    XCTAssertEqual(
      events, ["click"], "First click must be delivered in this call, without a double-tap timer.")
    surface.tapInput(at: point, time: 10.2)
    XCTAssertEqual(
      events, ["click", "doubleSecond"], "Second tap must not emit a full two-click command.")
    surface.tapInput(at: point, time: 10.3)
    XCTAssertEqual(events, ["click", "doubleSecond", "click"])
    let recognizers = try XCTUnwrap(
      surface.gestureRecognizers?.compactMap { $0 as? UITapGestureRecognizer })
    XCTAssertEqual(
      recognizers.count, 1,
      "A two-tap recognizer would reintroduce the first-click failure dependency.")
    XCTAssertEqual(recognizers.first?.numberOfTapsRequired, 1)
  }

  func testDoubleClickSequenceRejectsDistantLateAndInvalidTaps() {
    let (surface, layer) = makeSurface()
    var events: [String] = []
    surface.configure(
      layer: layer, size: source, enabled: true, mode: .touch,
      pointer: { action, _, _ in events.append(action) }, scroll: { _, _ in })
    let center = CGPoint(x: 195, y: 370)
    surface.tapInput(at: center, time: 10)
    surface.tapInput(at: center, time: 10.46)  // Later than a relaxed double tap (0.45 s).
    surface.tapInput(at: CGPoint(x: 240, y: 370), time: 10.5)  // 45 points away.
    surface.tapInput(at: CGPoint(x: 240, y: 10), time: 10.6)  // Letterbox also ends the sequence.
    surface.tapInput(at: CGPoint(x: 240, y: 370), time: 10.7)
    XCTAssertEqual(events, ["click", "click", "click", "click"])
    // A relaxed double tap, 0.4 s and 25 points apart, still double-clicks
    // (selecting a word must be simple).
    events = []
    surface.tapInput(at: center, time: 20)
    surface.tapInput(at: CGPoint(x: 220, y: 370), time: 20.4)
    XCTAssertEqual(events, ["click", "doubleSecond"])
  }

  func testDoubleClickSequenceCannotCrossInactiveSessionOrViewportChange() {
    let (surface, layer) = makeSurface()
    var events: [String] = []
    func configure(enabled: Bool = true, reframe: Int = 0) {
      surface.configure(
        layer: layer, size: source, enabled: enabled, mode: .trackpad,
        reframeID: reframe, pointer: { action, _, _ in events.append(action) }, scroll: { _, _ in })
      surface.layoutIfNeeded()
    }
    configure()
    surface.tapInput(at: .zero, time: 10)
    configure(enabled: false)
    surface.tapInput(at: .zero, time: 10.1)
    configure()
    surface.tapInput(at: .zero, time: 10.2)
    configure(reframe: 1)
    surface.tapInput(at: .zero, time: 10.3)
    surface.panInput(delta: CGPoint(x: 1, y: 1), at: .zero, touches: 1, state: .began)
    surface.tapInput(at: .zero, time: 10.4)
    XCTAssertEqual(events, ["click", "click", "click", "move", "click"])
  }

  func testConfigChangeToPortraitWindowReframesAndPreservesExactMapping() throws {
    let (surface, layer) = makeSurface(framing: .readable)
    surface.configure(
      layer: layer, size: CGSize(width: 390, height: 740), enabled: true,
      mode: .touch, framing: .fit, pointer: { _, _, _ in }, scroll: { _, _ in })
    surface.layoutIfNeeded()
    XCTAssertEqual(try scrollView(surface).zoomScale, 1)
    let corner = try XCTUnwrap(surface.normalizedPoint(at: CGPoint(x: 39, y: 74)))
    XCTAssertEqual(corner.x, 0.1, accuracy: 0.003)
    XCTAssertEqual(corner.y, 0.1, accuracy: 0.003)
    XCTAssertEqual(surface.visibleNormalizedRect, CGRect(x: 0, y: 0, width: 1, height: 1))
  }

  func testRoutineConfigurePreservesUserViewportAndResetThenReframeAreDistinct() throws {
    let (surface, layer) = makeSurface(framing: .readable)
    let scroll = try scrollView(surface)
    scroll.setZoomScale(4, animated: false)
    scroll.contentOffset = CGPoint(x: 130, y: 40)
    func configure(reset: Int = 0, reframe: Int = 0) {
      surface.configure(
        layer: layer, size: source, enabled: true, mode: .touch,
        resetZoomID: reset, framing: .readable, reframeID: reframe,
        pointer: { _, _, _ in }, scroll: { _, _ in })
      surface.layoutIfNeeded()
    }
    configure()
    XCTAssertEqual(scroll.zoomScale, 4)
    XCTAssertEqual(scroll.contentOffset, CGPoint(x: 130, y: 40))
    configure(reset: 1)
    XCTAssertEqual(scroll.zoomScale, 1)
    XCTAssertEqual(surface.visibleNormalizedRect.width, 1, accuracy: 0.003)
    configure(reset: 1, reframe: 1)
    XCTAssertGreaterThan(scroll.zoomScale, 3)
    XCTAssertEqual(surface.visibleNormalizedRect.midX, 0.5, accuracy: 0.003)
  }

  func testFullSurfaceTrackpadRoutesMovementClickAndTwoFingerScroll() throws {
    let (surface, layer) = makeSurface()
    var pointers: [(String, Double, Double)] = []
    var scrolls: [CGPoint] = []
    surface.configure(
      layer: layer, size: source, enabled: true, mode: .trackpad,
      pointer: { pointers.append(($0, $1, $2)) }, scroll: { scrolls.append(CGPoint(x: $0, y: $1)) })
    let scroll = try scrollView(surface)
    let offset = scroll.contentOffset
    XCTAssertFalse(scroll.panGestureRecognizer.isEnabled)
    let location = CGPoint(x: 10, y: 10)  // Outside the fitted video, inside the trackpad.
    XCTAssertNil(surface.normalizedPoint(at: location))
    // A slow movement: the pointer moves by the finger's distance across the
    // shown picture, times a small acceleration (1 + speed / 16).
    surface.panInput(delta: CGPoint(x: 6, y: -3), at: location, touches: 1, state: .changed)
    surface.panInput(delta: CGPoint(x: 12, y: 24), at: location, touches: 2, state: .changed)
    surface.activatePointer(at: location, action: "click")
    XCTAssertEqual(pointers.map(\.0), ["move", "click"])
    let gain = 1 + hypot(6.0, 3.0) / 16
    let shown = CGSize(width: 390, height: 390 * 900 / 1600)
    XCTAssertEqual(pointers[1].1, 0.5 + 6 * gain / shown.width, accuracy: 0.001)
    XCTAssertEqual(pointers[1].2, 0.5 - 3 * gain / shown.height, accuracy: 0.001)
    XCTAssertEqual(scrolls, [CGPoint(x: 12, y: 24)])
    XCTAssertEqual(scroll.contentOffset, offset, "Remote scrolling must not pan the viewport.")
    let twoFinger = try XCTUnwrap(
      surface.gestureRecognizers?.compactMap { $0 as? UIPanGestureRecognizer }
        .first { $0.minimumNumberOfTouches == 2 })
    XCTAssertTrue(twoFinger.isEnabled)
  }

  func testTrackpadAutoFollowMakesEveryCroppedCornerReachable() throws {
    let (surface, layer) = makeSurface(framing: .readable)
    var clicks: [CGPoint] = []
    surface.configure(
      layer: layer, size: source, enabled: true, mode: .trackpad, framing: .readable,
      pointer: { if $0 == "click" { clicks.append(CGPoint(x: $1, y: $2)) } }, scroll: { _, _ in })
    for target in [
      CGPoint(x: 1, y: 1), CGPoint(x: 0, y: 1), CGPoint(x: 0, y: 0), CGPoint(x: 1, y: 0),
    ] {
      surface.panInput(
        delta: CGPoint(
          x: target.x == 0 ? -1200 : 1200,
          y: target.y == 0 ? -1200 : 1200), at: .zero, touches: 1, state: .changed)
      surface.activatePointer(at: .zero, action: "click")
      let visible = surface.visibleNormalizedRect
      XCTAssertLessThanOrEqual(visible.minX, target.x + 0.003)
      XCTAssertGreaterThanOrEqual(visible.maxX, target.x - 0.003)
      XCTAssertLessThanOrEqual(visible.minY, target.y + 0.003)
      XCTAssertGreaterThanOrEqual(visible.maxY, target.y - 0.003)
      XCTAssertEqual(clicks.last, target)
    }
  }

  func testTouchScrollRejectsLetterboxStartEvenAfterFingerEntersVideo() {
    let (surface, layer) = makeSurface()
    var events: [String] = []
    surface.configure(
      layer: layer, size: source, enabled: true, mode: .touch,
      pointer: { action, _, _ in events.append(action) },
      scroll: { _, _ in events.append("scroll") })
    surface.panInput(delta: .zero, at: CGPoint(x: 195, y: 20), touches: 1, state: .began)
    surface.panInput(
      delta: CGPoint(x: 0, y: 30), at: CGPoint(x: 195, y: 370), touches: 1, state: .changed)
    surface.panInput(delta: .zero, at: .zero, touches: 0, state: .ended)
    XCTAssertTrue(events.isEmpty)

    // Recognition can begin inside the video after the finger crossed the border.
    surface.panInput(
      delta: CGPoint(x: 0, y: 200), at: CGPoint(x: 195, y: 370), touches: 1, state: .began)
    surface.panInput(
      delta: CGPoint(x: 0, y: 10), at: CGPoint(x: 195, y: 380), touches: 1, state: .changed)
    surface.panInput(delta: .zero, at: .zero, touches: 0, state: .ended)
    XCTAssertTrue(events.isEmpty)

    surface.panInput(delta: .zero, at: CGPoint(x: 195, y: 370), touches: 1, state: .began)
    surface.panInput(
      delta: CGPoint(x: 0, y: 10), at: CGPoint(x: 195, y: 380), touches: 1, state: .changed)
    surface.panInput(delta: .zero, at: .zero, touches: 0, state: .cancelled)
    surface.panInput(
      delta: CGPoint(x: 0, y: 10), at: CGPoint(x: 195, y: 380), touches: 1, state: .changed)
    XCTAssertEqual(
      events, ["move", "scroll"], "Only a gesture that began in video may scroll, until cancelled.")
  }

  func testTwoFingerInspectionNeverIssuesRemoteInputInTouchOrDrag() throws {
    for mode in [PalmInputMode.touch, .drag] {
      let (surface, layer) = makeSurface(framing: .readable)
      var events = 0
      surface.configure(
        layer: layer, size: source, enabled: true, mode: mode, framing: .readable,
        pointer: { _, _, _ in events += 1 }, scroll: { _, _ in events += 1 })
      XCTAssertTrue(try scrollView(surface).panGestureRecognizer.isEnabled)
      surface.panInput(
        delta: CGPoint(x: 60, y: 40), at: CGPoint(x: 195, y: 370), touches: 2, state: .changed)
      XCTAssertEqual(events, 0)
      let twoFinger = try XCTUnwrap(
        surface.gestureRecognizers?.compactMap { $0 as? UIPanGestureRecognizer }
          .first { $0.minimumNumberOfTouches == 2 })
      XCTAssertFalse(twoFinger.isEnabled)
    }
  }

  func testPinchReleasesDragOnceAndSuppressesRemoteGestureEffects() throws {
    let (surface, layer) = makeSurface(framing: .readable)
    var events: [String] = []
    surface.configure(
      layer: layer, size: source, enabled: true, mode: .drag, framing: .readable,
      pointer: { action, _, _ in events.append(action) },
      scroll: { _, _ in events.append("scroll") })
    surface.beginDrag(at: CGPoint(x: 195, y: 370))
    let scroll = try scrollView(surface)
    surface.scrollViewWillBeginZooming(scroll, with: scroll.subviews.first)
    surface.panInput(delta: CGPoint(x: 20, y: 10), at: .zero, touches: 1, state: .changed)
    surface.activatePointer(at: CGPoint(x: 195, y: 370), action: "click")
    surface.finishDrag()
    XCTAssertEqual(events, ["down", "up"])
    surface.configure(
      layer: layer, size: source, enabled: true, mode: .trackpad, framing: .readable,
      pointer: { action, _, _ in events.append(action) },
      scroll: { _, _ in events.append("scroll") })
    surface.panInput(delta: CGPoint(x: 20, y: 10), at: .zero, touches: 2, state: .changed)
    XCTAssertEqual(events, ["down", "up"])
    surface.scrollViewDidEndZooming(scroll, with: scroll.subviews.first, atScale: scroll.zoomScale)
    surface.panInput(delta: CGPoint(x: 20, y: 10), at: .zero, touches: 2, state: .changed)
    XCTAssertEqual(events, ["down", "up", "scroll"])
  }

  func testReframingHeldDragReleasesOldPointBeforeChangingGeometry() {
    let (surface, layer) = makeSurface(framing: .readable)
    var points: [(String, Double, Double)] = []
    surface.configure(
      layer: layer, size: source, enabled: true, mode: .drag, framing: .readable,
      pointer: { points.append(($0, $1, $2)) }, scroll: { _, _ in })
    surface.beginDrag(at: CGPoint(x: 100, y: 250))
    surface.configure(
      layer: layer, size: source, enabled: true, mode: .drag, resetZoomID: 1, framing: .readable,
      pointer: { points.append(($0, $1, $2)) }, scroll: { _, _ in })
    surface.layoutIfNeeded()
    surface.finishDrag()
    XCTAssertEqual(points.map(\.0), ["down", "up"])
    XCTAssertEqual(points.first?.1, points.last?.1)
    XCTAssertEqual(points.first?.2, points.last?.2)
  }

  func testReadableLayerReparentingSurvivesOldReframeAndDetach() throws {
    let (old, shared) = makeSurface(framing: .readable)
    let replacement = PalmSurfaceView(frame: CGRect(x: 0, y: 0, width: 844, height: 330))
    replacement.configure(
      layer: shared, size: source, enabled: true, mode: .touch, framing: .readable,
      pointer: { _, _, _ in }, scroll: { _, _ in })
    replacement.layoutIfNeeded()
    let owner = try XCTUnwrap(shared.superlayer)
    let frame = shared.frame
    old.frame = CGRect(x: 0, y: 0, width: 300, height: 600)
    old.setNeedsLayout()
    old.layoutIfNeeded()
    old.detach()
    XCTAssertTrue(shared.superlayer === owner)
    XCTAssertEqual(shared.frame, frame)
  }

  private func makeSurface(framing: PalmRemoteFraming = .fit) -> (
    PalmSurfaceView, AVSampleBufferDisplayLayer
  ) {
    let view = PalmSurfaceView(frame: CGRect(x: 0, y: 0, width: 390, height: 740))
    let layer = AVSampleBufferDisplayLayer()
    view.configure(
      layer: layer, size: source, enabled: true, mode: .touch, framing: framing,
      pointer: { _, _, _ in }, scroll: { _, _ in })
    view.layoutIfNeeded()
    return (view, layer)
  }

  private func overview(_ surface: PalmSurfaceView) throws -> UIView {
    try XCTUnwrap(surface.subviews.first { $0.accessibilityIdentifier == "remote.overview" })
  }

  private func scrollView(_ surface: PalmSurfaceView) throws -> UIScrollView {
    try XCTUnwrap(surface.subviews.first as? UIScrollView)
  }
}
