// 桌面端算法自检：不依赖第三方测试框架，`ctest` 或直接运行都行。
//
//   image_core_selftest [sample.jpg]
//
// 覆盖：C ABI 参数校验、RGBA/ARGB32 两条入口的等价性、三种滤镜的结构性质，
// 以及真实 JPEG 解码后整图处理不崩溃、尺寸不变。

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "image_core_c.h"

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"

namespace {

int g_failures = 0;

void check(bool ok, const char* name) {
  std::printf("%s  %s\n", ok ? "PASS" : "FAIL", name);
  if (!ok) ++g_failures;
}

int luma(int r, int g, int b) { return (299 * r + 587 * g + 114 * b) / 1000; }

int clamp255(int v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

int gray_expected(int r, int g, int b) {
  const int l = luma(r, g, b);
  return clamp255(static_cast<int>((l - 128) * 1.15f + 128));
}

void test_synthetic() {
  // 4x1 RGBA
  uint8_t rgba[16] = {
      200, 10, 10, 255,
      10, 200, 10, 255,
      10, 10, 200, 255,
      128, 128, 128, 255,
  };

  check(ic_process_rgba(nullptr, 1, 1, IC_FILTER_GRAY) == IC_ERR_ARGUMENT,
        "rgba: null buffer rejected");
  check(ic_process_rgba(rgba, 0, 1, IC_FILTER_GRAY) == IC_ERR_ARGUMENT,
        "rgba: width 0 rejected");
  check(ic_process_rgba(rgba, 4, 1, 99) == IC_ERR_FILTER,
        "rgba: unknown filter rejected");
  check(ic_process_rgba(rgba, 4, 1, IC_FILTER_ORIGINAL) == IC_OK,
        "rgba: original is a no-op");
  check(rgba[0] == 200 && rgba[1] == 10 && rgba[2] == 10 && rgba[3] == 255,
        "rgba: original leaves bytes untouched");

  std::vector<uint8_t> gray(rgba, rgba + sizeof(rgba));
  check(ic_process_rgba(gray.data(), 4, 1, IC_FILTER_GRAY) == IC_OK,
        "rgba: gray ok");

  const int src[4][3] = {{200, 10, 10}, {10, 200, 10}, {10, 10, 200}, {128, 128, 128}};
  bool gray_ok = true;
  bool alpha_ok = true;
  for (int i = 0; i < 4; ++i) {
    const uint8_t* px = gray.data() + i * 4;
    const int expected = gray_expected(src[i][0], src[i][1], src[i][2]);
    if (px[0] != px[1] || px[1] != px[2]) gray_ok = false;
    if (px[0] < expected - 1 || px[0] > expected + 1) gray_ok = false;
    if (px[3] != 255) alpha_ok = false;
  }
  check(gray_ok, "rgba: gray keeps R=G=B and matches luma curve");
  check(alpha_ok, "rgba: gray keeps alpha");

  std::vector<uint8_t> bw(rgba, rgba + sizeof(rgba));
  check(ic_process_rgba(bw.data(), 4, 1, IC_FILTER_BW) == IC_OK, "rgba: bw ok");
  bool bw_ok = true;
  for (int i = 0; i < 4; ++i) {
    const uint8_t v = bw[i * 4];
    if ((v != 0 && v != 255) || bw[i * 4 + 1] != v || bw[i * 4 + 2] != v ||
        bw[i * 4 + 3] != 255) {
      bw_ok = false;
    }
  }
  check(bw_ok, "rgba: bw outputs only 0/255 and keeps alpha");

  std::vector<uint8_t> enh(rgba, rgba + sizeof(rgba));
  check(ic_process_rgba(enh.data(), 4, 1, IC_FILTER_ENHANCE) == IC_OK,
        "rgba: enhance ok");
  // (200,10,10) 亮度 < 165 → 对比度拉伸：(200-128)*1.28+128 ≈ 220
  check(enh[0] >= 218 && enh[0] <= 222 && enh[1] <= 2 && enh[2] <= 2 &&
            enh[3] == 255,
        "rgba: enhance stretches dark pixels");

  // ARGB32 入口：同样 4 个像素，0xAARRGGBB
  uint32_t argb[4] = {0xFFC80A0Au, 0xFF0AC80Au, 0xFF0A0AC8u, 0xFF808080u};
  check(ic_process_argb32(argb, 4, 1, IC_FILTER_GRAY) == IC_OK,
        "argb32: gray ok");
  bool argb_ok = true;
  for (int i = 0; i < 4; ++i) {
    const uint8_t r = static_cast<uint8_t>((argb[i] >> 16) & 0xff);
    const uint8_t g = static_cast<uint8_t>((argb[i] >> 8) & 0xff);
    const uint8_t b = static_cast<uint8_t>(argb[i] & 0xff);
    const uint8_t a = static_cast<uint8_t>((argb[i] >> 24) & 0xff);
    if (r != g || g != b || a != 255) argb_ok = false;
    if (r < gray[i * 4] - 1 || r > gray[i * 4] + 1) argb_ok = false;
  }
  check(argb_ok, "argb32: matches rgba path and keeps alpha");

  const char* version = ic_version();
  check(version != nullptr && std::strstr(version, "image-core") != nullptr,
        "version string");
}

void test_jpeg(const char* path) {
  int width = 0;
  int height = 0;
  int channels = 0;
  unsigned char* base = stbi_load(path, &width, &height, &channels, 4);
  if (base == nullptr) {
    std::printf("FAIL  sample: cannot load %s (%s)\n", path,
                stbi_failure_reason());
    ++g_failures;
    return;
  }
  const size_t bytes = static_cast<size_t>(width) * height * 4;
  std::printf("PASS  sample decoded %dx%d (%d channels)\n", width, height,
              channels);

  std::vector<uint8_t> gray(base, base + bytes);
  check(ic_process_rgba(gray.data(), width, height, IC_FILTER_GRAY) == IC_OK,
        "sample: gray ok");
  bool gray_ok = true;
  for (size_t i = 0; i < bytes; i += 4 * 97) {  // 抽样，避免慢
    if (gray[i] != gray[i + 1] || gray[i + 1] != gray[i + 2]) gray_ok = false;
  }
  check(gray_ok, "sample: gray makes every sampled pixel neutral");

  std::vector<uint8_t> bw(base, base + bytes);
  check(ic_process_rgba(bw.data(), width, height, IC_FILTER_BW) == IC_OK,
        "sample: bw ok");
  bool bw_ok = true;
  for (size_t i = 0; i < bytes; i += 4 * 97) {
    if (bw[i] != 0 && bw[i] != 255) bw_ok = false;
    if (bw[i] != bw[i + 1] || bw[i + 1] != bw[i + 2]) bw_ok = false;
  }
  check(bw_ok, "sample: bw is binary at every sampled pixel");

  std::vector<uint8_t> enhanced(base, base + bytes);
  check(ic_process_rgba(enhanced.data(), width, height, IC_FILTER_ENHANCE) == IC_OK,
        "sample: enhance ok");
  size_t changed = 0;
  for (size_t i = 0; i < bytes; ++i) {
    if (enhanced[i] != base[i]) ++changed;
  }
  check(changed > bytes / 10, "sample: enhance changes a meaningful area");

  stbi_image_free(base);
}

}  // namespace

int main(int argc, char** argv) {
  test_synthetic();
  if (argc > 1) {
    test_jpeg(argv[1]);
  } else {
    std::printf("SKIP  sample image (no path given)\n");
  }
  std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "OK" : "FAILED",
              g_failures, g_failures == 1 ? "" : "s");
  return g_failures == 0 ? 0 : 1;
}
