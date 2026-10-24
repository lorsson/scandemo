// HarmonyOS NAPI bridge over the shared C++ kernel.
//
// 与 Android 的 jni_bridge.cpp、iOS 的 ImageCoreBridge.mm 一一对应：
// 解码/编码在平台侧完成，像素处理全部调用 modules/image-core/common/image_core.cpp。
// 新增算法或几何操作时，三个桥 + C ABI 要一起加，契约见 docs/DESIGN.md §6.2。

#include "napi/native_api.h"

#include <cstddef>
#include <cstdint>

#include "image_core.h"

namespace {

// ---------------------------------------------------------------------------
// 参数读取
// ---------------------------------------------------------------------------

/** ArrayBuffer -> 裸指针 + 字节数 */
bool read_buffer(napi_env env, napi_value value, void **data, size_t *length) {
  if (env == nullptr || value == nullptr || data == nullptr || length == nullptr) {
    return false;
  }
  size_t byte_length = 0;
  void *pointer = nullptr;
  const napi_status status =
      napi_get_arraybuffer_info(env, value, &pointer, &byte_length);
  if (status != napi_ok || pointer == nullptr) {
    return false;
  }
  *data = pointer;
  *length = byte_length;
  return true;
}

bool read_i32(napi_env env, napi_value value, int32_t *out) {
  if (env == nullptr || value == nullptr || out == nullptr) {
    return false;
  }
  int32_t parsed = 0;
  if (napi_get_value_int32(env, value, &parsed) != napi_ok) {
    return false;
  }
  *out = parsed;
  return true;
}

/**
 * quad 允许两种形态：ArkTS 传 Float64Array（推荐，零解析开销），
 * 也兼容普通 number[]（调试/桌面脚本里方便）。
 */
bool read_quad(napi_env env, napi_value value, double out[8]) {
  if (env == nullptr || value == nullptr || out == nullptr) {
    return false;
  }

  napi_typedarray_type type = napi_int8_array;
  size_t length = 0;
  void *data = nullptr;
  napi_value array_buffer = nullptr;
  size_t byte_offset = 0;
  if (napi_get_typedarray_info(env, value, &type, &length, &data, &array_buffer,
                               &byte_offset) == napi_ok) {
    if (type != napi_float64_array || length < 8 || data == nullptr) {
      return false;
    }
    const double *values = static_cast<const double *>(data);
    for (int i = 0; i < 8; ++i) {
      out[i] = values[i];
    }
    return true;
  }

  bool is_array = false;
  if (napi_is_array(env, value, &is_array) != napi_ok || !is_array) {
    return false;
  }
  uint32_t array_length = 0;
  if (napi_get_array_length(env, value, &array_length) != napi_ok ||
      array_length < 8) {
    return false;
  }
  for (uint32_t i = 0; i < 8; ++i) {
    napi_value item = nullptr;
    double number = 0.0;
    if (napi_get_element(env, value, i, &item) != napi_ok ||
        napi_get_value_double(env, item, &number) != napi_ok) {
      return false;
    }
    out[i] = number;
  }
  return true;
}

napi_value make_int(napi_env env, int32_t value) {
  napi_value result = nullptr;
  napi_create_int32(env, value, &result);
  return result;
}

/** 返回 [width, height]，与 Android 的 IntArray / iOS 的两个 out 指针等价 */
napi_value make_pair(napi_env env, int32_t first, int32_t second) {
  napi_value array = nullptr;
  if (napi_create_array_with_length(env, 2, &array) != napi_ok) {
    return nullptr;
  }
  napi_set_element(env, array, 0, make_int(env, first));
  napi_set_element(env, array, 1, make_int(env, second));
  return array;
}

napi_value throw_message(napi_env env, const char *message) {
  napi_throw_type_error(env, nullptr, message);
  return nullptr;
}

// ---------------------------------------------------------------------------
// 导出函数
// ---------------------------------------------------------------------------

napi_value Version(napi_env env, napi_callback_info /*info*/) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, image_core::version(), NAPI_AUTO_LENGTH, &result);
  return result;
}

