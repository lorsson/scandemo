import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
} from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  Image,
  Linking,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../lib/i18n';
import { theme } from '../theme';

type Props = {
  /** 最多可选数量（受文档剩余页数限制） */
  limit: number;
  title?: string;
  onCancel: () => void;
  /** names 与 uris 一一对应：相册里的原始文件名，用来给文档起默认标题 */
  onDone: (uris: string[], names: string[]) => void;
};

const PADDING = 12;
const GAP = 4;
const COLUMNS = 4;
const PAGE_SIZE = 60;

/**
 * 应用内相册选择器（参考扫描全能王的导入界面）。
 *
 * - 缩略图网格，点一下选中，右上角小圆圈显示「第几张」
 * - 已选的可以全屏预览、左右翻页、取消选择
 * - 导入完成后再进来（编辑器里的「添加图片」）复用同一个组件，
 *   选择结果按选中顺序追加到当前文档
 */
export default function PhotoPickerScreen({
  limit,
  title,
  onCancel,
  onDone,
}: Props) {
  const insets = useSafeAreaInsets();
  const { t, tp } = useI18n();
  const heading = title ?? t('selectImages');
  const { width } = useWindowDimensions();
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [selected, setSelected] = useState<MediaLibrary.Asset[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'denied' | 'error'>(
    'loading',
  );
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  /** 权限弹窗可能重复触发，只加载第一页一次 */
  const loaded = useRef(false);

  const tile = Math.floor((width - PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS);

  // ---- 手指滑过批量选择 ----
  // 网格在窗口里的左上角 + 当前滚动偏移，用来把手指坐标换算成格子下标
  const gridRef = useRef<ComponentRef<typeof View>>(null);
  const gridOrigin = useRef({ x: 0, y: 0 });
  const scrollY = useRef(0);
  // PanResponder 只创建一次，所以数据都从 ref 里读，避免闭包拿到旧值
  const assetsRef = useRef(assets);
  const selectedRef = useRef(selected);
  const limitRef = useRef(limit);
  const tileRef = useRef(tile);
  /** 正在划选：last 是上一次应用的格子，select 表示这一笔是选中还是取消 */
  const dragRef = useRef<{ last: number; select: boolean } | null>(null);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    limitRef.current = limit;
  }, [limit]);
  useEffect(() => {
    tileRef.current = tile;
  }, [tile]);

  const measureGrid = useCallback(() => {
    // 测量要等布局完成，回调是异步的，拖动开始前早已就绪
    gridRef.current?.measureInWindow((x, y) => {
      gridOrigin.current = { x, y };
    });
  }, []);

  const indexAt = useCallback((pageX: number, pageY: number) => {
    const step = tileRef.current + GAP;
    const col = Math.floor((pageX - gridOrigin.current.x - PADDING) / step);
    const row = Math.floor(
      (pageY - gridOrigin.current.y - PADDING + scrollY.current) / step,
    );
    if (col < 0 || col >= COLUMNS || row < 0) return -1;
    const index = row * COLUMNS + col;
    return index < assetsRef.current.length ? index : -1;
  }, []);

  const applyRange = useCallback((from: number, to: number, select: boolean) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    setSelected((prev) => {
      const list = prev.slice();
      for (let i = lo; i <= hi; i++) {
        const asset = assetsRef.current[i];
        if (!asset) continue;
        const at = list.findIndex((item) => item.id === asset.id);
        if (select) {
          if (at < 0 && list.length < limitRef.current) list.push(asset);
        } else if (at >= 0) {
          list.splice(at, 1);
        }
      }
      return list;
    });
  }, []);

  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const dragSelect = useMemo(
    () =>
      // 回调只在手势里执行，读 ref 是为了拿到最新的格子数据
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        // 单击仍然交给格子自己的 Pressable
        onStartShouldSetPanResponder: () => false,
        // 只接管横向为主的滑动：纵向滑动继续滚动列表，不误选
        onMoveShouldSetPanResponderCapture: (_0, gesture) =>
          Math.abs(gesture.dx) > 12 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.2,
        onPanResponderGrant: (_0, gesture) => {
          const index = indexAt(gesture.x0, gesture.y0);
          if (index < 0) {
            dragRef.current = null;
            return;
          }
          const asset = assetsRef.current[index];
          // 从已选的格子起手 = 这一笔是取消选择（与系统相册一致）
          const picked = selectedRef.current.some((item) => item.id === asset.id);
          dragRef.current = { last: index, select: !picked };
          applyRange(index, index, !picked);
        },
        onPanResponderMove: (_0, gesture) => {
          const drag = dragRef.current;
          if (!drag) return;
          const index = indexAt(gesture.moveX, gesture.moveY);
          if (index < 0 || index === drag.last) return;
          // 快速滑动会跳过中间格子，按线性区间补齐
          applyRange(drag.last, index, drag.select);
          drag.last = index;
        },
        onPanResponderRelease: () => {
          dragRef.current = null;
        },
        onPanResponderTerminate: () => {
          dragRef.current = null;
        },
      }),
    [applyRange, indexAt],
  );

  const loadFirstPage = async () => {
    setStatus('loading');
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) {
        setStatus('denied');
        return;
      }
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: 'photo',
        sortBy: [['creationTime', false]],
        first: PAGE_SIZE,
      });
      setAssets(page.assets);
      setCursor(page.hasNextPage ? page.endCursor : null);
      setHasMore(page.hasNextPage);
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  };

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void loadFirstPage();
  }, []);

  const loadMore = async () => {
    if (!hasMore || loadingMore || !cursor) return;
    setLoadingMore(true);
    try {
      const page = await MediaLibrary.getAssetsAsync({
        mediaType: 'photo',
        sortBy: [['creationTime', false]],
        first: PAGE_SIZE,
        after: cursor,
      });
      setAssets((prev) => {
        const seen = new Set(prev.map((item) => item.id));
        return [...prev, ...page.assets.filter((item) => !seen.has(item.id))];
      });
      setCursor(page.hasNextPage ? page.endCursor : null);
      setHasMore(page.hasNextPage);
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  };

  const indexOf = (asset: MediaLibrary.Asset) =>
    selected.findIndex((item) => item.id === asset.id);

  const toggle = (asset: MediaLibrary.Asset) => {
    const at = indexOf(asset);
    if (at >= 0) {
      setSelected((prev) => prev.filter((item) => item.id !== asset.id));
      return;
    }
    if (selected.length >= limit) {
      return;
    }
    setSelected((prev) => [...prev, asset]);
  };

  /** 把相册资源换成可直接读的本地文件路径，避免导入时再解码 content:// */
  const handleDone = async () => {
    const uris: string[] = [];
    const names: string[] = [];
    for (const asset of selected) {
      names.push(asset.filename);
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset);
        uris.push(info.localUri ?? asset.uri);
      } catch {
        uris.push(asset.uri);
      }
    }
    onDone(uris, names);
  };

  const handleBack = () => {
    if (previewAt !== null) {
      setPreviewAt(null);
      return true;
    }
    onCancel();
    return true;
  };

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', handleBack);
    return () => sub.remove();
  });

  /** 预览里取消当前这张；空了就关掉预览 */
  const removePreviewed = () => {
    if (previewAt === null) return;
    const rest = selected.filter((_, i) => i !== previewAt);
    setSelected(rest);
    if (rest.length === 0) {
      setPreviewAt(null);
    } else {
      setPreviewAt(Math.min(previewAt, rest.length - 1));
    }
  };

  const onPreviewScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(event.nativeEvent.contentOffset.x / width);
    if (page !== previewAt) setPreviewAt(page);
  };

  const full = selected.length >= limit;

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <Pressable hitSlop={12} onPress={onCancel} style={styles.topBtn}>
          <Text style={styles.topBtnText}>{t('cancel')}</Text>
        </Pressable>
        <View style={styles.topCenter}>
          <Text style={styles.topTitle}>{heading}</Text>
          {selected.length > 0 && (
            <Text style={styles.topSub}>
              {tp('selectedCount', selected.length)}
            </Text>
          )}
        </View>
        <View style={styles.topBtn} />
      </View>

      {status === 'loading' && (
        <View style={styles.center}>
          <ActivityIndicator color={theme.primary} />
          <Text style={styles.hint}>{t('readingLibrary')}</Text>
        </View>
      )}

      {status === 'denied' && (
        <View style={styles.center}>
          <Text style={styles.centerTitle}>{t('libraryPermissionTitle')}</Text>
          <Text style={styles.hint}>{t('libraryPermissionHint')}</Text>
          <Pressable style={styles.settingsBtn} onPress={() => void Linking.openSettings()}>
            <Text style={styles.settingsText}>{t('openSettings')}</Text>
          </Pressable>
        </View>
      )}

      {status === 'error' && (
        <View style={styles.center}>
          <Text style={styles.centerTitle}>{t('libraryReadFailed')}</Text>
          <Pressable style={styles.settingsBtn} onPress={() => void loadFirstPage()}>
            <Text style={styles.settingsText}>{t('retry')}</Text>
          </Pressable>
        </View>
      )}

      {status === 'ready' && assets.length === 0 && (
        <View style={styles.center}>
          <Text style={styles.centerTitle}>{t('noPhotosTitle')}</Text>
          <Text style={styles.hint}>{t('noPhotosHint')}</Text>
        </View>
      )}

      {status === 'ready' && assets.length > 0 && (
        <View
          ref={gridRef}
          style={styles.gridWrap}
          onLayout={measureGrid}
          {...dragSelect.panHandlers}
        >
        <FlatList
          data={assets}
          keyExtractor={(item) => item.id}
          numColumns={COLUMNS}
          contentContainerStyle={styles.grid}
          columnWrapperStyle={styles.gridRow}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          onScroll={(event) => {
            scrollY.current = event.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          initialNumToRender={24}
          windowSize={7}
          removeClippedSubviews
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator style={styles.more} color={theme.subtext} />
            ) : undefined
          }
          renderItem={({ item }) => {
            const index = indexOf(item);
            const picked = index >= 0;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  picked
                    ? t('selectedNth', { n: index + 1 })
                    : t('selectThisImage')
                }
                accessibilityState={{ selected: picked }}
                onPress={() => toggle(item)}
                onLongPress={() => {
                  // 长按直接预览大图；未选中的先选中再预览
                  if (!picked) {
                    if (full) return;
                    setSelected((prev) => [...prev, item]);
                    setPreviewAt(selected.length);
                  } else {
                    setPreviewAt(index);
                  }
                }}
                style={{ width: tile, height: tile }}
              >
                <Image
                  source={{ uri: item.uri }}
                  style={styles.thumb}
                  resizeMode="cover"
                />
                <View style={[styles.circle, picked && styles.circleOn]}>
                  {picked ? (
                    <Text style={styles.circleText}>{index + 1}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
        </View>
      )}

      {status === 'ready' && (
        <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
          <Pressable
            accessibilityRole="button"
            disabled={selected.length === 0}
            onPress={() => setPreviewAt(0)}
            style={[styles.previewBtn, selected.length === 0 && styles.disabled]}
          >
            <Text style={styles.previewBtnText}>{t('preview')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={selected.length === 0}
            onPress={() => void handleDone()}
            style={[styles.doneBtn, selected.length === 0 && styles.disabled]}
          >
            <Text style={styles.doneText}>
              {selected.length > 0
                ? t('doneWithCount', { count: selected.length })
                : t('maxSelectable', { count: limit })}
            </Text>
          </Pressable>
        </View>
      )}

      {previewAt !== null && selected[previewAt] && (
        <View style={styles.preview}>
          <View style={[styles.previewTop, { paddingTop: insets.top + 10 }]}>
            <Pressable hitSlop={12} onPress={() => setPreviewAt(null)}>
              <Text style={styles.previewClose}>{t('close')}</Text>
            </Pressable>
            <Text style={styles.previewIndex}>
              {previewAt + 1} / {selected.length}
            </Text>
            <View style={{ width: 44 }} />
          </View>
          <FlatList
            data={selected}
            keyExtractor={(item) => item.id}
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={previewAt}
            getItemLayout={(_, index) => ({
              length: width,
              offset: width * index,
              index,
            })}
            onMomentumScrollEnd={onPreviewScroll}
            renderItem={({ item }) => (
              <View style={[styles.previewPage, { width }]}>
                <Image
                  source={{ uri: item.uri }}
                  style={styles.previewImage}
                  resizeMode="contain"
                />
              </View>
            )}
          />
          <View style={[styles.previewBottom, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.previewBadge}>
              <Text style={styles.previewBadgeText}>{previewAt + 1}</Text>
            </View>
            <Pressable style={styles.removeBtn} onPress={removePreviewed}>
              <Text style={styles.removeText}>{t('deselect')}</Text>
            </Pressable>
          </View>
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
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: theme.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  topBtn: { minWidth: 44 },
  topBtnText: { color: theme.text, fontSize: 15 },
  topCenter: { flex: 1, alignItems: 'center' },
  topTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  topSub: { color: theme.subtext, fontSize: 11, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 30 },
  centerTitle: { fontSize: 15, fontWeight: '600', color: theme.text },
  hint: { fontSize: 12, color: theme.subtext, marginTop: 8, textAlign: 'center' },
  settingsBtn: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: theme.primary,
  },
  settingsText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  gridWrap: { flex: 1 },
  grid: { padding: PADDING, paddingBottom: 20 },
  gridRow: { gap: GAP, marginBottom: GAP },
  thumb: {
    width: '100%',
    height: '100%',
    backgroundColor: theme.surfaceAlt,
  },
  circle: {
    position: 'absolute',
    top: 5,
    right: 5,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.9)',
    backgroundColor: 'rgba(0,0,0,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  circleText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  more: { paddingVertical: 16 },
  bottomBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: theme.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  previewBtn: {
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  previewBtnText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  doneBtn: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: theme.primary,
    paddingVertical: 13,
    alignItems: 'center',
  },
  doneText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  disabled: { opacity: 0.45 },
  preview: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: '#000',
    zIndex: 10,
  },
  previewTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    zIndex: 2,
  },
  previewClose: { color: '#c9ced8', fontSize: 15 },
  previewIndex: { color: '#fff', fontSize: 14, fontWeight: '600' },
  previewPage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '100%' },
  previewBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    zIndex: 2,
  },
  previewBadge: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 6,
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewBadgeText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  removeBtn: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 10,
    backgroundColor: '#2a2f3d',
  },
  removeText: { color: '#ff9a9a', fontSize: 13, fontWeight: '700' },
});
