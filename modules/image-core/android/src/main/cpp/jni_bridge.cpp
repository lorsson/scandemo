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

JNIEXPORT jint JNICALL
Java_expo_modules_imagecore_ImageCoreModule_nativeProcessPixelsEx(
    JNIEnv* env, jobject /*thiz*/, jintArray pixels, jint width, jint height,
    jint filter, jint contrast, jint brightness, jint detail) {
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

  image_core::process_pixels_ex(reinterpret_cast<uint32_t*>(raw), width, height,
                                filter, contrast, brightness, detail);

  env->ReleaseIntArrayElements(pixels, raw, 0);
  return 0;
}

namespace {

/** jdoubleArray[8] -> float quad[8]；长度不足返回 false */
bool read_quad(JNIEnv* env, jdoubleArray quad, float out[8]) {
  if (quad == nullptr || env->GetArrayLength(quad) < 8) return false;
  jdouble raw[8];
  env->GetDoubleArrayRegion(quad, 0, 8, raw);
  for (int i = 0; i < 8; ++i) out[i] = static_cast<float>(raw[i]);
  return true;
}

}  // namespace

/** 裁剪输出尺寸；返回 {width, height} */
JNIEXPORT jintArray JNICALL
Java_expo_modules_imagecore_ImageCoreModule_nativeWarpSize(
    JNIEnv* env, jobject /*thiz*/, jint src_width, jint src_height,
    jdoubleArray quad, jint max_dim) {
  int32_t width = 8;
  int32_t height = 8;
  float q[8];
  if (read_quad(env, quad, q)) {
    image_core::warp_output_size(src_width, src_height, q, max_dim, &width,
                                 &height);
  }
  const jint values[2] = {static_cast<jint>(width), static_cast<jint>(height)};
  jintArray result = env->NewIntArray(2);
  if (result != nullptr) {
    env->SetIntArrayRegion(result, 0, 2, values);
  }
  return result;
}

JNIEXPORT jint JNICALL
Java_expo_modules_imagecore_ImageCoreModule_nativeWarp(
    JNIEnv* env, jobject /*thiz*/, jintArray src_pixels, jint src_width,
    jint src_height, jintArray dst_pixels, jint dst_width, jint dst_height,
    jdoubleArray quad) {
  if (src_pixels == nullptr || dst_pixels == nullptr || src_width <= 0 ||
      src_height <= 0 || dst_width <= 0 || dst_height <= 0) {
    return -1;
  }
  if (env->GetArrayLength(src_pixels) < src_width * src_height ||
      env->GetArrayLength(dst_pixels) < dst_width * dst_height) {
    return -2;
  }
  float q[8];
  if (!read_quad(env, quad, q)) return -3;

  jint* src = env->GetIntArrayElements(src_pixels, nullptr);
  if (src == nullptr) return -4;
  jint* dst = env->GetIntArrayElements(dst_pixels, nullptr);
  if (dst == nullptr) {
    env->ReleaseIntArrayElements(src_pixels, src, JNI_ABORT);
    return -4;
  }

  image_core::warp_pixels(reinterpret_cast<const uint32_t*>(src), src_width,
                          src_height, reinterpret_cast<uint32_t*>(dst),
                          dst_width, dst_height, q);

  env->ReleaseIntArrayElements(src_pixels, src, JNI_ABORT);
  env->ReleaseIntArrayElements(dst_pixels, dst, 0);
  return 0;
}

/** 缩放输出尺寸（不放大）；返回 {width, height} */
JNIEXPORT jintArray JNICALL
Java_expo_modules_imagecore_ImageCoreModule_nativeResizeSize(
    JNIEnv* env, jobject /*thiz*/, jint src_width, jint src_height,
    jint max_dim) {
  int32_t width = src_width > 0 ? src_width : 1;
  int32_t height = src_height > 0 ? src_height : 1;
  image_core::resize_output_size(src_width, src_height, max_dim, &width,
                                 &height);
  const jint values[2] = {static_cast<jint>(width), static_cast<jint>(height)};
  jintArray result = env->NewIntArray(2);
  if (result != nullptr) {
    env->SetIntArrayRegion(result, 0, 2, values);
  }
  return result;
}

JNIEXPORT jint JNICALL
Java_expo_modules_imagecore_ImageCoreModule_nativeResize(
    JNIEnv* env, jobject /*thiz*/, jintArray src_pixels, jint src_width,
    jint src_height, jintArray dst_pixels, jint dst_width, jint dst_height) {
  if (src_pixels == nullptr || dst_pixels == nullptr || src_width <= 0 ||
      src_height <= 0 || dst_width <= 0 || dst_height <= 0) {
    return -1;
  }
  if (env->GetArrayLength(src_pixels) < src_width * src_height ||
      env->GetArrayLength(dst_pixels) < dst_width * dst_height) {
    return -2;
  }

  jint* src = env->GetIntArrayElements(src_pixels, nullptr);
  if (src == nullptr) return -4;
  jint* dst = env->GetIntArrayElements(dst_pixels, nullptr);
  if (dst == nullptr) {
    env->ReleaseIntArrayElements(src_pixels, src, JNI_ABORT);
    return -4;
  }

  image_core::resize_pixels(reinterpret_cast<const uint32_t*>(src), src_width,
                            src_height, reinterpret_cast<uint32_t*>(dst),
                            dst_width, dst_height);

  env->ReleaseIntArrayElements(src_pixels, src, JNI_ABORT);
  env->ReleaseIntArrayElements(dst_pixels, dst, 0);
  return 0;
}

JNIEXPORT jint JNICALL
Java_expo_modules_imagecore_ImageCoreModule_nativeRotate(
    JNIEnv* env, jobject /*thiz*/, jintArray src_pixels, jint src_width,
    jint src_height, jintArray dst_pixels, jint degrees) {
  if (src_pixels == nullptr || dst_pixels == nullptr || src_width <= 0 ||
      src_height <= 0) {
    return -1;
  }
  const int swap = (degrees == 90 || degrees == 270) ? 1 : 0;
  const jint dst_width = swap ? src_height : src_width;
  const jint dst_height = swap ? src_width : src_height;
  if (env->GetArrayLength(src_pixels) < src_width * src_height ||
      env->GetArrayLength(dst_pixels) < dst_width * dst_height) {
    return -2;
  }

  jint* src = env->GetIntArrayElements(src_pixels, nullptr);
  if (src == nullptr) return -4;
  jint* dst = env->GetIntArrayElements(dst_pixels, nullptr);
  if (dst == nullptr) {
    env->ReleaseIntArrayElements(src_pixels, src, JNI_ABORT);
    return -4;
  }

  image_core::rotate_pixels(reinterpret_cast<const uint32_t*>(src), src_width,
                            src_height, reinterpret_cast<uint32_t*>(dst),
                            degrees);

  env->ReleaseIntArrayElements(src_pixels, src, JNI_ABORT);
  env->ReleaseIntArrayElements(dst_pixels, dst, 0);
  return 0;
}

JNIEXPORT jstring JNICALL
Java_expo_modules_imagecore_ImageCoreModule_nativeVersion(JNIEnv* env,
                                                          jobject /*thiz*/) {
  return env->NewStringUTF(image_core::version());
}

}  // extern "C"
