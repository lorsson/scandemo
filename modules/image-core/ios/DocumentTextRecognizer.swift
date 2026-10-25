import CoreGraphics
import Foundation
import ImageIO
import Vision

/// iOS 端侧文字识别。
///
/// 与 Android 的 PP-OCRv4（`PpOcrEngine.kt`）保持同一份输出契约：返回识别位图的
/// 像素尺寸和每行文本的四角（TL,TR,BR,BL，原点左上）+ 文本 + 置信度，JS 侧再
/// 归一化、按阅读顺序排序、编辑和导出。iOS 直接用系统自带的 Vision 文字识别
/// 模型，不额外打包 ONNX 和推理库。
enum DocumentTextRecognizer {
  /// 低于该置信度的行直接丢掉：多半是印章、水印上的残字
  private static let dropBelow: Float = 0.3

  /// podspec 的部署目标是 iOS 16.4，Vision 文字识别（iOS 13+）始终可用
  static func isSupported() -> Bool {
    return true
  }

  /// `path` 不带 `file://`，与 Android `ocrFile` 一致
  static func ocrFile(path: String) -> [String: Any]? {
    let url = URL(fileURLWithPath: path)
    guard let size = uprightPixelSize(url) else {
      return nil
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    // 不做语言模型纠错：文档里多是编号和数量，纠错会顺手把数字改坏
    request.usesLanguageCorrection = false
    request.recognitionLanguages = recognitionLanguages()

    // 用 URL 初始化，Vision 会自己按 EXIF 方向转正
    let handler = VNImageRequestHandler(url: url, options: [:])
    do {
      try handler.perform([request])
    } catch {
      return nil
    }
    guard let observations = request.results else {
      return nil
    }

    let width = Double(size.width)
    let height = Double(size.height)
    var lines: [[String: Any]] = []
    for observation in observations {
      guard
        let candidate = observation.topCandidates(1).first,
        candidate.confidence >= dropBelow
      else {
        continue
      }
      let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty {
        continue
      }
      // Vision 的 boundingBox 是归一化坐标、原点在左下，转成像素 + 左上原点
      let box = observation.boundingBox
      let x0 = Double(box.minX) * width
      let x1 = Double(box.maxX) * width
      let y0 = (1 - Double(box.maxY)) * height
      let y1 = (1 - Double(box.minY)) * height
      lines.append([
        "points": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        "text": text,
        "score": Double(candidate.confidence),
      ])
    }

    return ["width": size.width, "height": size.height, "lines": lines]
  }

  /// 简体/繁体中文优先，再带英文；系统不支持的语言不传（传了 perform 会抛异常）
  private static func recognitionLanguages() -> [String] {
    let wanted = ["zh-Hans", "zh-Hant", "en-US"]
    let supported =
      (try? VNRecognizeTextRequest.supportedRecognitionLanguages(
        for: .accurate,
        revision: VNRecognizeTextRequestRevision3
      )) ?? []
    let picked = wanted.filter { supported.contains($0) }
    return picked.isEmpty ? wanted : picked
  }

  /// 按 EXIF 方向转正后的像素尺寸：Vision 的 boundingBox 用的就是这套坐标系
  private static func uprightPixelSize(_ url: URL) -> (width: Int, height: Int)? {
    guard
      let source = CGImageSourceCreateWithURL(url as CFURL, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)
        as? [CFString: Any],
      let pixelWidth = properties[kCGImagePropertyPixelWidth] as? Int,
      let pixelHeight = properties[kCGImagePropertyPixelHeight] as? Int,
      pixelWidth > 0,
      pixelHeight > 0
    else {
      return nil
    }
    // 5..8 是 90° 方向的旋转，宽高互换
    let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
    if orientation >= 5 {
      return (width: pixelHeight, height: pixelWidth)
    }
    return (width: pixelWidth, height: pixelHeight)
  }
}
