#include "image_core.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <utility>
#include <vector>

namespace image_core {
namespace {

inline int clamp255(int v) {
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

inline int luma(int r, int g, int b) {
  // 0.299R + 0.587G + 0.114B，整数近似，与 JS 版保持一致的观感
  return (299 * r + 587 * g + 114 * b) / 1000;
}

inline uint32_t pack(int a, int r, int g, int b) {
  return (static_cast<uint32_t>(a) << 24) | (static_cast<uint32_t>(r) << 16) |
         (static_cast<uint32_t>(g) << 8) | static_cast<uint32_t>(b);
}

int otsu_threshold(const uint32_t* hist, uint64_t total) {
  uint64_t sum = 0;
  for (int i = 0; i < 256; ++i) {
    sum += static_cast<uint64_t>(i) * hist[i];
  }

  uint64_t sum_b = 0;
  uint64_t weight_b = 0;
  double best = 0.0;
  int threshold = 127;

  for (int t = 0; t < 256; ++t) {
    weight_b += hist[t];
    if (weight_b == 0) continue;
    const uint64_t weight_f = total - weight_b;
    if (weight_f == 0) break;

    sum_b += static_cast<uint64_t>(t) * hist[t];
    const double mean_b = static_cast<double>(sum_b) / static_cast<double>(weight_b);
    const double mean_f =
        static_cast<double>(sum - sum_b) / static_cast<double>(weight_f);
    const double between =
        static_cast<double>(weight_b) * static_cast<double>(weight_f) *
        (mean_b - mean_f) * (mean_b - mean_f);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** 单通道盒式模糊（可分离 + 滑动窗口，O(w*h)），r<=0 时直接拷贝 */
void box_blur(const uint8_t* src, uint8_t* dst, int32_t w, int32_t h, int r) {
  const size_t n = static_cast<size_t>(w) * static_cast<size_t>(h);
  if (r <= 0) {
    std::memcpy(dst, src, n);
    return;
  }
  const int window = 2 * r + 1;
  std::vector<uint8_t> tmp(n);

  for (int y = 0; y < h; ++y) {
    const uint8_t* row = src + static_cast<size_t>(y) * w;
    int sum = 0;
    for (int x = -r; x <= r; ++x) {
      sum += row[std::min(std::max(x, 0), w - 1)];
    }
    for (int x = 0; x < w; ++x) {
      tmp[static_cast<size_t>(y) * w + x] = static_cast<uint8_t>(sum / window);
      const int out = std::min(std::max(x - r, 0), w - 1);
      const int in = std::min(std::max(x + r + 1, 0), w - 1);
      sum += row[in] - row[out];
    }
  }

  for (int x = 0; x < w; ++x) {
    int sum = 0;
    for (int y = -r; y <= r; ++y) {
      sum += tmp[static_cast<size_t>(std::min(std::max(y, 0), h - 1)) * w + x];
    }
    for (int y = 0; y < h; ++y) {
      dst[static_cast<size_t>(y) * w + x] = static_cast<uint8_t>(sum / window);
      const int out = std::min(std::max(y - r, 0), h - 1);
      const int in = std::min(std::max(y + r + 1, 0), h - 1);
      sum += tmp[static_cast<size_t>(in) * w + x] -
             tmp[static_cast<size_t>(out) * w + x];
    }
  }
}

/** 亮度反锐化掩模：用模糊后的亮度作为基线，把差值加回 RGB */
void unsharp(uint32_t* pixels, int32_t w, int32_t h, int radius, float amount) {
  if (radius <= 0 || amount <= 0.0f) return;
  const size_t n = static_cast<size_t>(w) * static_cast<size_t>(h);
  std::vector<uint8_t> lum(n);
  std::vector<uint8_t> blurred(n);

  for (size_t i = 0; i < n; ++i) {
    const uint32_t p = pixels[i];
    lum[i] = static_cast<uint8_t>(
        luma(static_cast<int>((p >> 16) & 0xff), static_cast<int>((p >> 8) & 0xff),
             static_cast<int>(p & 0xff)));
  }
  box_blur(lum.data(), blurred.data(), w, h, radius);

  for (size_t i = 0; i < n; ++i) {
    const int diff = static_cast<int>(lum[i]) - static_cast<int>(blurred[i]);
    if (diff == 0) continue;
    const int delta = static_cast<int>(diff * amount);
    if (delta == 0) continue;
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    pixels[i] = pack(a, clamp255(static_cast<int>((p >> 16) & 0xff) + delta),
                     clamp255(static_cast<int>((p >> 8) & 0xff) + delta),
                     clamp255(static_cast<int>(p & 0xff) + delta));
  }
}

void apply_gray(uint32_t* pixels, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    const int lum = clamp255(
        static_cast<int>((luma(static_cast<int>((p >> 16) & 0xff),
                               static_cast<int>((p >> 8) & 0xff),
                               static_cast<int>(p & 0xff)) -
                          128) *
                             1.15f +
                         128));
    pixels[i] = pack(a, lum, lum, lum);
  }
}

void apply_bw(uint32_t* pixels, size_t count) {
  uint32_t hist[256] = {0};
  for (size_t i = 0; i < count; ++i) {
    const uint32_t p = pixels[i];
    const int lum = luma(static_cast<int>((p >> 16) & 0xff),
                         static_cast<int>((p >> 8) & 0xff),
                         static_cast<int>(p & 0xff));
    ++hist[lum];
  }
  const int threshold = otsu_threshold(hist, count);
  for (size_t i = 0; i < count; ++i) {
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    const int lum = luma(static_cast<int>((p >> 16) & 0xff),
                         static_cast<int>((p >> 8) & 0xff),
                         static_cast<int>(p & 0xff));
    const int v = lum > threshold ? 255 : 0;
    pixels[i] = pack(a, v, v, v);
  }
}

void apply_enhance(uint32_t* pixels, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    int r = static_cast<int>((p >> 16) & 0xff);
    int g = static_cast<int>((p >> 8) & 0xff);
    int b = static_cast<int>(p & 0xff);
    const int lum = luma(r, g, b);

    if (lum > 165) {
      // 纸面提亮趋白
      const float k = std::fmin(1.0f, (lum - 165) / 90.0f) * 0.92f;
      r = static_cast<int>(r + (255 - r) * k);
      g = static_cast<int>(g + (255 - g) * k);
      b = static_cast<int>(b + (255 - b) * k);
    } else {
      // 墨迹增强对比
      r = clamp255(static_cast<int>((r - 128) * 1.28f) + 128);
      g = clamp255(static_cast<int>((g - 128) * 1.28f) + 128);
      b = clamp255(static_cast<int>((b - 128) * 1.28f) + 128);
    }
    pixels[i] = pack(a, clamp255(r), clamp255(g), clamp255(b));
  }
}

/**
 * 去阴影：用大半径模糊估计每个位置的背景亮度，再用「目标亮度 / 背景亮度」
 * 做局部增益。纸面光照不均时背景估计低 → 增益大 → 提亮；纯黑墨迹受影响小。
 */
void apply_shadow(uint32_t* pixels, int32_t w, int32_t h) {
  const size_t n = static_cast<size_t>(w) * static_cast<size_t>(h);
  std::vector<uint8_t> lum(n);
  std::vector<uint8_t> bg(n);

  for (size_t i = 0; i < n; ++i) {
    const uint32_t p = pixels[i];
    lum[i] = static_cast<uint8_t>(
        luma(static_cast<int>((p >> 16) & 0xff), static_cast<int>((p >> 8) & 0xff),
             static_cast<int>(p & 0xff)));
  }
  const int radius = std::max(6, std::min(w, h) / 8);
  box_blur(lum.data(), bg.data(), w, h, radius);

  for (size_t i = 0; i < n; ++i) {
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    const int base = std::max(static_cast<int>(bg[i]), 24);
    float gain = 235.0f / static_cast<float>(base);
    if (gain > 3.5f) gain = 3.5f;
    if (gain < 1.0f) gain = 1.0f;
    const int r = clamp255(static_cast<int>((p >> 16) & 0xff) * gain);
    const int g = clamp255(static_cast<int>((p >> 8) & 0xff) * gain);
    const int b = clamp255(static_cast<int>(p & 0xff) * gain);
    pixels[i] = pack(a, r, g, b);
  }
}

/**
 * 去除手写：彩色笔迹（蓝/红/绿）饱和度明显高于印刷黑字与纸面。
 * 这是纯启发式，彩色印章/图片也会被一起去掉——文档场景下可接受。
 */
void apply_dehand(uint32_t* pixels, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    const int r = static_cast<int>((p >> 16) & 0xff);
    const int g = static_cast<int>((p >> 8) & 0xff);
    const int b = static_cast<int>(p & 0xff);
    const int mx = std::max(r, std::max(g, b));
    const int mn = std::min(r, std::min(g, b));
    const float sat = mx > 0 ? static_cast<float>(mx - mn) / mx : 0.0f;
    if (mx > 70 && sat > 0.32f) {
      pixels[i] = pack(a, 255, 255, 255);
    }
  }
}

/** 高清：先按 1%/99% 分位做色阶拉伸，再叠一层半径 2 的锐化 */
void apply_hd(uint32_t* pixels, int32_t w, int32_t h) {
  const size_t n = static_cast<size_t>(w) * static_cast<size_t>(h);
  uint32_t hist[256] = {0};
  for (size_t i = 0; i < n; ++i) {
    const uint32_t p = pixels[i];
    ++hist[luma(static_cast<int>((p >> 16) & 0xff),
                static_cast<int>((p >> 8) & 0xff),
                static_cast<int>(p & 0xff))];
  }

  const uint64_t lowCount = static_cast<uint64_t>(n / 100);
  const uint64_t highCount = static_cast<uint64_t>(n) - lowCount;
  int low = 0;
  int high = 255;
  uint64_t acc = 0;
  for (int v = 0; v < 256; ++v) {
    acc += hist[v];
    if (acc >= lowCount) {
      low = v;
      break;
    }
  }
  acc = 0;
  for (int v = 0; v < 256; ++v) {
    acc += hist[v];
    if (acc >= highCount) {
      high = v;
      break;
    }
  }
  if (high - low < 8) {
    low = 0;
    high = 255;
  }
  const float scale = 255.0f / static_cast<float>(high - low);

  for (size_t i = 0; i < n; ++i) {
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    const int r = clamp255(
        static_cast<int>((static_cast<int>((p >> 16) & 0xff) - low) * scale));
    const int g = clamp255(
        static_cast<int>((static_cast<int>((p >> 8) & 0xff) - low) * scale));
    const int b = clamp255(
        static_cast<int>((static_cast<int>(p & 0xff) - low) * scale));
    pixels[i] = pack(a, r, g, b);
  }

  unsharp(pixels, w, h, 2, 0.55f);
}

/** 增亮：压暗部 + 高光推向纸白 */
void apply_brighten(uint32_t* pixels, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    int r = static_cast<int>(255.0f - (255 - static_cast<int>((p >> 16) & 0xff)) * 0.76f);
    int g = static_cast<int>(255.0f - (255 - static_cast<int>((p >> 8) & 0xff)) * 0.76f);
    int b = static_cast<int>(255.0f - (255 - static_cast<int>(p & 0xff)) * 0.76f);
    const int lum = luma(r, g, b);
    if (lum > 205) {
      const float k = std::fmin(1.0f, (lum - 205) / 50.0f) * 0.85f;
      r = static_cast<int>(r + (255 - r) * k);
      g = static_cast<int>(g + (255 - g) * k);
      b = static_cast<int>(b + (255 - b) * k);
    }
    pixels[i] = pack(a, clamp255(r), clamp255(g), clamp255(b));
  }
}

void apply_sharpen(uint32_t* pixels, int32_t w, int32_t h) {
  unsharp(pixels, w, h, 1, 1.0f);
}

/** 省墨：把纯黑抬到深灰，整体向白压缩，打印时少用墨 */
void apply_inksave(uint32_t* pixels, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    const int r =
        clamp255(45 + static_cast<int>((p >> 16) & 0xff) * 210 / 255);
    const int g =
        clamp255(45 + static_cast<int>((p >> 8) & 0xff) * 210 / 255);
    const int b = clamp255(45 + static_cast<int>(p & 0xff) * 210 / 255);
    pixels[i] = pack(a, r, g, b);
  }
}

