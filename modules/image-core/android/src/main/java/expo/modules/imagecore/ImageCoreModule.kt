package expo.modules.imagecore

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.pdf.PdfDocument
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.min

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

  private external fun nativeProcessPixelsEx(
    pixels: IntArray,
    width: Int,
    height: Int,
    filter: Int,
    contrast: Int,
    brightness: Int,
    detail: Int
  ): Int

  private external fun nativeVersion(): String

  // 几何变换：共享 C++ 里实现（modules/image-core/common/image_core.cpp）
  private external fun nativeWarpSize(
    srcWidth: Int,
    srcHeight: Int,
    quad: DoubleArray,
    maxDim: Int
  ): IntArray

  private external fun nativeWarp(
    src: IntArray,
    srcWidth: Int,
    srcHeight: Int,
    dst: IntArray,
    dstWidth: Int,
    dstHeight: Int,
    quad: DoubleArray
  ): Int

  private external fun nativeResizeSize(
    srcWidth: Int,
    srcHeight: Int,
    maxDim: Int
  ): IntArray

  private external fun nativeResize(
    src: IntArray,
    srcWidth: Int,
    srcHeight: Int,
    dst: IntArray,
    dstWidth: Int,
    dstHeight: Int
  ): Int

  private external fun nativeRotate(
    src: IntArray,
    srcWidth: Int,
    srcHeight: Int,
    dst: IntArray,
    degrees: Int
  ): Int

  override fun definition() = ModuleDefinition {
    Name("ImageCore")

    Function("version") { nativeVersion() }

    // 按 EXIF 转正后的像素尺寸（与 RN Image 实际显示的方向一致）。
    // JS 的 Image.getSize 给的是文件里的原始宽高，竖拍照片会差 90°。
    AsyncFunction("imageSize") { path: String ->
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(path, bounds)
      val rawWidth = bounds.outWidth
      val rawHeight = bounds.outHeight
      require(rawWidth > 0 && rawHeight > 0) { "无法读取图片尺寸: $path" }
      val swap = DocCornerDetector.swapsDimensions(
        DocCornerDetector.readExifOrientation(path)
      )
      mapOf(
        "width" to if (swap) rawHeight else rawWidth,
        "height" to if (swap) rawWidth else rawHeight,
      )
    }

    AsyncFunction("processFile") {
      inputPath: String,
      outputPath: String,
      filter: String,
      quality: Int ->
      processFile(inputPath, outputPath, filter, quality, 0, 0, 0)
    }

    // 第二步微调：对比度/亮度 -50..50，细节 0..100
    AsyncFunction("processFileEx") {
      inputPath: String,
      outputPath: String,
      filter: String,
      quality: Int,
      contrast: Int,
      brightness: Int,
      detail: Int ->
      processFile(
        inputPath,
        outputPath,
        filter,
        quality,
        contrast,
        brightness,
        detail
      )
    }

    // 四角透视裁剪：quad 为 8 个归一化坐标 TL,TR,BR,BL
    AsyncFunction("warpFile") {
      inputPath: String,
      outputPath: String,
      quad: List<Double>,
      quality: Int,
      maxDim: Int ->
      require(quad.size == 8) { "quad 需要 8 个归一化坐标" }
      val startedAt = SystemClock.elapsedRealtime()
      val bitmap = decodeBitmap(inputPath)
      val decodeMs = SystemClock.elapsedRealtime() - startedAt
      try {
        val width = bitmap.width
        val height = bitmap.height
        val array = quad.toDoubleArray()
        val size = nativeWarpSize(width, height, array, maxDim)
        val dstWidth = size[0].coerceAtLeast(8)
        val dstHeight = size[1].coerceAtLeast(8)

        val src = IntArray(width * height)
        bitmap.getPixels(src, 0, width, 0, 0, width, height)

        val processStartedAt = SystemClock.elapsedRealtime()
        val dst = IntArray(dstWidth * dstHeight)
        check(
          nativeWarp(src, width, height, dst, dstWidth, dstHeight, array) == 0
        ) { "native 透视校正失败" }
        val processMs = SystemClock.elapsedRealtime() - processStartedAt

        val output = Bitmap.createBitmap(dstWidth, dstHeight, Bitmap.Config.ARGB_8888)
        output.setPixels(dst, 0, dstWidth, 0, 0, dstWidth, dstHeight)
        val encodeMs = writeJpeg(output, outputPath, quality)
        output.recycle()

        return@AsyncFunction timings(
          dstWidth,
          dstHeight,
          decodeMs,
          processMs,
          encodeMs,
          SystemClock.elapsedRealtime() - startedAt,
          "warp"
        )
      } finally {
        bitmap.recycle()
      }
    }

    // 等比缩放到最长边 maxDim（不放大）
    AsyncFunction("resizeFile") {
      inputPath: String,
      outputPath: String,
      maxDim: Int,
      quality: Int ->
      val startedAt = SystemClock.elapsedRealtime()
      val bitmap = decodeBitmap(inputPath)
      val decodeMs = SystemClock.elapsedRealtime() - startedAt
      try {
        val width = bitmap.width
        val height = bitmap.height
        val size = nativeResizeSize(width, height, maxDim)
        val dstWidth = size[0].coerceAtLeast(1)
        val dstHeight = size[1].coerceAtLeast(1)

        val src = IntArray(width * height)
        bitmap.getPixels(src, 0, width, 0, 0, width, height)

        val processStartedAt = SystemClock.elapsedRealtime()
        val dst = IntArray(dstWidth * dstHeight)
        check(nativeResize(src, width, height, dst, dstWidth, dstHeight) == 0) {
          "native 缩放失败"
        }
        val processMs = SystemClock.elapsedRealtime() - processStartedAt

        val output = Bitmap.createBitmap(dstWidth, dstHeight, Bitmap.Config.ARGB_8888)
        output.setPixels(dst, 0, dstWidth, 0, 0, dstWidth, dstHeight)
        val encodeMs = writeJpeg(output, outputPath, quality)
        output.recycle()

        return@AsyncFunction timings(
          dstWidth,
          dstHeight,
          decodeMs,
          processMs,
          encodeMs,
          SystemClock.elapsedRealtime() - startedAt,
          "resize"
        )
      } finally {
        bitmap.recycle()
      }
    }

    // 顺时针旋转 90 / 180 / 270
    AsyncFunction("rotateFile") {
      inputPath: String,
      outputPath: String,
      degrees: Int,
      quality: Int ->
      val normalized = ((degrees % 360) + 360) % 360
      require(normalized == 90 || normalized == 180 || normalized == 270) {
        "旋转角度只支持 90 / 180 / 270"
      }
      val startedAt = SystemClock.elapsedRealtime()
      val bitmap = decodeBitmap(inputPath)
      val decodeMs = SystemClock.elapsedRealtime() - startedAt
      try {
        val width = bitmap.width
        val height = bitmap.height
        val swap = normalized != 180
        val dstWidth = if (swap) height else width
        val dstHeight = if (swap) width else height

        val src = IntArray(width * height)
        bitmap.getPixels(src, 0, width, 0, 0, width, height)

        val processStartedAt = SystemClock.elapsedRealtime()
        val dst = IntArray(dstWidth * dstHeight)
        check(nativeRotate(src, width, height, dst, normalized) == 0) {
          "native 旋转失败"
        }
        val processMs = SystemClock.elapsedRealtime() - processStartedAt

        val output = Bitmap.createBitmap(dstWidth, dstHeight, Bitmap.Config.ARGB_8888)
        output.setPixels(dst, 0, dstWidth, 0, 0, dstWidth, dstHeight)
        val encodeMs = writeJpeg(output, outputPath, quality)
        output.recycle()

        return@AsyncFunction timings(
          dstWidth,
          dstHeight,
          decodeMs,
          processMs,
          encodeMs,
          SystemClock.elapsedRealtime() - startedAt,
          "rotate"
        )
      } finally {
        bitmap.recycle()
      }
    }

    // 一页一张图直接写 PDF：不经过 HTML / WebView，几百毫秒即可完成
    AsyncFunction("createPdf") {
      inputPaths: List<String>,
      outputPath: String,
      pageWidth: Int,
      pageHeight: Int ->
      createPdf(inputPaths, outputPath, pageWidth, pageHeight)
    }

    // 端侧文档四角检测（DocCornerNet）：path 不带 file://
    AsyncFunction("detectFile") { path: String ->
      val reactContext = appContext.reactContext
        ?: throw IllegalStateException("React context 不可用")
      DocCornerDetector.detectFile(reactContext, path)?.let { detected ->
        mapOf(
          "quad" to detected.toQuadMap(),
          "confidence" to detected.confidence
        )
      }
    }

    // JS 侧需要同步判断能否渲染原生取景组件（启动时就要决定）
    Function("isCameraAvailable") { true }

    // 实时相机取景：CameraX 预览 + 帧分析 + 拍照，全部在原生侧完成
    View(ImageCoreCameraView::class) {
      Events("onQuad", "onError")
      // 视野内的 AsyncFunction 会被强制放到 MAIN 线程，拍照必须走 promise，不能同步等待
      AsyncFunction("takePicture") { view: ImageCoreCameraView, promise: Promise ->
        view.takePicture(promise)
      }
      OnViewDestroys { view ->
        view.destroy()
      }
    }
  }

  private fun createPdf(
    inputPaths: List<String>,
    outputPath: String,
    pageWidth: Int,
    pageHeight: Int
  ): Int {
    require(inputPaths.isNotEmpty()) { "至少需要一张图片" }
    val startedAt = SystemClock.elapsedRealtime()
    // 以 2 倍页面尺寸解码：足够印刷，又不会把整张原图读进内存
    val targetDim = max(pageWidth, pageHeight) * 2
    val document = PdfDocument()
    try {
      inputPaths.forEachIndexed { index, path ->
        val bitmap = decodeForPdf(path, targetDim)
        try {
          val pageInfo = PdfDocument.PageInfo.Builder(pageWidth, pageHeight, index + 1).create()
          val page = document.startPage(pageInfo)
          val canvas = page.canvas
          canvas.drawColor(Color.WHITE)
          val scale = min(
            pageWidth.toFloat() / bitmap.width,
            pageHeight.toFloat() / bitmap.height
          )
          val drawWidth = bitmap.width * scale
          val drawHeight = bitmap.height * scale
          val left = (pageWidth - drawWidth) / 2f
          val top = (pageHeight - drawHeight) / 2f
          canvas.drawBitmap(
            bitmap,
            null,
            RectF(left, top, left + drawWidth, top + drawHeight),
            Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
          )
          document.finishPage(page)
        } finally {
          bitmap.recycle()
        }
      }
      File(outputPath).parentFile?.mkdirs()
      FileOutputStream(outputPath).use { document.writeTo(it) }
    } finally {
      document.close()
    }
    android.util.Log.i(
      "image-core",
      "createPdf ${inputPaths.size}p ${SystemClock.elapsedRealtime() - startedAt}ms"
    )
    return inputPaths.size
  }

  private fun decodeForPdf(path: String, targetDim: Int): Bitmap {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    require(bounds.outWidth > 0 && bounds.outHeight > 0) { "无法解码图片: $path" }
    var sampleSize = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sampleSize * 2) >= targetDim) {
      sampleSize *= 2
    }
    val options = BitmapFactory.Options().apply {
      inSampleSize = sampleSize
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    val decoded = BitmapFactory.decodeFile(path, options)
      ?: throw IllegalArgumentException("无法解码图片: $path")
    // 老记录里的源图可能还带 EXIF 方向
    val upright = DocCornerDetector.applyExifOrientation(path, decoded)
    if (upright !== decoded) decoded.recycle()
    return upright
  }

  private fun processFile(
    inputPath: String,
    outputPath: String,
    filter: String,
    quality: Int,
    contrast: Int,
    brightness: Int,
    detail: Int
  ): Map<String, Any> {
    val startedAt = SystemClock.elapsedRealtime()

    // 和裁剪/缩放共用解码：同样把 EXIF 方向烘进像素
    val bitmap = decodeBitmap(inputPath)

    val width = bitmap.width
    val height = bitmap.height

    try {
      val decodeMs = SystemClock.elapsedRealtime() - startedAt

      val pixels = IntArray(width * height)
      bitmap.getPixels(pixels, 0, width, 0, 0, width, height)

      val processStartedAt = SystemClock.elapsedRealtime()
      val result = nativeProcessPixelsEx(
        pixels,
        width,
        height,
        filterIdOf(filter),
        contrast.coerceIn(-50, 50),
        brightness.coerceIn(-50, 50),
        detail.coerceIn(0, 100)
      )
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

  /**
   * 解码成 ARGB 位图，并把 EXIF 方向烘进像素。
   *
   * 渲染端（RN Image）会按 EXIF 把照片摆正，像素运算必须用同一套方向：
   * 否则 8/1 号方向照片的裁剪框、缩放、滤镜全部会偏 90°。
   * 输出 JPEG 不带 EXIF，所以这里转正后不会再被转一次。
   */
  private fun decodeBitmap(path: String): Bitmap {
    val decoded = BitmapFactory.decodeFile(
      path,
      BitmapFactory.Options().apply {
        inPreferredConfig = Bitmap.Config.ARGB_8888
        inMutable = true
      }
    ) ?: throw IllegalArgumentException("无法解码图片: $path")

    val upright = DocCornerDetector.applyExifOrientation(path, decoded)
    if (upright !== decoded) decoded.recycle()
    return upright
  }

  /** 写 JPEG，返回耗时；调用方负责 recycle */
  private fun writeJpeg(bitmap: Bitmap, outputPath: String, quality: Int): Long {
    File(outputPath).parentFile?.mkdirs()
    val startedAt = SystemClock.elapsedRealtime()
    FileOutputStream(outputPath).use { stream ->
      check(bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(1, 100), stream)) {
        "JPEG 编码失败: $outputPath"
      }
    }
    return SystemClock.elapsedRealtime() - startedAt
  }

  private fun timings(
    width: Int,
    height: Int,
    decodeMs: Long,
    processMs: Long,
    encodeMs: Long,
    totalMs: Long,
    op: String
  ): Map<String, Any> = mapOf(
    "width" to width,
    "height" to height,
    "decodeMs" to decodeMs,
    "processMs" to processMs,
    "encodeMs" to encodeMs,
    "totalMs" to totalMs,
    "filter" to op
  )

  // 与 src/lib/filters.ts 的 FilterKey 一一对应
  private fun filterIdOf(filter: String): Int = when (filter) {
    "gray" -> 1
    "bw" -> 2
    "enhance" -> 3
    "shadow" -> 4
    "dehand" -> 5
    "hd" -> 6
    "brighten" -> 7
    "sharpen" -> 8
    "inksave" -> 9
    "invert" -> 10
    else -> 0
  }
}
