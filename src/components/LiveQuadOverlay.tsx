import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

/**
 * 相机实时四角叠加层（纯展示）。
 *
 * `quad` 是 8 个「预览视图」归一化坐标 TL,TR,BR,BL——原生侧已经处理过
 * 帧旋转与 FILL_CENTER 的居中裁剪，这里只按自身尺寸摆放，不再做任何映射。
 *
 * 没有 react-native-svg，所以沿用 CropOverlay 的做法：
 * 绝对定位 + rotate 变换画线，圆点直接摆到角点上。
 */

const ACCENT = '#4ea1ff';
const DOT_SIZE = 12;
const LINE_WIDTH = 2;

type Props = {
  /** 8 个归一化坐标；null 表示当前没有检测到文档 */
  quad: readonly number[] | null;
  color?: string;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export default function LiveQuadOverlay({ quad, color = ACCENT }: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const points =
    quad && quad.length === 8
      ? [0, 1, 2, 3].map((i) => ({
          x: clamp01(quad[i * 2]),
          y: clamp01(quad[i * 2 + 1]),
        }))
      : null;

  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout;
        setSize((prev) =>
          prev.width === width && prev.height === height
            ? prev
            : { width, height },
        );
      }}
    >
      {points && size.width > 0 && size.height > 0 && (
        <>
          {points.map((a, index) => {
            const b = points[(index + 1) % points.length];
            const ax = a.x * size.width;
            const ay = a.y * size.height;
            const bx = b.x * size.width;
            const by = b.y * size.height;
            const length = Math.hypot(bx - ax, by - ay);
            const angle = Math.atan2(by - ay, bx - ax);
            return (
              <View
                key={`edge-${index}`}
                style={[
                  styles.line,
                  {
                    width: length,
                    left: (ax + bx) / 2 - length / 2,
                    top: (ay + by) / 2 - LINE_WIDTH / 2,
                    backgroundColor: color,
                    transform: [{ rotate: `${angle}rad` }],
                  },
                ]}
              />
            );
          })}

          {points.map((point, index) => (
            <View
              key={`corner-${index}`}
              style={[
                styles.dot,
                {
                  left: point.x * size.width - DOT_SIZE / 2,
                  top: point.y * size.height - DOT_SIZE / 2,
                  borderColor: color,
                },
              ]}
            />
          ))}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    position: 'absolute',
    height: LINE_WIDTH,
    borderRadius: LINE_WIDTH / 2,
  },
  dot: {
    position: 'absolute',
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: 2,
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
});