void apply_invert(uint32_t* pixels, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    const uint32_t p = pixels[i];
    const int a = static_cast<int>((p >> 24) & 0xff);
    pixels[i] = pack(a, 255 - static_cast<int>((p >> 16) & 0xff),
                     255 - static_cast<int>((p >> 8) & 0xff),
                     255 - static_cast<int>(p & 0xff));
  }
}

/** 第二步微调：亮度 → 对比度 → 细节（反锐化） */
void apply_adjust(uint32_t* pixels, int32_t w, int32_t h, int contrast,
                  int brightness, int detail) {
  const size_t n = static_cast<size_t>(w) * static_cast<size_t>(h);

  if (contrast != 0 || brightness != 0) {
    const float c = static_cast<float>(contrast) * 2.55f;
    // 标准对比度系数，c=±127 时约为 0.35x ~ 2.9x
    const float factor = (259.0f * (c + 255.0f)) / (255.0f * (259.0f - c));
    const float add = static_cast<float>(brightness) * 2.55f;
    for (size_t i = 0; i < n; ++i) {
      const uint32_t p = pixels[i];
      const int a = static_cast<int>((p >> 24) & 0xff);
      const int r = clamp255(static_cast<int>(
          (static_cast<int>((p >> 16) & 0xff) + add - 128.0f) * factor + 128.0f));
      const int g = clamp255(static_cast<int>(
          (static_cast<int>((p >> 8) & 0xff) + add - 128.0f) * factor + 128.0f));
      const int b = clamp255(static_cast<int>(
          (static_cast<int>(p & 0xff) + add - 128.0f) * factor + 128.0f));
      pixels[i] = pack(a, r, g, b);
    }
  }

  if (detail > 0) {
    unsharp(pixels, w, h, 1, static_cast<float>(detail) / 100.0f * 1.2f);
  }
}

}  // namespace

