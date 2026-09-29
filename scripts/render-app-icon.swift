import CoreGraphics
import ImageIO
import Foundation

// Render the existing Palm vector mark at App Store icon resolution.
let size = 1024
let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
  bytesPerRow: size * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
// Graphite with a soft top light (22 September 2026: neutral look replaces green).
let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
  colors: [CGColor(red: 0.27, green: 0.27, blue: 0.29, alpha: 1), CGColor(red: 0.07, green: 0.07, blue: 0.08, alpha: 1)] as CFArray,
  locations: [0, 1])!
context.drawLinearGradient(gradient, start: CGPoint(x: 0, y: CGFloat(size)), end: CGPoint(x: 0, y: 0), options: [])
context.move(to: CGPoint(x: 312, y: 320))
context.addLine(to: CGPoint(x: 312, y: 712))
context.addLine(to: CGPoint(x: 488, y: 712))
context.addCurve(to: CGPoint(x: 712, y: 528), control1: CGPoint(x: 632, y: 712), control2: CGPoint(x: 712, y: 648))
context.addCurve(to: CGPoint(x: 488, y: 344), control1: CGPoint(x: 712, y: 408), control2: CGPoint(x: 632, y: 344))
context.addLine(to: CGPoint(x: 416, y: 344))
context.setLineWidth(96)
context.setLineCap(.round)
context.setLineJoin(.round)
context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
context.strokePath()
let destination = CommandLine.arguments.dropFirst().first ?? "ios/Palm/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png"
let output = CGImageDestinationCreateWithURL(URL(fileURLWithPath: destination) as CFURL, "public.png" as CFString, 1, nil)!
CGImageDestinationAddImage(output, context.makeImage()!, nil)
if !CGImageDestinationFinalize(output) { fatalError("Could not render the app icon") }