/**
 * processPixels(buffer, width, height, filter): number
 *
 * buffer 为 width*height 个小端 uint32，每个是 0xAARRGGBB。
 * ArkTS 侧向解码器要 BGRA_8888，内存顺序 B,G,R,A 在小端核上正好是它。
 */
napi_value ProcessPixels(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4] = {nullptr, nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 4) {
    return throw_message(env, "expected (buffer, width, height, filter)");
  }

  void *data = nullptr;
  size_t byte_length = 0;
  if (!read_buffer(env, args[0], &data, &byte_length)) {
    return throw_message(env, "arg0 must be an ArrayBuffer");
  }

  int32_t width = 0;
  int32_t height = 0;
  int32_t filter = 0;
  if (!read_i32(env, args[1], &width) || !read_i32(env, args[2], &height) ||
      !read_i32(env, args[3], &filter)) {
    return throw_message(env, "width, height and filter must be integers");
  }
  if (width <= 0 || height <= 0) {
    napi_throw_range_error(env, nullptr, "width and height must be positive");
    return nullptr;
  }

  const size_t needed =
      static_cast<size_t>(width) * static_cast<size_t>(height) * 4u;
  if (byte_length < needed) {
    napi_throw_range_error(env, nullptr, "buffer is smaller than width*height*4");
    return nullptr;
  }

  image_core::process_pixels(static_cast<uint32_t *>(data), width, height, filter);
  return make_int(env, 0);
}

/** processPixelsEx(buffer, w, h, filter, contrast, brightness, detail): number */
napi_value ProcessPixelsEx(napi_env env, napi_callback_info info) {
  size_t argc = 7;
  napi_value args[7] = {nullptr, nullptr, nullptr, nullptr,
                        nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 7) {
    return throw_message(
        env, "expected (buffer, width, height, filter, contrast, brightness, detail)");
  }

  void *data = nullptr;
  size_t byte_length = 0;
  if (!read_buffer(env, args[0], &data, &byte_length)) {
    return throw_message(env, "arg0 must be an ArrayBuffer");
  }

  int32_t width = 0;
  int32_t height = 0;
  int32_t filter = 0;
  int32_t contrast = 0;
  int32_t brightness = 0;
  int32_t detail = 0;
  if (!read_i32(env, args[1], &width) || !read_i32(env, args[2], &height) ||
      !read_i32(env, args[3], &filter) || !read_i32(env, args[4], &contrast) ||
      !read_i32(env, args[5], &brightness) || !read_i32(env, args[6], &detail)) {
    return throw_message(env, "numeric arguments must be integers");
  }
  if (width <= 0 || height <= 0) {
    napi_throw_range_error(env, nullptr, "width and height must be positive");
    return nullptr;
  }

  const size_t needed =
      static_cast<size_t>(width) * static_cast<size_t>(height) * 4u;
  if (byte_length < needed) {
    napi_throw_range_error(env, nullptr, "buffer is smaller than width*height*4");
    return nullptr;
  }

  image_core::process_pixels_ex(
      static_cast<uint32_t *>(data), width, height, filter,
      contrast < -50 ? -50 : (contrast > 50 ? 50 : contrast),
      brightness < -50 ? -50 : (brightness > 50 ? 50 : brightness),
      detail < 0 ? 0 : (detail > 100 ? 100 : detail));
  return make_int(env, 0);
}

/** warpSize(srcWidth, srcHeight, quad, maxDim): [width, height] */
napi_value WarpSize(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4] = {nullptr, nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 4) {
    return throw_message(env, "expected (srcWidth, srcHeight, quad, maxDim)");
  }

  int32_t src_width = 0;
  int32_t src_height = 0;
  int32_t max_dim = 0;
  if (!read_i32(env, args[0], &src_width) || !read_i32(env, args[1], &src_height) ||
      !read_i32(env, args[3], &max_dim)) {
    return throw_message(env, "srcWidth, srcHeight and maxDim must be integers");
  }
  if (src_width <= 0 || src_height <= 0) {
    napi_throw_range_error(env, nullptr, "width and height must be positive");
    return nullptr;
  }

  double quad[8] = {0};
  if (!read_quad(env, args[2], quad)) {
    return throw_message(env, "quad must be a Float64Array (or number[8])");
  }

  float quad_f[8];
  for (int i = 0; i < 8; ++i) {
    quad_f[i] = static_cast<float>(quad[i]);
  }

  int32_t out_width = 0;
  int32_t out_height = 0;
  image_core::warp_output_size(src_width, src_height, quad_f, max_dim, &out_width,
                               &out_height);
  return make_pair(env, out_width, out_height);
}

