import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';

import { useI18n } from '../lib/i18n';
import type { DocumentQuad, NormalizedPoint } from '../types';

/**
 * 四角裁剪框。
 *
 * 交互（与扫描类 App 一致）：
 *   - 拖 4 个角点：单独调整某个角
 *   - 拖 4 条边的中点：整条边平移，两个端点一起走
 *   - 手指落在手柄附近（GRAB_RADIUS）就能抓住最近的手柄，不必精确命中，
 *     避免手指盖住手柄后看不到、抓不到
 *   - 触摸区域向外扩出 inset：手柄压在图片边界上时有一半在图片外，
 *     不扩出去的话贴边手柄按不到
 *   - 拖动时由页面在最外层画放大镜（见 CropLoupe），手柄随手指移动
 * - 四个点围成的不是凸四边形（边交叉或凹陷）时，边框变红表示无效
 * 坐标全部是相对图片显示区域的归一化值，父组件按实际像素尺寸摆放。
 */

type CornerKey = keyof DocumentQuad;

const CORNERS: CornerKey[] = [
  'topLeft',
  'topRight',
  'bottomRight',
  'bottomLeft',
];

type EdgeId = 'top' | 'right' | 'bottom' | 'left';

const EDGES: { id: EdgeId; a: CornerKey; b: CornerKey }[] = [
  { id: 'top', a: 'topLeft', b: 'topRight' },
  { id: 'right', a: 'topRight', b: 'bottomRight' },
  { id: 'bottom', a: 'bottomLeft', b: 'bottomRight' },
  { id: 'left', a: 'topLeft', b: 'bottomLeft' },
];

export type CropHandle =
  | { kind: 'corner'; key: CornerKey }
  | { kind: 'edge'; key: EdgeId };

const ACCENT = '#4ea1ff';
const CORNER_SIZE = 18;
/** 边手柄是长条：长度方向沿边、粗细方向垂直 */
const EDGE_BAR_LENGTH = 30;
const EDGE_BAR_THICKNESS = 10;
/** 手指离手柄多近就算抓住：手指按下去会盖住 ~9mm，给足余量 */
const GRAB_RADIUS = 64;

const INVALID = '#ff453a';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 四个点按 左上→右上→右下→左下 的顺序是否围成凸四边形。
 *
 * 逐顶点看相邻两条边的叉积：凸四边形四个叉积同号；出现相反符号说明
 * 某个角凹进去（或边自交），透视变换会撕裂，属于无效区域。
 * 归一化坐标的 x/y 缩放不影响符号。
 */
