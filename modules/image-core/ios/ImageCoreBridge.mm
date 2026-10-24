#import "ImageCoreBridge.h"

#include "image_core.h"

int32_t ImageCoreProcessPixels(uint32_t *pixels, int32_t width, int32_t height,
                               int32_t filter) {
  if (pixels == nullptr || width <= 0 || height <= 0) {
    return -1;
  }
  image_core::process_pixels(pixels, width, height, filter);
  return 0;
}

const char *ImageCoreVersion(void) { return image_core::version(); }
