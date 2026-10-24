#ifndef IMAGE_CORE_H
#define IMAGE_CORE_H

#include <cstdint>

namespace image_core {

// 与 JS 侧 FilterKey 一一对应（src/lib/filters.ts）
// 新增算法时在这里追加 id，并同步四个桥的字符串映射。
enum Filter : int32_t {
  kOriginal = 0,
  kGray = 1,
  kBw = 2,
  kEnhance = 3,
  kShadow = 4,
  kDehand = 5,
  kHd = 6,
  kBrighten = 7,
  kSharpen = 8,
  kInkSave = 9,
  kInvert = 10,
};

/**
 * 原地处理 ARGB_8888 像素（每个 uint32 为 0xAARRGGBB）。
 * 不负责解码/编码，两个平台各自用系统 API 完成。
 */
void process_pixels(uint32_t* pixels, int32_t width, int32_t height, int32_t filter);

/**
 * 带第二步微调的处理：先执行 filter，再依次应用亮度、对比度、细节（锐化）。
 *
 * contrast / brightness 取值 -50..50，detail 取值 0..100；全 0 时与
 * process_pixels(pixels, width, height, filter) 完全等价。
 * 老调用方（C ABI、桌面 CLI、鸿蒙）继续用 process_pixels 即可。
 */
void process_pixels_ex(uint32_t* pixels, int32_t width, int32_t height,
                       int32_t filter, int32_t contrast, int32_t brightness,
                       int32_t detail);

/**
 * 四角透视校正（裁剪）。
 *
 * quad 是 8 个归一化坐标 x0,y0,x1,y1,x2,y2,x3,y3，顺序 TL → TR → BR → BL，
 * 取值 0..1（乘上源图宽高得到源像素坐标）。
 *
 * 输出尺寸按四边形对边长度的较大值算：宽取 |TL-TR| 与 |BL-BR| 的较大者，
 * 高取 |TL-BL| 与 |TR-BR| 的较大者；最长边超过 max_dim 时整体等比缩小。
 * 先调 warp_output_size 拿尺寸，分配好 dst 再调 warp_pixels。
 */
void warp_output_size(int32_t src_width, int32_t src_height, const float quad[8],
                      int32_t max_dim, int32_t* out_width, int32_t* out_height);

/** 把 src 中 quad 围成的四边形拉成 dst 矩形；越界采样填白色。 */
void warp_pixels(const uint32_t* src, int32_t src_width, int32_t src_height,
                 uint32_t* dst, int32_t dst_width, int32_t dst_height,
                 const float quad[8]);

/**
 * 等比缩放到最长边 max_dim（不放大）。
 * 缩小走盒式平均（降采样不锯齿），放大走双线性。
 */
void resize_output_size(int32_t src_width, int32_t src_height, int32_t max_dim,
                        int32_t* out_width, int32_t* out_height);

void resize_pixels(const uint32_t* src, int32_t src_width, int32_t src_height,
                   uint32_t* dst, int32_t dst_width, int32_t dst_height);

/** 顺时针旋转 degrees ∈ {90,180,270}；dst 尺寸需要按角度交换宽高。 */
void rotate_pixels(const uint32_t* src, int32_t src_width, int32_t src_height,
                   uint32_t* dst, int32_t degrees);

const char* version();

}  // namespace image_core

#endif  // IMAGE_CORE_H