void process_pixels(uint32_t* pixels, int32_t width, int32_t height,
                    int32_t filter) {
  process_pixels_ex(pixels, width, height, filter, 0, 0, 0);
}

void process_pixels_ex(uint32_t* pixels, int32_t width, int32_t height,
                       int32_t filter, int32_t contrast, int32_t brightness,
                       int32_t detail) {
  if (pixels == nullptr || width <= 0 || height <= 0) {
    return;
  }
  const size_t count = static_cast<size_t>(width) * static_cast<size_t>(height);

  switch (filter) {
    case kGray:
      apply_gray(pixels, count);
      break;
    case kBw:
      apply_bw(pixels, count);
      break;
    case kEnhance:
      apply_enhance(pixels, count);
      break;
    case kShadow:
      apply_shadow(pixels, width, height);
      break;
    case kDehand:
      apply_dehand(pixels, count);
      break;
    case kHd:
      apply_hd(pixels, width, height);
      break;
    case kBrighten:
      apply_brighten(pixels, count);
      break;
    case kSharpen:
      apply_sharpen(pixels, width, height);
      break;
    case kInkSave:
      apply_inksave(pixels, count);
      break;
    case kInvert:
      apply_invert(pixels, count);
      break;
    case kOriginal:
    default:
      break;
  }

  contrast = std::min(50, std::max(-50, contrast));
  brightness = std::min(50, std::max(-50, brightness));
  detail = std::min(100, std::max(0, detail));
  apply_adjust(pixels, width, height, contrast, brightness, detail);
}

