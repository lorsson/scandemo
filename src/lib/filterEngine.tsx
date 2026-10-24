import { useEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { isZeroAdjust, type PageAdjust } from './filters';
import type { FilterKey } from '../types';

/**
 * react-native-webview 14 的类型声明是 `WebView<P = undefined>`，
 * 与 React 19 的类型合起来会把 props 推成 never，这里放宽成 any。
 */
const WebViewAny = WebView as unknown as ComponentType<any>;

/**
 * 把逐像素的滤镜运算交给 WebView 里的 Canvas。
 *
 * 为什么不用纯 JS：Hermes 没有 JIT，jpeg-js 解码 + 编码 1MP 图在 Android 9
 * 模拟器上要 1~2 分钟。WebView 的 JS 引擎有 JIT，Canvas 的 getImageData /
 * toDataURL 也是原生实现，同样的图大约 200~500ms。
 *
 * 同一套引擎同时承担：
 *   - 滤镜 + 第二步微调（对比度 / 亮度 / 细节）
 *   - 四角透视裁剪（warp），C++ 侧暂未实现 warp，原生模式也走这里
 */

type Pending = {
  resolve: (dataUrl: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** 日志用：#filter / warp */
  label: string;
  start: number;
};

const pending = new Map<number, Pending>();
let seq = 0;
let post: ((payload: string) => void) | null = null;
let inject: ((js: string) => void) | null = null;
let markReady: (() => void) | null = null;
let engineReady = false;

const ready = new Promise<void>((resolve) => {
  markReady = resolve;
});

function resolveReady() {
  if (engineReady) return;
  engineReady = true;
  markReady?.();
}

const ENGINE_TIMEOUT = 15000;

function handleMessage(raw: string) {
  let msg: {
    id?: number;
    type?: string;
    ok?: boolean;
    dataUrl?: string;
    error?: string;
    ms?: number;
    width?: number;
    height?: number;
  };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (msg.type === 'ready') {
    resolveReady();
    return;
  }
  if (typeof msg.id !== 'number') return;
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  clearTimeout(entry.timer);
  if (msg.ok && typeof msg.dataUrl === 'string') {
    if (typeof msg.ms === 'number') {
      // 与原生路径的 [image-core] 日志对齐，方便两台引擎直接比耗时
      console.log(
        `[image-core:canvas] ${entry.label} ${msg.width ?? '?'}x${msg.height ?? '?'} ` +
          `process=${Math.round(msg.ms)}ms total=${Date.now() - entry.start}ms`,
      );
    }
    entry.resolve(msg.dataUrl);
  } else {
    entry.reject(new Error(msg.error || '图片处理失败'));
  }
}

/** 把任务交给隐藏 WebView 执行，返回处理后的 data URI */
async function runInEngine(
  payload: Record<string, unknown>,
  label: string,
): Promise<string> {
  await Promise.race([
    ready,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('滤镜引擎启动超时')), ENGINE_TIMEOUT),
    ),
  ]);

  const sendPost = post;
  const sendInject = inject;
  if (!sendPost && !sendInject) {
    throw new Error('滤镜引擎未就绪');
  }

  return new Promise<string>((resolve, reject) => {
    const id = ++seq;
    const raw = JSON.stringify({ ...payload, id });
    // 兜底：如果 postMessage 没被 WebView 收到，直接执行脚本
    const injectPayload = () => {
      sendInject?.(`window.__applyFilterPayload(${JSON.stringify(raw)}); true;`);
    };

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('图片处理超时'));
    }, 30000);
    pending.set(id, { resolve, reject, timer, label, start: Date.now() });

    if (sendPost) {
      sendPost(raw);
      setTimeout(() => {
        if (pending.has(id)) injectPayload();
      }, 1500);
    } else {
      injectPayload();
    }
  });
}

