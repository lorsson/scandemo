import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
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
import { SCAN_FILTERS } from '../lib/filters';
import { t, useI18n } from '../lib/i18n';
import { shadow, theme } from '../theme';
import { filterLabel } from '../types';
import type { DocPage, FilterKey, PdfDoc } from '../types';

type Props = {
  doc: PdfDoc;
  onBack: () => void;
  onUpdate: (doc: PdfDoc) => void | Promise<void>;
  /** 打开内置阅读器（有页面时） */
  onRead: () => void;
  /** 打开单页编辑器：增强 / 旋转 / 切边（预留）/ 批注（预留） */
  onEditPage: (pageId: string) => void;
};

type Busy =
  | { kind: 'import'; done: number; total: number }
  | { kind: 'apply'; done: number; total: number }
  | { kind: 'generate'; done: number; total: number }
  | null;


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : t('unknownError');
}

/** 页面改动时间：至少比上一次生成时间晚 1ms，保证 dirty 一定成立 */
function nextUpdatedAt(generatedAt: number | null): number {
  return Math.max(Date.now(), (generatedAt ?? 0) + 1);
}

/** 生成时间：不早于最后一次改动，避免同毫秒内生成后被误判为“待重新生成” */
function nextGeneratedAt(updatedAt: number): number {
  return Math.max(Date.now(), updatedAt);
}