// ---------------------------------------------------------------------------
// 几何变换：透视校正（裁剪）/ 缩放 / 旋转
//
// 这三步以前在 JS 的 WebView canvas 里做，1185x1400 的裁剪要 5.6 s；
// 放到这里以后同一张图是几十毫秒。像素约定与滤镜一致：0xAARRGGBB。
// ---------------------------------------------------------------------------

namespace {

/** 双线性采样；越界返回白色（裁剪时四边形外的区域） */
inline uint32_t sample_bilinear(const uint32_t* src, int32_t sw, int32_t sh,
                                double u, double v) {
  if (!(u >= 0.0 && v >= 0.0 && u <= sw - 1 && v <= sh - 1)) {
    return 0xFFFFFFFFu;
  }
  const int32_t x0 = static_cast<int32_t>(u);
  const int32_t y0 = static_cast<int32_t>(v);
  const int32_t x1 = std::min(x0 + 1, sw - 1);
  const int32_t y1 = std::min(y0 + 1, sh - 1);
  const double fx = u - x0;
  const double fy = v - y0;
  const uint32_t p00 = src[static_cast<size_t>(y0) * sw + x0];
  const uint32_t p10 = src[static_cast<size_t>(y0) * sw + x1];
  const uint32_t p01 = src[static_cast<size_t>(y1) * sw + x0];
  const uint32_t p11 = src[static_cast<size_t>(y1) * sw + x1];
  const double w00 = (1.0 - fx) * (1.0 - fy);
  const double w10 = fx * (1.0 - fy);
  const double w01 = (1.0 - fx) * fy;
  const double w11 = fx * fy;

  auto blend = [&](int shift) {
    const double value = static_cast<double>((p00 >> shift) & 0xFF) * w00 +
                         static_cast<double>((p10 >> shift) & 0xFF) * w10 +
                         static_cast<double>((p01 >> shift) & 0xFF) * w01 +
                         static_cast<double>((p11 >> shift) & 0xFF) * w11;
    return clamp255(static_cast<int>(value + 0.5));
  };
  return pack(255, blend(16), blend(8), blend(0));
}

/**
 * 4 点对应关系求单应矩阵：dst(x,y) -> src(u,v)。
 * 与 JS 版（filterEngine.tsx 的 solveHomography）同一套高斯消元，
 * 保证两边裁出来的画面一致。
 */
void solve_homography(const double dst[8], const double src[8], double h[8]) {
  double a[8][9];
  for (int32_t i = 0; i < 4; ++i) {
    const double x = dst[i * 2];
    const double y = dst[i * 2 + 1];
    const double u = src[i * 2];
    const double v = src[i * 2 + 1];
    double* r0 = a[i * 2];
    double* r1 = a[i * 2 + 1];
    r0[0] = x; r0[1] = y; r0[2] = 1; r0[3] = 0; r0[4] = 0; r0[5] = 0;
    r0[6] = -u * x; r0[7] = -u * y; r0[8] = u;
    r1[0] = 0; r1[1] = 0; r1[2] = 0; r1[3] = x; r1[4] = y; r1[5] = 1;
    r1[6] = -v * x; r1[7] = -v * y; r1[8] = v;
  }

  for (int32_t k = 0; k < 8; ++k) {
    int32_t pivot = k;
    for (int32_t i = k + 1; i < 8; ++i) {
      if (std::fabs(a[i][k]) > std::fabs(a[pivot][k])) pivot = i;
    }
    if (pivot != k) {
      for (int32_t j = 0; j < 9; ++j) std::swap(a[k][j], a[pivot][j]);
    }
    const double div = a[k][k] == 0.0 ? 1e-12 : a[k][k];
    for (int32_t j = k; j < 9; ++j) a[k][j] /= div;
    for (int32_t i = 0; i < 8; ++i) {
      if (i == k) continue;
      const double f = a[i][k];
      if (f == 0.0) continue;
      for (int32_t j = k; j < 9; ++j) a[i][j] -= f * a[k][j];
    }
  }

  for (int32_t i = 0; i < 8; ++i) h[i] = a[i][8];
}

}  // namespace

