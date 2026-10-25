# Model card: PP-OCRv4 (det + cls + rec)

PaddleOCR's Chinese PP-OCRv4 inference models, used by
`modules/image-core/android/.../PpOcrEngine.kt` for on-device text recognition.
The three `.onnx` files are copied verbatim from the models bundled with
`rapidocr_onnxruntime` 1.4.4 (PaddleOCR release export); no retraining or
quantization was applied.

| file | size | role |
|---|---|---|
| `ch_PP-OCRv4_det_infer.onnx` | 4.75 MB | DB text-line detector |
| `ch_ppocr_mobile_v2.0_cls_infer.onnx` | 0.59 MB | 0°/180° line classifier |
| `ch_PP-OCRv4_rec_infer.onnx` | 10.86 MB | CTC recognizer (Chinese + English + digits) |

License: **Apache-2.0** (PaddleOCR). The recognizer's character dictionary
(6623 entries) ships inside the ONNX file as custom metadata under the key
`character`, so no separate dictionary asset is needed.

## I/O contract

| model | input | output |
|---|---|---|
| det | `x` `[1,3,H,W]` float32 NCHW, RGB, `(v/255 − 0.5) / 0.5`; H,W multiples of 32, short side 736 | `sigmoid` probability map `[1,1,H,W]` |
| cls | `x` `[1,3,48,192]` float32, same normalization, right/bottom zero padding | `[1,2]` softmax (`0°`, `180°`) |
| rec | `x` `[1,3,48,W]` float32, same normalization, zero padding; `W = 48 × max(320/48, w/h)` | `[1,T,6625]` logits → CTC greedy decode |

## Pipeline (mirrors rapidocr 1.4.4)

1. Whole image capped to 2000 px on the long side; short side below 30 px is
   enlarged.
2. **det**: short side → 736, both sides rounded up to a multiple of 32 (canvas
   capped at 4096 px to avoid OOM on long screenshots). Probability map is
   thresholded at 0.3, dilated 2×2, grouped into 8-connected components, each
   reduced to a min-area rectangle (convex hull + rotating calipers), scored by
   mean probability inside the box (≥ 0.5), then unclipped by
   `1.6 × area / perimeter` (rectangles make this equivalent to pyclipper).
   Everything is pure Kotlin — the Android module has no OpenCV dependency.
3. Boxes are sorted in reading order (`sorted_boxes`: top-left y, then x, with
   the sub-10 px same-line swap).
4. Each box is perspective-cropped (homography + bilinear, edge clamp) at source
   resolution; crops taller than 1.5:1 are rotated 90° (vertical Chinese text).
5. **cls** flips lines it scores > 0.9 as 180°.
6. **rec** decodes greedily; lines with score < 0.5 are dropped.

## Known limits

- Chinese/English/digits only (PP-OCRv4 `ch` model). Other scripts are
  legible-ish at best.
- Rotated (non-axis-aligned) text inside a *vertical* layout is handled only by
  the 90° crop rotation; arbitrary skew is not deskewed.
- The detector is not trained on very low-contrast watermarks; those lines are
  typically dropped rather than mis-recognized.

## Verified behaviour

`scratch/sample1.jpg` (1200×1600 synthetic meeting-minute page) recognises all
11 text lines in reading order, text exactly matching the reference rapidocr
output (`scratch/ocr_ref_sample1.json`), on an x86_64 Android emulator.
