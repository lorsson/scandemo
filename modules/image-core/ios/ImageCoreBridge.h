#ifndef ImageCoreBridge_h
#define ImageCoreBridge_h

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int32_t ImageCoreProcessPixels(uint32_t *pixels, int32_t width, int32_t height,
                               int32_t filter);

int32_t ImageCoreProcessPixelsEx(uint32_t *pixels, int32_t width, int32_t height,
                                 int32_t filter, int32_t contrast,
                                 int32_t brightness, int32_t detail);

/* 几何变换：全部实现在共享 C++ 核心里，Android / iOS 走同一份代码 */

int32_t ImageCoreWarpSize(int32_t src_width, int32_t src_height,
                          const double quad[8], int32_t max_dim,
                          int32_t *out_width, int32_t *out_height);

int32_t ImageCoreWarp(const uint32_t *src, int32_t src_width,
                      int32_t src_height, uint32_t *dst, int32_t dst_width,
                      int32_t dst_height, const double quad[8]);

int32_t ImageCoreResizeSize(int32_t src_width, int32_t src_height,
                            int32_t max_dim, int32_t *out_width,
                            int32_t *out_height);

int32_t ImageCoreResize(const uint32_t *src, int32_t src_width,
                        int32_t src_height, uint32_t *dst, int32_t dst_width,
                        int32_t dst_height);

int32_t ImageCoreRotate(const uint32_t *src, int32_t src_width,
                        int32_t src_height, uint32_t *dst, int32_t degrees);

const char *ImageCoreVersion(void);

#ifdef __cplusplus
}
#endif

#endif /* ImageCoreBridge_h */