/**
 * warpPixels(src, srcW, srcH, dst, dstW, dstH, quad): number
 * src / dst 都是 ArrayBuffer，长度必须 >= w*h*4。
 */
napi_value WarpPixels(napi_env env, napi_callback_info info) {
  size_t argc = 7;
  napi_value args[7] = {nullptr, nullptr, nullptr, nullptr,
                        nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 7) {
    return throw_message(
        env, "expected (src, srcW, srcH, dst, dstW, dstH, quad)");
  }

  void *src = nullptr;
  size_t src_bytes = 0;
  void *dst = nullptr;
  size_t dst_bytes = 0;
  if (!read_buffer(env, args[0], &src, &src_bytes)) {
    return throw_message(env, "arg0 must be an ArrayBuffer");
  }
  if (!read_buffer(env, args[3], &dst, &dst_bytes)) {
    return throw_message(env, "arg3 must be an ArrayBuffer");
  }

  int32_t src_width = 0;
  int32_t src_height = 0;
  int32_t dst_width = 0;
  int32_t dst_height = 0;
  if (!read_i32(env, args[1], &src_width) || !read_i32(env, args[2], &src_height) ||
      !read_i32(env, args[4], &dst_width) || !read_i32(env, args[5], &dst_height)) {
    return throw_message(env, "width and height arguments must be integers");
  }
  if (src_width <= 0 || src_height <= 0 || dst_width <= 0 || dst_height <= 0) {
    napi_throw_range_error(env, nullptr, "width and height must be positive");
    return nullptr;
  }
  if (src_bytes < static_cast<size_t>(src_width) * src_height * 4u ||
      dst_bytes < static_cast<size_t>(dst_width) * dst_height * 4u) {
    napi_throw_range_error(env, nullptr, "buffer is smaller than width*height*4");
    return nullptr;
  }

  double quad[8] = {0};
  if (!read_quad(env, args[6], quad)) {
    return throw_message(env, "quad must be a Float64Array (or number[8])");
  }
  float quad_f[8];
  for (int i = 0; i < 8; ++i) {
    quad_f[i] = static_cast<float>(quad[i]);
  }

  image_core::warp_pixels(static_cast<const uint32_t *>(src), src_width,
                          src_height, static_cast<uint32_t *>(dst), dst_width,
                          dst_height, quad_f);
  return make_int(env, 0);
}

/** resizeSize(srcWidth, srcHeight, maxDim): [width, height] */
napi_value ResizeSize(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value args[3] = {nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 3) {
    return throw_message(env, "expected (srcWidth, srcHeight, maxDim)");
  }

  int32_t src_width = 0;
  int32_t src_height = 0;
  int32_t max_dim = 0;
  if (!read_i32(env, args[0], &src_width) || !read_i32(env, args[1], &src_height) ||
      !read_i32(env, args[2], &max_dim)) {
    return throw_message(env, "arguments must be integers");
  }
  if (src_width <= 0 || src_height <= 0) {
    napi_throw_range_error(env, nullptr, "width and height must be positive");
    return nullptr;
  }

  int32_t out_width = 0;
  int32_t out_height = 0;
  image_core::resize_output_size(src_width, src_height, max_dim, &out_width,
                                 &out_height);
  return make_pair(env, out_width, out_height);
}

