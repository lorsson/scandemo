#ifndef ImageCoreBridge_h
#define ImageCoreBridge_h

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int32_t ImageCoreProcessPixels(uint32_t *pixels, int32_t width, int32_t height,
                               int32_t filter);

const char *ImageCoreVersion(void);

#ifdef __cplusplus
}
#endif

#endif /* ImageCoreBridge_h */
