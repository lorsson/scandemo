import { useEffect, useRef, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../theme';
import type { PdfDoc } from '../types';

type Props = {
  doc: PdfDoc;
  /** 打开后定位到第几页（0 起） */
  initialPage?: number;
  onBack: () => void;
  /** 进入排版/制作页（PdfScreen） */
  onEditLayout: () => void;
  /** 编辑当前页，打开单页图片编辑器 */
  onEditPage: (pageId: string) => void;
};

/**
 * 基于页图的内置 PDF 阅读器。
 *
 * 不解析 PDF 文件本身，直接翻页渲染每页的高分效果图（page.uri），
 * 因此比解析真实 PDF 更快、更清晰，也免掉 pdf.js 一类的大依赖。
 * 手势：左右滑动翻页；双指捏合缩放；底部缩略图条点击跳页。
 */
export default function PdfReaderScreen({
  doc,
  initialPage = 0,
  onBack,
  onEditLayout,
  onEditPage,
}: Props) {
  const insets = useSafeAreaInsets();
  const pages = doc.pages;

  const ref = useRef<ScrollViewInstance>(null);
  const [pageW, setPageW] = useState(0);
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(initialPage, Math.max(0, pages.length - 1))),
  );

  // 容器宽度确定后，如果是初次进入的非首页，滚动到目标页
  useEffect(() => {
    if (pageW > 0 && index > 0 && ref.current) {
      ref.current.scrollTo({ x: index * pageW, animated: false });
    }
    // 只在 pageW 就绪时触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageW]);

  const onLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    const width = e.nativeEvent.layout.width;
    if (Math.abs(width - pageW) > 1) setPageW(width);
  };

  const onMomentum = (e: {
    nativeEvent: { contentOffset: { x: number } };
  }) => {
    if (pageW > 0) {
      const next = Math.round(e.nativeEvent.contentOffset.x / pageW);
      if (next >= 0 && next < pages.length && next !== index) setIndex(next);
    }
  };

  const scrollToPage = (i: number) => {
    const target = Math.max(0, Math.min(i, pages.length - 1));
    setIndex(target);
    if (pageW > 0 && ref.current) {
      ref.current.scrollTo({ x: target * pageW, animated: true });
    }
  };

  const dirty =
    !doc.uri || doc.generatedAt === null || doc.updatedAt > doc.generatedAt;
  const current = pages[index];

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <Pressable hitSlop={12} onPress={onBack} style={styles.topBtn}>
          <Text style={styles.topBtnText}>返回</Text>
        </Pressable>
        <View style={styles.topTitleWrap}>
          <Text style={styles.topTitle} numberOfLines={1}>
            {doc.title}
          </Text>
        </View>
        <Pressable hitSlop={10} onPress={onEditLayout} style={styles.layoutBtn}>
          <Text style={styles.layoutBtnText}>✎ 排版</Text>
        </Pressable>
      </View>

      {pages.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>📄</Text>
          <Text style={styles.emptyText}>这个文档还没有页面</Text>
          <Text style={styles.emptyHint}>先去「✎ 排版」添加图片。</Text>
        </View>
      ) : (
        <ScrollView
          ref={ref}
          style={styles.body}
          horizontal
          pagingEnabled
          pinchGestureEnabled
          maximumZoomScale={4}
          minimumZoomScale={1}
          showsHorizontalScrollIndicator={false}
          onLayout={onLayout}
          onMomentumScrollEnd={onMomentum}
        >
          {pages.map((page) => (
            <View
              key={page.id}
              style={[styles.page, { width: pageW || 1 }]}
            >
              <Image
                source={{ uri: page.uri }}
                style={styles.pageImage}
                resizeMode="contain"
              />
            </View>
          ))}
        </ScrollView>
      )}

      {pages.length > 0 && (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 10 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`编辑第 ${index + 1} 页`}
            style={({ pressed }) => [
              styles.editBtn,
              pressed && styles.pressed,
            ]}
            onPress={() => current && onEditPage(current.id)}
          >
            <Text style={styles.editBtnText}>✎ 编辑本页 · 第 {index + 1} 页</Text>
          </Pressable>
          {dirty && (
            <Text style={styles.dirtyHint}>页面已调整，PDF 是旧版；去排版处重新生成</Text>
          )}

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.strip}
          >
            {pages.map((page, i) => {
              const active = i === index;
              return (
                <Pressable
                  key={page.id}
                  accessibilityRole="button"
                  accessibilityLabel={`第 ${i + 1} 页`}
                  accessibilityState={{ selected: active }}
                  onPress={() => scrollToPage(i)}
                  style={[
                    styles.thumbWrap,
                    active && styles.thumbActive,
                  ]}
                >
                  <Image
                    source={{ uri: page.thumbUri }}
                    style={styles.thumb}
                  />
                  <Text style={[styles.thumbNo, active && styles.thumbNoActive]}>
                    {i + 1}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  topBtn: { minWidth: 52 },
  topBtnText: { color: theme.text, fontSize: 15 },
  topTitleWrap: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  topTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: theme.text,
    maxWidth: '100%',
  },
  layoutBtn: {
    minWidth: 52,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.primary,
    alignItems: 'center',
  },
  layoutBtnText: { color: theme.primary, fontSize: 12, fontWeight: '700' },
  body: { flex: 1 },
  page: {
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    backgroundColor: theme.ink,
  },
  pageImage: { width: '100%', height: '100%' },
  bottomBar: {
    backgroundColor: theme.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    paddingTop: 10,
  },
  editBtn: {
    alignSelf: 'stretch',
    marginHorizontal: 16,
    borderRadius: 12,
    backgroundColor: theme.primary,
    paddingVertical: 12,
    alignItems: 'center',
  },
  editBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  dirtyHint: {
    textAlign: 'center',
    fontSize: 11,
    color: '#8a5a00',
    marginTop: 8,
    paddingHorizontal: 16,
  },
  strip: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 2,
    gap: 8,
  },
  thumbWrap: {
    width: 44,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
    overflow: 'hidden',
    backgroundColor: theme.surfaceAlt,
  },
  thumbActive: { borderColor: theme.primary },
  thumb: { width: 44, height: 56, borderRadius: 6, backgroundColor: theme.surfaceAlt },
  thumbNo: {
    position: 'absolute',
    right: 2,
    bottom: 2,
    fontSize: 9,
    fontWeight: '700',
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: 4,
    overflow: 'hidden',
  },
  thumbNoActive: { backgroundColor: theme.primary },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  emptyIcon: { fontSize: 44, marginBottom: 12 },
  emptyText: { fontSize: 15, fontWeight: '700', color: theme.text },
  emptyHint: { fontSize: 12, color: theme.subtext, marginTop: 6 },
  pressed: { opacity: 0.8 },
});