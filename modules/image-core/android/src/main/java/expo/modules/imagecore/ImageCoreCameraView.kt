package expo.modules.imagecore

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.os.SystemClock
import android.util.Log
import android.util.Size
import android.view.Surface
import android.view.View
import android.view.View.MeasureSpec
import android.view.ViewGroup
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.exifinterface.media.ExifInterface
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.Promise
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.min

/**
 * 实时文档取景视图。
 *
 * 预览、拍照、帧分析都在原生侧完成（expo-camera 不暴露视频帧）：
 *   - PreviewView 负责画面
 *   - ImageAnalysis 以 ~8fps 把 RGBA 帧交给 DocCornerDetector
 *   - 四角换算成「预览视图归一化坐标」后通过 onQuad 事件回传 JS
 *   - ImageCapture 拍照，写盘后按 EXIF 物理转正
 */
class LiveQuadEvent(
  @Field val detected: Boolean,
  /** 8 个视图归一化坐标 TL,TR,BR,BL；未检测到时为 null */
  @Field val quad: List<Float>?,
  @Field val confidence: Float,
) : Record

/**
 * 相机/模型侧的失败信息。JS 只在开发构建里提示，正式包静默降级：
 * 相机预览和拍照永远不依赖检测模型。
 */
class CameraIssueEvent(
  /** `camera` | `model` */
  @Field val kind: String,
  @Field val message: String,
) : Record

