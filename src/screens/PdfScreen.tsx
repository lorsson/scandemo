import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isAbortError, throwIfAborted } from '../lib/abort';
import { renderPageBase64 } from '../lib/pageRender';
import { generatePdf, pdfProfileFor } from '../lib/pdf';
import {
  getPdfLimits,
  initPdfLimits,
  type PdfLimits,
} from '../lib/pdfLimits';
import {
  deletePdfPageFiles,
  pdfFilePath,
  persistPdfPages,
  savePageEdit,
} from '../lib/pdfStorage';
import { shadow, theme } from '../theme';
import { FILTER_LABELS } from '../types';
import type { FilterKey, PdfDoc, PdfPage } from '../types';

type Props = {
  doc: PdfDoc;
  onBack: () => void;
  onUpdate: (doc: PdfDoc) => void | Promise<void>;
  /** 打开单页编辑器：增强 / 旋转 / 切边（预留）/ 批注（预留） */
  onEditPage: (pageId: string) => void;
};

type Busy =
  | { kind: 'import'; done: number; total: number }
  | { kind: 'apply'; done: number; total: number }
  | { kind: 'generate'; done: number; total: number }
  | null;

const FILTERS: FilterKey[] = ['original', 'enhance', 'gray', 'bw'];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误';
}

/** 页面改动时间：至少比上一次生成时间晚 1ms，保证 dirty 一定成立 */
function nextUpdatedAt(generatedAt: number | null): number {
  return Math.max(Date.now(), (generatedAt ?? 0) + 1);
}

/** 生成时间：不早于最后一次改动，避免同毫秒内生成后被误判为“待重新生成” */
function nextGeneratedAt(updatedAt: number): number {
  return Math.max(Date.now(), updatedAt);
}

