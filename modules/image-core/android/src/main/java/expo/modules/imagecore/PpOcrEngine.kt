package expo.modules.imagecore

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.os.SystemClock
import android.util.Log
import java.nio.FloatBuffer
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * PP-OCRv4 端侧文字识别（检测 + 方向分类 + 识别）。
 *
 * 模型：android/src/main/assets/ 下的三个 ONNX（PaddleOCR 官方权重，Apache-2.0）
 *   ch_PP-OCRv4_det_infer.onnx       DB 文本检测，输入 [N,3,H,W] 动态尺寸
 *   ch_ppocr_mobile_v2.0_cls_infer   0/180 方向分类，输入 [N,3,48,192]
 *   ch_PP-OCRv4_rec_infer            CTC 识别，输入 [N,3,48,W]，字典在模型元数据 character 里
 *
 * 预处理 / 后处理与 `rapidocr_onnxruntime` 的默认配置一致（thresh 0.3, box_thresh 0.5,
 * unclip 1.6, use_dilation, text_score 0.5, limit_side_len 736/min），
 * 这样端侧结果和服务端 `/api/ocr` 的可比性最好。
 *
 * 这里不依赖 OpenCV：DB 后处理用连通域 + 旋转卡壳最小外接矩形，裁剪用单应变换采样。
 */
object PpOcrEngine {
  private const val TAG = "image-core-ocr"

  private const val DET_ASSET = "ch_PP-OCRv4_det_infer.onnx"
  private const val REC_ASSET = "ch_PP-OCRv4_rec_infer.onnx"
  private const val CLS_ASSET = "ch_ppocr_mobile_v2.0_cls_infer.onnx"

  // Global / Det / Cls / Rec 参数，对应 rapidocr 的 config.yaml
  private const val MAX_SIDE_LEN = 2000
  private const val MIN_SIDE_LEN = 30
  private const val DET_LIMIT_SIDE_LEN = 736
  private const val DET_THRESH = 0.3f
  private const val DET_BOX_THRESH = 0.5f
  private const val DET_MAX_CANDIDATES = 1000
  private const val DET_UNCLIP_RATIO = 1.6f
  private const val DET_MIN_SIZE = 3f
  /** 检测画布最长边上限，避免长截图把内存吃满 */
  private const val DET_MAX_CANVAS = 4096

  private const val CLS_HEIGHT = 48
  private const val CLS_WIDTH = 192
  private const val CLS_THRESH = 0.9f

  private const val REC_HEIGHT = 48
  private const val REC_WIDTH = 320
  private const val REC_BASE_RATIO = 320.0 / 48.0
  /** 低于该识别置信度的行直接丢掉（与 rapidocr text_score 一致） */
  private const val TEXT_SCORE = 0.5f

  /** 最近一次识别的耗时/规模，真机排查用 */
  @Volatile
  var lastStatus: String = "idle"
    private set

  private val env: OrtEnvironment by lazy { OrtEnvironment.getEnvironment() }

  @Volatile private var det: OrtSession? = null
  @Volatile private var cls: OrtSession? = null
  @Volatile private var rec: OrtSession? = null
  @Volatile private var dictionary: List<String>? = null

  /** 识别结果：points 是 8 个原图像素坐标（TL,TR,BR,BL），text/score 来自 CTC 解码。 */
  data class Line(val points: FloatArray, val text: String, val score: Float)

  // ---- 对外入口 ----

  /** 解文件 → 按 EXIF 转正 → 识别。points 相对这里解码出来的位图。 */
  fun recognizeFile(context: Context, path: String): Map<String, Any> {
    val decoded = DocCornerDetector.decodeSampledBitmap(path, MAX_SIDE_LEN)
      ?: throw IllegalArgumentException("无法解码图片: $path")
    val bitmap = DocCornerDetector.applyExifOrientation(path, decoded)
    val startedAt = SystemClock.elapsedRealtime()
    try {
      val lines = recognize(context, bitmap)
      Log.i(
        TAG,
        "ocr ${bitmap.width}x${bitmap.height} ${lines.size} lines in " +
          "${SystemClock.elapsedRealtime() - startedAt}ms ($lastStatus)",
      )
      return mapOf(
        "width" to bitmap.width,
        "height" to bitmap.height,
        "lines" to lines.map { line ->
          mapOf(
            "points" to (0 until 4).map { i ->
              listOf(line.points[i * 2].toDouble(), line.points[i * 2 + 1].toDouble())
            },
            "text" to line.text,
            "score" to line.score.toDouble(),
          )
        },
      )
    } finally {
      if (bitmap !== decoded) bitmap.recycle()
      decoded.recycle()
    }
  }

