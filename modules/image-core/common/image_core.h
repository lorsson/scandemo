#ifndef IMAGE_CORE_H
#define IMAGE_CORE_H

#include <cstdint>

namespace image_core {

// 与 JS 侧 FilterKey 一一对应
enum Filter : int32_t {
  kOriginal = 0,
  kGray = 1,
  kBw = 2,
  kEnhance = 3,
};

/**
 * 原地处理 ARGB_8888 像素（每个 uint32 为 0xAARRGGBB）。
 * 不负责解码/编码，两个平台各自用系统 API 完成。
 */
void process_pixels(uint32_t* pixels, int32_t width, int32_t height, int32_t filter);

const char* version();

}  // namespace image_core

#endif  // IMAGE_CORE_H