@SuppressLint("ViewConstructor")
class ImageCoreCameraView(
  context: Context,
  appContext: AppContext,
) : ExpoView(context, appContext) {
  private val onQuad by EventDispatcher<LiveQuadEvent>()
  private val onError by EventDispatcher<CameraIssueEvent>()

  private val previewView = PreviewView(context).apply {
    // FIT_CENTER：整幅相机画面等比缩进视图（上下留黑边），所见即所拍。
    // FILL_CENTER 会为了铺满超高屏裁掉左右约 40%，拍照却按整幅 4:3 存盘，
    // 于是「预览里看不到的，拍完却拍进来了」——取景框和成片对不上。
    scaleType = PreviewView.ScaleType.FIT_CENTER
    setBackgroundColor(android.graphics.Color.BLACK)
    elevation = 0f
  }

  private val analysisExecutor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "image-core-camera").apply { priority = Thread.NORM_PRIORITY - 1 }
  }
  private val mainExecutor = ContextCompat.getMainExecutor(context)

  private var provider: ProcessCameraProvider? = null
  private var imageCapture: ImageCapture? = null
  private var analysis: ImageAnalysis? = null

  /** 视图已销毁：异步回调回来后不要再绑定相机 */
  @Volatile private var destroyed = false

  private val inFlight = AtomicBoolean(false)
  private var lastAnalysisAt = 0L

  /** 帧像素缓冲：尺寸不变时复用 */
  private var framePixels = IntArray(0)
  private var rotatedPixels = IntArray(0)

  /** 平滑后的视图归一化四角 */
  private var smoothed: FloatArray? = null
  private var lastDetectedAt = 0L
  private var lostEmitted = false

  /** 模型初始化/推理失败后停用检测，但预览和拍照照常工作 */
  @Volatile private var modelBroken = false
  @Volatile private var modelErrorReported = false
  @Volatile private var firstFrameLogged = false
  private var lastWidth = 0
  private var lastHeight = 0
  private var lastDetDiagAt = 0L
  @Volatile private var quadEmitted = false
  /**
   * 调试：把送进模型的分析帧存盘（`files/dump-frames` 存在时存 3 帧），
   * 用于确认真机看到的画面。
   */
  @Volatile private var debugFramesToDump = if (
    runCatching {
      val dir = context.getExternalFilesDir(null) ?: context.cacheDir
      File(dir, DUMP_FRAMES_FILE).exists()
    }.getOrDefault(false)
  ) 3 else 0
  /**
   * 调试：外部文件存在时始终回传一个固定四角，
   * 用来在画面里没有文档时验证 JS 叠加层（`adb shell touch .../demo-quad`）。
   */
  private val demoQuadEnabled: Boolean by lazy {
    runCatching {
      val dir = context.getExternalFilesDir(null) ?: context.cacheDir
      File(dir, DEMO_QUAD_FILE).exists()
    }.getOrDefault(false)
  }

  init {
    runCatching {
      val dir = context.getExternalFilesDir(null) ?: context.cacheDir
      File(dir, DIAG_FILE).writeText("")
    }
    diag("view created")
    // 与 expo-camera 一致：PreviewView 的内部 Surface/Texture 是异步加进来的，
    // 加进来时父视图已经布局过了，不补一次 measure/layout 就是 0×0（黑屏）
    previewView.setOnHierarchyChangeListener(object : OnHierarchyChangeListener {
      override fun onChildViewRemoved(parent: View?, child: View?) = Unit
      override fun onChildViewAdded(parent: View?, child: View?) {
        diag("preview child added: ${child?.javaClass?.simpleName}")
        parent?.measure(
          MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
          MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY),
        )
        parent?.layout(0, 0, parent.measuredWidth, parent.measuredHeight)
      }
    })
    addView(
      previewView,
      ViewGroup.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.MATCH_PARENT,
      ),
    )
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    measureChild(previewView, widthMeasureSpec, heightMeasureSpec)
    setMeasuredDimension(
      ViewGroup.resolveSize(previewView.measuredWidth, widthMeasureSpec),
      ViewGroup.resolveSize(previewView.measuredHeight, heightMeasureSpec),
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    val width = right - left
    val height = bottom - top
    if (width != lastWidth || height != lastHeight) {
      lastWidth = width
      lastHeight = height
      previewView.layout(0, 0, width, height)
      diag("preview laid out ${width}x$height")
    }
  }

  /** React 后加的浮层必须盖在预览上面 */
  override fun onViewAdded(child: View?) {
    super.onViewAdded(child)
    if (child === previewView) return
    child?.bringToFront()
    removeView(previewView)
    addView(previewView, 0)
  }

  private fun emitIssue(kind: String, message: String) {
    if (destroyed) return
    diag("issue[$kind] $message")
    onError(CameraIssueEvent(kind, message))
  }

  /**
   * 现场诊断：真机日志被厂商过滤时，把关键状态写到文件供 adb pull。
   * 优先外部私有目录（adb shell 可直接读），拿不到再退回 cacheDir。
   */
  private fun diag(message: String) {
    try {
      val dir = context.getExternalFilesDir(null) ?: context.cacheDir
      File(dir, DIAG_FILE).appendText("${System.currentTimeMillis()} $message\n")
    } catch (_: Throwable) {
      // 诊断失败不影响相机
    }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    diag("attached")
    startCamera()
  }

  override fun onDetachedFromWindow() {
    stopCamera()
    super.onDetachedFromWindow()
  }

  /** 由模块的 OnViewDestroys 调用 */
  fun destroy() {
    destroyed = true
    stopCamera()
    analysisExecutor.shutdownNow()
  }

  private fun startCamera() {
    if (destroyed) return
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) !=
      PackageManager.PERMISSION_GRANTED
    ) {
      Log.w(TAG, "camera permission not granted")
      diag("permission not granted")
      emitIssue("camera", "camera permission not granted")
      return
    }
    val lifecycleOwner = appContext.currentActivity as? LifecycleOwner ?: run {
      Log.w(TAG, "no LifecycleOwner activity")
      emitIssue("camera", "no LifecycleOwner activity")
      return
    }
    diag("startCamera, lifecycle=${lifecycleOwner.javaClass.simpleName}")

    val future = ProcessCameraProvider.getInstance(context)
    future.addListener({
      // 回调可能在视图已卸载/销毁之后才到
      if (destroyed || !isAttachedToWindow) return@addListener
      val cameraProvider = try {
        future.get()
      } catch (t: Throwable) {
        Log.e(TAG, "camera provider unavailable", t)
        emitIssue("camera", "camera provider unavailable: ${t.message}")
        return@addListener
      }
      provider = cameraProvider
      diag("provider ready")
      bind(cameraProvider, lifecycleOwner)
    }, mainExecutor)
  }

  private fun bind(cameraProvider: ProcessCameraProvider, lifecycleOwner: LifecycleOwner) {
    val rotation = previewView.display?.rotation ?: Surface.ROTATION_0

    // 预览 / 拍照 / 分析统一 4:3：叠加层的映射假设三者画面一致（FIT_CENTER）
    val previewSelector = ResolutionSelector.Builder()
      .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
      .build()

    val preview = Preview.Builder()
      .setResolutionSelector(previewSelector)
      .build()
      .also {
        it.setSurfaceProvider(previewView.surfaceProvider)
      }

    val capture = ImageCapture.Builder()
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
      .setResolutionSelector(previewSelector)
      .build()
      .also { it.targetRotation = rotation }
    imageCapture = capture

    val analyzer = ImageAnalysis.Builder()
      .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
      .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
      .setResolutionSelector(
        ResolutionSelector.Builder()
          .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
          .setResolutionStrategy(
            ResolutionStrategy(
              Size(640, 480),
              ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER,
            ),
          )
          .build(),
      )
      .build()
      .also {
        it.targetRotation = rotation
        it.setAnalyzer(analysisExecutor, ::analyze)
      }
    analysis = analyzer

    try {
      cameraProvider.unbindAll()
      // 和 expo-camera 一样：预览必须是最底层子视图，React 的浮层才能盖在画面上
      removeView(previewView)
      addView(previewView, 0)
      val group = UseCaseGroup.Builder()
        .addUseCase(preview)
        .addUseCase(capture)
        .addUseCase(analyzer)
        .build()
      cameraProvider.bindToLifecycle(
        lifecycleOwner,
        CameraSelector.DEFAULT_BACK_CAMERA,
        group,
      )
      val previewRes = preview.resolutionInfo?.resolution
      diag(
        "bound rotation=$rotation view=${previewView.width}x${previewView.height} " +
          "preview=${previewRes?.let { "${it.width}x${it.height}" } ?: "?"}",
      )
      // 2 秒后回看一眼真实状态：真机上预览黑屏时靠这份记录定位
      previewView.postDelayed({
        val child = previewView.getChildAt(0)
        diag(
          "state attached=${previewView.isAttachedToWindow} " +
            "size=${previewView.width}x${previewView.height} " +
            "shown=${previewView.isShown} vis=${previewView.visibility} " +
            "parent=${previewView.parent != null} child=${child?.javaClass?.simpleName}",
        )
      }, 2000)
      // 首次推理要读 1.8MB 模型，提前在分析线程热身。
      // 模型失败只停用实时检测，不影响预览/拍照。
      try {
        analysisExecutor.execute {
          runCatching { DocCornerDetector.ensureSession(context) }
            .onFailure {
              Log.e(TAG, "model load failed", it)
              markModelBroken("model load failed: ${it.message}")
            }
        }
      } catch (_: Throwable) {
        // executor 已关闭（视图销毁中），忽略
      }
    } catch (t: Throwable) {
      Log.e(TAG, "bind camera failed", t)
      diag("bind failed: ${t.javaClass.simpleName}: ${t.message}")
      emitIssue("camera", "bind camera failed: ${t.message}")
    }
  }

  private fun markModelBroken(message: String) {
    modelBroken = true
    if (modelErrorReported) return
    modelErrorReported = true
    emitIssue("model", message)
  }

  private fun stopCamera() {
    runCatching { analysis?.clearAnalyzer() }
    runCatching { provider?.unbindAll() }
    analysis = null
    imageCapture = null
    provider = null
  }

  // ---- 帧分析 ----

  private fun analyze(proxy: ImageProxy) {
    try {
      val now = SystemClock.elapsedRealtime()
      if (now - lastAnalysisAt < 120) return // ~8fps
      if (!inFlight.compareAndSet(false, true)) return
      lastAnalysisAt = now
      if (!firstFrameLogged) {
        firstFrameLogged = true
        diag("first frame ${proxy.width}x${proxy.height} rot=${proxy.imageInfo.rotationDegrees}")
      }
      try {
        // 模型坏掉时只停检测：预览和拍照继续
        if (modelBroken) return

        val rotation = proxy.imageInfo.rotationDegrees
        val width = proxy.width
        val height = proxy.height
        if (width < 8 || height < 8) return

        val pixels = readArgb(proxy, width, height) ?: return
        val (upright, uprightWidth, uprightHeight) =
          rotateToUpright(pixels, width, height, rotation)
        if (debugFramesToDump > 0) {
          debugFramesToDump--
          dumpFrame(upright, uprightWidth, uprightHeight)
        }

        val detection = try {
          DocCornerDetector.detectArgb(
            context,
            upright,
            uprightWidth,
            uprightHeight,
          )
        } catch (t: Throwable) {
          Log.e(TAG, "detect failed", t)
          markModelBroken("detect failed: ${t.message}")
          null
        }
        val afterDetect = SystemClock.elapsedRealtime()
        if (afterDetect - lastDetDiagAt > 3000) {
          lastDetDiagAt = afterDetect
          diag(
            "det ${DocCornerDetector.lastStatus} " +
              "infer=${afterDetect - now}ms view=${previewView.width}x${previewView.height}",
          )
        }
        val viewWidth = previewView.width
        val viewHeight = previewView.height
        if (detection != null && viewWidth > 0 && viewHeight > 0) {
          emitQuad(detection, uprightWidth, uprightHeight, viewWidth, viewHeight)
        } else if (demoQuadEnabled && viewWidth > 0 && viewHeight > 0) {
          emitQuad(DEMO_QUAD, uprightWidth, uprightHeight, viewWidth, viewHeight)
        } else {
          emitLostIfNeeded()
        }
      } finally {
        inFlight.set(false)
      }
    } catch (t: Throwable) {
      Log.e(TAG, "frame analysis failed", t)
    } finally {
      proxy.close()
    }
  }

  /** 调试用：把分析帧写成 JPEG（与送进模型的像素完全一致）。 */
  private fun dumpFrame(pixels: IntArray, width: Int, height: Int) {
    try {
      val bitmap = android.graphics.Bitmap.createBitmap(
        pixels, width, height, android.graphics.Bitmap.Config.ARGB_8888,
      )
      val dir = context.getExternalFilesDir(null) ?: context.cacheDir
      FileOutputStream(File(dir, "frame-debug.jpg")).use { stream ->
        bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 90, stream)
      }
      bitmap.recycle()
      diag("dumped frame ${width}x$height")
    } catch (t: Throwable) {
      diag("dump failed: ${t.message}")
    }
  }

  /** RGBA_8888 平面 -> ARGB IntArray。rowStride 可能带 padding，必须逐行读。 */
  private fun readArgb(proxy: ImageProxy, width: Int, height: Int): IntArray? {
    val plane = proxy.planes.firstOrNull() ?: return null
    val buffer = plane.buffer
    buffer.rewind()
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride
    if (pixelStride < 4) return null

    val size = width * height
    if (framePixels.size != size) framePixels = IntArray(size)
    val out = framePixels
    var index = 0

    for (y in 0 until height) {
      var offset = y * rowStride
      for (x in 0 until width) {
        if (offset + 2 >= buffer.limit()) return null
        val r = buffer.get(offset).toInt() and 0xFF
        val g = buffer.get(offset + 1).toInt() and 0xFF
        val b = buffer.get(offset + 2).toInt() and 0xFF
        out[index++] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
        offset += pixelStride
      }
    }
    return out
  }

  /** 按 rotationDegrees（顺时针）把画面转正。 */
  private fun rotateToUpright(
    src: IntArray,
    width: Int,
    height: Int,
    degrees: Int,
  ): Triple<IntArray, Int, Int> {
    val normalized = ((degrees % 360) + 360) % 360
    if (normalized == 0) return Triple(src, width, height)

    val outWidth = if (normalized == 180) width else height
    val outHeight = if (normalized == 180) height else width
    val size = outWidth * outHeight
    if (rotatedPixels.size != size) rotatedPixels = IntArray(size)
    val out = rotatedPixels

    when (normalized) {
      90 -> {
        // src(x,y) -> dst(h-1-y, x)
        for (y in 0 until height) {
          for (x in 0 until width) {
            val dx = height - 1 - y
            val dy = x
            out[dx + dy * outWidth] = src[x + y * width]
          }
        }
      }
      180 -> {
        for (y in 0 until height) {
          val dy = height - 1 - y
          for (x in 0 until width) {
            val dx = width - 1 - x
            out[dx + dy * outWidth] = src[x + y * width]
          }
        }
      }
      270 -> {
        // src(x,y) -> dst(y, w-1-x)
        for (y in 0 until height) {
          for (x in 0 until width) {
            val dx = y
            val dy = width - 1 - x
            out[dx + dy * outWidth] = src[x + y * width]
          }
        }
      }
      else -> return Triple(src, width, height)
    }
    return Triple(out, outWidth, outHeight)
  }

  private fun emitQuad(
    detection: DetectedQuad,
    frameWidth: Int,
    frameHeight: Int,
    viewWidth: Int,
    viewHeight: Int,
  ) {
    // PreviewView FIT_CENTER：整幅等比缩进视图并居中，四周是黑边
    val scale = min(
      viewWidth.toFloat() / frameWidth,
      viewHeight.toFloat() / frameHeight,
    )
    val offsetX = (viewWidth - frameWidth * scale) / 2f
    val offsetY = (viewHeight - frameHeight * scale) / 2f

    val next = FloatArray(8)
    for (i in 0 until 4) {
      val px = detection.points[i * 2] * frameWidth
      val py = detection.points[i * 2 + 1] * frameHeight
      next[i * 2] = (px * scale + offsetX) / viewWidth
      next[i * 2 + 1] = (py * scale + offsetY) / viewHeight
    }

    val previous = smoothed
    if (previous != null) {
      for (i in 0 until 8) {
        next[i] = previous[i] * 0.45f + next[i] * 0.55f
      }
    }
    smoothed = next
    lastDetectedAt = SystemClock.elapsedRealtime()
    lostEmitted = false
    if (!quadEmitted) {
      quadEmitted = true
      diag("first quad conf=${"%.3f".format(detection.confidence)} ${next.joinToString(",")}")
    }
    onQuad(LiveQuadEvent(true, next.toList(), detection.confidence))
  }

  private fun emitLostIfNeeded() {
    if (lostEmitted) return
    if (SystemClock.elapsedRealtime() - lastDetectedAt < LOST_TIMEOUT_MS) return
    smoothed = null
    lostEmitted = true
    onQuad(LiveQuadEvent(false, null, 0f))
  }

  // ---- 拍照 ----

  /**
   * 拍照并回调 `{ uri, width, height }`。
   * 视图级 AsyncFunction 在 MAIN 线程执行，所以这里只发起请求，结果从回调里 resolve。
   * CameraX 只写 EXIF 方向，而 app 的 C++ 解码不读 EXIF，所以把方向烘进像素。
   */
  fun takePicture(promise: Promise) {
    val capture = imageCapture ?: run {
      promise.reject("camera_not_ready", "相机尚未就绪", null)
      return
    }

    val raw = File(context.cacheDir, "capture-${System.currentTimeMillis()}.jpg")
    val options = ImageCapture.OutputFileOptions.Builder(raw).build()

    capture.takePicture(
      options,
      mainExecutor,
      object : ImageCapture.OnImageSavedCallback {
        override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
          // 解码 + 旋转可能上百毫秒，放到分析线程，避免卡住主线程
          try {
            analysisExecutor.execute { finishCapture(raw, promise) }
          } catch (_: Throwable) {
            // executor 已关闭（视图正在销毁）：降级到主线程完成
            mainExecutor.execute { finishCapture(raw, promise) }
          }
        }

        override fun onError(exception: ImageCaptureException) {
          raw.delete()
          promise.reject("capture_failed", exception.message, exception)
        }
      },
    )
  }

  private fun finishCapture(raw: File, promise: Promise) {
    try {
      val upright = normalizeExif(raw)
      val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
      BitmapFactory.decodeFile(upright.absolutePath, bounds)
      val result = mapOf(
        "uri" to "file://${upright.absolutePath}",
        "width" to bounds.outWidth,
        "height" to bounds.outHeight,
      )
      mainExecutor.execute { promise.resolve(result) }
    } catch (t: Throwable) {
      raw.delete()
      mainExecutor.execute { promise.reject("capture_normalize_failed", t.message, t) }
    }
  }

  private fun normalizeExif(file: File): File {
    val orientation = try {
      ExifInterface(file)
        .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (t: Throwable) {
      ExifInterface.ORIENTATION_NORMAL
    }
    if (orientation == ExifInterface.ORIENTATION_NORMAL ||
      orientation == ExifInterface.ORIENTATION_UNDEFINED
    ) {
      return file
    }

    val decoded = DocCornerDetector.decodeSampledBitmap(file.absolutePath, 2048)
      ?: return file
    val rotated = DocCornerDetector.applyExifOrientation(file.absolutePath, decoded)
    val output = File(file.parentFile, "capture-fixed-${System.currentTimeMillis()}.jpg")
    try {
      FileOutputStream(output).use { stream ->
        rotated.compress(android.graphics.Bitmap.CompressFormat.JPEG, 92, stream)
      }
    } catch (t: Throwable) {
      output.delete()
      return file
    } finally {
      if (rotated !== decoded) rotated.recycle()
      decoded.recycle()
    }
    file.delete()
    return output
  }

  companion object {
    private const val TAG = "ImageCoreCamera"
    private const val LOST_TIMEOUT_MS = 700L
    /** 现场诊断文件（cacheDir 下），只在状态变化时追加 */
    private const val DIAG_FILE = "camera-diag.log"
    /** 存在该文件时回传固定四角，用于验证叠加层 */
    private const val DEMO_QUAD_FILE = "demo-quad"
    /** 存在该文件时把前 3 帧分析画面写成 JPEG */
    private const val DUMP_FRAMES_FILE = "dump-frames"
    /** 分析帧归一化坐标下的居中矩形（后面还要走 FIT_CENTER 映射） */
    private val DEMO_QUAD = DetectedQuad(
      floatArrayOf(0.3f, 0.25f, 0.7f, 0.25f, 0.7f, 0.75f, 0.3f, 0.75f),
      0.99f,
    )
  }
}
