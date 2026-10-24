// imagecore —— 共享 C++ 算法的命令行入口。
//
// 读 JPEG/PNG/BMP/TGA（stb_image），在 RGBA 上执行与 App 完全相同的滤镜
// （image_core_c），再按扩展名写回 JPEG/PNG/BMP。Python / Java / 桌面 UI
// 都可以直接调用这个可执行文件，或通过 C ABI 在进程内使用。
//
// 用法：
//   imagecore -f enhance -q 90 -m 1600 in.jpg out.jpg
//   imagecore --filter gray in.png out.png
//   imagecore --version

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "image_core_c.h"

#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

namespace {

struct Options {
  std::string input;
  std::string output;
  int filter = IC_FILTER_ENHANCE;
  int quality = 90;
  int max_dim = 0;
};

void print_usage() {
  std::fprintf(stderr,
               "imagecore %s\n"
               "usage: imagecore [options] <input> <output>\n"
               "  -f, --filter <name>   original | gray | bw | enhance (default: enhance)\n"
               "  -q, --quality <1-100> JPEG quality (default: 90)\n"
               "  -m, --max-dim <px>    downscale so the longest side <= px, 0 = off\n"
               "  -v, --version         print version\n"
               "  -h, --help            show this help\n"
               "output format follows the extension: .jpg/.jpeg, .png, .bmp, .tga\n",
               ic_version());
}

bool parse_filter(const std::string& value, int* out) {
  if (value == "original" || value == "none" || value == "0") {
    *out = IC_FILTER_ORIGINAL;
  } else if (value == "gray" || value == "grey" || value == "1") {
    *out = IC_FILTER_GRAY;
  } else if (value == "bw" || value == "binary" || value == "2") {
    *out = IC_FILTER_BW;
  } else if (value == "enhance" || value == "3") {
    *out = IC_FILTER_ENHANCE;
  } else {
    return false;
  }
  return true;
}

const char* filter_name(int filter) {
  switch (filter) {
    case IC_FILTER_GRAY:
      return "gray";
    case IC_FILTER_BW:
      return "bw";
    case IC_FILTER_ENHANCE:
      return "enhance";
    default:
      return "original";
  }
}

// 面积平均降采样：每个目标像素取源图对应矩形区域的平均值。
// 只缩小不放大；对文档图片来说比最近邻平滑，也不会引入锐化伪影。
std::vector<unsigned char> downscale_rgba(const unsigned char* src, int sw,
                                          int sh, int dw, int dh) {
  std::vector<unsigned char> dst(static_cast<size_t>(dw) * dh * 4);
  for (int dy = 0; dy < dh; ++dy) {
    const int y0 = static_cast<int>(static_cast<long long>(dy) * sh / dh);
    int y1 = static_cast<int>(static_cast<long long>(dy + 1) * sh / dh);
    if (y1 <= y0) y1 = y0 + 1;
    for (int dx = 0; dx < dw; ++dx) {
      const int x0 = static_cast<int>(static_cast<long long>(dx) * sw / dw);
      int x1 = static_cast<int>(static_cast<long long>(dx + 1) * sw / dw);
      if (x1 <= x0) x1 = x0 + 1;

      unsigned long long sum[4] = {0, 0, 0, 0};
      for (int y = y0; y < y1; ++y) {
        const unsigned char* row = src + (static_cast<size_t>(y) * sw + x0) * 4;
        for (int x = x0; x < x1; ++x, row += 4) {
          sum[0] += row[0];
          sum[1] += row[1];
          sum[2] += row[2];
          sum[3] += row[3];
        }
      }
      const unsigned long long count =
          static_cast<unsigned long long>(y1 - y0) * (x1 - x0);
      unsigned char* out = dst.data() + (static_cast<size_t>(dy) * dw + dx) * 4;
      for (int c = 0; c < 4; ++c) {
        out[c] = static_cast<unsigned char>(sum[c] / count);
      }
    }
  }
  return dst;
}

// 只用于把路径放进单行 JSON；Windows 路径里的反斜杠和引号必须转义
std::string json_escape(const std::string& text) {
  std::string out;
  out.reserve(text.size() + 8);
  for (char c : text) {
    switch (c) {
      case '\\':
        out += "\\\\";
        break;
      case '"':
        out += "\\\"";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        out += c;
    }
  }
  return out;
}

std::string lower_extension(const std::string& path) {
  const size_t dot = path.find_last_of('.');
  if (dot == std::string::npos) return "";
  std::string ext = path.substr(dot);
  for (char& c : ext) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  }
  return ext;
}

}  // namespace

