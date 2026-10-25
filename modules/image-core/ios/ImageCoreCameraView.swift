import AVFoundation
import CoreImage
import ExpoModulesCore
import ImageIO
import QuartzCore

import UIKit
import Vision

/// 实时文档取景视图（iOS）。
///
/// 与 Android `ImageCoreCameraView.kt` 行为对齐：
///   - AVCaptureSession 预览 + 视频帧分析（Vision 文档检测）+ 拍照
///   - 四角换算成「预览视图归一化坐标」后通过 onQuad 事件回传 JS
///   - 拍照写盘后按 EXIF 物理转正，返回 { uri, width, height }
public final class ImageCoreCameraView: ExpoView {
  /// 事件名必须与模块注册的 Events("onQuad") 一致
  let onQuad = EventDispatcher()
  /// 相机/模型侧的非致命错误；JS 只在开发构建里提示。
  /// 目前 iOS 的 Vision 检测不会阻塞预览，预留同一个事件名保持两端契约一致。
  let onError = EventDispatcher()

  private let session = AVCaptureSession()
  private let sessionQueue = DispatchQueue(label: "image-core.camera.session")
  private let analysisQueue = DispatchQueue(
    label: "image-core.camera.analysis",
    qos: .userInitiated
  )
  private let videoOutput = AVCaptureVideoDataOutput()
  private let photoOutput = AVCapturePhotoOutput()
  private let previewLayer = AVCaptureVideoPreviewLayer()

  private var configured = false

  // 分析节流：~8fps，同时只跑一帧
  private var lastAnalysisAt: CFTimeInterval = 0
  private var inFlight = false

  // 平滑后的视图归一化四角
  private var smoothed: [Double]?
  private var lastDetectedAt: CFTimeInterval = 0
  private var lostEmitted = false