void warp_output_size(int32_t src_width, int32_t src_height, const float quad[8],
                      int32_t max_dim, int32_t* out_width,
                      int32_t* out_height) {
  if (out_width == nullptr || out_height == nullptr) return;
  *out_width = 8;
  *out_height = 8;
  if (src_width <= 0 || src_height <= 0 || quad == nullptr) return;

  double x[4];
  double y[4];
  for (int32_t i = 0; i < 4; ++i) {
    x[i] = static_cast<double>(quad[i * 2]) * src_width;
    y[i] = static_cast<double>(quad[i * 2 + 1]) * src_height;
  }
  auto dist = [&](int32_t a, int32_t b) {
    const double dx = x[a] - x[b];
    const double dy = y[a] - y[b];
    return std::sqrt(dx * dx + dy * dy);
  };

  const double width = std::max(dist(0, 1), dist(3, 2));
  const double height = std::max(dist(0, 3), dist(1, 2));
  const double largest = std::max(width, height);
  if (largest < 1.0) return;

  const double limit = max_dim > 0 ? static_cast<double>(max_dim) : largest;
  const double scale = std::min(1.0, limit / largest);
  *out_width = std::max(8, static_cast<int32_t>(std::lround(width * scale)));
  *out_height = std::max(8, static_cast<int32_t>(std::lround(height * scale)));
}

