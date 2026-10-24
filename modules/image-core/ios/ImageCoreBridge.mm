#import "ImageCoreBridge.h"

#include "image_core.h"

// CocoaPods 不会把 podspec 根目录之外的 `../common/*.cpp` 编进 ImageCore target
//（pod install 解析时被丢弃），导致链接期找不到 image_core::* 符号。
// 因此在桥接的编译单元里直接包含共享算法源文件，保证 .cpp 一定参与编译。
#include "../common/image_core.cpp"

int32_t ImageCoreProcessPixels(uint32_t *pixels, int32_t width, int32_t height,
                               int32_t filter) {
  if (pixels == nullptr || width <= 0 || height <= 0) {
    return -1;
  }
  image_core::process_pixels(pixels, width, height, filter);
  return 0;
}

int32_t ImageCoreProcessPixelsEx(uint32_t *pixels, int32_t width, int32_t height,
                                 int32_t filter, int32_t contrast,
                                 int32_t brightness, int32_t detail) {
  if (pixels == nullptr || width <= 0 || height <= 0) {
    return -1;
  }
  image_core::process_pixels_ex(pixels, width, height, filter, contrast,
                                brightness, detail);
  return 0;
}

static void to_float_quad(const double quad[8], float out[8]) {
  for (int i = 0; i < 8; ++i) {
    out[i] = static_cast<float>(quad[i]);
  }
}

int32_t ImageCoreWarpSize(int32_t src_width, int32_t src_height,
                          const double quad[8], int32_t max_dim,
                          int32_t *out_width, int32_t *out_height) {
  if (src_width <= 0 || src_height <= 0 || quad == nullptr ||
      out_width == nullptr || out_height == nullptr) {
    return -1;
  }
  float q[8];
  to_float_quad(quad, q);
  image_core::warp_output_size(src_width, src_height, q, max_dim, out_width,
                               out_height);
  return 0;
}

int32_t ImageCoreWarp(const uint32_t *src, int32_t src_width,
                      int32_t src_height, uint32_t *dst, int32_t dst_width,
                      int32_t dst_height, const double quad[8]) {
  if (src == nullptr || dst == nullptr || quad == nullptr || src_width <= 0 ||
      src_height <= 0 || dst_width <= 0 || dst_height <= 0) {
    return -1;
  }
  float q[8];
  to_float_quad(quad, q);
  image_core::warp_pixels(src, src_width, src_height, dst, dst_width, dst_height,
                          q);
  return 0;
}

int32_t ImageCoreResizeSize(int32_t src_width, int32_t src_height,
                            int32_t max_dim, int32_t *out_width,
                            int32_t *out_height) {
  if (src_width <= 0 || src_height <= 0 || out_width == nullptr ||
      out_height == nullptr) {
    return -1;
  }
  image_core::resize_output_size(src_width, src_height, max_dim, out_width,
                                 out_height);
  return 0;
}

int32_t ImageCoreResize(const uint32_t *src, int32_t src_width,
                        int32_t src_height, uint32_t *dst, int32_t dst_width,
                        int32_t dst_height) {
  if (src == nullptr || dst == nullptr || src_width <= 0 || src_height <= 0 ||
      dst_width <= 0 || dst_height <= 0) {
    return -1;
  }
  image_core::resize_pixels(src, src_width, src_height, dst, dst_width,
                            dst_height);
  return 0;
}

int32_t ImageCoreRotate(const uint32_t *src, int32_t src_width,
                        int32_t src_height, uint32_t *dst, int32_t degrees) {
  if (src == nullptr || dst == nullptr || src_width <= 0 || src_height <= 0) {
    return -1;
  }
  if (degrees != 90 && degrees != 180 && degrees != 270) {
    return -2;
  }
  image_core::rotate_pixels(src, src_width, src_height, dst, degrees);
  return 0;
}

const char *ImageCoreVersion(void) { return image_core::version(); }