  // 拍照回调要一直持有到完成
  private var photoDelegates: [Int64: PhotoCaptureDelegate] = [:]
  private var photoSeq: Int64 = 0
  private let delegateLock = NSLock()

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    // resizeAspect：整幅画面等比缩进视图（上下留黑边），所见即所拍。
    // resizeAspectFill 会为了铺满超高屏裁掉左右，成片却按整幅存盘，
    // 取景框和照片就对不上。
    previewLayer.videoGravity = .resizeAspect
    previewLayer.backgroundColor = UIColor.black.cgColor
    previewLayer.frame = bounds
    layer.insertSublayer(previewLayer, at: 0)
    previewLayer.session = session
  }

  deinit {
    videoOutput.setSampleBufferDelegate(nil, queue: nil)
    if session.isRunning {
      session.stopRunning()
    }
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    previewLayer.frame = bounds
    CATransaction.commit()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      startSessionIfNeeded()
    } else {
      stopSession()
    }
  }

  // MARK: - 会话

  func startSessionIfNeeded() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      startSession()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
        if granted {
          self?.startSession()
        }
      }
    default:
      NSLog("[image-core] camera permission not granted")
    }
  }

  private func startSession() {
    sessionQueue.async { [weak self] in
      guard let self else { return }
      if !self.configured {
        guard self.configureSession() else { return }
        self.configured = true
      }
      if !self.session.isRunning {
        self.session.startRunning()
      }
    }
  }

  private func stopSession() {
    sessionQueue.async { [weak self] in
      guard let self else { return }
      if self.session.isRunning {
        self.session.stopRunning()
      }
    }
  }

  private func configureSession() -> Bool {
    session.beginConfiguration()
    defer { session.commitConfiguration() }

    session.sessionPreset = .vga640x480

    guard
      let device = AVCaptureDevice.default(
        .builtInWideAngleCamera,
        for: .video,
        position: .back
      ),
      let input = try? AVCaptureDeviceInput(device: device),
      session.canAddInput(input)
    else {
      NSLog("[image-core] camera device unavailable")
      return false
    }
    session.addInput(input)

    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String:
        Int(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
    ]
    videoOutput.setSampleBufferDelegate(self, queue: analysisQueue)
    guard session.canAddOutput(videoOutput) else {
      NSLog("[image-core] cannot add video data output")
      return false
    }
    session.addOutput(videoOutput)

    guard session.canAddOutput(photoOutput) else {
      NSLog("[image-core] cannot add photo output")
      return false
    }
    session.addOutput(photoOutput)

    // 预览/帧/拍照统一竖屏方向；测试时只支持竖直握持
    Self.applyPortraitOrientation(to: videoOutput.connection(with: .video))
    Self.applyPortraitOrientation(to: photoOutput.connection(with: .video))
    Self.applyPortraitOrientation(to: previewLayer.connection)

    return true
  }

  private static func applyPortraitOrientation(to connection: AVCaptureConnection?) {
    guard let connection else { return }
    if #available(iOS 17.0, *) {
      if connection.isVideoRotationAngleSupported(90) {
        connection.videoRotationAngle = 90
      }
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }

  // MARK: - 帧分析

  private func analyze(pixelBuffer: CVPixelBuffer) {
    let now = CACurrentMediaTime()
    if now - lastAnalysisAt < 0.12 {
      return
    }
    if inFlight {
      return
    }
    inFlight = true
    lastAnalysisAt = now
    defer { inFlight = false }

    let frameWidth = CVPixelBufferGetWidth(pixelBuffer)
    let frameHeight = CVPixelBufferGetHeight(pixelBuffer)
    // 连接已经把缓冲转成竖屏（见 applyPortraitOrientation），所以这里传 .up
    let detection = DocumentRectDetector.detect(
      pixelBuffer: pixelBuffer,
      orientation: .up
    )

    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      if let detection {
        self.emitQuad(
          detection,
          frameWidth: frameWidth,
          frameHeight: frameHeight
        )
      } else {
        self.emitLostIfNeeded()
      }
    }
  }

  private func emitQuad(
    _ detection: DocumentRectDetector.Detection,
    frameWidth: Int,
    frameHeight: Int
  ) {
    let viewWidth = previewLayer.bounds.width
    let viewHeight = previewLayer.bounds.height
    guard viewWidth > 0, viewHeight > 0, frameWidth > 0, frameHeight > 0 else {
      return
    }

    // resizeAspect：整幅等比缩进视图并居中，四周是黑边
    let scale = min(
      viewWidth / CGFloat(frameWidth),
      viewHeight / CGFloat(frameHeight)
    )
    let offsetX = (viewWidth - CGFloat(frameWidth) * scale) / 2
    let offsetY = (viewHeight - CGFloat(frameHeight) * scale) / 2

    var next = [Double](repeating: 0, count: 8)
    for i in 0..<4 {
      let px = CGFloat(detection.quad[i * 2]) * CGFloat(frameWidth)
      let py = CGFloat(detection.quad[i * 2 + 1]) * CGFloat(frameHeight)
      next[i * 2] = Double((px * scale + offsetX) / viewWidth)
      next[i * 2 + 1] = Double((py * scale + offsetY) / viewHeight)
    }

    if let previous = smoothed {
      for i in 0..<8 {
        next[i] = previous[i] * 0.45 + next[i] * 0.55
      }
    }
    smoothed = next
    lastDetectedAt = CACurrentMediaTime()
    lostEmitted = false
    onQuad([
      "detected": true,
      "quad": next,
      "confidence": Double(detection.confidence),
    ])
  }

  private func emitLostIfNeeded() {
    if lostEmitted {
      return
    }
    if CACurrentMediaTime() - lastDetectedAt < 0.7 {
      return
    }
    smoothed = nil
    lostEmitted = true
    onQuad(["detected": false, "quad": NSNull(), "confidence": 0.0])
  }

  // MARK: - 拍照

  /// 拍照并返回 `{ uri, width, height }`；EXIF 方向已烘进像素。
  func takePicture() async throws -> [String: Any] {
    guard session.isRunning else {
      throw ImageCoreCameraError.notReady
    }

    let data: Data = try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<Data, Error>) in
      let settings = AVCapturePhotoSettings()
      settings.flashMode = .off
      let id = nextPhotoId()
      let delegate = PhotoCaptureDelegate { [weak self] result in
        self?.releasePhotoDelegate(id)
        continuation.resume(with: result)
      }
      delegateLock.lock()
      photoDelegates[id] = delegate
      delegateLock.unlock()
      photoOutput.capturePhoto(with: settings, delegate: delegate)
    }

    // 解码/转正放到分析线程，别占住调用线程
    return try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<[String: Any], Error>) in
      analysisQueue.async {
        do {
          continuation.resume(returning: try Self.normalizePhoto(data))
        } catch {
          continuation.resume(throwing: error)
        }
      }
    }
  }

  private func nextPhotoId() -> Int64 {
    delegateLock.lock()
    defer { delegateLock.unlock() }
    photoSeq += 1
    return photoSeq
  }

  private func releasePhotoDelegate(_ id: Int64) {
    delegateLock.lock()
    photoDelegates[id] = nil
    delegateLock.unlock()
  }

  /// 解码 → 应用 EXIF 方向 → 写 JPEG 到临时目录
  private static func normalizePhoto(_ data: Data) throws -> [String: Any] {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
      throw ImageCoreCameraError.decodeFailed
    }
    guard let image = DocumentRectDetector.uprightThumbnail(source, maxPixel: 4096)
    else {
      throw ImageCoreCameraError.decodeFailed
    }
    guard
      let jpeg = UIImage(cgImage: image).jpegData(compressionQuality: 0.92)
    else {
      throw ImageCoreCameraError.encodeFailed
    }
    let file = FileManager.default.temporaryDirectory
      .appendingPathComponent("capture-\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
    try jpeg.write(to: file, options: .atomic)
    return [
      "uri": file.absoluteString,
      "width": image.width,
      "height": image.height,
    ]
  }
}

extension ImageCoreCameraView: AVCaptureVideoDataOutputSampleBufferDelegate {
  public func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
      return
    }
    analyze(pixelBuffer: pixelBuffer)
  }
}

/// 拍照回调：持有到 AVCapturePhotoOutput 调完为止
private final class PhotoCaptureDelegate: NSObject, AVCapturePhotoCaptureDelegate {
  private let completion: (Result<Data, Error>) -> Void

  init(completion: @escaping (Result<Data, Error>) -> Void) {
    self.completion = completion
  }

  func photoOutput(
    _ output: AVCapturePhotoOutput,
    didFinishProcessingPhoto photo: AVCapturePhoto,
    error: Error?
  ) {
    if let error {
      completion(.failure(error))
      return
    }
    guard let data = photo.fileDataRepresentation() else {
      completion(.failure(ImageCoreCameraError.encodeFailed))
      return
    }
    completion(.success(data))
  }
}

enum ImageCoreCameraError: Error, LocalizedError {
  case notReady
  case decodeFailed
  case encodeFailed

  var errorDescription: String? {
    switch self {
    case .notReady: return "相机尚未就绪"
    case .decodeFailed: return "无法解码照片"
    case .encodeFailed: return "无法编码照片"
    }
  }
}
