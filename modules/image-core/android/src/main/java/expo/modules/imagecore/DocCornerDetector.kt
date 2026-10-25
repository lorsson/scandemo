package expo.modules.imagecore

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.nio.FloatBuffer
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * DocCornerNet（scanic SimCC）端侧检测。
 *
 * 模型：android/src/main/assets/doccornernet_lean.onnx（1.82 MB, MIT）
 *   input  `input`       [1,224,224,3] float32 NHWC，RGB，/255 后减 ImageNet mean 除 std
 *   output `coords`      [1,8] 归一化角点，顺序 TL,TR,BR,BL
 *   output `score_logit` [1,1] -> sigmoid = 文档存在置信度
 *
 * 预处理与 scratch/onnx_eval/dc_real.py 完全一致（双线性缩放到 224，压扁宽高比）。
 */
data class DetectedQuad(
  /** 8 个归一化坐标：x0,y0,x1,y1,x2,y2,x3,y3（TL,TR,BR,BL） */
  val points: FloatArray,
  val confidence: Float,
) {
  fun toQuadMap(): Map<String, Any> = mapOf(
    "topLeft" to mapOf("x" to points[0], "y" to points[1]),
    "topRight" to mapOf("x" to points[2], "y" to points[3]),
    "bottomRight" to mapOf("x" to points[4], "y" to points[5]),
    "bottomLeft" to mapOf("x" to points[6], "y" to points[7]),
  )
}

object DocCornerDetector {
  private const val MODEL_ASSET = "doccornernet_lean.onnx"
  const val INPUT_SIZE = 224

  /** 最近一次推理的诊断状态，真机上排查「为什么没有四角」用 */
  @Volatile
  var lastStatus: String = "idle"
    private set

  /** 低于该置信度视为画面里没有文档 */
  private const val SCORE_THRESHOLD = 0.55f
  /** 太小（误检）或几乎整图（模型退回边框）都不值得自动切 */
  private const val MIN_AREA = 0.03f
  private const val MAX_AREA = 0.995f

  private val MEAN = floatArrayOf(0.485f, 0.456f, 0.406f)
  private val STD = floatArrayOf(0.229f, 0.224f, 0.225f)

