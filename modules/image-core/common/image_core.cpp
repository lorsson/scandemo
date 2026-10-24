#include "image_core.h"

#include <cmath>

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

}  // namespace

void process_pixels(uint32_t* pixels, int32_t width, int32_t height, int32_t filter) {
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
    case kOriginal:
    default:
      break;
  }
}

const char* version() { return "image-core/0.1.0"; }

}  // namespace image_core