export default function PdfScreen({ doc, onBack, onUpdate, onEditPage }: Props) {
  const insets = useSafeAreaInsets();
  const [pages, setPages] = useState<PdfPage[]>(doc.pages);
  const [pdfUri, setPdfUri] = useState<string | null>(doc.uri);
  const [generatedAt, setGeneratedAt] = useState<number | null>(doc.generatedAt);
  const [updatedAt, setUpdatedAt] = useState<number>(doc.updatedAt);
  const [defaultFilter, setDefaultFilter] = useState<FilterKey>(
    doc.defaultFilter ?? 'original',
  );
  const [limits, setLimits] = useState<PdfLimits>(getPdfLimits());
  const [busy, setBusy] = useState<Busy>(null);
  const abortRef = useRef<AbortController | null>(null);

  const dirty = !pdfUri || generatedAt === null || updatedAt > generatedAt;

  // 物理内存只探测一次；init 后补上 Android 的 JVM 堆限制，页数可能下调
  useEffect(() => {
    let alive = true;
    void initPdfLimits().then((next) => {
      if (alive) setLimits(next);
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 页面数组变化：持久化并把 generatedAt 留在原地，使 dirty 为 true */
  const applyPages = (nextPages: PdfPage[]) => {
    const now = nextUpdatedAt(generatedAt);
    setPages(nextPages);
    setUpdatedAt(now);
    void onUpdate({
      ...doc,
      pages: nextPages,
      pageCount: nextPages.length,
      uri: pdfUri,
      generatedAt,
      updatedAt: now,
      defaultFilter,
    });
  };

  /**
   * 选择导入时自动执行的算法。只影响「之后导入」和「应用到全部」，
   * 不改变已有页面，所以不触发 dirty。
   * 空文档不落库（避免首页出现 0 页记录），等第一次导入时一起写入。
   */
  const handleSelectDefault = (key: FilterKey) => {
    if (busy || key === defaultFilter) return;
    setDefaultFilter(key);
    if (pages.length > 0) {
      void onUpdate({
        ...doc,
        pages,
        pageCount: pages.length,
        uri: pdfUri,
        generatedAt,
        updatedAt,
        defaultFilter: key,
      });
    }
  };

  const handleBack = () => {
    if (!busy) {
      onBack();
      return;
    }
    Alert.alert('正在处理', '当前操作还没有完成。', [
      { text: '继续等待', style: 'cancel' },
      {
        text: '取消并返回',
        style: 'destructive',
        onPress: () => {
          abortRef.current?.abort();
          onBack();
        },
      },
    ]);
  };

  const handleAdd = async () => {
    if (busy) return;
    const remaining = limits.pageLimit - pages.length;
    if (remaining <= 0) {
      Alert.alert(
        '已达页数上限',
        `本机单次最多 ${limits.pageLimit} 页。更多页面请拆成多个 PDF。`,
      );
      return;
    }

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('未获得相册权限', '请在系统设置中允许访问相册。');
      return;
    }

    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      orderedSelection: true,
      selectionLimit: remaining,
      quality: 1,
    });
    if (picked.canceled || picked.assets.length === 0) return;

    const uris = picked.assets.slice(0, remaining).map((asset) => asset.uri);
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy({ kind: 'import', done: 0, total: uris.length });

    try {
      const added = await persistPdfPages(
        doc.id,
        uris,
        pdfProfileFor(pages.length + uris.length, limits),
        {
          signal: controller.signal,
          filter: defaultFilter,
          onProgress: (done, total) => setBusy({ kind: 'import', done, total }),
        },
      );
      applyPages([...pages, ...added]);
    } catch (error) {
      if (!isAbortError(error)) {
        Alert.alert('导入失败', errorMessage(error));
      }
    } finally {
      abortRef.current = null;
      setBusy(null);
    }
  };

  const handleMove = (index: number, delta: -1 | 1) => {
    if (busy) return;
    const target = index + delta;
    if (target < 0 || target >= pages.length) return;
    const next = [...pages];
    [next[index], next[target]] = [next[target], next[index]];
    applyPages(next);
  };

  const handleRemove = (page: PdfPage, index: number) => {
    if (busy) return;
    Alert.alert('移除页面', `确定移除第 ${index + 1} 页吗？`, [
      { text: '取消', style: 'cancel' },
      {
        text: '移除',
        style: 'destructive',
        onPress: () => {
          applyPages(pages.filter((item) => item.id !== page.id));
          void deletePdfPageFiles(page);
        },
      },
    ]);
  };

  /**
   * 对全部页面重新执行当前算法。
   *
   * 三种模式互补：导入前选算法 = 自动执行；这个按钮 = 导入后批量补做；
   * 每页的 ✎ = 单页手动覆盖。每页都从 originalUri 重渲染并保留旋转，
   * 所以重复点击不会累积画质损失。中途取消会保留已完成的部分。
   */
  const runApplyAll = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy({ kind: 'apply', done: 0, total: pages.length });

    const next = [...pages];
    let changed = false;

    try {
      for (let i = 0; i < pages.length; i++) {
        throwIfAborted(controller.signal);
        const page = pages[i];
        const edit = { filter: defaultFilter, rotation: page.rotation };
        const base64 = await renderPageBase64(page, edit);
        next[i] = await savePageEdit(doc.id, page, base64, edit, {
          signal: controller.signal,
        });
        changed = true;
        setBusy({ kind: 'apply', done: i + 1, total: pages.length });
      }
    } catch (error) {
      if (!isAbortError(error)) {
        Alert.alert('应用失败', errorMessage(error));
      }
    } finally {
      abortRef.current = null;
      if (changed) applyPages(next);
      setBusy(null);
    }
  };

  const handleApplyAll = () => {
    if (busy || pages.length === 0) return;
    const label = FILTER_LABELS[defaultFilter];
    Alert.alert(
      '应用到全部页面',
      defaultFilter === 'original'
        ? `将把 ${pages.length} 页全部恢复为原图（旋转保留），手动调整会被覆盖。`
        : `将对 ${pages.length} 页执行「${label}」，手动调整过的页面会被覆盖。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '开始', onPress: () => void runApplyAll() },
      ],
    );
  };

  const handleGenerate = async () => {
    if (busy || pages.length === 0) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy({ kind: 'generate', done: 0, total: pages.length });

    try {
      const result = await generatePdf(
        pages.map((page) => page.uri),
        pdfFilePath(doc.id),
        {
          signal: controller.signal,
          onProgress: (done, total) => setBusy({ kind: 'generate', done, total }),
        },
      );
      // 不比对 result.numberOfPages：expo-print 在 Android 上按
      // 1 + contentHeight/pageHeight 估算，排版结果恒定偏小（实测 3 页报 1 页），
      // 与实际写入页数无关。以 pageCount 和打开后的文件为准。
      const generated = nextGeneratedAt(updatedAt);
      setPdfUri(result.uri);
      setGeneratedAt(generated);
      void onUpdate({
        ...doc,
        pages,
        pageCount: pages.length,
        uri: result.uri,
        generatedAt: generated,
        updatedAt,
      });
      Alert.alert('PDF 已生成', `${pages.length} 页，可点击「分享 PDF」导出。`);
    } catch (error) {
      if (!isAbortError(error)) {
        Alert.alert('生成失败', errorMessage(error));
      }
    } finally {
      abortRef.current = null;
      setBusy(null);
    }
  };

  const handleShare = async () => {
    if (!pdfUri || dirty || busy) return;
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert('无法分享', '当前设备不支持系统分享。');
        return;
      }
      await Sharing.shareAsync(pdfUri, {
        mimeType: 'application/pdf',
        UTI: 'com.adobe.pdf',
        dialogTitle: doc.title,
      });
    } catch (error) {
      Alert.alert('分享失败', errorMessage(error));
    }
  };

  const handlePrimary = () => {
    if (dirty) {
      void handleGenerate();
    } else {
      void handleShare();
    }
  };

  const primaryLabel = dirty
    ? pdfUri
      ? '重新生成 PDF'
      : '生成 PDF'
    : '分享 PDF';

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <Pressable hitSlop={12} onPress={handleBack} style={styles.topBtn}>
          <Text style={styles.topBtnText}>返回</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>
          {doc.title}
        </Text>
        <Text style={styles.topMeta}>{pages.length} 页</Text>
      </View>

      <FlatList
        data={pages}
        keyExtractor={(page) => page.id}
        contentContainerStyle={styles.listContent}
        initialNumToRender={8}
        windowSize={5}
        removeClippedSubviews={Platform.OS === 'android'}
        ListHeaderComponent={
          <View>
            <View style={styles.filterCard}>
              <Text style={styles.filterTitle}>导入时自动执行</Text>
              <View style={styles.filterRow}>
                {FILTERS.map((key) => {
                  const active = defaultFilter === key;
                  return (
                    <Pressable
                      key={key}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                      disabled={!!busy}
                      onPress={() => handleSelectDefault(key)}
                      style={({ pressed }) => [
                        styles.chip,
                        active && styles.chipActive,
                        pressed && !active && styles.pressed,
                        !!busy && styles.disabled,
                      ]}
                    >
                      <Text
                        style={[styles.chipText, active && styles.chipTextActive]}
                      >
                        {FILTER_LABELS[key]}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <Text style={styles.filterHint}>
                新导入的图片会自动套用该算法；单页仍可点 ✎ 单独调整。
              </Text>
              {pages.length > 0 && (
                <Pressable
                  accessibilityRole="button"
                  disabled={!!busy}
                  onPress={handleApplyAll}
                  style={({ pressed }) => [
                    styles.applyAllBtn,
                    pressed && !busy && styles.pressed,
                    !!busy && styles.disabled,
                  ]}
                >
                  <Text style={styles.applyAllText}>
                    {defaultFilter === 'original'
                      ? '↺ 全部恢复原图'
                      : `对整个文档执行「${FILTER_LABELS[defaultFilter]}」`}
                  </Text>
                </Pressable>
              )}
            </View>

            <View
              style={[
                styles.banner,
                dirty ? styles.bannerWarn : styles.bannerOk,
              ]}
            >
              <Text
                style={[
                  styles.bannerText,
                  dirty ? styles.bannerWarnText : styles.bannerOkText,
                ]}
              >
                {pages.length === 0
                  ? '还没有页面，先添加图片。'
                  : dirty
                    ? pdfUri
                      ? '页面已调整，当前 PDF 是旧版本；分享前请重新生成。'
                      : '按 ↑ ↓ 调整顺序，然后生成 PDF。'
                    : `PDF 已生成 · ${pages.length} 页`}
              </Text>
            </View>
            {pages.length > 0 && (
              <Text style={styles.listHint}>共 {pages.length} 页 · 可上下调整顺序</Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📄</Text>
            <Text style={styles.emptyTitle}>把照片变成 PDF</Text>
            <Text style={styles.emptyHint}>
              支持多选、调整顺序。导入时会自动执行上方选中的算法
              （当前：{FILTER_LABELS[defaultFilter]}），之后仍可单页调整。
            </Text>
            <Pressable style={styles.emptyBtn} onPress={handleAdd}>
              <Text style={styles.emptyBtnText}>选择图片</Text>
            </Pressable>
          </View>
        }
        ListFooterComponent={
          pages.length > 0 ? (
            <Text style={styles.footerHint}>
              点 ✎ 可对单页做增强 / 旋转（切边、批注为预留接口）。
              {limits.totalMB
                ? `本机内存约 ${(limits.totalMB / 1024).toFixed(1)} GB，`
                : ''}
              单次最多 {limits.pageLimit} 页；页数越多，单页会自动压缩
              （≤8 页 1800px · ≤25 页 1500px · 更多 1200px，低内存机型再降一档）。
            </Text>
          ) : undefined
        }
        renderItem={({ item, index }) => (
          <View style={styles.pageCard}>
            <Image source={{ uri: item.thumbUri }} style={styles.thumb} resizeMode="cover" />
            <View style={styles.pageMeta}>
              <Text style={styles.pageTitle}>第 {index + 1} 页</Text>
              <Text style={styles.pageSub}>
                {item.filter === 'original'
                  ? '原图'
                  : `${FILTER_LABELS[item.filter]}模式`}
                {item.rotation ? ` · 旋转 ${item.rotation}°` : ''}
              </Text>
            </View>
            <View style={styles.pageActions}>
              <IconButton
                label="↑"
                accessibilityLabel={`第 ${index + 1} 页上移`}
                disabled={index === 0 || !!busy}
                onPress={() => handleMove(index, -1)}
              />
              <IconButton
                label="↓"
                accessibilityLabel={`第 ${index + 1} 页下移`}
                disabled={index === pages.length - 1 || !!busy}
                onPress={() => handleMove(index, 1)}
              />
              <IconButton
                label="✎"
                accessibilityLabel={`编辑第 ${index + 1} 页`}
                tone="crop"
                disabled={!!busy}
                onPress={() => onEditPage(item.id)}
              />
              <IconButton
                label="✕"
                accessibilityLabel={`移除第 ${index + 1} 页`}
                tone="danger"
                disabled={!!busy}
                onPress={() => handleRemove(item, index)}
              />
            </View>
          </View>
        )}
      />

      <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          style={({ pressed }) => [
            styles.addBtn,
            pressed && styles.pressed,
            (!!busy || pages.length >= limits.pageLimit) && styles.disabled,
          ]}
          onPress={handleAdd}
          disabled={!!busy || pages.length >= limits.pageLimit}
        >
          <Text style={styles.addBtnText}>＋ 添加图片</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.primaryBtn,
            pressed && styles.pressed,
            (!!busy || pages.length === 0) && styles.disabled,
          ]}
          onPress={handlePrimary}
          disabled={!!busy || pages.length === 0}
        >
          <Text style={styles.primaryBtnText}>{primaryLabel}</Text>
        </Pressable>
      </View>

      {busy && (
        <View style={styles.overlay}>
          <View style={styles.overlayCard}>
            <ActivityIndicator size="large" color={theme.primary} />
            <Text style={styles.overlayTitle}>
              {busy.kind === 'import'
                ? '正在导入图片'
                : busy.kind === 'apply'
                  ? '正在应用算法'
                  : '正在生成 PDF'}
            </Text>
            <Text style={styles.overlaySub}>
              {busy.kind === 'generate' && busy.done >= busy.total
                ? '正在排版输出…'
                : `${busy.done} / ${busy.total}`}
            </Text>
            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${Math.round((busy.done / Math.max(1, busy.total)) * 100)}%`,
                  },
                ]}
              />
            </View>
            <Pressable
              hitSlop={10}
              onPress={() => abortRef.current?.abort()}
              style={styles.cancelBtn}
            >
              <Text style={styles.cancelText}>取消</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function IconButton({
  label,
  accessibilityLabel,
  onPress,
  disabled,
  tone,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'crop' | 'danger';
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={4}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.iconBtn,
        tone === 'crop' && styles.iconBtnCrop,
        tone === 'danger' && styles.iconBtnDanger,
        disabled && styles.iconBtnDisabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text
        style={[
          styles.iconText,
          tone === 'crop' && styles.iconTextCrop,
          tone === 'danger' && styles.iconTextDanger,
        ]}
      >
        {label}
      </Text>
    </Pressable>
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
  topBtn: { minWidth: 48 },
  topBtnText: { color: theme.text, fontSize: 15 },
  topTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '700',
    color: theme.text,
    paddingHorizontal: 8,
  },
  topMeta: { minWidth: 48, textAlign: 'right', color: theme.subtext, fontSize: 13 },
  listContent: { padding: 16, paddingBottom: 28 },
  filterCard: {
    backgroundColor: theme.surface,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    ...shadow,
  },
  filterTitle: { fontSize: 13, fontWeight: '700', color: theme.text },
  filterRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  chip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.border,
    alignItems: 'center',
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { fontSize: 13, fontWeight: '600', color: theme.text },
  chipTextActive: { color: '#fff' },
  filterHint: {
    fontSize: 11,
    color: theme.subtext,
    lineHeight: 16,
    marginTop: 10,
  },
  applyAllBtn: {
    marginTop: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.primary,
    paddingVertical: 9,
    alignItems: 'center',
  },
  applyAllText: { color: theme.primary, fontSize: 12, fontWeight: '700' },
  banner: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bannerWarn: { backgroundColor: '#fff6e6' },
  bannerOk: { backgroundColor: '#e9f7f0' },
  bannerText: { fontSize: 12, lineHeight: 18 },
  bannerWarnText: { color: '#8a5a00' },
  bannerOkText: { color: '#176b4a' },
  listHint: { fontSize: 12, color: theme.subtext, marginTop: 14, marginBottom: 10 },
  pageCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderRadius: 14,
    padding: 10,
    marginBottom: 10,
    ...shadow,
  },
  thumb: {
    width: 54,
    height: 72,
    borderRadius: 8,
    backgroundColor: theme.surfaceAlt,
  },
  pageMeta: { flex: 1, marginLeft: 12, marginRight: 8 },
  pageTitle: { fontSize: 14, fontWeight: '700', color: theme.text },
  pageSub: { fontSize: 11, color: theme.subtext, marginTop: 5 },
  pageActions: { flexDirection: 'row', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' },
  iconBtn: {
    width: 30,
    height: 30,
    borderRadius: 9,
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBtnCrop: { backgroundColor: '#eaf0ff' },
  iconBtnDanger: { backgroundColor: '#fdeeee' },
  iconBtnDisabled: { opacity: 0.35 },
  iconText: { color: theme.text, fontSize: 15, fontWeight: '700' },
  iconTextCrop: { color: theme.primary, fontSize: 13 },
  iconTextDanger: { color: theme.danger, fontSize: 13 },
  empty: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    paddingVertical: 40,
    paddingHorizontal: 24,
    alignItems: 'center',
    ...shadow,
  },
  emptyIcon: { fontSize: 40, marginBottom: 10 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: theme.text },
  emptyHint: {
    fontSize: 12,
    color: theme.subtext,
    textAlign: 'center',
    lineHeight: 19,
    marginTop: 8,
  },
  emptyBtn: {
    marginTop: 18,
    backgroundColor: theme.primary,
    borderRadius: 10,
    paddingHorizontal: 22,
    paddingVertical: 11,
  },
  emptyBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  footerHint: {
    fontSize: 11,
    color: theme.subtext,
    lineHeight: 17,
    marginTop: 8,
    paddingHorizontal: 2,
  },
  bottomBar: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: theme.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
  },
  addBtn: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.border,
    paddingVertical: 13,
    alignItems: 'center',
  },
  addBtnText: { color: theme.text, fontWeight: '700', fontSize: 14 },
  primaryBtn: {
    flex: 1.2,
    borderRadius: 12,
    backgroundColor: theme.primary,
    paddingVertical: 13,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.45 },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(11, 13, 18, 0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },
  overlayCard: {
    width: 270,
    borderRadius: 16,
    backgroundColor: theme.surface,
    padding: 22,
    alignItems: 'center',
    ...shadow,
  },
  overlayTitle: { fontSize: 16, fontWeight: '700', color: theme.text, marginTop: 14 },
  overlaySub: { fontSize: 12, color: theme.subtext, marginTop: 6 },
  progressTrack: {
    width: '100%',
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.surfaceAlt,
    marginTop: 14,
    overflow: 'hidden',
  },
  progressFill: { height: 4, borderRadius: 2, backgroundColor: theme.primary },
  cancelBtn: { marginTop: 16, paddingHorizontal: 18, paddingVertical: 6 },
  cancelText: { color: theme.subtext, fontSize: 13, fontWeight: '600' },
});
