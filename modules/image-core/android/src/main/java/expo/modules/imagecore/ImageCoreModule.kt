package expo.modules.imagecore

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream

class ImageCoreModule : Module() {
  init {
    System.loadLibrary("image_core")
  }

  // JNI 实现在 src/main/cpp/jni_bridge.cpp
  private external fun nativeProcessPixels(
    pixels: IntArray,
    width: Int,
    height: Int,
    filter: Int
  ): Int

  private external fun nativeVersion(): String

  override fun definition() = ModuleDefinition {
    Name("ImageCore")

    Function("version") { nativeVersion() }

    AsyncFunction("processFile") {
      inputPath: String,
      outputPath: String,
      filter: String,
      quality: Int ->
      processFile(inputPath, outputPath, filter, quality)
    }
  }

  private fun processFile(
    inputPath: String,
    outputPath: String,
    filter: String,
    quality: Int
  ): Map<String, Any> {
    val startedAt = SystemClock.elapsedRealtime()

    val options = BitmapFactory.Options().apply {
      inPreferredConfig = Bitmap.Config.ARGB_8888
      // 原地修改像素，省掉第二张 Bitmap 的内存
      inMutable = true
    }
    val bitmap = BitmapFactory.decodeFile(inputPath, options)
      ?: throw IllegalArgumentException("无法解码图片: $inputPath")

    val width = bitmap.width
    val height = bitmap.height

    try {
      val decodeMs = SystemClock.elapsedRealtime() - startedAt

      val pixels = IntArray(width * height)
      bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

      val processStartedAt = SystemClock.elapsedRealtime()
      val result = nativeProcessPixels(pixels, width, height, filterIdOf(filter))
      check(result == 0) { "native 处理失败，错误码 $result" }
      val processMs = SystemClock.elapsedRealtime() - processStartedAt

      bitmap.setPixels(pixels, 0, width, 0, 0, width, height)

      File(outputPath).parentFile?.mkdirs()
      val encodeStartedAt = SystemClock.elapsedRealtime()
      FileOutputStream(outputPath).use { stream ->
        check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), stream)) {
          "JPEG 编码失败: $outputPath"
        }
      }
      val encodeMs = SystemClock.elapsedRealtime() - encodeStartedAt

      return mapOf(
        "width" to width,
        "height" to height,
        "decodeMs" to decodeMs,
        "processMs" to processMs,
        "encodeMs" to encodeMs,
        "totalMs" to (SystemClock.elapsedRealtime() - startedAt),
        "filter" to filter
      )
    } finally {
      bitmap.recycle()
    }
  }

  private fun filterIdOf(filter: String): Int = when (filter) {
    "gray" -> 1
    "bw" -> 2
    "enhance" -> 3
    else -> 0
  }
}