  @Synchronized
  fun recognize(context: Context, bitmap: Bitmap): List<Line> {
    val initStart = SystemClock.elapsedRealtime()
    ensureSessions(context)
    val initMs = SystemClock.elapsedRealtime() - initStart

    // rapidocr 的 Global 预处理：长边 > 2000 先缩小；短边 < 30 放大
    var source = imageFromBitmap(bitmap)
    var scaleX = 1f // 检测坐标乘这个系数回到位图像素
    var scaleY = 1f
    if (max(source.width, source.height) > MAX_SIDE_LEN) {
      val ratio = MAX_SIDE_LEN.toFloat() / max(source.width, source.height)
      val w = max(1, (source.width * ratio).toInt())
      val h = max(1, (source.height * ratio).toInt())
      source = scale(source, w, h)
      scaleX = bitmap.width.toFloat() / w
      scaleY = bitmap.height.toFloat() / h
    } else if (min(source.width, source.height) < MIN_SIDE_LEN) {
      val ratio = MIN_SIDE_LEN.toFloat() / min(source.width, source.height)
      val w = max(1, (source.width * ratio).toInt())
      val h = max(1, (source.height * ratio).toInt())
      source = scale(source, w, h)
      scaleX = bitmap.width.toFloat() / w
      scaleY = bitmap.height.toFloat() / h
    }

    val detStart = SystemClock.elapsedRealtime()
    val boxes = sortBoxes(detectBoxes(source)) // 已经是 source 像素坐标
    val detMs = SystemClock.elapsedRealtime() - detStart
    if (boxes.isEmpty()) {
      lastStatus = "no-box init=${initMs}ms det=${detMs}ms"
      return emptyList()
    }

    val recStart = SystemClock.elapsedRealtime()
    var clsMs = 0L
    var recMs = 0L
    val out = ArrayList<Line>(boxes.size)
    for (box in boxes) {
      val crop = cropQuad(source, box) ?: continue
      val clsStart = SystemClock.elapsedRealtime()
      val upright = if (needsRotate180(crop)) rotate180(crop) else crop
      clsMs += SystemClock.elapsedRealtime() - clsStart
      val recBoxStart = SystemClock.elapsedRealtime()
      val (text, score) = recognizeText(upright)
      recMs += SystemClock.elapsedRealtime() - recBoxStart
      if (text.isEmpty() || score < TEXT_SCORE) continue
      val points = FloatArray(8)
      for (i in 0 until 4) {
        points[i * 2] = box[i][0] * scaleX
        points[i * 2 + 1] = box[i][1] * scaleY
      }
      out.add(Line(points, text, score))
    }
    lastStatus = "ok ${boxes.size} boxes, ${out.size} lines " +
      "init=${initMs}ms det=${detMs}ms crop/cls=${clsMs}ms rec=${recMs}ms " +
      "loop=${SystemClock.elapsedRealtime() - recStart}ms"
    return out
  }

  // ---- 会话 ----

  @Synchronized
  private fun ensureSessions(context: Context) {
    if (det != null && rec != null && cls != null) return
    det = createSession(context, DET_ASSET)
    cls = createSession(context, CLS_ASSET)
    val recSession = createSession(context, REC_ASSET)
    rec = recSession
    if (dictionary == null) {
      val raw: String? = try {
        recSession.metadata.getCustomMetadataValue("character").orElse(null)
      } catch (t: Throwable) {
        Log.w(TAG, "读取识别字典失败", t)
        null
      }
      if (raw.isNullOrEmpty()) {
        throw IllegalStateException("识别模型缺少 character 字典")
      }
      // CTCLabelDecode：0 是 blank，末尾补空格
      val chars = raw.split("\n").map { it.trimEnd('\r') }
      dictionary = buildList {
        add("blank")
        addAll(chars)
        add(" ")
      }
    }
  }

