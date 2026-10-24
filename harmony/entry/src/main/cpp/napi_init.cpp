#include "napi/native_api.h"

#include <cstdint>
#include <cstddef>

#include "image_core.h"

namespace {

napi_value Version(napi_env env, napi_callback_info info) {
  napi_value result = nullptr;
  napi_create_string_utf8(env, image_core::version(), NAPI_AUTO_LENGTH, &result);
  return result;
}

// processPixels(buffer: ArrayBuffer, width: number, height: number, filter: number): number
napi_value ProcessPixels(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value args[4] = {nullptr, nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc < 4) {
    napi_throw_type_error(env, nullptr, "expected (buffer, width, height, filter)");
    return nullptr;
  }

  void* data = nullptr;
  size_t byteLength = 0;
  napi_status status = napi_get_arraybuffer_info(env, args[0], &data, &byteLength);
  if (status != napi_ok || data == nullptr) {
    napi_throw_type_error(env, nullptr, "arg0 must be an ArrayBuffer");
    return nullptr;
  }

  int32_t width = 0;
  int32_t height = 0;
  int32_t filter = 0;
  napi_get_value_int32(env, args[1], &width);
  napi_get_value_int32(env, args[2], &height);
  napi_get_value_int32(env, args[3], &filter);

  if (width <= 0 || height <= 0) {
    napi_throw_range_error(env, nullptr, "width and height must be positive");
    return nullptr;
  }

  const size_t needed = static_cast<size_t>(width) * static_cast<size_t>(height) * 4u;
  if (byteLength < needed) {
    napi_throw_range_error(env, nullptr, "buffer is smaller than width*height*4");
    return nullptr;
  }

  image_core::process_pixels(static_cast<uint32_t*>(data), width, height, filter);

  napi_value ret = nullptr;
  napi_create_int32(env, 0, &ret);
  return ret;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor desc[] = {
      {"version", nullptr, Version, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"processPixels", nullptr, ProcessPixels, nullptr, nullptr, nullptr, napi_default,
       nullptr},
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