void warp_pixels(const uint32_t* src, int32_t src_width, int32_t src_height,
                 uint32_t* dst, int32_t dst_width, int32_t dst_height,
                 const float quad[8]) {
  if (src == nullptr || dst == nullptr || quad == nullptr) return;
  if (src_width <= 0 || src_height <= 0 || dst_width <= 0 || dst_height <= 0) {
    return;
  }

  // 目标矩形四角 -> 源四边形四角
  const double dst_pts[8] = {0.0, 0.0,
                             static_cast<double>(dst_width), 0.0,
                             static_cast<double>(dst_width),
                             static_cast<double>(dst_height), 0.0,
                             static_cast<double>(dst_height)};
  double src_pts[8];
  for (int32_t i = 0; i < 4; ++i) {
    src_pts[i * 2] = static_cast<double>(quad[i * 2]) * src_width;
    src_pts[i * 2 + 1] = static_cast<double>(quad[i * 2 + 1]) * src_height;
  }

  double h[8];
  solve_homography(dst_pts, src_pts, h);

  // 用整数像素下标而不是像素中心：与 JS 版（filterEngine.tsx）完全一致，
  // 整图裁剪时逐像素原样复制，边缘也不会采样到图外变白
  for (int32_t y = 0; y < dst_height; ++y) {
    const double yy = static_cast<double>(y);
    uint32_t* row = dst + static_cast<size_t>(y) * dst_width;
    for (int32_t x = 0; x < dst_width; ++x) {
      const double xx = static_cast<double>(x);
      const double den = h[6] * xx + h[7] * yy + 1.0;
      if (std::fabs(den) < 1e-12) {
        row[x] = 0xFFFFFFFFu;
        continue;
      }
      const double u = (h[0] * xx + h[1] * yy + h[2]) / den;
      const double v = (h[3] * xx + h[4] * yy + h[5]) / den;
      row[x] = sample_bilinear(src, src_width, src_height, u, v);
    }
  }
}

void resize_output_size(int32_t src_width, int32_t src_height, int32_t max_dim,
                        int32_t* out_width, int32_t* out_height) {
  if (out_width == nullptr || out_height == nullptr) return;
  *out_width = 8;
  *out_height = 8;
  if (src_width <= 0 || src_height <= 0) return;
  const int32_t largest = std::max(src_width, src_height);
  if (max_dim <= 0 || largest <= max_dim) {
    *out_width = src_width;
    *out_height = src_height;
    return;
  }
  const double scale = static_cast<double>(max_dim) / largest;
  *out_width = std::max(1, static_cast<int32_t>(std::lround(src_width * scale)));
  *out_height = std::max(1, static_cast<int32_t>(std::lround(src_height * scale)));
}

