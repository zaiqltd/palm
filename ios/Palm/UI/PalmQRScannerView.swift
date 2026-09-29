@preconcurrency import AVFoundation
import SwiftUI
import UIKit

struct PalmQRScannerView: View {
  @Environment(\.dismiss) private var dismiss
  let onScan: (String) -> Void
  @State private var error: String?

  var body: some View {
    NavigationStack {
      VStack(spacing: 22) {
        Text("Point your camera at the pairing code in Palm on your Mac.")
          .font(.body).foregroundStyle(PalmStyle.muted)
        if let error {
          ContentUnavailableView(
            "Camera unavailable", systemImage: "camera",
            description: Text(error))
          Button("Enter the code instead") { dismiss() }
            .buttonStyle(PalmPrimaryButton())
        } else {
          QRPreview(onScan: onScan, onError: { error = $0 })
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 28))
            .overlay {
              RoundedRectangle(cornerRadius: 22)
                .stroke(PalmStyle.accent, style: StrokeStyle(lineWidth: 2, dash: [22, 10]))
                .frame(width: 220, height: 220)
                .allowsHitTesting(false)
            }
            .accessibilityLabel("Camera preview. Aim at the Palm pairing QR code on your Mac.")
          Text("You’ll review the address before connecting.")
            .font(.caption).foregroundStyle(PalmStyle.muted)
        }
      }
      .padding(24)
      .navigationTitle("Scan to pair")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
      }
      .palmScreen()
    }
  }
}

private struct QRPreview: UIViewControllerRepresentable {
  let onScan: (String) -> Void
  let onError: (String) -> Void

  func makeUIViewController(context: Context) -> QRCameraController {
    QRCameraController(onScan: onScan, onError: onError)
  }

  func updateUIViewController(_ controller: QRCameraController, context: Context) {}

  static func dismantleUIViewController(_ controller: QRCameraController, coordinator: ()) {
    controller.stopCamera()
  }
}

private final class QRCameraController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  private let session = AVCaptureSession()
  private let queue = DispatchQueue(label: "app.palm.qr-camera", qos: .userInitiated)
  private var preview: AVCaptureVideoPreviewLayer?
  private var scanned = false
  private var stopped = false
  private let onScan: (String) -> Void
  private let onError: (String) -> Void

  init(onScan: @escaping (String) -> Void, onError: @escaping (String) -> Void) {
    self.onScan = onScan
    self.onError = onError
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { nil }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: configureCamera()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
        DispatchQueue.main.async {
          guard let self, !self.stopped else { return }
          if allowed {
            self.configureCamera()
          } else {
            self.onError(
              "Camera access was declined. You can still enter the Mac address and pairing code by hand."
            )
          }
        }
      }
    default:
      onError(
        "Allow camera access in iPhone Settings to scan, or enter the Mac address and code by hand."
      )
    }
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    preview?.frame = view.bounds
  }

  override func viewDidDisappear(_ animated: Bool) {
    super.viewDidDisappear(animated)
    stopCamera()
  }

  func stopCamera() {
    stopped = true
    let session = session
    queue.async { if session.isRunning { session.stopRunning() } }
  }

  private func configureCamera() {
    guard !stopped, let device = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: device)
    else {
      onError("This device has no available camera. Enter the pairing details instead.")
      return
    }
    let output = AVCaptureMetadataOutput()
    guard session.canAddInput(input), session.canAddOutput(output) else {
      onError("The camera could not start. Enter the pairing details instead.")
      return
    }
    session.beginConfiguration()
    session.addInput(input)
    session.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    guard output.availableMetadataObjectTypes.contains(.qr) else {
      session.commitConfiguration()
      onError("QR scanning is unavailable. Enter the pairing details instead.")
      return
    }
    output.metadataObjectTypes = [.qr]
    session.commitConfiguration()
    let preview = AVCaptureVideoPreviewLayer(session: session)
    preview.videoGravity = .resizeAspectFill
    preview.frame = view.bounds
    view.layer.addSublayer(preview)
    self.preview = preview
    let session = session
    queue.async { session.startRunning() }
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard !scanned, !stopped,
      let code = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject })
        .first(where: { $0.type == .qr })?.stringValue
    else { return }
    scanned = true
    stopCamera()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    onScan(code)
  }
}
