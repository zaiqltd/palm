import AVFoundation
import UIKit
import XCTest

@testable import Palm

@MainActor
final class PalmInterfaceTests: XCTestCase {
  func testPairingQRPreservesReviewedHostAndCode() throws {
    let link = try PalmPairingLink.parse("https://test-mac.example.ts.net:8443/#pair=012345abcd")
    XCTAssertEqual(link.host, "https://test-mac.example.ts.net:8443")
    XCTAssertEqual(link.code, "012345ABCD")
  }

  func testPairingQRRejectsCredentialsCommandsAndMalformedCodes() {
    for value in [
      "http://test-mac.example.ts.net/#pair=012345ABCD",
      "https://user:pass@test-mac.example.ts.net/#pair=012345ABCD",
      "https://test-mac.example.ts.net/run?command=lock#pair=012345ABCD",
      "https://test-mac.example.ts.net/#pair=012345ABCD&command=lock",
      "https://test-mac.example.ts.net/#pair=012345ABCG",
      "https://test-mac.example.ts.net/#pair=012345ABC",
      "https://test-mac.example.ts.net/#pair=012345ABCDE",
      "file:///Users/private#pair=012345ABCD",
      "palm://run/lock",
    ] {
      XCTAssertThrowsError(try PalmPairingLink.parse(value), value)
    }
  }

  func testTouchMappingRejectsLetterboxAndMapsVisibleVideoCenter() throws {
    let surface = makeSurface()
    XCTAssertNil(surface.normalizedPoint(at: CGPoint(x: 195, y: 4)))
    XCTAssertNil(surface.normalizedPoint(at: CGPoint(x: 195, y: 297)))
    let middle = try XCTUnwrap(surface.normalizedPoint(at: CGPoint(x: 195, y: 150)))
    XCTAssertEqual(middle.x, 0.5, accuracy: 0.002)
    XCTAssertEqual(middle.y, 0.5, accuracy: 0.002)
  }

  func testTouchMappingSurvivesZoomAndPanWithoutChangingTarget() throws {
    let surface = makeSurface()
    let scroll = try XCTUnwrap(surface.subviews.first as? UIScrollView)
    let content = try XCTUnwrap(scroll.subviews.first)
    scroll.setZoomScale(2.5, animated: false)
    scroll.contentOffset = CGPoint(x: 87, y: 55)
    let knownVideoPoint = CGPoint(x: content.bounds.width * 0.25, y: content.bounds.height * 0.75)
    let visiblePoint = content.convert(knownVideoPoint, to: surface)
    let normalized = try XCTUnwrap(surface.normalizedPoint(at: visiblePoint))
    XCTAssertEqual(normalized.x, 0.25, accuracy: 0.002)
    XCTAssertEqual(normalized.y, 0.75, accuracy: 0.002)
  }

  func testRotatingSurfaceKeepsVideoAndTouchRectAligned() throws {
    let surface = makeSurface()
    surface.frame = CGRect(x: 0, y: 0, width: 600, height: 240)
    surface.setNeedsLayout()
    surface.layoutIfNeeded()
    XCTAssertNil(surface.normalizedPoint(at: CGPoint(x: 2, y: 120)))
    let middle = try XCTUnwrap(surface.normalizedPoint(at: CGPoint(x: 300, y: 120)))
    XCTAssertEqual(middle.x, 0.5, accuracy: 0.002)
    XCTAssertEqual(middle.y, 0.5, accuracy: 0.002)
  }

  func testDragReleasesOnceOnCancellationAndStaysInsideVideoBounds() {
    let surface = makeSurface()
    var events: [(String, Double, Double)] = []
    let layer = AVSampleBufferDisplayLayer()
    surface.configure(
      layer: layer, size: CGSize(width: 1280, height: 800),
      enabled: true, mode: .drag, resetZoomID: 0,
      pointer: { events.append(($0, $1, $2)) }, scroll: { _, _ in })
    surface.layoutIfNeeded()
    surface.beginDrag(at: CGPoint(x: 195, y: 4))
    XCTAssertTrue(events.isEmpty, "Letterboxing must never begin a drag.")
    surface.beginDrag(at: CGPoint(x: 195, y: 150))
    surface.moveDrag(to: CGPoint(x: 900, y: 900))
    surface.finishDrag()
    surface.finishDrag()
    XCTAssertEqual(events.map(\.0), ["down", "move", "up"])
    XCTAssertTrue(events.allSatisfy { (0...1).contains($0.1) && (0...1).contains($0.2) })
    XCTAssertEqual(events.last?.1, 1)
    XCTAssertEqual(events.last?.2, 1)
  }

