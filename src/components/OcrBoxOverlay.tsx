import { memo, useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { OcrLine } from '../lib/ocr';

/**
 * 识别结果叠加层：在图片上画出每一行的文本框。
 *
 * 用的是「绝对定位 View + rotate」而不是 SVG——项目里没有
 * react-native-svg，CropOverlay / LiveQuadOverlay 也是同一套做法。
 * 每个框同时是一个可点的热区（按外接矩形放大到至少 22pt），
 * 点一下就把对应的文本行选中并滚到可见。
 */

type Props = {
  lines: OcrLine[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  lowConfidenceIds?: Set<string>;
  /** 点选后高亮的框保留多久由父级控制；这里只负责样式 */
};

const ACCENT = '#2f6bff';
const LOW = '#ff8f0a';
/** 文本框最细的可点高度：细行也能点中 */
const MIN_TOUCH_HEIGHT = 22;

function OcrBoxOverlay({
  lines,
  selectedId,
  onSelect,
  lowConfidenceIds,
}: Props) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  const onLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const { width, height } = event.nativeEvent.layout;
      setSize((prev) =>
        prev.width === width && prev.height === height
          ? prev
          : { width, height },
      );
    },
    [],
  );

  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="box-none">
      {size.width > 0 &&
        lines.map((line) => {
          const a = line.box[0];
          const b = line.box[1];
          const c = line.box[3];
          const ax = a.x * size.width;
          const ay = a.y * size.height;
          const bx = b.x * size.width;
          const by = b.y * size.height;
          const cx = c.x * size.width;
          const cy = c.y * size.height;

          const d = line.box[2];
          const dx = d.x * size.width;
          const dy = d.y * size.height;
          const width = Math.hypot(bx - ax, by - ay);
          // 左右两条边取平均，透视/轻微弯曲时比只看一条边稳
          const height = Math.max(
            2,
            (Math.hypot(cx - ax, cy - ay) + Math.hypot(dx - bx, dy - by)) / 2,
          );
          const angle = Math.atan2(by - ay, bx - ax);
          // 四个角的几何中心，比外接矩形中心更贴合旋转后的框
          const centerX =
            ((a.x + b.x + line.box[2].x + c.x) / 4) * size.width;
          const centerY =
            ((a.y + b.y + line.box[2].y + c.y) / 4) * size.height;

          const selected = selectedId === line.id;
          const low = lowConfidenceIds?.has(line.id) ?? false;
          const touchHeight = Math.max(height, MIN_TOUCH_HEIGHT);

          return (
            <Pressable
              key={line.id}
              accessibilityRole="button"
              accessibilityLabel={line.text}
              onPress={() => onSelect(line.id)}
              style={[
                styles.box,
                {
                  width,
                  height: touchHeight,
                  left: centerX - width / 2,
                  top: centerY - touchHeight / 2,
                  transform: [{ rotate: `${angle}rad` }],
                },
                selected && styles.boxSelected,
                low && !selected && styles.boxLow,
              ]}
            >
              <View
                pointerEvents="none"
                style={[
                  styles.outline,
                  { height: Math.max(height, 2) },
                  selected && styles.outlineSelected,
                  low && !selected && styles.outlineLow,
                ]}
              />
            </Pressable>
          );
        })}
    </View>
  );
}

/**
 * 编辑文字时每一行都会重建 lines 数组，但文本框的几何没变。
 * 只比较 id / box / 置信度，打字时不重绘整层框。
 */
export default memo(OcrBoxOverlay, (prev, next) => {
  if (prev.selectedId !== next.selectedId) return false;
  if (prev.lines.length !== next.lines.length) return false;
  for (let i = 0; i < prev.lines.length; i += 1) {
    const a = prev.lines[i];
    const b = next.lines[i];
    if (a.id !== b.id || a.score !== b.score || a.box !== b.box) return false;
  }
  const prevLow = prev.lowConfidenceIds;
  const nextLow = next.lowConfidenceIds;
  if (prevLow === nextLow) return true;
  if (!prevLow || !nextLow || prevLow.size !== nextLow.size) return false;
  for (const id of prevLow) {
    if (!nextLow.has(id)) return false;
  }
  return true;
});

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    justifyContent: 'center',
  },
  boxSelected: {
    backgroundColor: 'rgba(47, 107, 255, 0.20)',
  },
  boxLow: {
    backgroundColor: 'rgba(255, 143, 10, 0.10)',
  },
  outline: {
    borderWidth: 1,
    borderColor: 'rgba(47, 107, 255, 0.85)',
    borderRadius: 2,
  },
  outlineSelected: {
    borderWidth: 2,
    borderColor: ACCENT,
    backgroundColor: 'rgba(47, 107, 255, 0.12)',
  },
  outlineLow: {
    borderColor: LOW,
    borderStyle: 'dashed',
  },
});