void resize_pixels(const uint32_t* src, int32_t src_width, int32_t src_height,
                   uint32_t* dst, int32_t dst_width, int32_t dst_height) {
  if (src == nullptr || dst == nullptr) return;
  if (src_width <= 0 || src_height <= 0 || dst_width <= 0 || dst_height <= 0) {
    return;
  }

  if (dst_width == src_width && dst_height == src_height) {
    std::memcpy(dst, src,
                static_cast<size_t>(src_width) * src_height * sizeof(uint32_t));
    return;
  }

  if (dst_width <= src_width && dst_height <= src_height) {
    // 缩小：每个目标像素取源图对应区域的平均值，避免降采样锯齿
    for (int32_t y = 0; y < dst_height; ++y) {
      const int32_t y0 = static_cast<int32_t>(
          static_cast<int64_t>(y) * src_height / dst_height);
      const int32_t y1 = std::max(
          y0 + 1, static_cast<int32_t>(static_cast<int64_t>(y + 1) * src_height /
                                       dst_height));
      uint32_t* row = dst + static_cast<size_t>(y) * dst_width;
      for (int32_t x = 0; x < dst_width; ++x) {
        const int32_t x0 = static_cast<int32_t>(
            static_cast<int64_t>(x) * src_width / dst_width);
        const int32_t x1 = std::max(
            x0 + 1, static_cast<int32_t>(static_cast<int64_t>(x + 1) * src_width /
                                         dst_width));
        uint64_t sum_a = 0, sum_r = 0, sum_g = 0, sum_b = 0;
        uint32_t count = 0;
        for (int32_t sy = y0; sy < y1 && sy < src_height; ++sy) {
          const uint32_t* srow = src + static_cast<size_t>(sy) * src_width;
          for (int32_t sx = x0; sx < x1 && sx < src_width; ++sx) {
            const uint32_t p = srow[sx];
            sum_a += (p >> 24) & 0xFF;
            sum_r += (p >> 16) & 0xFF;
            sum_g += (p >> 8) & 0xFF;
            sum_b += p & 0xFF;
            ++count;
          }
        }
        if (count == 0) {
          row[x] = 0xFFFFFFFFu;
          continue;
        }
        row[x] = pack(static_cast<int>(sum_a / count),
                      static_cast<int>(sum_r / count),
                      static_cast<int>(sum_g / count),
                      static_cast<int>(sum_b / count));
      }
    }
    return;
  }

  // 放大：双线性，采样点夹到边界内
  for (int32_t y = 0; y < dst_height; ++y) {
    double v = (static_cast<double>(y) + 0.5) * src_height / dst_height - 0.5;
    v = std::min(std::max(v, 0.0), static_cast<double>(src_height - 1));
    uint32_t* row = dst + static_cast<size_t>(y) * dst_width;
    for (int32_t x = 0; x < dst_width; ++x) {
      double u = (static_cast<double>(x) + 0.5) * src_width / dst_width - 0.5;
      u = std::min(std::max(u, 0.0), static_cast<double>(src_width - 1));
      row[x] = sample_bilinear(src, src_width, src_height, u, v);
    }
  }
}

void rotate_pixels(const uint32_t* src, int32_t src_width, int32_t src_height,
                   uint32_t* dst, int32_t degrees) {
  if (src == nullptr || dst == nullptr || src_width <= 0 || src_height <= 0) {
    return;
  }

  if (degrees == 180) {
    const size_t count = static_cast<size_t>(src_width) * src_height;
    for (size_t i = 0; i < count; ++i) dst[i] = src[count - 1 - i];
    return;
  }

  if (degrees != 90 && degrees != 270) {
    std::memcpy(dst, src,
                static_cast<size_t>(src_width) * src_height * sizeof(uint32_t));
    return;
  }

  // 顺时针 90：源 (x,y) -> 目标 (h-1-y, x)；270 是它的逆
  const int32_t dst_width = src_height;
  const int32_t dst_height = src_width;
  for (int32_t y = 0; y < src_height; ++y) {
    const uint32_t* srow = src + static_cast<size_t>(y) * src_width;
    for (int32_t x = 0; x < src_width; ++x) {
      const int32_t dx = degrees == 90 ? (src_height - 1 - y) : y;
      const int32_t dy = degrees == 90 ? x : (src_width - 1 - x);
      dst[static_cast<size_t>(dy) * dst_width + dx] = srow[x];
    }
  }
}

const char* version() { return "image-core/0.3.0"; }

}  // namespace image_core
