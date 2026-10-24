import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../lib/i18n';
import { theme } from '../theme';
import type { FilterKey, Rotation } from '../types';
import { filterLabel } from '../types';
import { SCAN_FILTERS } from '../lib/filters';
import { prepareBase, readBase64, rotateImage } from '../lib/imagePipeline';
import { filterWithCanvas } from '../lib/filterEngine';
import { filterWithNative, isNativeFilterAvailable } from '../lib/filterNative';

type Props = {
  sourceUri: string;
  title: string;
  onCancel: () => void;
  onSave: (payload: {
    base64: string;
    filter: FilterKey;
    title: string;
    rotation: Rotation;
  }) => Promise<void> | void;
  /** PDF 单页编辑：页面的原始滤镜 / 旋转 / 工作尺寸 */
  initialFilter?: FilterKey;
  initialRotation?: Rotation;
  maxDim?: number;
  /** 显示切边、批注等单页工具（切边/批注目前是预留接口） */
  showPageTools?: boolean;
};

/** data:image/jpeg;base64,xxx -> xxx */
function stripDataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

export default function EditorScreen({
  sourceUri,
  title,
  onCancel,
  onSave,
  initialFilter = 'enhance',
  initialRotation = 0,
  maxDim = 1400,
  showPageTools = false,
}: Props) {
  const [currentUri, setCurrentUri] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>(initialFilter);
  const [rotation, setRotation] = useState<Rotation>(initialRotation);
  const [processed, setProcessed] = useState<{
    key: FilterKey;
    uri: string;
    source: 'native' | 'canvas';
  } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);
  // 未旋转的预处理图；旋转总是从它重来，避免多次编码累积损失
  const preparedRef = useRef<string | null>(null);
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  // 原生模块（development build）优先；Expo Go 里自动退回 WebView Canvas
  const runFilter = useCallback(async (uri: string, key: FilterKey) => {
    if (isNativeFilterAvailable()) {
      const out = await filterWithNative(uri, key);
      return { key, uri: out.uri, source: out.source };
    }
    const dataUrl = await filterWithCanvas(await readBase64(uri), key);
    return { key, uri: dataUrl, source: 'canvas' as const };
  }, []);

  // 初次载入：把图片压到合适尺寸，并恢复页面已有的旋转
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prepared = await prepareBase(sourceUri, maxDim);
        const rotated =
          initialRotation === 0
            ? prepared
            : await rotateImage(prepared, initialRotation);
        if (!cancelled) {
          preparedRef.current = prepared;
          setCurrentUri(rotated);
          setProcessing(true); // 接下来滤镜 effect 会接手，先把遮罩亮起来
        }
      } catch {
        if (!cancelled) setError(t('imageReadFailedShort'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceUri, maxDim, initialRotation, t]);

  // 滤镜预览
  useEffect(() => {
    if (!currentUri) return;
    // 原图直接显示 currentUri（见 previewUri），无需清空 processed 触发重渲染
    if (filter === 'original') return;
    const myReq = ++reqId.current;
    let cancelled = false;
    (async () => {
      try {
        // 让“处理中”先渲染出来
        await new Promise<void>((r) => setTimeout(r, 30));
        const result = await runFilter(currentUri, filter);
        if (!cancelled && myReq === reqId.current) {
          setProcessed(result);
        }
      } catch (e) {
        if (!cancelled && myReq === reqId.current) {
          setError(
            t('filterFailed', {
              message: (e as Error)?.message ?? t('unknownError'),
            }),
          );
        }
      } finally {
        if (!cancelled) setProcessing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUri, filter, runFilter, t]);

  const handleSelectFilter = (key: FilterKey) => {
    if (key === filter) return;
    setFilter(key);
    setError(null);
    if (key !== 'original') setProcessing(true);
  };

  const handleRotate = async (deg: 90 | 270) => {
    const base = preparedRef.current;
    if (!currentUri || !base) return;
    setProcessing(true);
    setError(null);
    setProcessed(null);
    const nextRotation = ((rotation + deg) % 360) as Rotation;
    try {
      const rotated =
        nextRotation === 0 ? base : await rotateImage(base, nextRotation);
      setRotation(nextRotation);
      setCurrentUri(rotated);
    } catch {
      setError(t('rotationFailed'));
    }
  };

  const handleResetOriginal = () => {
    if (!preparedRef.current) return;
    setFilter('original');
    setRotation(0);
    setProcessed(null);
    setError(null);
    setCurrentUri(preparedRef.current);
  };

  const handleSave = async () => {
    if (!currentUri || saving) return;
    setSaving(true);
    try {
      let b64: string;
      if (filter === 'original') {
        b64 = await readBase64(currentUri);
      } else {
        const result =
          processed && processed.key === filter
            ? processed
            : await runFilter(currentUri, filter);
        b64 =
          result.source === 'native'
            ? await readBase64(result.uri)
            : stripDataUrl(result.uri);
      }
      await onSave({ base64: b64, filter, title, rotation });
    } catch {
      setSaving(false);
      setError(t('saveFailedTitle'));
    }
  };

  const previewUri =
    filter === 'original'
      ? currentUri
      : processed && processed.key === filter
        ? processed.uri
        : currentUri;

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: 12 + insets.top }]}>
        <Pressable hitSlop={12} onPress={onCancel} style={styles.topBtn}>
          <Text style={styles.topBtnText}>{t('cancel')}</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>
          {title}
        </Text>
        <Pressable hitSlop={12} onPress={handleSave} style={styles.topBtn} disabled={saving || !currentUri}>
          <Text style={[styles.topBtnText, styles.saveText]}>
            {saving ? t('savingLabel') : t('save')}
          </Text>
        </Pressable>
      </View>

      <View style={styles.previewArea}>
        <ScrollView
          style={styles.previewScroll}
          contentContainerStyle={styles.previewScrollContent}
          maximumZoomScale={4}
          minimumZoomScale={1}
          pinchGestureEnabled
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          {previewUri ? (
            <Image
              source={{ uri: previewUri }}
              style={styles.preview}
              resizeMode="contain"
            />
          ) : (
            <ActivityIndicator color="#fff" />
          )}
        </ScrollView>
        {((processing && filter !== 'original') || saving) && (
          <View style={styles.overlay}>
            <ActivityIndicator color="#fff" />
            <Text style={styles.overlayText}>
              {saving ? t('savingEllipsis') : t('processingEllipsis')}
            </Text>
          </View>
        )}
        {error && <Text style={styles.error}>{error}</Text>}
      </View>

      <View style={[styles.toolbar, { paddingBottom: 18 + insets.bottom }]}>
        <View style={styles.rotateRow}>
          <Pressable style={styles.rotateBtn} onPress={() => handleRotate(270)}>
            <Text style={styles.rotateText}>↺ {t('leftShort')}</Text>
          </Pressable>
          <Pressable style={styles.rotateBtn} onPress={() => handleRotate(90)}>
            <Text style={styles.rotateText}>↻ {t('rightShort')}</Text>
          </Pressable>
        </View>

        <Text style={styles.filterLabel}>{t('filter')}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
        >
          {SCAN_FILTERS.map((key) => {
            const active = key === filter;
            return (
              <Pressable
                key={key}
                onPress={() => handleSelectFilter(key)}
                style={[styles.filterChip, active && styles.filterChipActive]}
              >
                <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                  {filterLabel(key)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {showPageTools && (
          <>
            <Text style={styles.filterLabel}>{t('pageTools')}</Text>
            <View style={styles.pageToolRow}>
              <Pressable
                style={styles.pageToolBtn}
                onPress={() =>
                  Alert.alert(t('cropReservedTitle'), t('cropReservedBody'))
                }
              >
                <Text style={styles.pageToolText}>✂ {t('crop')}</Text>
              </Pressable>
              <Pressable
                style={styles.pageToolBtn}
                onPress={() =>
                  Alert.alert(
                    t('annotateReservedTitle'),
                    t('annotateReservedBody'),
                  )
                }
              >
                <Text style={styles.pageToolText}>✎ {t('annotate')}</Text>
              </Pressable>
              <Pressable style={styles.pageToolBtn} onPress={handleResetOriginal}>
                <Text style={styles.pageToolText}>
                  ↺ {t('resetToOriginal')}
                </Text>
              </Pressable>
            </View>
            <Text style={styles.pageToolHint}>
              {t('saveThenRegenerate')}
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.ink },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 52,
    paddingBottom: 12,
  },
  topBtn: { minWidth: 52 },
  topBtnText: { color: '#c9ced8', fontSize: 15 },
  saveText: { color: '#6ea0ff', fontWeight: '700', textAlign: 'right' },
  topTitle: { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1, textAlign: 'center' },
  previewArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  previewScroll: { width: '100%', height: '100%' },
  previewScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  preview: { width: '100%', height: '100%' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlayText: { color: '#fff', marginTop: 10, fontSize: 13 },
  error: {
    position: 'absolute',
    bottom: 12,
    color: '#ff9a9a',
    fontSize: 13,
  },
  toolbar: {
    backgroundColor: '#141821',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 30,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  rotateRow: { flexDirection: 'row', gap: 12 },
  rotateBtn: {
    backgroundColor: '#232838',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  rotateText: { color: '#dfe4ee', fontSize: 13, fontWeight: '600' },
  filterLabel: { color: '#7f8698', fontSize: 12, marginTop: 16, marginBottom: 10 },
  filterRow: { gap: 10, paddingRight: 8 },
  filterChip: {
    paddingVertical: 9,
    paddingHorizontal: 20,
    borderRadius: 20,
    backgroundColor: '#232838',
  },
  filterChipActive: { backgroundColor: theme.primary },
  filterChipText: { color: '#c9ced8', fontSize: 14, fontWeight: '600' },
  filterChipTextActive: { color: '#fff' },
  pageToolRow: { flexDirection: 'row', gap: 10 },
  pageToolBtn: {
    flex: 1,
    backgroundColor: '#232838',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  pageToolText: { color: '#dfe4ee', fontSize: 13, fontWeight: '600' },
  pageToolHint: { color: '#6f7688', fontSize: 11, marginTop: 10, lineHeight: 16 },
});