  func testChangingInputModeReleasesDragAndLosingControlClosesSession() {
    let surface = makeSurface()
    var events: [String] = []
    var cancellations = 0
    let layer = AVSampleBufferDisplayLayer()
    func configure(_ mode: PalmInputMode, enabled: Bool = true) {
      surface.configure(
        layer: layer, size: CGSize(width: 1280, height: 800),
        enabled: enabled, mode: mode, resetZoomID: 0,
        pointer: { action, _, _ in events.append(action) }, scroll: { _, _ in },
        cancelSession: { cancellations += 1 })
      surface.layoutIfNeeded()
    }
    configure(.drag)
    surface.beginDrag(at: CGPoint(x: 195, y: 150))
    configure(.touch)
    XCTAssertEqual(events, ["down", "up"])
    XCTAssertEqual(cancellations, 0)
    configure(.drag)
    surface.beginDrag(at: CGPoint(x: 195, y: 150))
    configure(.drag, enabled: false)
    XCTAssertEqual(events, ["down", "up", "down"], "Disabled UI must issue no further input.")
    XCTAssertEqual(cancellations, 1, "Closing the transport makes the host release the held mouse.")
  }

  func testRemovingSurfaceCancelsHeldMouseWithoutReplayingInput() {
    let surface = makeSurface()
    var events: [String] = []
    var cancellations = 0
    surface.configure(
      layer: AVSampleBufferDisplayLayer(), size: CGSize(width: 1280, height: 800),
      enabled: true, mode: .drag, resetZoomID: 0,
      pointer: { action, _, _ in events.append(action) }, scroll: { _, _ in },
      cancelSession: { cancellations += 1 })
    surface.layoutIfNeeded()
    surface.beginDrag(at: CGPoint(x: 195, y: 150))
    surface.detach()
    surface.moveDrag(to: CGPoint(x: 230, y: 180))
    surface.finishDrag()
    XCTAssertEqual(events, ["down"])
    XCTAssertEqual(cancellations, 1)
  }

  func testReparentedVideoSurvivesOldSurfaceLayoutAndDetach() throws {
    let layer = AVSampleBufferDisplayLayer()
    let oldSurface = makeSurface()
    configure(oldSurface, layer: layer)
    let replacement = makeSurface()
    replacement.frame = CGRect(x: 0, y: 0, width: 600, height: 240)
    configure(replacement, layer: layer)
    let newOwner = try XCTUnwrap(layer.superlayer)
    let expectedFrame = layer.frame

    oldSurface.frame = CGRect(x: 0, y: 0, width: 200, height: 400)
    oldSurface.setNeedsLayout()
    oldSurface.layoutIfNeeded()
    XCTAssertEqual(layer.frame, expectedFrame, "An obsolete viewport must not resize a layer now owned by its replacement.")
    oldSurface.detach()
    XCTAssertTrue(layer.superlayer === newOwner,
      "SwiftUI may attach the replacement before dismantling the old viewport; the shared video must remain visible.")
  }

  func testSameSurfaceRepairsDetachedVideoWithoutBoundsChange() throws {
    let surface = makeSurface()
    let layer = AVSampleBufferDisplayLayer()
    configure(surface, layer: layer)
    let owner = try XCTUnwrap(layer.superlayer)
    let expectedFrame = layer.frame
    layer.removeFromSuperlayer()
    layer.frame = .zero
    configure(surface, layer: layer)
    XCTAssertTrue(layer.superlayer === owner, "A regular SwiftUI update must repair a missing attachment even when layer identity is unchanged.")
    XCTAssertEqual(layer.frame, expectedFrame)
  }

  func testReplacingLayerOnOldSurfaceDoesNotStealReplacementVideo() throws {
    let shared = AVSampleBufferDisplayLayer()
    let oldSurface = makeSurface()
    configure(oldSurface, layer: shared)
    let replacement = makeSurface()
    configure(replacement, layer: shared)
    let newOwner = try XCTUnwrap(shared.superlayer)
    configure(oldSurface, layer: AVSampleBufferDisplayLayer())
    XCTAssertTrue(shared.superlayer === newOwner)
  }

  private func configure(_ surface: PalmSurfaceView, layer: AVSampleBufferDisplayLayer) {
    surface.configure(layer: layer, size: CGSize(width: 1280, height: 800), enabled: false,
      mode: .touch, resetZoomID: 0, pointer: { _, _, _ in }, scroll: { _, _ in })
    surface.layoutIfNeeded()
  }

  private func makeSurface() -> PalmSurfaceView {
    let surface = PalmSurfaceView(frame: CGRect(x: 0, y: 0, width: 390, height: 300))
    surface.configure(
      layer: AVSampleBufferDisplayLayer(), size: CGSize(width: 1280, height: 800),
      enabled: false, mode: .touch, resetZoomID: 0, pointer: { _, _, _ in }, scroll: { _, _ in })
    surface.setNeedsLayout()
    surface.layoutIfNeeded()
    return surface
  }
}
