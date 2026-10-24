// Java JNI 绑定：把共享 C ABI 暴露给 com.imagecore.ImageCore。
//
// 只处理像素数组，不做文件 IO —— Java 侧用 ImageIO 解码/编码，
// 这样 JNI 层保持最小，也不需要把 stb 编进动态库。

#include <jni.h>

#include <cstdint>

#include "image_core_c.h"

extern "C" {

JNIEXPORT jstring JNICALL Java_com_imagecore_ImageCore_nativeVersion(JNIEnv* env,
                                                                    jclass) {
  return env->NewStringUTF(ic_version());
}

JNIEXPORT jint JNICALL Java_com_imagecore_ImageCore_nativeProcessArgb(
    JNIEnv* env, jclass, jintArray pixels, jint width, jint height,
    jint filter) {
  if (pixels == nullptr || width <= 0 || height <= 0) {
    return IC_ERR_ARGUMENT;
  }
  const jsize length = env->GetArrayLength(pixels);
  if (length < width * height) {
    return IC_ERR_ARGUMENT;
  }

  jint* buffer = env->GetIntArrayElements(pixels, nullptr);
  if (buffer == nullptr) {
    return IC_ERR_ARGUMENT;
  }
  const int32_t rc = ic_process_argb32(
      reinterpret_cast<uint32_t*>(buffer), width, height, filter);
  env->ReleaseIntArrayElements(pixels, buffer, 0);  // 0 = 写回 Java 数组
  return rc;
}

JNIEXPORT jint JNICALL Java_com_imagecore_ImageCore_nativeProcessRgba(
    JNIEnv* env, jclass, jbyteArray pixels, jint width, jint height,
    jint filter) {
  if (pixels == nullptr || width <= 0 || height <= 0) {
    return IC_ERR_ARGUMENT;
  }
  const jsize length = env->GetArrayLength(pixels);
  if (length < width * height * 4) {
    return IC_ERR_ARGUMENT;
  }

  // GetByteArrayElements 允许返回副本；释放时必须用 0 把修改写回。
  jbyte* buffer = env->GetByteArrayElements(pixels, nullptr);
  if (buffer == nullptr) {
    return IC_ERR_ARGUMENT;
  }
  const int32_t rc = ic_process_rgba(
      reinterpret_cast<uint8_t*>(buffer), width, height, filter);
  env->ReleaseByteArrayElements(pixels, buffer, 0);
  return rc;
}

}  // extern "C"
