#ifndef IMAGE_CORE_C_H
#define IMAGE_CORE_C_H

#include <stdint.h>

/*
 * 共享算法的稳定 C ABI。
 *
 * 手机端（JNI / ObjC++ / NAPI）直接用 C++ 接口，不需要这一层；
 * 桌面端（Python ctypes、Java JNI、命令行工具、任何 FFI）通过这里调用，
 * 避免 C++ 名字修饰和 STL 类型跨边界。
 *
 * 内存约定：
 *   - ic_process_argb32: width*height 个 uint32，每个 0xAARRGGBB。
 *     这在 little-endian 机器（x86/x64/arm64 Windows、macOS）上的内存顺序
 *     是 B,G,R,A，与 Android Bitmap ARGB_8888 一致。
 *   - ic_process_rgba: width*height*4 字节，行优先，顺序 R,G,B,A。
 *     供 Python / 命令行 / WebCanvas 等以 RGBA 为默认顺序的调用方使用。
 *     内部按 uint32 处理，缓冲区需 4 字节对齐（malloc / bytearray / JVM 数组
 *     都满足；从其他缓冲区切片传入时要用 4 的倍数偏移）。
 */

/* 构建动态库时由 CMake 定义 IC_EXPORTS；直接编进可执行文件时不需要导出。 */
#ifndef IC_API
#if defined(_WIN32) && defined(IC_EXPORTS)
#define IC_API __declspec(dllexport)
#elif defined(__GNUC__) || defined(__clang__)
#define IC_API __attribute__((visibility("default")))
#else
#define IC_API
#endif
#endif

#ifdef __cplusplus
extern "C" {
#endif

/* 与 JS 侧 FilterKey / image_core::Filter 一一对应 */
enum {
  IC_FILTER_ORIGINAL = 0,
  IC_FILTER_GRAY = 1,
  IC_FILTER_BW = 2,
  IC_FILTER_ENHANCE = 3
};

/* 返回值 */
enum {
  IC_OK = 0,
  IC_ERR_ARGUMENT = -1,   /* 空指针或宽高非法 */
  IC_ERR_FILTER = -2      /* 未知滤镜编号 */
};

/* 例如 "image-core/0.1.0"；返回静态字符串，调用方不要释放。 */
IC_API const char* ic_version(void);

/* 原地处理；返回 IC_OK / IC_ERR_*。 */
IC_API int32_t ic_process_argb32(uint32_t* pixels, int32_t width, int32_t height,
                                 int32_t filter);

/* 原地处理；返回 IC_OK / IC_ERR_*。 */
IC_API int32_t ic_process_rgba(uint8_t* pixels, int32_t width, int32_t height,
                               int32_t filter);

#ifdef __cplusplus
}  /* extern "C" */
#endif

#endif /* IMAGE_CORE_C_H */
