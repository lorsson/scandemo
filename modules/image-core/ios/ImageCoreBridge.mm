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

const char *ImageCoreVersion(void) { return image_core::version(); }