export function isQuadConvex(quad: DocumentQuad): boolean {
  const points = [
    quad.topLeft,
    quad.topRight,
    quad.bottomRight,
    quad.bottomLeft,
  ];
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    // 三点共线 -> 退化成三角/线段，同样无效
    if (Math.abs(cross) < 1e-6) return false;
    const current = cross > 0 ? 1 : -1;
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

function moveQuad(
  start: DocumentQuad,
  kind: 'corner' | 'edge',
  key: CornerKey | EdgeId,
  dnx: number,
  dny: number,
): DocumentQuad {
  const next: DocumentQuad = {
    topLeft: { ...start.topLeft },
    topRight: { ...start.topRight },
    bottomRight: { ...start.bottomRight },
    bottomLeft: { ...start.bottomLeft },
  };

  if (kind === 'corner') {
    const point = start[key as CornerKey];
    next[key as CornerKey] = {
      x: clamp01(point.x + dnx),
      y: clamp01(point.y + dny),
    };
    return next;
  }

  const edge = EDGES.find((item) => item.id === key);
  if (!edge) return next;
  const a = start[edge.a];
  const b = start[edge.b];
  // 平移整条边时两个端点共享位移，先夹到「两端都不出界」的范围
  const dx = Math.max(
    -Math.min(a.x, b.x),
    Math.min(dnx, 1 - Math.max(a.x, b.x)),
  );
  const dy = Math.max(
    -Math.min(a.y, b.y),
    Math.min(dny, 1 - Math.max(a.y, b.y)),
  );
  next[edge.a] = { x: a.x + dx, y: a.y + dy };
  next[edge.b] = { x: b.x + dx, y: b.y + dy };
  return next;
}

function midpoint(a: NormalizedPoint, b: NormalizedPoint): NormalizedPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function edgeOf(id: EdgeId): { a: CornerKey; b: CornerKey } {
  return EDGES.find((item) => item.id === id) ?? EDGES[0];
}

/** 手势开始时选最近的手柄；超过 GRAB_RADIUS 返回 null（不抢手势） */
function findHandle(
  quad: DocumentQuad,
  width: number,
  height: number,
  location: { x: number; y: number },
): CropHandle | null {
  let best: CropHandle | null = null;
  let bestDist = GRAB_RADIUS;

  const cornerDist = (key: CornerKey) =>
    Math.hypot(quad[key].x * width - location.x, quad[key].y * height - location.y);

  for (const key of CORNERS) {
    const dist = cornerDist(key);
    if (dist <= bestDist) {
      bestDist = dist;
      best = { kind: 'corner', key };
    }
  }

  for (const edge of EDGES) {
    const mid = midpoint(quad[edge.a], quad[edge.b]);
    const dist = Math.hypot(mid.x * width - location.x, mid.y * height - location.y);
    // 角点和边中点重叠时优先角点，所以边用严格小于
    if (dist < bestDist) {
      bestDist = dist;
      best = { kind: 'edge', key: edge.id };
    }
  }

  return best;
}

/** 手柄位置（归一化）：角点就是角点，边手柄是两端中点 */
export function handlePoint(
  quad: DocumentQuad,
  handle: CropHandle,
): NormalizedPoint {
  if (handle.kind === 'corner') return quad[handle.key];
  const edge = edgeOf(handle.key);
  return midpoint(quad[edge.a], quad[edge.b]);
}

function sameHandle(a: CropHandle | null, b: CropHandle | null): boolean {
  return a !== null && b !== null && a.kind === b.kind && a.key === b.key;
}

/** 拖拽中的手柄信息，交给页面画放大镜 */
export type ActiveHandle = {
  handle: CropHandle;
  /** 边手柄的屏幕角度（弧度）；角点为 null */
  edgeAngle: number | null;
};

type Props = {
  /** 图片实际显示区域（像素） */
  width: number;
  height: number;
  /**
   * 触摸区域向外扩出的边距（dp）。
   * 手柄压在图片边界上，有一半落在图片外；不扩出来的话，
   * 贴边的手柄按不到——这些点的触摸事件根本到不了这个视图。
   */
  inset?: number;
  quad: DocumentQuad;
  onChange: (quad: DocumentQuad) => void;
  /**
   * 按下/松开手柄时通知页面。放大镜由页面渲染在最外层，
   * 这样它可以超出图片边界而不被预览区域裁掉。
   */
  onActiveHandle?: (active: ActiveHandle | null) => void;
};

export default function CropOverlay({
  width,
  height,
  inset = 0,
  quad,
  onChange,
  onActiveHandle,
}: Props) {
  const { t } = useI18n();
  const quadRef = useRef(quad);
  const sizeRef = useRef({ width, height });
  const insetRef = useRef(inset);
  const changeRef = useRef(onChange);
  const activeRef = useRef(onActiveHandle);
  /** 一次拖拽的起始状态；放在 ref 里因为只有手势回调会读写它 */
  const dragRef = useRef<{ start: DocumentQuad | null; handle: CropHandle | null }>({
    start: null,
    handle: null,
  });
  const [active, setActive] = useState<CropHandle | null>(null);

  // ref 只用于手势回调；在 effect 里同步，避免渲染期间读写 ref
  useEffect(() => {
    quadRef.current = quad;
  }, [quad]);
  useEffect(() => {
    sizeRef.current = { width, height };
  }, [width, height]);
  useEffect(() => {
    insetRef.current = inset;
  }, [inset]);
  useEffect(() => {
    changeRef.current = onChange;
  }, [onChange]);
  useEffect(() => {
    activeRef.current = onActiveHandle;
  }, [onActiveHandle]);

  /**
   * 手势句柄只创建一次：拖动过程中 quad 每帧变化会触发重渲染，
   * 如果每次重建 PanResponder，正在进行的拖拽会丢失起始状态。
   *
   * 统一的整层响应器负责「就近抓取」：按下时找 GRAB_RADIUS 内最近的手柄，
   * 找不到就不接管手势。
   */
  // 响应器在渲染期创建，但回调只会在触摸发生后执行；读 ref 是刻意的，
  // 保证始终拿到最新的 quad / 尺寸。
  /* eslint-disable react-hooks/refs */
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (event) => {
          const size = sizeRef.current;
          if (!size.width || !size.height) return false;
          dragRef.current.handle = findHandle(
            quadRef.current,
            size.width,
            size.height,
            {
              // location 是相对整个触摸区域的，减掉外扩边距才是图片内坐标
              x: event.nativeEvent.locationX - insetRef.current,
              y: event.nativeEvent.locationY - insetRef.current,
            },
          );
          return dragRef.current.handle !== null;
        },
        onMoveShouldSetPanResponder: () => false,
        onPanResponderGrant: () => {
          const handle = dragRef.current.handle;
          if (!handle) return;
          const start = quadRef.current;
          const size = sizeRef.current;
          dragRef.current.start = start;
          setActive(handle);
          // 边的方向在整段拖拽里不变（两端同步平移），按一次就够
          let edgeAngle: number | null = null;
          if (handle.kind === 'edge') {
            const edge = edgeOf(handle.key);
            const ax = start[edge.a].x * size.width;
            const ay = start[edge.a].y * size.height;
            const bx = start[edge.b].x * size.width;
            const by = start[edge.b].y * size.height;
            edgeAngle = Math.atan2(by - ay, bx - ax);
          }
          activeRef.current?.({ handle, edgeAngle });
        },
        onPanResponderMove: (_event, gesture) => {
          const { start, handle } = dragRef.current;
          const size = sizeRef.current;
          if (!start || !handle || !size.width || !size.height) return;
          changeRef.current(
            moveQuad(
              start,
              handle.kind,
              handle.key,
              gesture.dx / size.width,
              gesture.dy / size.height,
            ),
          );
        },
        onPanResponderRelease: () => {
          dragRef.current.start = null;
          dragRef.current.handle = null;
          setActive(null);
          activeRef.current?.(null);
        },
        onPanResponderTerminate: () => {
          dragRef.current.start = null;
          dragRef.current.handle = null;
          setActive(null);
          activeRef.current?.(null);
        },
        // 拖动中不让父级滚动/翻页抢走手势
        onPanResponderTerminationRequest: () => false,
      }),
    [],
  );
  /* eslint-enable react-hooks/refs */

  // 图片内坐标 -> 触摸区域坐标（外扩边距是图片到本视图左上角的距离）
  const px = (point: NormalizedPoint) => ({
    x: inset + point.x * width,
    y: inset + point.y * height,
  });

  const valid = isQuadConvex(quad);

  return (
    <View
      style={StyleSheet.absoluteFill}
      {...responder.panHandlers}
      accessibilityRole="adjustable"
      accessibilityLabel={t('cropA11y')}
    >
      {EDGES.map((edge) => {
        const a = px(quad[edge.a]);
        const b = px(quad[edge.b]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy);
        const angle = Math.atan2(dy, dx);
        return (
          <View
            key={`line-${edge.id}`}
            pointerEvents="none"
            style={[
              styles.line,
              {
                width: length,
                left: (a.x + b.x) / 2 - length / 2,
                top: (a.y + b.y) / 2 - 1,
                transform: [{ rotate: `${angle}rad` }],
              },
              !valid && styles.lineInvalid,
            ]}
          />
        );
      })}

      {/* 四条边的中点：长条沿边方向摆放，表示「整条边可以平移」。
          直接按自身尺寸定位到中点，不套居中容器——旋转以视图中心为原点，
          所以长条中心永远落在边中点上。 */}
      {EDGES.map((edge) => {
        const a = px(quad[edge.a]);
        const b = px(quad[edge.b]);
        const mid = px(midpoint(quad[edge.a], quad[edge.b]));
        const angle = Math.atan2(b.y - a.y, b.x - a.x);
        const isActive = sameHandle(active, { kind: 'edge', key: edge.id });
        return (
          <View
            key={`grip-${edge.id}`}
            pointerEvents="none"
            style={[
              styles.edgeBar,
              {
                left: mid.x - EDGE_BAR_LENGTH / 2,
                top: mid.y - EDGE_BAR_THICKNESS / 2,
                transform: [{ rotate: `${angle}rad` }],
              },
              isActive && styles.edgeBarActive,
            ]}
          />
        );
      })}

      {/* 四个角点：圆圈表示「这个点可以拖动」 */}
      {CORNERS.map((key) => {
        const point = px(quad[key]);
        const isActive = sameHandle(active, { kind: 'corner', key });
        return (
          <View
            key={`corner-${key}`}
            pointerEvents="none"
            style={[
              styles.cornerDot,
              {
                left: point.x - CORNER_SIZE / 2,
                top: point.y - CORNER_SIZE / 2,
              },
              isActive && styles.cornerDotActive,
            ]}
          />
        );
      })}

    </View>
  );
}

const styles = StyleSheet.create({
  line: {
    position: 'absolute',
    height: 2,
    borderRadius: 1,
    backgroundColor: ACCENT,
  },
  // 非凸四边形：边框变红，提示这块区域不能裁剪
  lineInvalid: {
    backgroundColor: INVALID,
  },
  // 角点：圆圈，提示「这是一个可以拖动的点」
  cornerDot: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderRadius: CORNER_SIZE / 2,
    borderWidth: 2,
    borderColor: ACCENT,
    backgroundColor: '#ffffff',
  },
  cornerDotActive: {
    borderColor: '#ffffff',
    backgroundColor: ACCENT,
  },
  // 边中点：长条，沿边方向摆放，提示「整条边可以平移」
  edgeBar: {
    position: 'absolute',
    width: EDGE_BAR_LENGTH,
    height: EDGE_BAR_THICKNESS,
    borderRadius: EDGE_BAR_THICKNESS / 2,
    borderWidth: 2,
    borderColor: '#ffffff',
    backgroundColor: ACCENT,
  },
  edgeBarActive: {
    backgroundColor: '#b8d8ff',
  },
});