/** 输入 JPEG base64，返回处理后的 data URI（JPEG）。 */
export async function filterWithCanvas(
  base64: string,
  filter: FilterKey,
  adjust?: PageAdjust | null,
): Promise<string> {
  if (filter === 'original' && isZeroAdjust(adjust)) {
    return `data:image/jpeg;base64,${base64}`;
  }
  const tag =
    adjust && (adjust.contrast || adjust.brightness || adjust.detail)
      ? `${filter}+${adjust.contrast}/${adjust.brightness}/${adjust.detail}`
      : filter;
  return runInEngine(
    {
      op: 'filter',
      b64: base64,
      filter,
      contrast: adjust?.contrast ?? 0,
      brightness: adjust?.brightness ?? 0,
      detail: adjust?.detail ?? 0,
    },
    tag,
  );
}

export type NormalizedQuad = {
  topLeft: { x: number; y: number };
  topRight: { x: number; y: number };
  bottomRight: { x: number; y: number };
  bottomLeft: { x: number; y: number };
};

/**
 * 四角透视裁剪：把 quad 内的四边形拉成矩形。
 * 坐标是相对原图的归一化值（0..1），四个角按 TL → TR → BR → BL 顺时针。
 * 输出最长边不超过 1600 px。
 */
export async function warpWithCanvas(
  base64: string,
  quad: NormalizedQuad,
): Promise<string> {
  return runInEngine({ op: 'warp', b64: base64, quad }, 'warp');
}