/** resizePixels(src, srcW, srcH, dst, dstW, dstH): number */
napi_value ResizePixels(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value args[6] = {nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 6) {
    return throw_message(env, "expected (src, srcW, srcH, dst, dstW, dstH)");
  }

  void *src = nullptr;
  size_t src_bytes = 0;
  void *dst = nullptr;
  size_t dst_bytes = 0;
  if (!read_buffer(env, args[0], &src, &src_bytes)) {
    return throw_message(env, "arg0 must be an ArrayBuffer");
  }
  if (!read_buffer(env, args[3], &dst, &dst_bytes)) {
    return throw_message(env, "arg3 must be an ArrayBuffer");
  }

  int32_t src_width = 0;
  int32_t src_height = 0;
  int32_t dst_width = 0;
  int32_t dst_height = 0;
  if (!read_i32(env, args[1], &src_width) || !read_i32(env, args[2], &src_height) ||
      !read_i32(env, args[4], &dst_width) || !read_i32(env, args[5], &dst_height)) {
    return throw_message(env, "width and height arguments must be integers");
  }
  if (src_width <= 0 || src_height <= 0 || dst_width <= 0 || dst_height <= 0) {
    napi_throw_range_error(env, nullptr, "width and height must be positive");
    return nullptr;
  }
  if (src_bytes < static_cast<size_t>(src_width) * src_height * 4u ||
      dst_bytes < static_cast<size_t>(dst_width) * dst_height * 4u) {
    napi_throw_range_error(env, nullptr, "buffer is smaller than width*height*4");
    return nullptr;
  }

  image_core::resize_pixels(static_cast<const uint32_t *>(src), src_width,
                            src_height, static_cast<uint32_t *>(dst), dst_width,
                            dst_height);
  return make_int(env, 0);
}

/** rotatePixels(src, srcW, srcH, dst, degrees): number */
napi_value RotatePixels(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value args[5] = {nullptr, nullptr, nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc < 5) {
    return throw_message(env, "expected (src, srcW, srcH, dst, degrees)");
  }

  void *src = nullptr;
  size_t src_bytes = 0;
  void *dst = nullptr;
  size_t dst_bytes = 0;
  if (!read_buffer(env, args[0], &src, &src_bytes)) {
    return throw_message(env, "arg0 must be an ArrayBuffer");
  }
  if (!read_buffer(env, args[3], &dst, &dst_bytes)) {
    return throw_message(env, "arg3 must be an ArrayBuffer");
  }

  int32_t src_width = 0;
  int32_t src_height = 0;
  int32_t degrees = 0;
  if (!read_i32(env, args[1], &src_width) || !read_i32(env, args[2], &src_height) ||
      !read_i32(env, args[4], &degrees)) {
    return throw_message(env, "numeric arguments must be integers");
  }
  if (src_width <= 0 || src_height <= 0) {
    napi_throw_range_error(env, nullptr, "width and height must be positive");
    return nullptr;
  }
  if (degrees != 90 && degrees != 180 && degrees != 270) {
    napi_throw_range_error(env, nullptr, "degrees must be 90, 180 or 270");
    return nullptr;
  }

  const bool swap = degrees != 180;
  const int32_t dst_width = swap ? src_height : src_width;
  const int32_t dst_height = swap ? src_width : src_height;
  if (src_bytes < static_cast<size_t>(src_width) * src_height * 4u ||
      dst_bytes < static_cast<size_t>(dst_width) * dst_height * 4u) {
    napi_throw_range_error(env, nullptr, "buffer is smaller than width*height*4");
    return nullptr;
  }

  image_core::rotate_pixels(static_cast<const uint32_t *>(src), src_width,
                            src_height, static_cast<uint32_t *>(dst), degrees);
  return make_int(env, 0);
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
      {"version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"processPixels", nullptr, ProcessPixels, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"processPixelsEx", nullptr, ProcessPixelsEx, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"warpSize", nullptr, WarpSize, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"warpPixels", nullptr, WarpPixels, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"resizeSize", nullptr, ResizeSize, nullptr, nullptr, nullptr, napi_default,
       nullptr},
      {"resizePixels", nullptr, ResizePixels, nullptr, nullptr, nullptr,
       napi_default, nullptr},
      {"rotatePixels", nullptr, RotatePixels, nullptr, nullptr, nullptr,
       napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(desc) / sizeof(desc[0]), desc);
  return exports;
}

}  // namespace

static napi_module g_image_core_module = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
    .nm_modname = "image_core",
    .nm_priv = nullptr,
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterImageCoreModule(void) {
  napi_module_register(&g_image_core_module);
}