  private fun createSession(context: Context, asset: String): OrtSession {
    val bytes = context.assets.open(asset).use { it.readBytes() }
    return try {
      env.createSession(bytes, OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(4)
        setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      })
    } catch (t: Throwable) {
      env.createSession(bytes, OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(1)
      })
    }
  }

  // ---- 检测 ----

  private fun detectBoxes(img: RgbImage): List<Array<FloatArray>> {
    // limit_type=min：短边不足 736 就放大，再对齐到 32 的倍数
    val shortSide = min(img.width, img.height).toFloat()
    val ratio = if (shortSide < DET_LIMIT_SIDE_LEN) DET_LIMIT_SIDE_LEN / shortSide else 1f
    var detW = max(32, roundToMultipleOf32(img.width * ratio))
    var detH = max(32, roundToMultipleOf32(img.height * ratio))
    // 长截图这类极端宽高比：不加上限的话检测画布会到几千像素宽
    val longSide = max(detW, detH)
    if (longSide > DET_MAX_CANVAS) {
      val down = DET_MAX_CANVAS.toFloat() / longSide
      detW = max(32, roundToMultipleOf32(detW * down))
      detH = max(32, roundToMultipleOf32(detH * down))
    }
    val resized = scale(img, detW, detH)

    val input = FloatArray(3 * detW * detH)
    fillNchw(resized, input, mean = 0.5f, std = 0.5f)

    val session = det ?: return emptyList()
    val inputName = session.inputNames.first()
    val prob = OnnxTensor.createTensor(
      env,
      FloatBuffer.wrap(input),
      longArrayOf(1, 3, detH.toLong(), detW.toLong()),
    ).use { tensor ->
      session.run(mapOf(inputName to tensor)).use { result ->
        val output = result.toList().firstOrNull()?.value as? OnnxTensor ?: return emptyList()
        val buffer = FloatArray(detH * detW)
        output.floatBuffer.get(buffer)
        buffer
      }
    }

    val boxes = dbPostProcess(prob, detW, detH)
    // 映射回 source 像素坐标，取整并夹到图内（filter_tag_det_res 的做法）
    val sx = img.width.toFloat() / detW
    val sy = img.height.toFloat() / detH
    val maxX = (img.width - 1).toFloat()
    val maxY = (img.height - 1).toFloat()
    return boxes.map { box ->
      for (point in box) {
        point[0] = (point[0] * sx).roundToInt().toFloat().coerceIn(0f, maxX)
        point[1] = (point[1] * sy).roundToInt().toFloat().coerceIn(0f, maxY)
      }
      orderPointsClockwise(box)
    }.filter { box ->
      val w = dist(box[0], box[1]).toInt()
      val h = dist(box[0], box[3]).toInt()
      w > 3 && h > 3
    }
  }

  /** rapidocr sorted_boxes：先按左上角 y、x 排序，再把 y 差 < 10 的行按 x 交换成阅读顺序。 */
  private fun sortBoxes(boxes: List<Array<FloatArray>>): List<Array<FloatArray>> {
    val sorted = boxes.sortedWith(
      compareBy({ it[0][1] }, { it[0][0] }),
    ).toMutableList()
    for (i in 0 until sorted.size - 1) {
      for (j in i downTo 0) {
        if (abs(sorted[j + 1][0][1] - sorted[j][0][1]) < 10f &&
          sorted[j + 1][0][0] < sorted[j][0][0]
        ) {
          val tmp = sorted[j]
          sorted[j] = sorted[j + 1]
          sorted[j + 1] = tmp
        } else {
          break
        }
      }
    }
    return sorted
  }

  private fun dbPostProcess(prob: FloatArray, width: Int, height: Int): List<Array<FloatArray>> {
    val n = width * height
    val mask = BooleanArray(n)
    for (i in 0 until n) mask[i] = prob[i] > DET_THRESH
    val dilated = dilate2x2(mask, width, height)

    val boxes = ArrayList<Array<FloatArray>>()
    val labels = IntArray(n)
    val order = IntArray(n)
    var orderSize = 0
    val stack = IntArray(n)

    for (start in 0 until n) {
      if (!dilated[start] || labels[start] != 0) continue
      val componentStart = orderSize
      var sp = 0
      stack[sp++] = start
      labels[start] = 1
      while (sp > 0) {
        val idx = stack[--sp]
        order[orderSize++] = idx
        val x = idx % width
        val y = idx / width
        for (dy in -1..1) {
          val ny = y + dy
          if (ny < 0 || ny >= height) continue
          for (dx in -1..1) {
            if (dx == 0 && dy == 0) continue
            val nx = x + dx
            if (nx < 0 || nx >= width) continue
            val ni = ny * width + nx
            if (dilated[ni] && labels[ni] == 0) {
              labels[ni] = 1
              stack[sp++] = ni
            }
          }
        }
      }
      val count = orderSize - componentStart
      if (count < 9) continue
      val box = boxFromComponent(prob, width, height, order, componentStart, count) ?: continue
      boxes.add(box)
      if (boxes.size >= DET_MAX_CANDIDATES) break
    }
    return boxes
  }

  private fun boxFromComponent(
    prob: FloatArray,
    width: Int,
    height: Int,
    order: IntArray,
    start: Int,
    count: Int,
  ): Array<FloatArray>? {
    val points = ArrayList<FloatArray>(count)
    var minX = Float.MAX_VALUE
    var maxX = -Float.MAX_VALUE
    var minY = Float.MAX_VALUE
    var maxY = -Float.MAX_VALUE
    for (i in start until start + count) {
      val idx = order[i]
      val x = (idx % width).toFloat()
      val y = (idx / width).toFloat()
      points.add(floatArrayOf(x, y))
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    // 细到几乎是一条线：get_mini_boxes 的 sside < 3 分支
    if (maxX - minX < 2f || maxY - minY < 2f) return null

    val (rect, rectW, rectH) = minAreaRect(points)
    val sside = min(rectW, rectH)
    if (sside < DET_MIN_SIZE) return null

    val ordered = orderMiniBox(rect)
    val score = boxScore(prob, width, height, ordered)
    if (score < DET_BOX_THRESH) return null

    val area = polygonArea(ordered)
    val perimeter = polygonPerimeter(ordered)
    if (perimeter <= 0f) return null
    val expanded = offsetPolygon(ordered, area * DET_UNCLIP_RATIO / perimeter)
    val (rect2, rect2W, rect2H) = minAreaRect(expanded.toList())
    if (min(rect2W, rect2H) < DET_MIN_SIZE + 2f) return null
    return orderMiniBox(rect2)
  }

  /** 2x2 膨胀（cv2.dilate 默认 anchor），边界按常量 -inf 处理。 */
  private fun dilate2x2(mask: BooleanArray, width: Int, height: Int): BooleanArray {
    val out = BooleanArray(mask.size)
    for (y in 0 until height) {
      val row = y * width
      val prevRow = row - width
      for (x in 0 until width) {
        var on = mask[row + x]
        if (!on && x > 0) on = mask[row + x - 1]
        if (!on && y > 0) {
          on = mask[prevRow + x]
          if (!on && x > 0) on = mask[prevRow + x - 1]
        }
        out[row + x] = on
      }
    }
    return out
  }

  /** 框内概率均值（box_score_fast：多边形填充后取 mean）。 */
  private fun boxScore(prob: FloatArray, width: Int, height: Int, box: Array<FloatArray>): Float {
    val minX = floor(box.minOf { it[0] }).toInt().coerceIn(0, width - 1)
    val maxX = ceil(box.maxOf { it[0] }).toInt().coerceIn(0, width - 1)
    val minY = floor(box.minOf { it[1] }).toInt().coerceIn(0, height - 1)
    val maxY = ceil(box.maxOf { it[1] }).toInt().coerceIn(0, height - 1)
    if (maxX < minX || maxY < minY) return 0f

    // cv2.fillPoly 按像素中心判断是否在多边形内
    val poly = Array(4) { floatArrayOf(box[it][0] - minX, box[it][1] - minY) }
    var sum = 0f
    var count = 0
    for (y in 0..(maxY - minY)) {
      for (x in 0..(maxX - minX)) {
        if (pointInPolygon(x + 0.5f, y + 0.5f, poly)) {
          sum += prob[(y + minY) * width + x + minX]
          count += 1
        }
      }
    }
    return if (count == 0) 0f else sum / count
  }

  // ---- 裁剪 / 方向 ----

  private fun cropQuad(img: RgbImage, quad: Array<FloatArray>): RgbImage? {
    val cropW = max(dist(quad[0], quad[1]), dist(quad[2], quad[3])).toInt()
    val cropH = max(dist(quad[0], quad[3]), dist(quad[1], quad[2])).toInt()
    if (cropW <= 1 || cropH <= 1) return null

    val dstCorners = arrayOf(
      floatArrayOf(0f, 0f),
      floatArrayOf(cropW.toFloat(), 0f),
      floatArrayOf(cropW.toFloat(), cropH.toFloat()),
      floatArrayOf(0f, cropH.toFloat()),
    )
    val h = solveHomography(dstCorners, quad) ?: return null

    val out = FloatArray(cropW * cropH * 3)
    var o = 0
    for (y in 0 until cropH) {
      for (x in 0 until cropW) {
        val w = h[6] * x + h[7] * y + 1f
        if (abs(w) < 1e-8f) {
          o += 3
          continue
        }
        val sx = (h[0] * x + h[1] * y + h[2]) / w
        val sy = (h[3] * x + h[4] * y + h[5]) / w
        sampleBilinear(img, sx, sy, out, o)
        o += 3
      }
    }
    val crop = RgbImage(cropW, cropH, out)
    // 竖排文本转正（PaddleOCR 的 rot90）
    return if (cropH.toFloat() / cropW >= 1.5f) rotate90(crop) else crop
  }

  private fun needsRotate180(crop: RgbImage): Boolean {
    val session = cls ?: return false
    val resizedW = min(
      ceil(CLS_HEIGHT * crop.width.toDouble() / crop.height).toInt(),
      CLS_WIDTH,
    )
    val scaled = scale(crop, max(1, resizedW), CLS_HEIGHT)
    val input = FloatArray(3 * CLS_HEIGHT * CLS_WIDTH)
    fillNchw(scaled, input, mean = 0.5f, std = 0.5f, canvasWidth = CLS_WIDTH)
    val inputName = session.inputNames.first()
    return OnnxTensor.createTensor(
      env,
      FloatBuffer.wrap(input),
      longArrayOf(1, 3, CLS_HEIGHT.toLong(), CLS_WIDTH.toLong()),
    ).use { tensor ->
      session.run(mapOf(inputName to tensor)).use { result ->
        val output = result.toList().firstOrNull()?.value as? OnnxTensor ?: return false
        val probs = FloatArray(2)
        output.floatBuffer.get(probs)
        probs[1] > CLS_THRESH && probs[1] > probs[0]
      }
    }
  }

  // ---- 识别 ----

  private fun recognizeText(crop: RgbImage): Pair<String, Float> {
    val session = rec ?: return "" to 0f
    val chars = dictionary ?: return "" to 0f

    // 与 PaddleOCR 一样用双精度算宽度：float 会把 48×(320/48) 算成 319
    val ratio = crop.width.toDouble() / crop.height
    val maxWhRatio = max(REC_BASE_RATIO, ratio)
    val canvasW = max(1, (REC_HEIGHT * maxWhRatio).toInt())
    val resizedW = min(ceil(REC_HEIGHT * ratio).toInt(), canvasW)
    val scaled = scale(crop, max(1, resizedW), REC_HEIGHT)

    val input = FloatArray(3 * REC_HEIGHT * canvasW)
    fillNchw(scaled, input, mean = 0.5f, std = 0.5f, canvasWidth = canvasW)

    val inputName = session.inputNames.first()
    return OnnxTensor.createTensor(
      env,
      FloatBuffer.wrap(input),
      longArrayOf(1, 3, REC_HEIGHT.toLong(), canvasW.toLong()),
    ).use { tensor ->
      session.run(mapOf(inputName to tensor)).use { result ->
        val output = result.toList().firstOrNull()?.value as? OnnxTensor ?: return "" to 0f
        val shape = output.info.shape // [1, T, C]
        val steps = shape[1].toInt()
        val classes = shape[2].toInt()
        val probs = FloatArray(steps * classes)
        output.floatBuffer.get(probs)
        ctcDecode(probs, steps, classes, chars)
      }
    }
  }

  private fun ctcDecode(
    probs: FloatArray,
    steps: Int,
    classes: Int,
    chars: List<String>,
  ): Pair<String, Float> {
    val builder = StringBuilder()
    var sum = 0f
    var count = 0
    var prev = -1
    for (t in 0 until steps) {
      val base = t * classes
      var best = 0
      var bestProb = probs[base]
      for (c in 1 until classes) {
        val value = probs[base + c]
        if (value > bestProb) {
          bestProb = value
          best = c
        }
      }
      if (best != 0 && best != prev) {
        if (best < chars.size) builder.append(chars[best])
        sum += bestProb
        count += 1
      }
      prev = best
    }
    return builder.toString() to if (count == 0) 0f else sum / count
  }

  // ---- 图像基础 ----

  private class RgbImage(val width: Int, val height: Int, val data: FloatArray)

  private fun imageFromBitmap(bitmap: Bitmap): RgbImage {
    val w = bitmap.width
    val h = bitmap.height
    val pixels = IntArray(w * h)
    bitmap.getPixels(pixels, 0, w, 0, 0, w, h)
    val out = FloatArray(w * h * 3)
    var o = 0
    for (pixel in pixels) {
      out[o++] = ((pixel shr 16) and 0xFF) / 255f
      out[o++] = ((pixel shr 8) and 0xFF) / 255f
      out[o++] = (pixel and 0xFF) / 255f
    }
    return RgbImage(w, h, out)
  }

  /** 双线性缩放，像素中心约定与 cv2.resize(INTER_LINEAR) 一致。 */
  private fun scale(src: RgbImage, dstW: Int, dstH: Int): RgbImage {
    if (src.width == dstW && src.height == dstH) return src
    val out = FloatArray(dstW * dstH * 3)
    val scaleX = src.width.toFloat() / dstW
    val scaleY = src.height.toFloat() / dstH
    var o = 0
    for (y in 0 until dstH) {
      val sy = max(0f, (y + 0.5f) * scaleY - 0.5f)
      val y0 = floor(sy).toInt().coerceIn(0, src.height - 1)
      val y1 = min(y0 + 1, src.height - 1)
      val fy = sy - y0
      for (x in 0 until dstW) {
        val sx = max(0f, (x + 0.5f) * scaleX - 0.5f)
        val x0 = floor(sx).toInt().coerceIn(0, src.width - 1)
        val x1 = min(x0 + 1, src.width - 1)
        val fx = sx - x0
        for (c in 0..2) {
          val p00 = src.data[(y0 * src.width + x0) * 3 + c]
          val p10 = src.data[(y0 * src.width + x1) * 3 + c]
          val p01 = src.data[(y1 * src.width + x0) * 3 + c]
          val p11 = src.data[(y1 * src.width + x1) * 3 + c]
          out[o++] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) +
            p01 * (1 - fx) * fy + p11 * fx * fy
        }
      }
    }
    return RgbImage(dstW, dstH, out)
  }

  /** 逆时针 90°（PaddleOCR 的 np.rot90）。 */
  private fun rotate90(src: RgbImage): RgbImage {
    val w = src.height
    val h = src.width
    val out = FloatArray(w * h * 3)
    var o = 0
    for (y in 0 until h) {
      for (x in 0 until w) {
        val sx = y
        val sy = src.height - 1 - x
        val base = (sy * src.width + sx) * 3
        out[o++] = src.data[base]
        out[o++] = src.data[base + 1]
        out[o++] = src.data[base + 2]
      }
    }
    return RgbImage(w, h, out)
  }

  private fun rotate180(src: RgbImage): RgbImage {
    val out = FloatArray(src.data.size)
    val n = src.width * src.height
    var o = 0
    for (i in n - 1 downTo 0) {
      out[o++] = src.data[i * 3]
      out[o++] = src.data[i * 3 + 1]
      out[o++] = src.data[i * 3 + 2]
    }
    return RgbImage(src.width, src.height, out)
  }

  /** RGB 0..1 → NCHW 归一化；右侧不足 canvasWidth 的部分保持 0（与 Paddle 的 padding 一致）。 */
  private fun fillNchw(
    img: RgbImage,
    out: FloatArray,
    mean: Float,
    std: Float,
    canvasWidth: Int = img.width,
  ) {
    val plane = canvasWidth * img.height
    for (y in 0 until img.height) {
      for (x in 0 until min(img.width, canvasWidth)) {
        val si = (y * img.width + x) * 3
        val di = y * canvasWidth + x
        out[di] = (img.data[si] - mean) / std
        out[plane + di] = (img.data[si + 1] - mean) / std
        out[2 * plane + di] = (img.data[si + 2] - mean) / std
      }
    }
  }

  private fun sampleBilinear(img: RgbImage, sx: Float, sy: Float, out: FloatArray, offset: Int) {
    val x = sx.coerceIn(0f, (img.width - 1).toFloat())
    val y = sy.coerceIn(0f, (img.height - 1).toFloat())
    val x0 = floor(x).toInt().coerceIn(0, img.width - 1)
    val y0 = floor(y).toInt().coerceIn(0, img.height - 1)
    val x1 = min(x0 + 1, img.width - 1)
    val y1 = min(y0 + 1, img.height - 1)
    val fx = x - x0
    val fy = y - y0
    for (c in 0..2) {
      val p00 = img.data[(y0 * img.width + x0) * 3 + c]
      val p10 = img.data[(y0 * img.width + x1) * 3 + c]
      val p01 = img.data[(y1 * img.width + x0) * 3 + c]
      val p11 = img.data[(y1 * img.width + x1) * 3 + c]
      out[offset + c] = p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) +
        p01 * (1 - fx) * fy + p11 * fx * fy
    }
  }

  // ---- 几何 ----

  private fun dist(a: FloatArray, b: FloatArray): Float = hypot(a[0] - b[0], a[1] - b[1])

  private fun roundToMultipleOf32(value: Float): Int = (value / 32f).roundToInt() * 32

  /** 由点集求最小外接矩形：凸包 + 旋转卡壳。返回 4 个角点与矩形宽高。 */
  private fun minAreaRect(points: List<FloatArray>): Triple<Array<FloatArray>, Float, Float> {
    val hull = convexHull(points)
    if (hull.size < 3) {
      val (minX, maxX, minY, maxY) = bounds(points)
      val rect = arrayOf(
        floatArrayOf(minX, minY),
        floatArrayOf(maxX, minY),
        floatArrayOf(maxX, maxY),
        floatArrayOf(minX, maxY),
      )
      return Triple(rect, maxX - minX, maxY - minY)
    }

    var bestArea = Float.MAX_VALUE
    var bestUx = 1f
    var bestUy = 0f
    var bestMinU = 0f
    var bestMinV = 0f
    var bestW = 0f
    var bestH = 0f

    for (i in hull.indices) {
      val p = hull[i]
      val q = hull[(i + 1) % hull.size]
      val dx = q[0] - p[0]
      val dy = q[1] - p[1]
      val len = hypot(dx, dy)
      if (len < 1e-6f) continue
      val ux = dx / len
      val uy = dy / len
      // 法向 = (-uy, ux)
      val vx = -uy
      val vy = ux
      var minU = Float.MAX_VALUE
      var maxU = -Float.MAX_VALUE
      var minV = Float.MAX_VALUE
      var maxV = -Float.MAX_VALUE
      for (point in hull) {
        val u = point[0] * ux + point[1] * uy
        val v = point[0] * vx + point[1] * vy
        if (u < minU) minU = u
        if (u > maxU) maxU = u
        if (v < minV) minV = v
        if (v > maxV) maxV = v
      }
      val area = (maxU - minU) * (maxV - minV)
      if (area < bestArea) {
        bestArea = area
        bestUx = ux
        bestUy = uy
        bestMinU = minU
        bestMinV = minV
        bestW = maxU - minU
        bestH = maxV - minV
      }
    }

    // 法向由 u 轴旋转 90° 得到，与循环里一致
    val vx = -bestUy
    val vy = bestUx
    fun corner(u: Float, v: Float) =
      floatArrayOf(bestUx * u + vx * v, bestUy * u + vy * v)
    val rect = arrayOf(
      corner(bestMinU, bestMinV),
      corner(bestMinU + bestW, bestMinV),
      corner(bestMinU + bestW, bestMinV + bestH),
      corner(bestMinU, bestMinV + bestH),
    )
    return Triple(rect, bestW, bestH)
  }

  private fun bounds(points: List<FloatArray>): FloatArray {
    var minX = Float.MAX_VALUE
    var maxX = -Float.MAX_VALUE
    var minY = Float.MAX_VALUE
    var maxY = -Float.MAX_VALUE
    for (p in points) {
      if (p[0] < minX) minX = p[0]
      if (p[0] > maxX) maxX = p[0]
      if (p[1] < minY) minY = p[1]
      if (p[1] > maxY) maxY = p[1]
    }
    return floatArrayOf(minX, maxX, minY, maxY)
  }

  /** Andrew 单调链凸包。 */
  private fun convexHull(points: List<FloatArray>): List<FloatArray> {
    if (points.size < 3) return points
    val sorted = points.sortedWith(compareBy({ it[0] }, { it[1] }))
    val hull = ArrayList<FloatArray>(sorted.size * 2)
    for (point in sorted) {
      while (hull.size >= 2 && cross(hull[hull.size - 2], hull[hull.size - 1], point) <= 0f) {
        hull.removeAt(hull.size - 1)
      }
      hull.add(point)
    }
    val lowerSize = hull.size + 1
    for (i in sorted.size - 2 downTo 0) {
      val point = sorted[i]
      while (hull.size >= lowerSize && cross(hull[hull.size - 2], hull[hull.size - 1], point) <= 0f) {
        hull.removeAt(hull.size - 1)
      }
      hull.add(point)
    }
    if (hull.size > 1) hull.removeAt(hull.size - 1)
    return hull
  }

  private fun cross(o: FloatArray, a: FloatArray, b: FloatArray): Float =
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

  /** 复刻 rapidocr get_mini_boxes 的角点顺序（先按 x，再按 y 选 TL/TR/BR/BL）。 */
  private fun orderMiniBox(box: Array<FloatArray>): Array<FloatArray> {
    val points = box.sortedBy { it[0] }
    val index1: Int
    val index4: Int
    if (points[1][1] > points[0][1]) {
      index1 = 0
      index4 = 1
    } else {
      index1 = 1
      index4 = 0
    }
    val index2: Int
    val index3: Int
    if (points[3][1] > points[2][1]) {
      index2 = 2
      index3 = 3
    } else {
      index2 = 3
      index3 = 2
    }
    return arrayOf(points[index1], points[index2], points[index3], points[index4])
  }

  /** 框点转 TL,TR,BR,BL（rapidocr order_points_clockwise）。 */
  private fun orderPointsClockwise(pts: Array<FloatArray>): Array<FloatArray> {
    val sorted = pts.sortedBy { it[0] }
    val left = sorted.take(2).sortedBy { it[1] }
    val right = sorted.drop(2).sortedBy { it[1] }
    return arrayOf(left[0], right[0], right[1], left[1])
  }

  private fun polygonArea(poly: Array<FloatArray>): Float {
    var sum = 0f
    for (i in poly.indices) {
      val a = poly[i]
      val b = poly[(i + 1) % poly.size]
      sum += a[0] * b[1] - b[0] * a[1]
    }
    return abs(sum) / 2f
  }

  private fun polygonPerimeter(poly: Array<FloatArray>): Float {
    var sum = 0f
    for (i in poly.indices) {
      sum += dist(poly[i], poly[(i + 1) % poly.size])
    }
    return sum
  }

  /** pyclipper 的圆角外扩：这里用斜接近似（矩形外扩两者等价）。 */
  private fun offsetPolygon(poly: Array<FloatArray>, distance: Float): Array<FloatArray> {
    if (distance <= 0f) return poly
    val n = poly.size
    var cx = 0f
    var cy = 0f
    for (p in poly) {
      cx += p[0]
      cy += p[1]
    }
    cx /= n
    cy /= n

    val lines = arrayOfNulls<FloatArray>(n) // [ox, oy, dx, dy]
    for (i in 0 until n) {
      val a = poly[i]
      val b = poly[(i + 1) % n]
      var dx = b[0] - a[0]
      var dy = b[1] - a[1]
      val len = hypot(dx, dy)
      if (len < 1e-6f) return poly
      dx /= len
      dy /= len
      var nx = dy
      var ny = -dx
      val mx = (a[0] + b[0]) / 2f
      val my = (a[1] + b[1]) / 2f
      if ((cx - mx) * nx + (cy - my) * ny > 0f) {
        nx = -nx
        ny = -ny
      }
      lines[i] = floatArrayOf(a[0] + nx * distance, a[1] + ny * distance, dx, dy)
    }

    return Array(n) { i ->
      val l1 = lines[(i + n - 1) % n]!!
      val l2 = lines[i]!!
      intersectLines(l1, l2) ?: poly[i]
    }
  }

  private fun intersectLines(l1: FloatArray, l2: FloatArray): FloatArray? {
    val denom = l1[2] * l2[3] - l1[3] * l2[2]
    if (abs(denom) < 1e-6f) return null
    val dx = l2[0] - l1[0]
    val dy = l2[1] - l1[1]
    val t = (dx * l2[3] - dy * l2[2]) / denom
    return floatArrayOf(l1[0] + l1[2] * t, l1[1] + l1[3] * t)
  }

  private fun pointInPolygon(px: Float, py: Float, poly: Array<FloatArray>): Boolean {
    var inside = false
    var j = poly.size - 1
    for (i in poly.indices) {
      val xi = poly[i][0]
      val yi = poly[i][1]
      val xj = poly[j][0]
      val yj = poly[j][1]
      if ((yi > py) != (yj > py) &&
        px < (xj - xi) * (py - yi) / (yj - yi) + xi
      ) {
        inside = !inside
      }
      j = i
    }
    return inside
  }

  /** 解 dst→src 的单应矩阵（4 组对应点，8 个未知数）。 */
  private fun solveHomography(src: Array<FloatArray>, dst: Array<FloatArray>): FloatArray? {
    val a = Array(8) { DoubleArray(8) }
    val b = DoubleArray(8)
    for (i in 0 until 4) {
      val x = src[i][0].toDouble()
      val y = src[i][1].toDouble()
      val u = dst[i][0].toDouble()
      val v = dst[i][1].toDouble()
      val r1 = i * 2
      val r2 = r1 + 1
      a[r1][0] = x
      a[r1][1] = y
      a[r1][2] = 1.0
      a[r1][6] = -x * u
      a[r1][7] = -y * u
      b[r1] = u
      a[r2][3] = x
      a[r2][4] = y
      a[r2][5] = 1.0
      a[r2][6] = -x * v
      a[r2][7] = -y * v
      b[r2] = v
    }
    val solution = solveLinear(a, b) ?: return null
    return FloatArray(8) { solution[it].toFloat() }
  }

  private fun solveLinear(a: Array<DoubleArray>, b: DoubleArray): DoubleArray? {
    val n = b.size
    for (col in 0 until n) {
      var pivot = col
      for (row in col + 1 until n) {
        if (abs(a[row][col]) > abs(a[pivot][col])) pivot = row
      }
      if (abs(a[pivot][col]) < 1e-12) return null
      if (pivot != col) {
        val tmp = a[col]
        a[col] = a[pivot]
        a[pivot] = tmp
        val t = b[col]
        b[col] = b[pivot]
        b[pivot] = t
      }
      val div = a[col][col]
      for (k in col until n) a[col][k] /= div
      b[col] /= div
      for (row in 0 until n) {
        if (row == col) continue
        val factor = a[row][col]
        if (factor == 0.0) continue
        for (k in col until n) a[row][k] -= factor * a[col][k]
        b[row] -= factor * b[col]
      }
    }
    return b
  }
}
