#include <jni.h>

#include <cstdint>

#include "image_core.h"

extern "C" {

JNIEXPORT jint JNICALL
Java_expo_modules_imagecore_ImageCoreModule_nativeProcessPixels(
    JNIEnv* env, jobject /*thiz*/, jintArray pixels, jint width, jint height,
    jint filter) {
  if (pixels == nullptr || width <= 0 || height <= 0) {
    return -1;
  }

  const jsize length = env->GetArrayLength(pixels);
  if (length < width * height) {
    return -2;
  }

  jint* raw = env->GetIntArrayElements(pixels, nullptr);
  if (raw == nullptr) {
    return -3;
  }

  image_core::process_pixels(reinterpret_cast<uint32_t*>(raw), width, height,
                             filter);

  env->ReleaseIntArrayElements(pixels, raw, 0);
  return 0;
}

JNIEXPORT jstring JNICALL
Java_expo_modules_imagecore_ImageCoreModule_nativeVersion(JNIEnv* env,
                                                          jobject /*thiz*/) {
  return env->NewStringUTF(image_core::version());
}

}  // extern "C"