int main(int argc, char** argv) {
  Options options;
  std::vector<std::string> positional;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "-v" || arg == "--version") {
      std::printf("%s\n", ic_version());
      return 0;
    }
    if (arg == "-h" || arg == "--help") {
      print_usage();
      return 0;
    }
    if (arg == "-f" || arg == "--filter" || arg == "-q" || arg == "--quality" ||
        arg == "-m" || arg == "--max-dim") {
      if (i + 1 >= argc) {
        std::fprintf(stderr, "error: %s requires a value\n", arg.c_str());
        return 2;
      }
      const std::string value = argv[++i];
      if (arg == "-f" || arg == "--filter") {
        if (!parse_filter(value, &options.filter)) {
          std::fprintf(stderr, "error: unknown filter '%s'\n", value.c_str());
          return 2;
        }
      } else if (arg == "-q" || arg == "--quality") {
        options.quality = std::atoi(value.c_str());
        if (options.quality < 1 || options.quality > 100) {
          std::fprintf(stderr, "error: quality must be 1-100\n");
          return 2;
        }
      } else {
        options.max_dim = std::atoi(value.c_str());
        if (options.max_dim < 0) {
          std::fprintf(stderr, "error: max-dim must be >= 0\n");
          return 2;
        }
      }
      continue;
    }
    if (!arg.empty() && arg[0] == '-') {
      std::fprintf(stderr, "error: unknown option '%s'\n", arg.c_str());
      return 2;
    }
    positional.push_back(arg);
  }

  if (positional.size() != 2) {
    print_usage();
    return 2;
  }
  options.input = positional[0];
  options.output = positional[1];

  int width = 0;
  int height = 0;
  int channels = 0;
  unsigned char* pixels =
      stbi_load(options.input.c_str(), &width, &height, &channels, 4);
  if (pixels == nullptr) {
    std::fprintf(stderr, "error: cannot read image '%s': %s\n",
                 options.input.c_str(), stbi_failure_reason());
    return 3;
  }

  const auto start = std::chrono::steady_clock::now();
  std::vector<unsigned char> resized;
  if (options.max_dim > 0 && (width > options.max_dim || height > options.max_dim)) {
    const int longest = width > height ? width : height;
    const double scale = static_cast<double>(options.max_dim) / longest;
    const int dw = width > height ? options.max_dim : static_cast<int>(width * scale + 0.5);
    const int dh = height > width ? options.max_dim : static_cast<int>(height * scale + 0.5);
    resized = downscale_rgba(pixels, width, height, dw, dh);
    stbi_image_free(pixels);
    pixels = resized.data();
    width = dw;
    height = dh;
  }

  const int32_t rc = ic_process_rgba(pixels, width, height, options.filter);
  if (rc != IC_OK) {
    std::fprintf(stderr, "error: filter failed (code %d)\n", rc);
    if (resized.empty()) stbi_image_free(pixels);
    return 4;
  }

  const std::string ext = lower_extension(options.output);
  int written = 0;
  if (ext == ".jpg" || ext == ".jpeg") {
    written = stbi_write_jpg(options.output.c_str(), width, height, 4, pixels,
                             options.quality);
  } else if (ext == ".png") {
    written = stbi_write_png(options.output.c_str(), width, height, 4, pixels,
                             width * 4);
  } else if (ext == ".bmp") {
    written = stbi_write_bmp(options.output.c_str(), width, height, 4, pixels);
  } else if (ext == ".tga") {
    written = stbi_write_tga(options.output.c_str(), width, height, 4, pixels);
  } else {
    std::fprintf(stderr,
                 "error: unsupported output extension '%s' "
                 "(use .jpg/.jpeg/.png/.bmp/.tga)\n",
                 ext.c_str());
    if (resized.empty()) stbi_image_free(pixels);
    return 2;
  }

  const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                           std::chrono::steady_clock::now() - start)
                           .count();
  if (resized.empty()) stbi_image_free(pixels);

  if (!written) {
    std::fprintf(stderr, "error: cannot write '%s'\n", options.output.c_str());
    return 3;
  }

  std::printf(
      "{\"ok\":true,\"input\":\"%s\",\"output\":\"%s\",\"width\":%d,"
      "\"height\":%d,\"filter\":\"%s\",\"ms\":%lld}\n",
      json_escape(options.input).c_str(), json_escape(options.output).c_str(),
      width, height, filter_name(options.filter),
      static_cast<long long>(elapsed));
  return 0;
}