  private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }

  @Volatile private var session: OrtSession? = null
  @Volatile private var inputName: String = "input"
  @Volatile private var coordsName: String = "coords"
  @Volatile private var scoreName: String = "score_logit"

  /** 224×224×3 的输入缓冲：逐帧复用，避免每次推理都分配 */
  private val inputBuffer = FloatArray(INPUT_SIZE * INPUT_SIZE * 3)

  @Synchronized
  fun ensureSession(context: Context): OrtSession {
    session?.let { return it }

    val bytes = context.assets.open(MODEL_ASSET).use { it.readBytes() }
    val created = try {
      env.createSession(bytes, OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(4)
        setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      })
    } catch (t: Throwable) {
      // 个别设备上多线程初始化会失败，退到单线程再试一次
      env.createSession(bytes, OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(1)
      })
    }

    inputName = created.inputNames.firstOrNull() ?: "input"
    val outputs = created.outputNames.toList()
    coordsName = outputs.firstOrNull { it.contains("coord", ignoreCase = true) }
      ?: outputs.getOrElse(0) { "coords" }
    scoreName = outputs.firstOrNull { it.contains("score", ignoreCase = true) }
      ?: outputs.getOrElse(1) { "score_logit" }

    session = created
    return created
  }

  /**
   * 检测一张已解码的 ARGB 像素图。width/height 是像素图尺寸；
   * 返回的四角是相对该图的归一化坐标。
   */
  @Synchronized
  fun detectArgb(
    context: Context,
    pixels: IntArray,
    width: Int,
    height: Int,
  ): DetectedQuad? {
    if (width < 8 || height < 8 || pixels.size < width * height) {
      lastStatus = "bad-size ${width}x$height"
      return null
    }
    val sess = ensureSession(context)
    fillInput(pixels, width, height)

    OnnxTensor.createTensor(
      env,
      FloatBuffer.wrap(inputBuffer),
      longArrayOf(1, INPUT_SIZE.toLong(), INPUT_SIZE.toLong(), 3),
    ).use { input ->
      sess.run(mapOf(inputName to input)).use { result ->
        var coordsValue: OnnxTensor? = null
        var scoreValue: OnnxTensor? = null
        for (entry in result) {
          when (entry.key) {
            coordsName -> coordsValue = entry.value as? OnnxTensor
            scoreName -> scoreValue = entry.value as? OnnxTensor
          }
        }
        // 名称兜底：按输出顺序取（模型固定 coords, score_logit）
        if (coordsValue == null || scoreValue == null) {
          val values = result.toList()
          coordsValue = values.getOrNull(0)?.value as? OnnxTensor
          scoreValue = values.getOrNull(1)?.value as? OnnxTensor
        }
        val coordsTensor = coordsValue ?: return null
        val scoreTensor = scoreValue ?: return null

        val coords = FloatArray(8)
        coordsTensor.floatBuffer.get(coords)
        val logit = scoreTensor.floatBuffer.get(0)
        val confidence = (1.0 / (1.0 + kotlin.math.exp(-logit.toDouble()))).toFloat()

        if (!confidence.isFinite() || confidence < SCORE_THRESHOLD) {
          lastStatus = "low-score ${"%.3f".format(confidence)}"
          return null
        }
        val sanitized = sanitize(coords)
        if (sanitized == null) {
          lastStatus = "invalid-quad score=${"%.3f".format(confidence)}"
          return null
        }
        lastStatus = "ok score=${"%.3f".format(confidence)}"
        return DetectedQuad(sanitized, confidence)
      }
    }
  }

  /** 解码文件 → 按 EXIF 转正 → 检测。 */
  fun detectFile(context: Context, path: String): DetectedQuad? {
    val decoded = decodeSampledBitmap(path, 640) ?: return null
    val upright = applyExifOrientation(path, decoded)
    return try {
      val width = upright.width
      val height = upright.height
      val pixels = IntArray(width * height)
      upright.getPixels(pixels, 0, width, 0, 0, width, height)
      detectArgb(context, pixels, width, height)
    } finally {
      if (upright !== decoded) upright.recycle()
      decoded.recycle()
    }
  }

  /** 按最长边 maxDim 做 2 的幂次采样解码，避免把整张 12MP 原图读进内存。 */
  fun decodeSampledBitmap(path: String, maxDim: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / sample > maxDim) sample *= 2

    return BitmapFactory.decodeFile(
      path,
      BitmapFactory.Options().apply {
        inSampleSize = sample
        inPreferredConfig = Bitmap.Config.ARGB_8888
      },
    )
  }

  /** 读 EXIF 方向；读不到时按 NORMAL 处理 */
  fun readExifOrientation(path: String): Int = try {
    ExifInterface(File(path).absolutePath)
      .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
  } catch (t: Throwable) {
    ExifInterface.ORIENTATION_NORMAL
  }

  /** 该 EXIF 方向是否交换宽高（转置 / 旋转 90 / 270） */
  fun swapsDimensions(orientation: Int): Boolean = orientation in 5..8

  /** 把 EXIF 方向烘进像素；方向为 NORMAL 时原样返回（调用方不要再 recycle 第二份）。 */
  fun applyExifOrientation(path: String, bitmap: Bitmap): Bitmap {
    val orientation = readExifOrientation(path)
    if (orientation == ExifInterface.ORIENTATION_NORMAL ||
      orientation == ExifInterface.ORIENTATION_UNDEFINED
    ) {
      return bitmap
    }

    val matrix = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.postScale(-1f, 1f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.postScale(1f, -1f)
      ExifInterface.ORIENTATION_ROTATE_90 -> matrix.postRotate(90f)
      ExifInterface.ORIENTATION_ROTATE_180 -> matrix.postRotate(180f)
      ExifInterface.ORIENTATION_ROTATE_270 -> matrix.postRotate(-90f)
      ExifInterface.ORIENTATION_TRANSPOSE -> {
        matrix.postRotate(90f)
        matrix.postScale(-1f, 1f)
      }
      ExifInterface.ORIENTATION_TRANSVERSE -> {
        matrix.postRotate(-90f)
        matrix.postScale(-1f, 1f)
      }
    }

    return try {
      Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    } catch (t: Throwable) {
      bitmap
    }
  }

  // ---- 预处理 ----

  /** 双线性缩放填 NHWC 缓冲；坐标映射与 cv2.resize(INTER_LINEAR) 一致。 */
  private fun fillInput(pixels: IntArray, width: Int, height: Int) {
    val scaleX = width.toFloat() / INPUT_SIZE
    val scaleY = height.toFloat() / INPUT_SIZE
    var out = 0

    for (y in 0 until INPUT_SIZE) {
      val sy = max(0f, (y + 0.5f) * scaleY - 0.5f)
      val y0 = floor(sy).toInt().coerceIn(0, height - 1)
      val y1 = min(y0 + 1, height - 1)
      val fy = sy - y0

      for (x in 0 until INPUT_SIZE) {
        val sx = max(0f, (x + 0.5f) * scaleX - 0.5f)
        val x0 = floor(sx).toInt().coerceIn(0, width - 1)
        val x1 = min(x0 + 1, width - 1)
        val fx = sx - x0

        val p00 = pixels[y0 * width + x0]
        val p10 = pixels[y0 * width + x1]
        val p01 = pixels[y1 * width + x0]
        val p11 = pixels[y1 * width + x1]

        val w00 = (1f - fx) * (1f - fy)
        val w10 = fx * (1f - fy)
        val w01 = (1f - fx) * fy
        val w11 = fx * fy

        for (channel in 0..2) {
          val shift = when (channel) {
            0 -> 16 // R
            1 -> 8  // G
            else -> 0 // B
          }
          val value =
            ((p00 shr shift) and 0xFF) * w00 +
              ((p10 shr shift) and 0xFF) * w10 +
              ((p01 shr shift) and 0xFF) * w01 +
              ((p11 shr shift) and 0xFF) * w11
          inputBuffer[out++] = (value / 255f - MEAN[channel]) / STD[channel]
        }
      }
    }
  }

  // ---- 后处理 ----

  private fun sanitize(coords: FloatArray): FloatArray? {
    val out = FloatArray(8)
    for (i in 0 until 8) {
      val v = coords[i]
      if (!v.isFinite()) return null
      // 模型可能轻微越界，夹回 [0,1] 再判断
      if (v < -0.08f || v > 1.08f) return null
      out[i] = v.coerceIn(0f, 1f)
    }
    if (!isConvex(out)) return null
    val area = area(out)
    if (area < MIN_AREA || area > MAX_AREA) return null
    return out
  }

  /** 四个点按 TL→TR→BR→BL 是否构成凸四边形。 */
  private fun isConvex(pts: FloatArray): Boolean {
    var sign = 0
    for (i in 0 until 4) {
      val ax = pts[i * 2]
      val ay = pts[i * 2 + 1]
      val bx = pts[((i + 1) % 4) * 2]
      val by = pts[((i + 1) % 4) * 2 + 1]
      val cx = pts[((i + 2) % 4) * 2]
      val cy = pts[((i + 2) % 4) * 2 + 1]
      val cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx)
      if (abs(cross) < 1e-6f) return false
      val current = if (cross > 0f) 1 else -1
      if (sign == 0) sign = current else if (current != sign) return false
    }
    return true
  }

  /** 鞋带公式，归一化坐标下的面积。 */
  private fun area(pts: FloatArray): Float {
    var sum = 0f
    for (i in 0 until 4) {
      val x1 = pts[i * 2]
      val y1 = pts[i * 2 + 1]
      val x2 = pts[((i + 1) % 4) * 2]
      val y2 = pts[((i + 1) % 4) * 2 + 1]
      sum += x1 * y2 - x2 * y1
    }
    return abs(sum) / 2f
  }
}
