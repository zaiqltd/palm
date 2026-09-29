import CoreGraphics
import Foundation
import ImageIO

// Palm's mark: an open hand, the palm facing you, drawn from rounded shapes
// so it stays crisp from a 16-pixel favicon to the 1024-pixel App Store icon.
// This script is the one source for every copy of it:
//
//   swift scripts/render-brand.swift            write every asset
//   swift scripts/render-brand.swift --preview  write .local/brand-preview.png only
//
// Outputs: the iPhone app icon, the vector glyph the app draws, the Mac app
// icon (.icns), the setup page's favicon and home-screen icon, and the glyph
// markup used by the setup page and the demo video.

struct Capsule {
  var x: Double, y: Double, width: Double, height: Double
  var radius: Double
  var rotate: Double = 0  // degrees about the centre
}

// Drawn on a 1024-point square, y down. Fingers overlap the palm so the
// shapes read as one hand.
let hand: [Capsule] = [
  Capsule(x: 404, y: 450, width: 390, height: 220, radius: 24),  // palm, top half
  Capsule(x: 404, y: 450, width: 390, height: 384, radius: 170),  // palm, rounded base
  Capsule(x: 404, y: 262, width: 90, height: 400, radius: 45),  // index
  Capsule(x: 504, y: 204, width: 90, height: 440, radius: 45),  // middle
  Capsule(x: 604, y: 236, width: 90, height: 420, radius: 45),  // ring
  Capsule(x: 704, y: 318, width: 90, height: 340, radius: 45),  // little
  Capsule(x: 171.5, y: 533, width: 389, height: 104, radius: 52, rotate: 53.9),  // thumb
]

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let preview = CommandLine.arguments.contains("--preview")

func path(scale: Double, offset: CGPoint = .zero) -> CGPath {
  let result = CGMutablePath()
  for c in hand {
    let rect = CGRect(x: c.x * scale + offset.x, y: c.y * scale + offset.y, width: c.width * scale, height: c.height * scale)
    var transform = CGAffineTransform.identity
    if c.rotate != 0 {
      transform = transform.translatedBy(x: rect.midX, y: rect.midY).rotated(by: c.rotate * .pi / 180)
        .translatedBy(x: -rect.midX, y: -rect.midY)
    }
    let r = min(c.radius * scale, rect.width / 2, rect.height / 2)
    result.addPath(CGPath(roundedRect: rect, cornerWidth: r, cornerHeight: r, transform: nil), transform: transform)
  }
  return result
}

/// The mark on its tile: graphite with a soft top light, as the app icon.
/// `inset` leaves the transparent margin a Mac icon has.
func renderTile(size: Int, inset: Double = 0, corner: Double = 0, opaque: Bool) -> CGImage {
  let space = CGColorSpace(name: CGColorSpace.sRGB)!
  let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: space,
    bitmapInfo: opaque ? CGImageAlphaInfo.noneSkipLast.rawValue : CGImageAlphaInfo.premultipliedLast.rawValue)!
  // Draw y down, like the geometry.
  context.translateBy(x: 0, y: Double(size))
  context.scaleBy(x: 1, y: -1)
  let s = Double(size)
  let tile = CGRect(x: inset * s, y: inset * s, width: s * (1 - 2 * inset), height: s * (1 - 2 * inset))
  context.saveGState()
  if corner > 0 { context.addPath(CGPath(roundedRect: tile, cornerWidth: corner * s, cornerHeight: corner * s, transform: nil)); context.clip() }
  let gradient = CGGradient(colorsSpace: space,
    colors: [CGColor(red: 0.27, green: 0.27, blue: 0.29, alpha: 1), CGColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1)] as CFArray,
    locations: [0, 1])!
  context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: tile.minY), end: CGPoint(x: 0, y: tile.maxY), options: [])
  context.restoreGState()
  // The hand fills about 64% of the tile, centred.
  let glyph = tile.width / 1024
  context.addPath(path(scale: glyph, offset: CGPoint(x: tile.minX, y: tile.minY)))
  context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
  context.fillPath()
  return context.makeImage()!
}

func writePNG(_ image: CGImage, _ relative: String) throws {
  let url = root.appendingPathComponent(relative)
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  let destination = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "brand", code: 1) }
}

func write(_ text: String, _ relative: String) throws {
  let url = root.appendingPathComponent(relative)
  try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  try text.write(to: url, atomically: true, encoding: .utf8)
}

/// SVG elements for the hand, in the 1024 space.
func svgShapes(fill: String) -> String {
  hand.map { c in
    let transform = c.rotate != 0 ? " transform=\"rotate(\(c.rotate) \(c.x + c.width / 2) \(c.y + c.height / 2))\"" : ""
    return "<rect x=\"\(c.x)\" y=\"\(c.y)\" width=\"\(c.width)\" height=\"\(c.height)\" rx=\"\(c.radius)\"\(transform) fill=\"\(fill)\"/>"
  }.joined()
}

if preview {
  try writePNG(renderTile(size: 512, opaque: true), ".local/brand-preview.png")
  try writePNG(renderTile(size: 64, opaque: true), ".local/brand-preview-64.png")
  try writePNG(renderTile(size: 16, opaque: true), ".local/brand-preview-16.png")
  exit(0)
}

// iPhone app icon (opaque, the system rounds it) and the home-screen icon for the setup page.
try writePNG(renderTile(size: 1024, opaque: true), "ios/Palm/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png")
try writePNG(renderTile(size: 180, opaque: true), "public/apple-touch-icon.png")

// The glyph the app draws (a template image: it takes the text colour).
let glyph = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1024 1024\">\(svgShapes(fill: "#000"))</svg>\n"
try write(glyph, "ios/Palm/Resources/Assets.xcassets/PalmHand.imageset/PalmHand.svg")
try write("""
  {
    "images" : [ { "filename" : "PalmHand.svg", "idiom" : "universal" } ],
    "info" : { "author" : "xcode", "version" : 1 },
    "properties" : { "preserves-vector-representation" : true, "template-rendering-intent" : "template" }
  }

  """, "ios/Palm/Resources/Assets.xcassets/PalmHand.imageset/Contents.json")

// The favicon: the tile with rounded corners.
try write("""
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#45454a"/><stop offset="1" stop-color="#121214"/></linearGradient></defs><rect width="1024" height="1024" rx="230" fill="url(#g)"/>\(svgShapes(fill: "#fff"))</svg>

  """, "public/icon.svg")

// Markup for the setup page and the demo video (fill follows the text colour).
try write("""
  // Generated by scripts/render-brand.swift: Palm's hand, in a 1024 view box.
  export const handShapes = \(String(reflecting: svgShapes(fill: "currentColor")));

  """, "src/brand.js")

// The Mac app icon: a rounded tile inside the standard transparent margin.
let iconset = root.appendingPathComponent(".local/Palm.iconset")
try? FileManager.default.removeItem(at: iconset)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
for base in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let pixels = base * scale
    let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
    try writePNG(renderTile(size: pixels, inset: 100.0 / 1024, corner: 185.0 / 1024, opaque: false), ".local/Palm.iconset/\(name)")
  }
}
let iconutil = Process()
iconutil.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
iconutil.arguments = ["-c", "icns", iconset.path, "-o", root.appendingPathComponent("native/Palm.icns").path]
try iconutil.run()
iconutil.waitUntilExit()
guard iconutil.terminationStatus == 0 else { fatalError("iconutil failed") }
print("Wrote the app icons, the glyph, the favicon and native/Palm.icns.")
