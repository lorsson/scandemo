import CoreGraphics
import ExpoModulesCore
import Foundation
import ImageIO
import UIKit

public final class ImageCoreModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ImageCore")

    Function("version") { () -> String in
      String(cString: ImageCoreVersion())
    }

    AsyncFunction("processFile") {
      (inputPath: String, outputPath: String, filter: String, quality: Int) -> [String: Any] in
      try processFile(
        inputPath: inputPath,
        outputPath: outputPath,
        filter: filter,
        quality: quality,
        contrast: 0,
        brightness: 0,
        detail: 0
      )
    }

    // 第二步微调：对比度/亮度 -50..50，细节 0..100
    AsyncFunction("processFileEx") {
      (
        inputPath: String,
        outputPath: String,
        filter: String,
        quality: Int,
        contrast: Int,
        brightness: Int,
        detail: Int
      ) -> [String: Any] in
      try processFile(
        inputPath: inputPath,
        outputPath: outputPath,
        filter: filter,
        quality: quality,
        contrast: contrast,
        brightness: brightness,
        detail: detail
      )
    }

    // 按 EXIF 转正后的像素尺寸（与 UIImage 实际显示方向一致）
    AsyncFunction("imageSize") { (path: String) -> [String: Any] in
      let upright = try uprightImage(path)
      return ["width": upright.width, "height": upright.height]
    }

    // 四角透视裁剪：quad 为 8 个归一化坐标 TL,TR,BR,BL
    AsyncFunction("warpFile") {
      (
        inputPath: String,
        outputPath: String,
        quad: [Double],
        quality: Int,
        maxDim: Int
      ) -> [String: Any] in
      try warpFile(
        inputPath: inputPath,
        outputPath: outputPath,
        quad: quad,
        quality: quality,
        maxDim: maxDim
      )
    }

    // 等比缩放到最长边 maxDim（不放大）
    AsyncFunction("resizeFile") {
      (inputPath: String, outputPath: String, maxDim: Int, quality: Int) -> [String: Any] in
      try resizeFile(
        inputPath: inputPath,
        outputPath: outputPath,
        maxDim: maxDim,
        quality: quality
      )
    }

    // 顺时针旋转 90 / 180 / 270
    AsyncFunction("rotateFile") {
      (inputPath: String, outputPath: String, degrees: Int, quality: Int) -> [String: Any] in
      try rotateFile(
        inputPath: inputPath,
        outputPath: outputPath,
        degrees: degrees,
        quality: quality
      )
    }

    // 一页一张图直接写 PDF：不经过 HTML / WebView，几百毫秒即可完成
    AsyncFunction("createPdf") {
      (inputPaths: [String], outputPath: String, pageWidth: Int, pageHeight: Int) -> Int in
      try createPdf(
        inputPaths: inputPaths,
        outputPath: outputPath,
        pageWidth: pageWidth,
        pageHeight: pageHeight
      )
    }

    // 端侧文档四角检测（Vision）：path 不带 file://，与 Android detectFile 同契约
    AsyncFunction("detectFile") { (path: String) -> [String: Any]? in
      DocumentRectDetector.detectFile(path: path)?.dictionary
    }

    // JS 侧需要同步判断能否渲染原生取景组件
    Function("isCameraAvailable") { true }

    // 实时相机取景：AVCaptureSession 预览 + 帧分析 + 拍照
    View(ImageCoreCameraView.self) {
      Events("onQuad", "onError")
      OnViewDidUpdateProps { (view: ImageCoreCameraView) in
        view.startSessionIfNeeded()
      }
      AsyncFunction("takePicture") { (view: ImageCoreCameraView) async throws -> [String: Any] in
        try await view.takePicture()
      }
    }
  }

  private func createPdf(
    inputPaths: [String],
    outputPath: String,
    pageWidth: Int,
    pageHeight: Int
  ) throws -> Int {
    guard !inputPaths.isEmpty else {
      throw ImageCoreError.noPages
    }
    let startedAt = CFAbsoluteTimeGetCurrent()
    let bounds = CGRect(x: 0, y: 0, width: pageWidth, height: pageHeight)
    // 与 Android decodeForPdf 一致：PDF 一页最多 1600px，
    // 解码时直接降到 2 倍页宽，避免整页原图（12 MP ≈ 48 MB）进内存
    let maxPixel = max(pageWidth, pageHeight, 1) * 2
    let renderer = UIGraphicsPDFRenderer(bounds: bounds)
    var drawn = 0
    var failedPath: String?

    let data = renderer.pdfData { context in
      for path in inputPaths {
        if failedPath != nil {
          break
        }
        // 逐页解码：autoreleasepool 保证上一页的位图在这里就释放
        autoreleasepool {
          guard let image = downsampledImage(path, maxPixel: maxPixel) else {
            failedPath = path
            return
          }
          let imageWidth = CGFloat(image.cgImage?.width ?? Int(image.size.width))
          let imageHeight = CGFloat(image.cgImage?.height ?? Int(image.size.height))
          guard imageWidth > 0, imageHeight > 0 else {
            failedPath = path
            return
          }
          context.beginPage()
          UIColor.white.setFill()
          context.fill(bounds)
          let scale = min(bounds.width / imageWidth, bounds.height / imageHeight)
          let width = imageWidth * scale
          let height = imageHeight * scale
          image.draw(
            in: CGRect(
              x: (bounds.width - width) / 2,
              y: (bounds.height - height) / 2,
              width: width,
              height: height
            )
          )
          drawn += 1
        }
      }
    }

    if let path = failedPath {
      throw ImageCoreError.decodeFailed(path)
    }
    try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    NSLog(
      "[image-core] createPdf %ldp %.0fms",
      drawn,
      (CFAbsoluteTimeGetCurrent() - startedAt) * 1000
    )
    return drawn
  }

  /**
   * 用 ImageIO 直接按目标像素尺寸解码（缩略图通道），
   * 不先把整张原图读成位图。会顺带应用 EXIF 方向。
   */
  private func downsampledImage(_ path: String, maxPixel: Int) -> UIImage? {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil) else {
      return nil
    }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard
      let image = CGImageSourceCreateThumbnailAtIndex(
        source,
        0,
        options as CFDictionary
      )
    else {
      return nil
    }
    return UIImage(cgImage: image)
  }

  // MARK: - 几何变换（裁剪 / 缩放 / 旋转）

  // 算法在共享 C++ 核心（modules/image-core/common/image_core.cpp），
  // 这里只负责把图片解码成 0xAARRGGBB 像素、调 C 桥、再编码回 JPEG。

  private func warpFile(
    inputPath: String,
    outputPath: String,
    quad: [Double],
    quality: Int,
    maxDim: Int
  ) throws -> [String: Any] {
    guard quad.count == 8 else {
      throw ImageCoreError.invalidQuad
    }
    let startedAt = CFAbsoluteTimeGetCurrent()
    let (width, height, pixels) = try decodePixels(inputPath)
    let decodeMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1000

    var outWidth: Int32 = 0
    var outHeight: Int32 = 0
    var sizeResult: Int32 = 0
    quad.withUnsafeBufferPointer { buffer in
      sizeResult = ImageCoreWarpSize(
        Int32(width),
        Int32(height),
        buffer.baseAddress,
        Int32(maxDim),
        &outWidth,
        &outHeight
      )
    }
    guard sizeResult == 0 else {
      throw ImageCoreError.processFailed
    }
    let dstWidth = max(8, Int(outWidth))
    let dstHeight = max(8, Int(outHeight))

    var dst = [UInt32](repeating: 0, count: dstWidth * dstHeight)
    let processStartedAt = CFAbsoluteTimeGetCurrent()
    let processResult = pixels.withUnsafeBufferPointer { src in
      dst.withUnsafeMutableBufferPointer { out in
        quad.withUnsafeBufferPointer { q in
          ImageCoreWarp(
            src.baseAddress,
            Int32(width),
            Int32(height),
            out.baseAddress,
            Int32(dstWidth),
            Int32(dstHeight),
            q.baseAddress
          )
        }
      }
    }
    let processMs = (CFAbsoluteTimeGetCurrent() - processStartedAt) * 1000
    guard processResult == 0 else {
      throw ImageCoreError.processFailed
    }

    let encodeMs = try writeJpeg(
      dst,
      width: dstWidth,
      height: dstHeight,
      outputPath: outputPath,
      quality: quality
    )
    return timings(
      width: dstWidth,
      height: dstHeight,
      decodeMs: decodeMs,
      processMs: processMs,
      encodeMs: encodeMs,
      totalMs: (CFAbsoluteTimeGetCurrent() - startedAt) * 1000,
      op: "warp"
    )
  }

  private func resizeFile(
    inputPath: String,
    outputPath: String,
    maxDim: Int,
    quality: Int
  ) throws -> [String: Any] {
    let startedAt = CFAbsoluteTimeGetCurrent()
    let (width, height, pixels) = try decodePixels(inputPath)
    let decodeMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1000

    var outWidth: Int32 = 0
    var outHeight: Int32 = 0
    guard
      ImageCoreResizeSize(
        Int32(width),
        Int32(height),
        Int32(maxDim),
        &outWidth,
        &outHeight
      ) == 0
    else {
      throw ImageCoreError.processFailed
    }
    let dstWidth = max(1, Int(outWidth))
    let dstHeight = max(1, Int(outHeight))

    var dst = [UInt32](repeating: 0, count: dstWidth * dstHeight)
    let processStartedAt = CFAbsoluteTimeGetCurrent()
    let processResult = pixels.withUnsafeBufferPointer { src in
      dst.withUnsafeMutableBufferPointer { out in
        ImageCoreResize(
          src.baseAddress,
          Int32(width),
          Int32(height),
          out.baseAddress,
          Int32(dstWidth),
          Int32(dstHeight)
        )
      }
    }
    let processMs = (CFAbsoluteTimeGetCurrent() - processStartedAt) * 1000
    guard processResult == 0 else {
      throw ImageCoreError.processFailed
    }

    let encodeMs = try writeJpeg(
      dst,
      width: dstWidth,
      height: dstHeight,
      outputPath: outputPath,
      quality: quality
    )
    return timings(
      width: dstWidth,
      height: dstHeight,
      decodeMs: decodeMs,
      processMs: processMs,
      encodeMs: encodeMs,
      totalMs: (CFAbsoluteTimeGetCurrent() - startedAt) * 1000,
      op: "resize"
    )
  }

  private func rotateFile(
    inputPath: String,
    outputPath: String,
    degrees: Int,
    quality: Int
  ) throws -> [String: Any] {
    let normalized = ((degrees % 360) + 360) % 360
    guard normalized == 90 || normalized == 180 || normalized == 270 else {
      throw ImageCoreError.invalidDegrees
    }
    let startedAt = CFAbsoluteTimeGetCurrent()
    let (width, height, pixels) = try decodePixels(inputPath)
    let decodeMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1000

    let swap = normalized != 180
    let dstWidth = swap ? height : width
    let dstHeight = swap ? width : height

    var dst = [UInt32](repeating: 0, count: dstWidth * dstHeight)
    let processStartedAt = CFAbsoluteTimeGetCurrent()
    let processResult = pixels.withUnsafeBufferPointer { src in
      dst.withUnsafeMutableBufferPointer { out in
        ImageCoreRotate(
          src.baseAddress,
          Int32(width),
          Int32(height),
          out.baseAddress,
          Int32(normalized)
        )
      }
    }
    let processMs = (CFAbsoluteTimeGetCurrent() - processStartedAt) * 1000
    guard processResult == 0 else {
      throw ImageCoreError.processFailed
    }

    let encodeMs = try writeJpeg(
      dst,
      width: dstWidth,
      height: dstHeight,
      outputPath: outputPath,
      quality: quality
    )
    return timings(
      width: dstWidth,
      height: dstHeight,
      decodeMs: decodeMs,
      processMs: processMs,
      encodeMs: encodeMs,
      totalMs: (CFAbsoluteTimeGetCurrent() - startedAt) * 1000,
      op: "rotate"
    )
  }

  // premultipliedFirst + little endian => 内存里每个 UInt32 是 0xAARRGGBB，
  // 与 Android 的 Int 像素格式一致，共用同一份 C++ 核心
  private var pixelBitmapInfo: UInt32 {
    CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
  }

  /** 解码成 0xAARRGGBB 像素（行 0 = 图片顶部） */
  private func decodePixels(
    _ path: String
  ) throws -> (width: Int, height: Int, pixels: [UInt32]) {
    let image = try uprightImage(path)
    let width = image.width
    let height = image.height
    var pixels = [UInt32](repeating: 0, count: width * height)
    try pixels.withUnsafeMutableBytes { raw in
      guard
        let context = CGContext(
          data: raw.baseAddress,
          width: width,
          height: height,
          bitsPerComponent: 8,
          bytesPerRow: width * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: pixelBitmapInfo
        )
      else {
        throw ImageCoreError.processFailed
      }
      // uprightImage 返回 (宽, 高, 转正后的 CGImage) 元组
      context.draw(image.image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }
    return (width, height, pixels)
  }

  /**
   * 按 EXIF 方向转正后的 CGImage 与尺寸。
   *
   * `UIImage.cgImage` 是传感器原始方向，而渲染端（RN Image）会按 EXIF 摆正；
   * 裁剪/缩放/滤镜必须用同一套方向，否则竖拍照片会整体偏 90°。
   * 输出 JPEG 不带 EXIF，转正后不会再被转第二次。
   */
  private func uprightImage(
    _ path: String
  ) throws -> (width: Int, height: Int, image: CGImage) {
    guard
      let source = UIImage(contentsOfFile: path),
      let cgImage = source.cgImage
    else {
      throw ImageCoreError.decodeFailed(path)
    }

    let swaps = [.left, .right, .leftMirrored, .rightMirrored]
      .contains(source.imageOrientation)
    let width = swaps ? cgImage.height : cgImage.width
    let height = swaps ? cgImage.width : cgImage.height
    if source.imageOrientation == .up {
      return (width, height, cgImage)
    }

    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true
    let size = CGSize(width: CGFloat(width), height: CGFloat(height))
    let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
      source.draw(in: CGRect(origin: .zero, size: size))
    }
    guard let upright = rendered.cgImage else {
      throw ImageCoreError.decodeFailed(path)
    }
    return (width, height, upright)
  }

  /** 把像素写成 JPEG，返回编码耗时（毫秒） */
  private func writeJpeg(
    _ pixels: [UInt32],
    width: Int,
    height: Int,
    outputPath: String,
    quality: Int
  ) throws -> Double {
    var buffer = pixels
    let startedAt = CFAbsoluteTimeGetCurrent()
    var data: Data?
    try buffer.withUnsafeMutableBytes { raw in
      guard
        let context = CGContext(
          data: raw.baseAddress,
          width: width,
          height: height,
          bitsPerComponent: 8,
          bytesPerRow: width * 4,
          space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: pixelBitmapInfo
        ),
        let image = context.makeImage()
      else {
        throw ImageCoreError.processFailed
      }
      data = UIImage(cgImage: image).jpegData(
        compressionQuality: CGFloat(max(1, min(100, quality))) / 100.0
      )
    }
    guard let output = data else {
      throw ImageCoreError.processFailed
    }
    try output.write(to: URL(fileURLWithPath: outputPath), options: .atomic)
    return (CFAbsoluteTimeGetCurrent() - startedAt) * 1000
  }

  private func timings(
    width: Int,
    height: Int,
    decodeMs: Double,
    processMs: Double,
    encodeMs: Double,
    totalMs: Double,
    op: String
  ) -> [String: Any] {
    return [
      "width": width,
      "height": height,
      "decodeMs": Int(decodeMs),
      "processMs": Int(processMs),
      "encodeMs": Int(encodeMs),
      "totalMs": Int(totalMs),
      "filter": op,
    ]
  }

  private func processFile(
    inputPath: String,
    outputPath: String,
    filter: String,
    quality: Int,
    contrast: Int,
    brightness: Int,
    detail: Int
  ) throws -> [String: Any] {
    let startedAt = CFAbsoluteTimeGetCurrent()

    // 与 decodePixels 用同一套方向：滤镜和裁剪看到的像素必须一致，
    // 否则带 EXIF 的竖拍原图经过滤镜会被整体转 90°
    let upright = try uprightImage(inputPath)
    let image = upright.image
    let width = upright.width
    let height = upright.height
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    // premultipliedFirst + little endian => 内存里每个 UInt32 是 0xAARRGGBB，
    // 与 Android 的 Int 像素格式一致，共用同一份 C++ 核心
    let bitmapInfo =
      CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

    var pixels = [UInt32](repeating: 0, count: width * height)

    var decodeMs = 0.0
    var processMs = 0.0
    var encodeMs = 0.0

    let outputData: Data? = pixels.withUnsafeMutableBytes { raw -> Data? in
      guard
        let context = CGContext(
          data: raw.baseAddress,
          width: width,
          height: height,
          bitsPerComponent: 8,
          bytesPerRow: width * 4,
          space: colorSpace,
          bitmapInfo: bitmapInfo
        )
      else {
        return nil
      }

      context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
      // 解码耗时要把绘制算进去（CGContext.draw 才是真正的像素转换）
      decodeMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1000

      let processStartedAt = CFAbsoluteTimeGetCurrent()
      let result: Int32
      if contrast == 0 && brightness == 0 && detail == 0 {
        result = ImageCoreProcessPixels(
          raw.baseAddress?.assumingMemoryBound(to: UInt32.self),
          Int32(width),
          Int32(height),
          Int32(filterId(of: filter))
        )
      } else {
        result = ImageCoreProcessPixelsEx(
          raw.baseAddress?.assumingMemoryBound(to: UInt32.self),
          Int32(width),
          Int32(height),
          Int32(filterId(of: filter)),
          Int32(max(-50, min(50, contrast))),
          Int32(max(-50, min(50, brightness))),
          Int32(max(0, min(100, detail)))
        )
      }
      processMs = (CFAbsoluteTimeGetCurrent() - processStartedAt) * 1000
      guard result == 0 else {
        return nil
      }

      guard let outputImage = context.makeImage() else {
        return nil
      }

      let encodeStartedAt = CFAbsoluteTimeGetCurrent()
      let data = UIImage(cgImage: outputImage).jpegData(
        compressionQuality: CGFloat(max(1, min(100, quality))) / 100.0
      )
      encodeMs = (CFAbsoluteTimeGetCurrent() - encodeStartedAt) * 1000
      return data
    }

    guard let data = outputData else {
      throw ImageCoreError.processFailed
    }

    try data.write(to: URL(fileURLWithPath: outputPath), options: .atomic)

    return [
      "width": width,
      "height": height,
      "decodeMs": Int(decodeMs),
      "processMs": Int(processMs),
      "encodeMs": Int(encodeMs),
      "totalMs": Int((CFAbsoluteTimeGetCurrent() - startedAt) * 1000),
      "filter": filter,
    ]
  }

  // 与 src/lib/filters.ts 的 FilterKey 一一对应
  private func filterId(of filter: String) -> Int32 {
    switch filter {
    case "gray": return 1
    case "bw": return 2
    case "enhance": return 3
    case "shadow": return 4
    case "dehand": return 5
    case "hd": return 6
    case "brighten": return 7
    case "sharpen": return 8
    case "inksave": return 9
    case "invert": return 10
    default: return 0
    }
  }
}

enum ImageCoreError: Error {
  case decodeFailed(String)
  case processFailed
  case noPages
  case invalidQuad
  case invalidDegrees
}
