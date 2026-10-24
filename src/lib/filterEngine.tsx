import { useEffect, useRef } from 'react';
import type { ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';

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
 */

type Pending = {
  resolve: (dataUrl: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  filter: FilterKey;
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
        `[image-core:canvas] ${entry.filter} ${msg.width ?? '?'}x${msg.height ?? '?'} ` +
          `process=${Math.round(msg.ms)}ms total=${Date.now() - entry.start}ms`,
      );
    }
    entry.resolve(msg.dataUrl);
  } else {
    entry.reject(new Error(msg.error || '滤镜处理失败'));
  }
}

/** 输入 JPEG base64，返回处理后的 data URI（JPEG）。 */
export async function filterWithCanvas(base64: string, filter: FilterKey): Promise<string> {
  if (filter === 'original') {
    return `data:image/jpeg;base64,${base64}`;
  }

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
    const payload = { id, b64: base64, filter };
    const raw = JSON.stringify(payload);
    // 兜底：如果 postMessage 没被 WebView 收到，直接执行脚本
    const injectPayload = () => {
      sendInject?.(`window.__applyFilterPayload(${JSON.stringify(raw)}); true;`);
    };

    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('滤镜处理超时'));
    }, 25000);
    pending.set(id, { resolve, reject, timer, filter, start: Date.now() });

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

const HTML = `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body>
<canvas id="c"></canvas>
<script>
(function () {
  var canvas = document.getElementById('c');
  var ctx = canvas.getContext('2d');

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

  function applyFilter(dataUrl, key) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        try {
          var t0 = performance.now();
          var w = img.naturalWidth, h = img.naturalHeight;
          canvas.width = w;
          canvas.height = h;
          ctx.drawImage(img, 0, 0);

          if (key !== 'original') {
            var im = ctx.getImageData(0, 0, w, h);
            var d = im.data;
            var n = w * h;
            var p, i, r, g, b, lum;

            if (key === 'gray') {
              for (p = 0; p < n; p++) {
                i = p * 4;
                lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                lum = clamp((lum - 128) * 1.15 + 128);
                d[i] = d[i + 1] = d[i + 2] = lum;
              }
            } else if (key === 'bw') {
              var hist = new Uint32Array(256);
              for (p = 0; p < n; p++) {
                i = p * 4;
                lum = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
                hist[lum]++;
              }
              var th = otsu(hist, n);
              for (p = 0; p < n; p++) {
                i = p * 4;
                lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
                var v = lum > th ? 255 : 0;
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
            }
            ctx.putImageData(im, 0, 0);
          }

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

  function onPayload(raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    applyFilter('data:image/jpeg;base64,' + msg.b64, msg.filter).then(function (r) {
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
