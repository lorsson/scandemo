import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import Vision

/// iOS 端侧文档四角检测。
///
/// 与 Android 的 DocCornerNet（`DocCornerDetector.kt`）保持同一份输出契约：
/// 归一化坐标 TL,TR,BR,BL（原点左上），服务层只看这份数据，不关心用什么模型。
/// iOS 直接用系统自带的 Vision 文档分割模型（`VNDetectDocumentSegmentationRequest`），
/// 不引入额外原生依赖；没有结果时退回矩形检测。
enum DocumentRectDetector {
  struct Detection {
    /// 8 个值：TL.x, TL.y, TR.x, TR.y, BR.x, BR.y, BL.x, BL.y
    let quad: [Double]
    let confidence: Float

    var dictionary: [String: Any] {
      [
        "quad": [
          "topLeft": ["x": quad[0], "y": quad[1]],
          "topRight": ["x": quad[2], "y": quad[3]],
          "bottomRight": ["x": quad[4], "y": quad[5]],
          "bottomLeft": ["x": quad[6], "y": quad[7]],
        ],
        "confidence": confidence,
      ]
    }
  }

  /// 与 Android 一致：低于该置信度视为画面里没有文档
  static let scoreThreshold: Float = 0.55
  private static let minArea: Double = 0.03
  private static let maxArea: Double = 0.995

  // MARK: - 静态图片

  static func detectFile(path: String) -> Detection? {
    guard
      let source = CGImageSourceCreateWithURL(
        URL(fileURLWithPath: path) as CFURL,
        nil
      ),
      let image = uprightThumbnail(source, maxPixel: 640)
    else {
      return nil
    }
    return detect(cgImage: image)
  }

  /// 已经按 EXIF 方向转正的图片（orientation 传 .up）
  static func detect(cgImage: CGImage) -> Detection? {
    run { VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:]) }
  }

  /// 相机帧：orientation 由调用方按连接方向给出
  static func detect(
    pixelBuffer: CVPixelBuffer,
    orientation: CGImagePropertyOrientation
  ) -> Detection? {
    run {
      VNImageRequestHandler(
        cvPixelBuffer: pixelBuffer,
        orientation: orientation,
        options: [:]
      )
    }
  }

  private static func run(_ makeHandler: () -> VNImageRequestHandler) -> Detection? {
    let handler = makeHandler()
    if let detection = runDocumentSegmentation(handler) {
      return detection
    }
    return runRectangleDetection(handler)
  }

  private static func runDocumentSegmentation(
    _ handler: VNImageRequestHandler
  ) -> Detection? {
    guard #available(iOS 15.0, *) else { return nil }
    let request = VNDetectDocumentSegmentationRequest()
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard let observation = request.results?.first else { return nil }
    return sanitize(observation)
  }

  private static func runRectangleDetection(
    _ handler: VNImageRequestHandler
  ) -> Detection? {
    let request = VNDetectRectanglesRequest()
    request.maximumObservations = 1
    request.minimumConfidence = 0.4
    request.minimumSize = 0.15
    request.quadratureTolerance = 30
    request.minimumAspectRatio = 0.2
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard let observation = request.results?.first else { return nil }
    return sanitize(observation)
  }

  // MARK: - 后处理

  private static func sanitize(_ rect: VNRectangleObservation) -> Detection? {
    let confidence = Float(rect.confidence)
    guard confidence.isFinite, confidence >= scoreThreshold else { return nil }

    // Vision 的原点在左下，转成左上原点
    let quad = [
      Double(rect.topLeft.x), 1 - Double(rect.topLeft.y),
      Double(rect.topRight.x), 1 - Double(rect.topRight.y),
      Double(rect.bottomRight.x), 1 - Double(rect.bottomRight.y),
      Double(rect.bottomLeft.x), 1 - Double(rect.bottomLeft.y),
    ]
    let clamped = quad.map { min(1, max(0, $0)) }
    guard isConvex(clamped), area(clamped).isFinite else { return nil }
    let normalizedArea = area(clamped)
    guard normalizedArea >= minArea, normalizedArea <= maxArea else { return nil }
    return Detection(quad: clamped, confidence: confidence)
  }

  private static func isConvex(_ pts: [Double]) -> Bool {
    var sign = 0
    for i in 0..<4 {
      let ax = pts[i * 2]
      let ay = pts[i * 2 + 1]
      let bx = pts[((i + 1) % 4) * 2]
      let by = pts[((i + 1) % 4) * 2 + 1]
      let cx = pts[((i + 2) % 4) * 2]
      let cy = pts[((i + 2) % 4) * 2 + 1]
      let cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
      if abs(cross) < 1e-6 {
        return false
      }
      let current = cross > 0 ? 1 : -1
      if sign == 0 {
        sign = current
      } else if current != sign {
        return false
      }
    }
    return true
  }

  private static func area(_ pts: [Double]) -> Double {
    var sum = 0.0
    for i in 0..<4 {
      let x1 = pts[i * 2]
      let y1 = pts[i * 2 + 1]
      let x2 = pts[((i + 1) % 4) * 2]
      let y2 = pts[((i + 1) % 4) * 2 + 1]
      sum += x1 * y2 - x2 * y1
    }
    return abs(sum) / 2
  }

  /// 按 EXIF 方向转正 + 降采样（与 Android `decodeSampledBitmap` 的用途一致）
  static func uprightThumbnail(
    _ source: CGImageSource,
    maxPixel: Int
  ) -> CGImage? {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }
}
