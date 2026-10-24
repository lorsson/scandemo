import { Image, StyleSheet, View } from 'react-native';

/**
 * 裁剪手柄的放大镜。
 *
 * 单独成一个组件、由页面渲染在最外层，是为了不被预览舞台的 overflow 裁掉：
 * 放大镜允许超出图片边界，超出图片的部分保持透明（能看到下面的界面），
 * 只有图片区域被放大。
 *
 * 镜心与手柄保持固定的屏幕偏移，拖动时 1:1 跟手，不做任何夹取，
 * 所以不会出现跳动。
 */

const ACCENT = '#4ea1ff';

/** 放大镜直径、放大倍率、镜心与手柄的距离 */
export const LOUPE_SIZE = 100;
export const LOUPE_ZOOM = 2.6;
export const LOUPE_DISTANCE = 88;

type Props = {
  /** 图片地址（与预览同一张） */
  uri: string;
  /** 图片显示区域的像素尺寸 */
  imageWidth: number;
  imageHeight: number;
  /** 放大中心点（图片显示区域内的像素坐标） */
  focusX: number;
  focusY: number;
  /** 屏幕坐标（页面根节点内）左上角 */
  left: number;
  top: number;
  /** 边手柄：镜心标记跟着边方向转；角点传 null 显示圆点 */
  edgeAngle: number | null;
};

export default function CropLoupe({
  uri,
  imageWidth,
  imageHeight,
  focusX,
  focusY,
  left,
  top,
  edgeAngle,
}: Props) {
  return (
    <View pointerEvents="none" style={[styles.loupe, { left, top }]}>
      <Image
        source={{ uri }}
        resizeMode="stretch"
        style={{
          position: 'absolute',
          width: imageWidth * LOUPE_ZOOM,
          height: imageHeight * LOUPE_ZOOM,
          left: LOUPE_SIZE / 2 - focusX * LOUPE_ZOOM,
          top: LOUPE_SIZE / 2 - focusY * LOUPE_ZOOM,
        }}
      />
      <View style={styles.crossH} />
      <View style={styles.crossV} />
      <View style={styles.centerWrap}>
        {edgeAngle === null ? (
          <View style={styles.centerCircle} />
        ) : (
          <View
            style={[
              styles.centerBar,
              { transform: [{ rotate: `${edgeAngle}rad` }] },
            ]}
          />
        )}
      </View>
      <View style={styles.ring} />
    </View>
  );
}

const styles = StyleSheet.create({
  loupe: {
    position: 'absolute',
    width: LOUPE_SIZE,
    height: LOUPE_SIZE,
    borderRadius: LOUPE_SIZE / 2,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: '#ffffff',
  },
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: LOUPE_SIZE / 2,
    borderWidth: 3,
    borderColor: 'rgba(78,161,255,0.85)',
  },
  crossH: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: LOUPE_SIZE / 2 - 0.5,
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.75)',
  },
  crossV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: LOUPE_SIZE / 2 - 0.5,
    width: 1,
    backgroundColor: 'rgba(255,255,255,0.75)',
  },
  centerWrap: {
    position: 'absolute',
    left: LOUPE_SIZE / 2 - 16,
    top: LOUPE_SIZE / 2 - 16,
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerCircle: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: ACCENT,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  centerBar: {
    width: 30,
    height: 11,
    borderRadius: 5.5,
    borderWidth: 2,
    borderColor: '#ffffff',
    backgroundColor: ACCENT,
  },
});
