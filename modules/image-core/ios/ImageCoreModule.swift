import CoreGraphics
import ExpoModulesCore
import Foundation
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
        quality: quality
      )
    }
  }

  private func processFile(
    inputPath: String,
    outputPath: String,
    filter: String,
    quality: Int
  ) throws -> [String: Any] {
    let startedAt = CFAbsoluteTimeGetCurrent()

    guard let image = UIImage(contentsOfFile: inputPath)?.cgImage else {
      throw ImageCoreError.decodeFailed(inputPath)
    }

    let width = image.width
    let height = image.height
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    // premultipliedFirst + little endian => 内存里每个 UInt32 是 0xAARRGGBB，
    // 与 Android 的 Int 像素格式一致，共用同一份 C++ 核心
    let bitmapInfo =
      CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue

    var pixels = [UInt32](repeating: 0, count: width * height)
    let decodeMs = (CFAbsoluteTimeGetCurrent() - startedAt) * 1000

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

      let processStartedAt = CFAbsoluteTimeGetCurrent()
      let result = ImageCoreProcessPixels(
        raw.baseAddress?.assumingMemoryBound(to: UInt32.self),
        Int32(width),
        Int32(height),
        Int32(filterId(of: filter))
      )
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

  private func filterId(of filter: String) -> Int32 {
    switch filter {
    case "gray": return 1
    case "bw": return 2
    case "enhance": return 3
    default: return 0
    }
  }
}

enum ImageCoreError: Error {
  case decodeFailed(String)
  case processFailed
}
