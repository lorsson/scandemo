#include "image_core_c.h"

#include <cstddef>

#include "image_core.h"

namespace {

bool valid_filter(int32_t filter) {
  return filter >= IC_FILTER_ORIGINAL && filter <= IC_FILTER_ENHANCE;
}

bool valid_buffer(const void* pixels, int32_t width, int32_t height) {
  return pixels != nullptr && width > 0 && height > 0;
}

/* RGBA <-> 0xAARRGGBB 的字节序互换（little-endian 上即交换 R/B） */
void swap_red_blue(uint8_t* pixels, size_t count) {
  for (size_t i = 0; i < count; ++i) {
    uint8_t* px = pixels + i * 4;
    const uint8_t r = px[0];
    px[0] = px[2];
    px[2] = r;
  }
}

}  // namespace

extern "C" {

const char* ic_version(void) { return image_core::version(); }

int32_t ic_process_argb32(uint32_t* pixels, int32_t width, int32_t height,
                          int32_t filter) {
  if (!valid_buffer(pixels, width, height)) {
    return IC_ERR_ARGUMENT;
  }
  if (!valid_filter(filter)) {
    return IC_ERR_FILTER;
  }
  image_core::process_pixels(pixels, width, height, filter);
  return IC_OK;
}

int32_t ic_process_rgba(uint8_t* pixels, int32_t width, int32_t height,
                        int32_t filter) {
  if (!valid_buffer(pixels, width, height)) {
    return IC_ERR_ARGUMENT;
  }
  if (!valid_filter(filter)) {
    return IC_ERR_FILTER;
  }
  if (filter == IC_FILTER_ORIGINAL) {
    return IC_OK;
  }
  const size_t count = static_cast<size_t>(width) * static_cast<size_t>(height);
  swap_red_blue(pixels, count);
  image_core::process_pixels(reinterpret_cast<uint32_t*>(pixels), width, height,
                             filter);
  swap_red_blue(pixels, count);
  return IC_OK;
}

}  // extern "C"