export default function PdfScreen({ doc, onBack, onUpdate, onRead, onEditPage }: Props) {
  const insets = useSafeAreaInsets();
  const { t: tr, tp: trp } = useI18n();
  const [pages, setPages] = useState<DocPage[]>(doc.pages);
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
  const applyPages = (nextPages: DocPage[]) => {
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
    Alert.alert(tr('busyTitle'), tr('busyBody'), [
      { text: tr('keepWaiting'), style: 'cancel' },
      {
        text: tr('discardAndLeave'),
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
        tr('pageLimitTitle'),
        tr('pageLimitPdfBody', { limit: limits.pageLimit }),
      );
      return;
    }

    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(tr('photoPermissionAlertTitle'), tr('photoPermissionAlertBody'));
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
        Alert.alert(tr('importFailedTitle'), errorMessage(error));
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

  const handleRemove = (page: DocPage, index: number) => {
    if (busy) return;
    Alert.alert(tr('removePageTitle'), tr('removePageBody', { n: index + 1 }), [
      { text: tr('cancel'), style: 'cancel' },
      {
        text: tr('remove'),
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
        Alert.alert(tr('applyFailedTitle'), errorMessage(error));
      }
    } finally {
      abortRef.current = null;
      if (changed) applyPages(next);
      setBusy(null);
    }
  };

  const handleApplyAll = () => {
    if (busy || pages.length === 0) return;
    const label = filterLabel(defaultFilter);
    Alert.alert(
      tr('applyAllTitle'),
      defaultFilter === 'original'
        ? tr('applyAllOriginalBody', { count: pages.length })
        : trp('applyAllFilterBody', pages.length, { filter: label }),
      [
        { text: tr('cancel'), style: 'cancel' },
        { text: tr('start'), onPress: () => void runApplyAll() },
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
      Alert.alert(
        tr('pdfCreatedTitle'),
        trp('pdfCreatedBody', pages.length),
      );
    } catch (error) {
      if (!isAbortError(error)) {
        Alert.alert(tr('createFailedTitle'), errorMessage(error));
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
        Alert.alert(tr('shareUnavailableTitle'), tr('shareUnavailableBody'));
        return;
      }
      await Sharing.shareAsync(pdfUri, {
        mimeType: 'application/pdf',
        UTI: 'com.adobe.pdf',
        dialogTitle: doc.title,
      });
    } catch (error) {
      Alert.alert(tr('shareFailedTitle'), errorMessage(error));
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
      ? tr('regeneratePdf')
      : tr('createPdf')
    : tr('sharePdf');

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: insets.top + 10 }]}>
        <Pressable hitSlop={12} onPress={handleBack} style={styles.topBtn}>
          <Text style={styles.topBtnText}>{tr('back')}</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>
          {doc.title}
        </Text>
        <View style={styles.topRight}>
          <Text style={styles.topMeta}>{trp('pageCount', pages.length)}</Text>
          {pages.length > 0 && (
            <Pressable
              hitSlop={8}
              onPress={onRead}
              style={({ pressed }) => [
                styles.readBtn,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.readBtnText}>{tr('read')}</Text>
            </Pressable>
          )}
        </View>
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
              <Text style={styles.filterTitle}>{tr('applyOnImport')}</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filterRow}
              >
                {SCAN_FILTERS.map((key) => {
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
                        {filterLabel(key)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              <Text style={styles.filterHint}>
                {tr('applyOnImportHint')}
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
                      ? tr('restoreAllOriginals')
                      : tr('applyFilterToDocument', {
                          filter: filterLabel(defaultFilter),
                        })}
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
                  ? tr('noPagesAddImages')
                  : dirty
                    ? pdfUri
                      ? tr('pagesOutOfDate')
                      : tr('reorderThenCreate')
                    : tr('pdfUpToDate', { count: pages.length })}
              </Text>
            </View>
            {pages.length > 0 && (
              <Text style={styles.listHint}>
                {tr('reorderHint', { count: pages.length })}
              </Text>
            )}
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyIcon}>📄</Text>
            <Text style={styles.emptyTitle}>{tr('emptyPdfTitle')}</Text>
            <Text style={styles.emptyHint}>
              {tr('emptyPdfHint', { filter: filterLabel(defaultFilter) })}
            </Text>
            <Pressable style={styles.emptyBtn} onPress={handleAdd}>
              <Text style={styles.emptyBtnText}>{tr('selectImages')}</Text>
            </Pressable>
          </View>
        }
        ListFooterComponent={
          pages.length > 0 ? (
            <Text style={styles.footerHint}>
              {tr('pdfFooterHint', {
                memory: limits.totalMB
                  ? tr('memoryHint', {
                      gb: (limits.totalMB / 1024).toFixed(1),
                    })
                  : '',
                limit: limits.pageLimit,
              })}
            </Text>
          ) : undefined
        }
        renderItem={({ item, index }) => (
          <View style={styles.pageCard}>
            <Image source={{ uri: item.thumbUri }} style={styles.thumb} resizeMode="cover" />
            <View style={styles.pageMeta}>
              <Text style={styles.pageTitle}>
                {tr('pageN', { n: index + 1 })}
              </Text>
              <Text style={styles.pageSub}>
                {item.filter === 'original'
                  ? tr('original')
                  : tr('filterMode', { filter: filterLabel(item.filter) })}
                {item.rotation
                  ? ` · ${tr('rotated', { degrees: item.rotation })}`
                  : ''}
              </Text>
            </View>
            <View style={styles.pageActions}>
              <IconButton
                label="↑"
                accessibilityLabel={tr('movePageUp', { n: index + 1 })}
                disabled={index === 0 || !!busy}
                onPress={() => handleMove(index, -1)}
              />
              <IconButton
                label="↓"
                accessibilityLabel={tr('movePageDown', { n: index + 1 })}
                disabled={index === pages.length - 1 || !!busy}
                onPress={() => handleMove(index, 1)}
              />
              <IconButton
                label="✎"
                accessibilityLabel={tr('editPageTitle', { n: index + 1 })}
                tone="crop"
                disabled={!!busy}
                onPress={() => onEditPage(item.id)}
              />
              <IconButton
                label="✕"
                accessibilityLabel={tr('removePageN', { n: index + 1 })}
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
          <Text style={styles.addBtnText}>{tr('addImagesPlus')}</Text>
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
                ? tr('importingImages')
                : busy.kind === 'apply'
                  ? tr('applyingFilter')
                  : tr('creatingPdfTitle')}
            </Text>
            <Text style={styles.overlaySub}>
              {busy.kind === 'generate' && busy.done >= busy.total
                ? tr('layoutWriting')
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
              <Text style={styles.cancelText}>{tr('cancel')}</Text>
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
  topMeta: { color: theme.subtext, fontSize: 13 },
  topRight: {
    minWidth: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  readBtn: {
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.primary,
  },
  readBtnText: { color: theme.primary, fontSize: 12, fontWeight: '700' },
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
    paddingVertical: 8,
    paddingHorizontal: 14,
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