const HTML = `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<canvas id="c"></canvas>
<script>
(function () {
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');
  var MAX_WARP = 1600;

  function otsu(hist, total) {
    var sum = 0;
    for (var i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, th = 127;
    for (var t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      var wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      var mB = sumB / wB;
      var mF = (sum - sumB) / wF;
      var between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; th = t; }
    }
    return th;
  }

  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

  function lumAt(d, i) {
    return (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
  }

  /** 单通道盒式模糊（可分离 + 滑动窗口），r<=0 时返回原数组 */
  function boxBlurGray(src, w, h, r) {
    if (r <= 0) return src.slice();
    var n = w * h, tmp = new Uint8Array(n), dst = new Uint8Array(n);
    var win = 2 * r + 1, x, y, k, sum, off, out, inn;
    for (y = 0; y < h; y++) {
      off = y * w;
      sum = 0;
      for (k = -r; k <= r; k++) sum += src[off + Math.min(Math.max(k, 0), w - 1)];
      for (x = 0; x < w; x++) {
        tmp[off + x] = (sum / win) | 0;
        out = Math.min(Math.max(x - r, 0), w - 1);
        inn = Math.min(Math.max(x + r + 1, 0), w - 1);
        sum += src[off + inn] - src[off + out];
      }
    }
    for (x = 0; x < w; x++) {
      sum = 0;
      for (k = -r; k <= r; k++) sum += tmp[Math.min(Math.max(k, 0), h - 1) * w + x];
      for (y = 0; y < h; y++) {
        dst[y * w + x] = (sum / win) | 0;
        out = Math.min(Math.max(y - r, 0), h - 1);
        inn = Math.min(Math.max(y + r + 1, 0), h - 1);
        sum += tmp[inn * w + x] - tmp[out * w + x];
      }
    }
    return dst;
  }

  /** 亮度反锐化掩模：与 C++ 的 unsharp() 同一套公式 */
  function unsharp(d, w, h, r, amount) {
    var n = w * h, lum = new Uint8Array(n), p, i;
    for (p = 0; p < n; p++) lum[p] = lumAt(d, p * 4);
    var blur = boxBlurGray(lum, w, h, r);
    for (p = 0; p < n; p++) {
      var diff = lum[p] - blur[p];
      if (!diff) continue;
      var delta = diff * amount;
      if (!delta) continue;
      i = p * 4;
      d[i] = clamp(d[i] + delta);
      d[i + 1] = clamp(d[i + 1] + delta);
      d[i + 2] = clamp(d[i + 2] + delta);
    }
  }

  function applyShadow(d, w, h) {
    var n = w * h, lum = new Uint8Array(n), p, i;
    for (p = 0; p < n; p++) lum[p] = lumAt(d, p * 4);
    var radius = Math.max(6, Math.floor(Math.min(w, h) / 8));
    var bg = boxBlurGray(lum, w, h, radius);
    for (p = 0; p < n; p++) {
      var gain = 235 / Math.max(bg[p], 24);
      if (gain > 3.5) gain = 3.5;
      if (gain < 1) gain = 1;
      i = p * 4;
      d[i] = clamp(d[i] * gain);
      d[i + 1] = clamp(d[i + 1] * gain);
      d[i + 2] = clamp(d[i + 2] * gain);
    }
  }

  function applyDehand(d, w, h) {
    var n = w * h, p, i, mx, mn, sat;
    for (p = 0; p < n; p++) {
      i = p * 4;
      var r = d[i], g = d[i + 1], b = d[i + 2];
      mx = Math.max(r, Math.max(g, b));
      mn = Math.min(r, Math.min(g, b));
      sat = mx > 0 ? (mx - mn) / mx : 0;
      if (mx > 70 && sat > 0.32) { d[i] = 255; d[i + 1] = 255; d[i + 2] = 255; }
    }
  }

  function applyHd(d, w, h) {
    var n = w * h, hist = new Uint32Array(256), p, i;
    for (p = 0; p < n; p++) hist[lumAt(d, p * 4)]++;
    var lowCount = (n / 100) | 0, highCount = n - lowCount;
    var low = 0, high = 255, acc = 0, v;
    for (v = 0; v < 256; v++) { acc += hist[v]; if (acc >= lowCount) { low = v; break; } }
    acc = 0;
    for (v = 0; v < 256; v++) { acc += hist[v]; if (acc >= highCount) { high = v; break; } }
    if (high - low < 8) { low = 0; high = 255; }
    var scale = 255 / (high - low);
    for (p = 0; p < n; p++) {
      i = p * 4;
      d[i] = clamp((d[i] - low) * scale);
      d[i + 1] = clamp((d[i + 1] - low) * scale);
      d[i + 2] = clamp((d[i + 2] - low) * scale);
    }
    unsharp(d, w, h, 2, 0.55);
  }

  function applyBrighten(d, w, h) {
    var n = w * h, p, i;
    for (p = 0; p < n; p++) {
      i = p * 4;
      d[i] = clamp(255 - (255 - d[i]) * 0.76);
      d[i + 1] = clamp(255 - (255 - d[i + 1]) * 0.76);
      d[i + 2] = clamp(255 - (255 - d[i + 2]) * 0.76);
      var lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum > 205) {
        var k = Math.min(1, (lum - 205) / 50) * 0.85;
        d[i] = d[i] + (255 - d[i]) * k;
        d[i + 1] = d[i + 1] + (255 - d[i + 1]) * k;
        d[i + 2] = d[i + 2] + (255 - d[i + 2]) * k;
      }
    }
  }

  function applyInkSave(d, w, h) {
    var n = w * h, p, i;
    for (p = 0; p < n; p++) {
      i = p * 4;
      d[i] = clamp(45 + d[i] * 210 / 255);
      d[i + 1] = clamp(45 + d[i + 1] * 210 / 255);
      d[i + 2] = clamp(45 + d[i + 2] * 210 / 255);
    }
  }

  function applyInvert(d, w, h) {
    var n = w * h, p, i;
    for (p = 0; p < n; p++) {
      i = p * 4;
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
  }

  /** 第二步微调：亮度 → 对比度 → 细节，与 C++ 的 apply_adjust 一致 */
  function applyAdjust(d, w, h, contrast, brightness, detail) {
    var n = w * h, p, i;
    if (contrast || brightness) {
      var c = contrast * 2.55;
      var factor = (259 * (c + 255)) / (255 * (259 - c));
      var add = brightness * 2.55;
      for (p = 0; p < n; p++) {
        i = p * 4;
        d[i] = clamp((d[i] + add - 128) * factor + 128);
        d[i + 1] = clamp((d[i + 1] + add - 128) * factor + 128);
        d[i + 2] = clamp((d[i + 2] + add - 128) * factor + 128);
      }
    }
    if (detail > 0) unsharp(d, w, h, 1, detail / 100 * 1.2);
  }

  function applyFilters(d, w, h, key, contrast, brightness, detail) {
    var n = w * h, p, i, r, g, b, lum;
    if (key === 'gray') {
      for (p = 0; p < n; p++) {
        i = p * 4;
        lum = clamp((0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] - 128) * 1.15 + 128);
        d[i] = d[i + 1] = d[i + 2] = lum;
      }
    } else if (key === 'bw') {
      var hist = new Uint32Array(256);
      for (p = 0; p < n; p++) hist[lumAt(d, p * 4)]++;
      var th = otsu(hist, n);
      for (p = 0; p < n; p++) {
        i = p * 4;
        var v = lumAt(d, i) > th ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    } else if (key === 'enhance') {
      for (p = 0; p < n; p++) {
        i = p * 4;
        r = d[i]; g = d[i + 1]; b = d[i + 2];
        lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum > 165) {
          var k = Math.min(1, (lum - 165) / 90) * 0.92;
          d[i] = r + (255 - r) * k;
          d[i + 1] = g + (255 - g) * k;
          d[i + 2] = b + (255 - b) * k;
        } else {
          d[i] = clamp((r - 128) * 1.28 + 128);
          d[i + 1] = clamp((g - 128) * 1.28 + 128);
          d[i + 2] = clamp((b - 128) * 1.28 + 128);
        }
      }
    } else if (key === 'shadow') {
      applyShadow(d, w, h);
    } else if (key === 'dehand') {
      applyDehand(d, w, h);
    } else if (key === 'hd') {
      applyHd(d, w, h);
    } else if (key === 'brighten') {
      applyBrighten(d, w, h);
    } else if (key === 'sharpen') {
      unsharp(d, w, h, 1, 1.0);
    } else if (key === 'inksave') {
      applyInkSave(d, w, h);
    } else if (key === 'invert') {
      applyInvert(d, w, h);
    }
    applyAdjust(d, w, h, contrast, brightness, detail);
  }

  function applyFilter(dataUrl, key, contrast, brightness, detail) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var t0 = performance.now();
          var w = img.naturalWidth, h = img.naturalHeight;
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(img, 0, 0);
          var im = ctx.getImageData(0, 0, w, h);
          applyFilters(im.data, w, h, key, contrast || 0, brightness || 0, detail || 0);
          ctx.putImageData(im, 0, 0);
          resolve({
            dataUrl: canvas.toDataURL('image/jpeg', 0.9),
            ms: performance.now() - t0,
            width: w,
            height: h
          });
        } catch (e) {
          reject(String(e));
        }
      };
      img.onerror = function () { reject('image decode failed'); };
      img.src = dataUrl;
    });
  }

  /** 4 点对应关系求单应矩阵：dst(x,y) -> src(u,v) */
  function solveHomography(dst, src) {
    var A = [], k, i;
    for (i = 0; i < 4; i++) {
      var x = dst[i].x, y = dst[i].y, u = src[i].x, v = src[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    for (k = 0; k < 8; k++) {
      var pivot = k;
      for (i = k + 1; i < 8; i++) {
        if (Math.abs(A[i][k]) > Math.abs(A[pivot][k])) pivot = i;
      }
      var tmp = A[k]; A[k] = A[pivot]; A[pivot] = tmp;
      var div = A[k][k] || 1e-12;
      for (i = k; i < 9; i++) A[k][i] /= div;
      for (i = 0; i < 8; i++) {
        if (i === k) continue;
        var f = A[i][k];
        if (!f) continue;
        for (var j = k; j < 9; j++) A[i][j] -= f * A[k][j];
      }
    }
    var out = [];
    for (i = 0; i < 8; i++) out[i] = A[i][8];
    return out;
  }

  function sampleBilinear(src, sw, sh, u, v, out, oi) {
    if (u < 0 || v < 0 || u > sw - 1 || v > sh - 1) {
      out[oi] = 255; out[oi + 1] = 255; out[oi + 2] = 255; out[oi + 3] = 255;
      return;
    }
    var x0 = u | 0, y0 = v | 0;
    var x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
    var fx = u - x0, fy = v - y0;
    var i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
    var i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
    var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
    var w01 = (1 - fx) * fy, w11 = fx * fy;
    for (var ch = 0; ch < 3; ch++) {
      out[oi + ch] =
        src[i00 + ch] * w00 + src[i10 + ch] * w10 +
        src[i01 + ch] * w01 + src[i11 + ch] * w11;
    }
    out[oi + 3] = 255;
  }

  function warpImage(dataUrl, quad) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var t0 = performance.now();
          var sw = img.naturalWidth, sh = img.naturalHeight;
          var pts = [
            { x: quad.topLeft.x * sw, y: quad.topLeft.y * sh },
            { x: quad.topRight.x * sw, y: quad.topRight.y * sh },
            { x: quad.bottomRight.x * sw, y: quad.bottomRight.y * sh },
            { x: quad.bottomLeft.x * sw, y: quad.bottomLeft.y * sh }
          ];
          function dist(a, b) {
            return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
          }
          var outW = Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]));
          var outH = Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]));
          if (outW < 8 || outH < 8) throw 'crop area too small';
          var scale = Math.min(1, MAX_WARP / Math.max(outW, outH));
          var W = Math.max(8, Math.round(outW * scale));
          var H = Math.max(8, Math.round(outH * scale));

          canvas.width = sw;
          canvas.height = sh;
          ctx.drawImage(img, 0, 0);
          var srcData = ctx.getImageData(0, 0, sw, sh).data;

          var h = solveHomography(
            [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }],
            pts
          );

          canvas.width = W;
          canvas.height = H;
          var out = ctx.createImageData(W, H);
          var od = out.data;
          var oi = 0, X, Y, den, u, v;
          for (Y = 0; Y < H; Y++) {
            for (X = 0; X < W; X++) {
              den = h[6] * X + h[7] * Y + 1;
              u = (h[0] * X + h[1] * Y + h[2]) / den;
              v = (h[3] * X + h[4] * Y + h[5]) / den;
              sampleBilinear(srcData, sw, sh, u, v, od, oi);
              oi += 4;
            }
          }
          ctx.putImageData(out, 0, 0);
          resolve({
            dataUrl: canvas.toDataURL('image/jpeg', 0.92),
            ms: performance.now() - t0,
            width: W,
            height: H
          });
        } catch (e) {
          reject(String(e));
        }
      };
      img.onerror = function () { reject('image decode failed'); };
      img.src = dataUrl;
    });
  }

  // 所有任务共用一个 canvas，必须串行：缩略图批量生成和微调预览可能同时到达，
  // 并发写同一个 canvas 会互相覆盖。
  var queue = Promise.resolve();
  function enqueue(thunk) {
    var run = queue.then(thunk, thunk);
    queue = run.then(function () {}, function () {});
    return run;
  }

  function onPayload(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    var thunk = function () {
      return msg.op === 'warp'
        ? warpImage('data:image/jpeg;base64,' + msg.b64, msg.quad)
        : applyFilter(
            'data:image/jpeg;base64,' + msg.b64,
            msg.filter,
            msg.contrast,
            msg.brightness,
            msg.detail
          );
    };
    enqueue(thunk).then(function (r) {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        id: msg.id, ok: true, dataUrl: r.dataUrl, ms: r.ms, width: r.width, height: r.height
      }));
    }).catch(function (err) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ id: msg.id, ok: false, error: String(err) }));
    });
  }

  window.__applyFilterPayload = onPayload;
  window.addEventListener('message', function (e) { onPayload(e.data); });
  document.addEventListener('message', function (e) { onPayload(e.data); });
  try {
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
  } catch (e) {}
})();
</script>
</body>
</html>`;

export function FilterEngineHost() {
  const ref = useRef<any>(null);

  useEffect(() => {
    post = (payload: string) => {
      ref.current?.postMessage(payload);
    };
    inject = (js: string) => {
      ref.current?.injectJavaScript(js);
    };
    return () => {
      post = null;
      inject = null;
    };
  }, []);

  return (
    <View pointerEvents="none" style={styles.hidden}>
      <WebViewAny
        ref={ref}
        source={{ html: HTML }}
        originWhitelist={['*']}
        javaScriptEnabled
        onLoadEnd={() => resolveReady()}
        onMessage={(e: { nativeEvent: { data: string } }) => handleMessage(e.nativeEvent.data)}
        style={styles.webview}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1,
    height: 1,
    opacity: 0.01,
    overflow: 'hidden',
  },
  webview: { width: 1, height: 1, backgroundColor: 'transparent' },
});
