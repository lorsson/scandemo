import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type ScrollViewInstance,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import CameraScreen from './CameraScreen';
import PhotoPickerScreen from './PhotoPickerScreen';
import CropOverlay from '../components/CropOverlay';
import OcrBoxOverlay from '../components/OcrBoxOverlay';
import { isAbortError } from '../lib/abort';
import {
  FULL_QUAD,
  cloneQuad,
  isQuadConvex,
  isUsableQuad,
  quadToArray,
} from '../lib/crop';
import { getDetectionServerUrl } from '../lib/detectionConfig';
import {
  detectDocumentQuad,
  isEdgeDetectionAvailable,
} from '../lib/documentDetection';
import { useI18n } from '../lib/i18n';
import { warpPerspective } from '../lib/imagePipeline';
import {
  documentText,
  isLineEdited,
  isLowConfidence,
  ocrId,
  type OcrLine,
  type OcrPage,
} from '../lib/ocr';
import { recognizeOnServer } from '../lib/ocrServer';
import {
  importOcrPage,
  removeOcrSession,
  replaceOcrPage,
  writeOcrText,
} from '../lib/ocrStorage';
import { theme } from '../theme';
import type { DocumentQuad } from '../types';

/**
 * 文字识别（OCR）。
 *
 * 流程与扫描编辑器一致：拍照/导入 → 自动切边（端侧 DocCornerNet）→
 * 逐页识别 → 「上图下文」对照编辑。
 *
 * 推理当前在服务端（demo.py 的 /api/ocr，PaddleOCR PP-OCRv4），
 * 数据契约是归一化文本框，之后换成端侧 ONNX 时这一层不用改。
 */

type Props = {
  /** 从扫描编辑器进来：图已经处理好了，直接识别，不再走导入/切边 */
  initialUris?: string[];
  /** 导入后立刻识别 */
  autoStart?: boolean;
  /** 导入后自动切边；从编辑器的成品页进来时关掉，避免二次裁切 */
  autoCrop?: boolean;
  initialTitle?: string;
  onClose: () => void;
};

type Mode = 'collect' | 'results' | 'crop';

type Busy =
  | { kind: 'import'; done: number; total: number }
  | { kind: 'detect'; done: number; total: number }
  | { kind: 'recognize'; done: number; total: number }
  | { kind: 'crop' }
  | null;

/** 裁剪时图片四周留白：与扫描编辑器一致，贴边手柄也能按到 */
const CROP_INSET = 22;

export default function OcrScreen({
  initialUris,
  autoStart = false,
  autoCrop = true,
  initialTitle,
  onClose,
}: Props) {
  const insets = useSafeAreaInsets();
  const { t, tp } = useI18n();

  // 会话目录：页面图都在这里，离开时整目录删掉（结果不持久化）
  const [sessionId] = useState(() => ocrId('ocr'));

  const [pages, setPages] = useState<OcrPage[]>([]);
  const pagesRef = useRef<OcrPage[]>([]);
  const [mode, setMode] = useState<Mode>('collect');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title] = useState(initialTitle ?? '');
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // 裁剪
  const [cropPageId, setCropPageId] = useState<string | null>(null);
  const [cropQuad, setCropQuad] = useState<DocumentQuad>(FULL_QUAD);
  const [cropSize, setCropSize] = useState({ width: 0, height: 0 });
  const [cropStage, setCropStage] = useState({ width: 0, height: 0 });
  const [resultStage, setResultStage] = useState({ width: 0, height: 0 });

  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);
  const runningRef = useRef(false);

  const commit = useCallback((next: OcrPage[]) => {
    pagesRef.current = next;
    setPages(next);
  }, []);

  const updatePage = useCallback(
    (id: string, updater: (page: OcrPage) => OcrPage) => {
      commit(pagesRef.current.map((page) => (page.id === id ? updater(page) : page)));
    },
    [commit],
  );

  // 离开时中止在途请求并清掉本次会话的图片
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      void removeOcrSession(sessionId);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 1800);
    return () => clearTimeout(timer);
  }, [notice]);

  // 安卓返回键逐层退出：相机/相册 → 裁剪 → 结果 → 关闭
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // 识别/导入进行中不让退出：文件正在被读写
      if (busy) return true;
      if (cameraOpen) {
        setCameraOpen(false);
        return true;
      }
      if (pickerOpen) {
        setPickerOpen(false);
        return true;
      }
      if (mode === 'crop') {
        setMode('collect');
        setCropPageId(null);
        return true;
      }
      if (mode === 'results' && !initialUris?.length) {
        setMode('collect');
        return true;
      }
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [busy, cameraOpen, initialUris, mode, onClose, pickerOpen]);

  const activePage =
    pages.find((page) => page.id === activeId) ?? pages[0] ?? null;
  const activeIndex = activePage
    ? pages.findIndex((page) => page.id === activePage.id)
    : -1;

  /**
   * 自动切边：端侧 DocCornerNet 找四角后直接拉正。
   * 单页失败保留原图，用户还能手动裁剪，不影响其余页。
   */
  const autoCropPages = useCallback(
    async (targets: OcrPage[]) => {
      if (!isEdgeDetectionAvailable() || targets.length === 0) return;
      for (let index = 0; index < targets.length; index += 1) {
        const page = targets[index];
        setBusy({ kind: 'detect', done: index, total: targets.length });
        try {
          const detection = await detectDocumentQuad(page.uri);
          if (!detection || !isUsableQuad(detection.quad)) continue;
          const warped = await warpPerspective(page.uri, quadToArray(detection.quad));
          try {
            const next = await replaceOcrPage(warped, sessionId, page.slot);
            updatePage(page.id, (current) => ({
              ...current,
              uri: next.uri,
              width: next.width,
              height: next.height,
            }));
          } finally {
            await FileSystem.deleteAsync(warped, { idempotent: true }).catch(
              () => {},
            );
          }
        } catch (error) {
          console.warn('[ocr] auto crop failed:', error);
        }
      }
      setBusy(null);
    },
    [sessionId, updatePage],
  );

  /** 识别所有还没识别的页（含失败重试） */
  const recognizeAll = useCallback(
    async (force = false) => {
      if (runningRef.current) return;
      const targets = pagesRef.current.filter(
        (page) => force || page.status !== 'done',
      );
      if (targets.length === 0) {
        setMode('results');
        return;
      }
      const baseUrl = await getDetectionServerUrl();
      if (!baseUrl) {
        Alert.alert(t('ocrNeedsServerTitle'), t('ocrNeedsServerBody'));
        return;
      }

      runningRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      setMode('results');
      if (!activeId) setActiveId(pagesRef.current[0]?.id ?? null);
      const startActiveId = activeId;

      let failed = 0;
      try {
        for (let index = 0; index < targets.length; index += 1) {
          if (controller.signal.aborted) break;
          const page = targets[index];
          setBusy({ kind: 'recognize', done: index, total: targets.length });
          updatePage(page.id, (current) => ({
            ...current,
            status: 'running',
            error: undefined,
          }));
          try {
            const lines = await recognizeOnServer(page.uri, baseUrl, {
              signal: controller.signal,
            });
            updatePage(page.id, (current) => ({
              ...current,
              status: 'done',
              lines,
              error: undefined,
            }));
          } catch (error) {
            if (isAbortError(error)) break;
            failed += 1;
            updatePage(page.id, (current) => ({
              ...current,
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            }));
          }
        }
      } finally {
        setBusy(null);
        abortRef.current = null;
        runningRef.current = false;
      }

      if (controller.signal.aborted) return;
      // 当前页没文字、别的页有：自动跳过去，省一次手动翻页
      const currentHasLines = pagesRef.current.find(
        (page) => page.id === startActiveId,
      )?.lines.length;
      if (!currentHasLines) {
        const firstWithLines = pagesRef.current.find(
          (page) => page.lines.length > 0,
        );
        if (firstWithLines) setActiveId(firstWithLines.id);
      }
      if (failed > 0) {
        Alert.alert(t('ocrFailedTitle'), tp('ocrFailedBody', failed));
      }
    },
    [activeId, t, tp, updatePage],
  );

  const addImages = useCallback(
    async (uris: string[], startNow = false, detectEdges = true) => {
      if (!uris.length || runningRef.current) return;
      runningRef.current = true;
      const added: OcrPage[] = [];
      try {
        // 用最大序号往后排，删过页再添加也不会覆盖还在用的 page-<slot>.jpg
        const base = pagesRef.current.reduce(
          (max, page) => Math.max(max, page.slot),
          0,
        );
        setBusy({ kind: 'import', done: 0, total: uris.length });
        try {
          for (let index = 0; index < uris.length; index += 1) {
            const slot = base + index + 1;
            const imported = await importOcrPage(uris[index], sessionId, slot);
            added.push({
              id: ocrId('page'),
              slot,
              uri: imported.uri,
              width: imported.width,
              height: imported.height,
              status: 'pending',
              lines: [],
            });
            setBusy({ kind: 'import', done: index + 1, total: uris.length });
          }
        } catch (error) {
          console.warn('[ocr] import failed', error);
          Alert.alert(
            t('ocrImportFailedTitle'),
            error instanceof Error ? error.message : t('unknownError'),
          );
        } finally {
          setBusy(null);
        }
        if (added.length === 0) return;

        commit([...pagesRef.current, ...added]);
        if (!activeId) setActiveId(added[0].id);

        if (detectEdges) await autoCropPages(added);
      } finally {
        runningRef.current = false;
      }
      // 先释放锁再识别：recognizeAll 自己也用同一个锁
      if (startNow) await recognizeAll();
    },
    [activeId, autoCropPages, commit, recognizeAll, sessionId, t],
  );

  // 从扫描编辑器进来：页面图已经处理过，直接识别一次。
  // 延后一拍再调用：addImages 会立刻 setBusy，在 effect 里同步 setState 会多渲染一轮。
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!initialUris?.length) return;
    const timer = setTimeout(() => {
      void addImages(initialUris, autoStart, autoCrop);
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 打开裁剪：默认整图，随后用端侧检测预填一次四角 */
  const openCrop = useCallback(
    (page: OcrPage) => {
      setCropPageId(page.id);
      setCropQuad(FULL_QUAD);
      setCropSize({ width: page.width, height: page.height });
      setMode('crop');
      if (!isEdgeDetectionAvailable()) return;
      void (async () => {
        try {
          const detection = await detectDocumentQuad(page.uri);
          if (detection && isUsableQuad(detection.quad)) {
            setCropQuad((current) =>
              // 用户已经开始拖动了就别覆盖
              isQuadConvex(current) && quadToArray(current).join() !== quadToArray(FULL_QUAD).join()
                ? current
                : cloneQuad(detection.quad),
            );
          }
        } catch {
          // 检测失败就保持整图，用户手动拖
        }
      })();
    },
    [],
  );

  const confirmCrop = useCallback(async () => {
    const page = pagesRef.current.find((item) => item.id === cropPageId);
    if (!page) {
      setMode('collect');
      return;
    }
    setBusy({ kind: 'crop' });
    try {
      const warped = await warpPerspective(page.uri, quadToArray(cropQuad));
      try {
        const next = await replaceOcrPage(warped, sessionId, page.slot);
        updatePage(page.id, (current) => ({
          ...current,
          uri: next.uri,
          width: next.width,
          height: next.height,
          // 画面变了，之前的识别结果作废
          status: 'pending',
          lines: [],
          error: undefined,
        }));
        setSelectedLineId(null);
      } finally {
        await FileSystem.deleteAsync(warped, { idempotent: true }).catch(
          () => {},
        );
      }
      // 其他页已有识别结果时，裁剪完回结果页更顺手
      const hasResults = pagesRef.current.some((item) => item.lines.length > 0);
      setMode(hasResults ? 'results' : 'collect');
    } catch (error) {
      Alert.alert(
        t('ocrCropFailedTitle'),
        error instanceof Error ? error.message : t('unknownError'),
      );
    } finally {
      setBusy(null);
      setCropPageId(null);
    }
  }, [cropPageId, cropQuad, sessionId, t, updatePage]);

  const removePage = useCallback(
    (page: OcrPage) => {
      Alert.alert(t('ocrDeletePageTitle'), t('ocrDeletePageBody'), [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('delete'),
          style: 'destructive',
          onPress: () => {
            commit(pagesRef.current.filter((item) => item.id !== page.id));
            if (activeId === page.id) setActiveId(null);
            if (pagesRef.current.length === 0) setMode('collect');
          },
        },
      ]);
    },
    [activeId, commit, t],
  );

  const updateLineText = useCallback(
    (lineId: string, text: string) => {
      if (!activePage) return;
      updatePage(activePage.id, (page) => ({
        ...page,
        lines: page.lines.map((line) =>
          line.id === lineId ? { ...line, text } : line,
        ),
      }));
    },
    [activePage, updatePage],
  );

  const revertLine = useCallback(
    (lineId: string) => {
      if (!activePage) return;
      updatePage(activePage.id, (page) => ({
        ...page,
        lines: page.lines.map((line) =>
          line.id === lineId ? { ...line, text: line.originalText } : line,
        ),
      }));
    },
    [activePage, updatePage],
  );

  // —— 列表滚动联动 ——
  const listRef = useRef<ScrollViewInstance>(null);
  const rowOffsets = useRef<Record<string, number>>({});

  const focusLine = useCallback((lineId: string) => {
    setSelectedLineId(lineId);
    const y = rowOffsets.current[lineId];
    if (y !== undefined) {
      listRef.current?.scrollTo({ y: Math.max(0, y - 12), animated: true });
    }
  }, []);

  const handleCopy = useCallback(async () => {
    const text = documentText(pagesRef.current);
    if (!text.trim()) {
      setNotice(t('ocrNoText'));
      return;
    }
    await Clipboard.setStringAsync(text);
    setNotice(t('ocrCopied'));
  }, [t]);

  const handleExport = useCallback(async () => {
    const text = documentText(pagesRef.current);
    if (!text.trim()) {
      setNotice(t('ocrNoText'));
      return;
    }
    const stamp = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const name =
      title.trim() ||
      `${t('ocrDefaultTitle')} ${pad(stamp.getMonth() + 1)}-${pad(
        stamp.getDate(),
      )} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
    try {
      const path = await writeOcrText(name, text);
      const canShare = await Sharing.isAvailableAsync();
      Alert.alert(t('ocrExportedTitle'), path.replace(/^file:\/\//, ''), [
        { text: t('done'), style: 'cancel' },
        ...(canShare
          ? [
              {
                text: t('share'),
                onPress: () => {
                  void Sharing.shareAsync(path).catch(() => {});
                },
              },
            ]
          : []),
      ]);
    } catch (error) {
      Alert.alert(
        t('ocrExportFailedTitle'),
        error instanceof Error ? error.message : t('unknownError'),
      );
    }
  }, [t, title]);

  const busyText = (() => {
    if (!busy) return '';
    switch (busy.kind) {
      case 'import':
        return t('ocrImporting', { done: busy.done, total: busy.total });
      case 'detect':
        return t('ocrDetecting');
      case 'recognize':
        return busy.total > 1
          ? t('ocrRecognizing', { done: busy.done, total: busy.total })
          : t('ocrRecognizingOne');
      case 'crop':
        return t('ocrCropping');
      default:
        return '';
    }
  })();

  /** 图片按 contain 摆放后的实际矩形（叠加层和裁剪框都按它定位） */
  const imageRect = useMemo(() => {
    if (!activePage || !resultStage.width || !resultStage.height) return null;
    const scale = Math.min(
      resultStage.width / activePage.width,
      resultStage.height / activePage.height,
    );
    const width = activePage.width * scale;
    const height = activePage.height * scale;
    return {
      x: (resultStage.width - width) / 2,
      y: (resultStage.height - height) / 2,
      width,
      height,
    };
  }, [activePage, resultStage]);

  const cropRect = useMemo(() => {
    if (!cropSize.width || !cropSize.height || !cropStage.width) return null;
    const availW = Math.max(1, cropStage.width - CROP_INSET * 2);
    const availH = Math.max(1, cropStage.height - CROP_INSET * 2);
    const scale = Math.min(availW / cropSize.width, availH / cropSize.height);
    const width = cropSize.width * scale;
    const height = cropSize.height * scale;
    return {
      x: (cropStage.width - width) / 2,
      y: (cropStage.height - height) / 2,
      width,
      height,
    };
  }, [cropSize, cropStage]);

  const lowConfidenceIds = useMemo(() => {
    const ids = new Set<string>();
    activePage?.lines.forEach((line) => {
      if (isLowConfidence(line)) ids.add(line.id);
    });
    return ids;
  }, [activePage]);

  const cropPage = pages.find((page) => page.id === cropPageId) ?? null;

  /* ------------------------------- 裁剪 ------------------------------- */
  if (mode === 'crop' && cropPage) {
    return (
      <View style={styles.root}>
        <View style={[styles.topBar, { paddingTop: 12 + insets.top }]}>
          <Pressable
            hitSlop={12}
            onPress={() => {
              setMode('collect');
              setCropPageId(null);
            }}
            style={styles.topBtn}
          >
            <Text style={styles.topBtnText}>{t('cancel')}</Text>
          </Pressable>
          <Text style={styles.topTitle}>{t('crop')}</Text>
          <Pressable
            hitSlop={12}
            onPress={() => void confirmCrop()}
            disabled={busy !== null || !isQuadConvex(cropQuad)}
            style={styles.topBtn}
          >
            <Text
              style={[
                styles.topBtnText,
                styles.topPrimary,
                (busy !== null || !isQuadConvex(cropQuad)) && styles.disabledText,
              ]}
            >
              {t('done')}
            </Text>
          </Pressable>
        </View>

        <View
          style={styles.cropStage}
          onLayout={(event: LayoutChangeEvent) => {
            const { width, height } = event.nativeEvent.layout;
            setCropStage({ width, height });
          }}
        >
          {cropRect && (
            <>
              <Image
                source={{ uri: cropPage.uri }}
                style={[
                  styles.cropImage,
                  {
                    left: cropRect.x,
                    top: cropRect.y,
                    width: cropRect.width,
                    height: cropRect.height,
                  },
                ]}
                resizeMode="contain"
              />
              <View
                style={[
                  styles.cropBox,
                  {
                    left: cropRect.x - 12,
                    top: cropRect.y - 12,
                    width: cropRect.width + 24,
                    height: cropRect.height + 24,
                  },
                ]}
              >
                <CropOverlay
                  width={cropRect.width}
                  height={cropRect.height}
                  inset={12}
                  quad={cropQuad}
                  onChange={setCropQuad}
                />
              </View>
            </>
          )}
        </View>

        <Text style={[styles.cropHint, { paddingBottom: insets.bottom + 14 }]}>
          {t('ocrCropHint')}
        </Text>

        {busy && (
          <View style={styles.overlay}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={styles.overlayText}>{busyText}</Text>
          </View>
        )}
      </View>
    );
  }

  /* ------------------------------- 结果 ------------------------------- */
  if (mode === 'results') {
    const recognizing =
      activePage?.status === 'pending' || activePage?.status === 'running';
    return (
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.topBar, { paddingTop: 12 + insets.top }]}>
          <Pressable
            hitSlop={12}
            // 从编辑器进来只有这一页，返回就是关闭；工具箱流程回图片列表
            onPress={() => (initialUris?.length ? onClose() : setMode('collect'))}
            style={styles.topBtn}
          >
            <Text style={styles.topBtnText}>{t('back')}</Text>
          </Pressable>
          <View style={styles.topCenter}>
            <Text style={styles.topTitle}>{t('ocr')}</Text>
            {pages.length > 1 && (
              <Text style={styles.topSub}>
                {t('pageOfPages', { current: activeIndex + 1, total: pages.length })}
              </Text>
            )}
          </View>
          <View style={styles.topActions}>
            <Pressable
              hitSlop={10}
              onPress={() => void handleCopy()}
              accessibilityLabel={t('ocrCopyAll')}
              style={styles.iconBtn}
            >
              <Ionicons name="copy-outline" size={20} color="#fff" />
            </Pressable>
            <Pressable
              hitSlop={10}
              onPress={() => void handleExport()}
              accessibilityLabel={t('ocrExportTxt')}
              style={styles.iconBtn}
            >
              <Ionicons name="share-outline" size={20} color="#fff" />
            </Pressable>
            <Pressable
              hitSlop={10}
              onPress={() => void recognizeAll(true)}
              disabled={busy !== null}
              accessibilityLabel={t('ocrRecognizeAgain')}
              style={styles.iconBtn}
            >
              <Ionicons
                name="refresh"
                size={20}
                color={busy ? 'rgba(255,255,255,0.35)' : '#fff'}
              />
            </Pressable>
          </View>
        </View>

        <View style={styles.resultBody}>
          {/* 图片 + 文本框 */}
          <View
            style={styles.imagePane}
            onLayout={(event: LayoutChangeEvent) => {
              const { width, height } = event.nativeEvent.layout;
              setResultStage((prev) =>
                prev.width === width && prev.height === height
                  ? prev
                  : { width, height },
              );
            }}
          >
            {activePage ? (
              <View style={StyleSheet.absoluteFill}>
                <Image
                  source={{ uri: activePage.uri }}
                  style={[
                    styles.resultImage,
                    imageRect
                      ? {
                          left: imageRect.x,
                          top: imageRect.y,
                          width: imageRect.width,
                          height: imageRect.height,
                        }
                      : styles.resultImageLoading,
                  ]}
                  resizeMode="contain"
                />
                {activePage.status === 'done' && imageRect && (
                  <View
                    style={[
                      styles.imageBox,
                      {
                        left: imageRect.x,
                        top: imageRect.y,
                        width: imageRect.width,
                        height: imageRect.height,
                      },
                    ]}
                  >
                    <OcrBoxOverlay
                      lines={activePage.lines}
                      selectedId={selectedLineId}
                      lowConfidenceIds={lowConfidenceIds}
                      onSelect={focusLine}
                    />
                  </View>
                )}
                {recognizing && (
                  <View style={styles.imageStatus}>
                    <ActivityIndicator color="#fff" />
                    <Text style={styles.imageStatusText}>
                      {busy?.kind === 'recognize'
                        ? t('ocrRecognizing', busy)
                        : t('ocrRecognizingOne')}
                    </Text>
                  </View>
                )}
                {activePage.status === 'failed' && (
                  <View style={styles.imageStatus}>
                    <Text style={styles.imageStatusText} numberOfLines={3}>
                      {activePage.error ?? t('ocrFailedTitle')}
                    </Text>
                    <Pressable
                      onPress={() => void recognizeAll()}
                      style={styles.retryBtn}
                    >
                      <Text style={styles.retryText}>{t('retry')}</Text>
                    </Pressable>
                  </View>
                )}
                {activePage.status === 'done' && activePage.lines.length === 0 && (
                  <View style={styles.imageStatus}>
                    <Text style={styles.imageStatusText}>{t('ocrNoTextPage')}</Text>
                  </View>
                )}
              </View>
            ) : (
              <View style={styles.imageStatus}>
                <Text style={styles.imageStatusText}>{t('ocrEmptyPages')}</Text>
              </View>
            )}

            {pages.length > 1 && (
              <View style={styles.pager}>
                <Pressable
                  hitSlop={8}
                  disabled={activeIndex <= 0}
                  onPress={() => {
                    const prev = pages[activeIndex - 1];
                    if (prev) {
                      setActiveId(prev.id);
                      setSelectedLineId(null);
                    }
                  }}
                  style={styles.pagerBtn}
                >
                  <Ionicons
                    name="chevron-back"
                    size={18}
                    color={activeIndex <= 0 ? 'rgba(255,255,255,0.3)' : '#fff'}
                  />
                </Pressable>
                <Text style={styles.pagerText}>
                  {t('pageOfPages', {
                    current: activeIndex + 1,
                    total: pages.length,
                  })}
                </Text>
                <Pressable
                  hitSlop={8}
                  disabled={activeIndex < 0 || activeIndex >= pages.length - 1}
                  onPress={() => {
                    const next = pages[activeIndex + 1];
                    if (next) {
                      setActiveId(next.id);
                      setSelectedLineId(null);
                    }
                  }}
                  style={styles.pagerBtn}
                >
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={
                      activeIndex >= pages.length - 1
                        ? 'rgba(255,255,255,0.3)'
                        : '#fff'
                    }
                  />
                </Pressable>
              </View>
            )}
          </View>

          {/* 文本行 */}
          <View style={styles.listPane}>
            {activePage && activePage.lines.length > 0 ? (
              <ScrollView
                ref={listRef}
                style={styles.lineList}
                contentContainerStyle={styles.lineListContent}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
              >
                {activePage.lines.map((line, index) => (
                  <LineRow
                    key={line.id}
                    line={line}
                    index={index}
                    selected={selectedLineId === line.id}
                    onLayout={(y) => {
                      rowOffsets.current[line.id] = y;
                    }}
                    onChangeText={(text) => updateLineText(line.id, text)}
                    onFocus={() => setSelectedLineId(line.id)}
                    onRevert={() => revertLine(line.id)}
                    revertLabel={t('ocrRevert')}
                    editedLabel={t('ocrEdited')}
                    lowLabel={t('ocrLowConfidence')}
                  />
                ))}
              </ScrollView>
            ) : (
              <View style={styles.listEmpty}>
                <Text style={styles.listEmptyTitle}>
                  {busy?.kind === 'recognize' ? busyText : t('ocrResultHint')}
                </Text>
                <Text style={styles.listEmptyHint}>{t('ocrSelectHint')}</Text>
              </View>
            )}
          </View>
        </View>

        <View style={[styles.resultFooter, { paddingBottom: insets.bottom + 10 }]}>
          <Pressable
            onPress={() => void recognizeAll()}
            disabled={busy !== null}
            style={({ pressed }) => [
              styles.footerBtn,
              pressed && styles.pressed,
              busy !== null && styles.disabled,
            ]}
          >
            <Text style={styles.footerBtnText}>{t('ocrRecognize')}</Text>
          </Pressable>
          <Pressable
            onPress={() => void handleExport()}
            style={({ pressed }) => [
              styles.footerBtn,
              styles.footerPrimary,
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.footerBtnText, styles.footerPrimaryText]}>
              {t('ocrExportTxt')}
            </Text>
          </Pressable>
        </View>

        {notice && (
          <View style={[styles.notice, { bottom: insets.bottom + 76 }]}>
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        )}
      </KeyboardAvoidingView>
    );
  }

  /* ------------------------------- 收集 ------------------------------- */
  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: 12 + insets.top }]}>
        <Pressable hitSlop={12} onPress={onClose} style={styles.topBtn}>
          <Text style={styles.topBtnText}>{t('close')}</Text>
        </Pressable>
        <Text style={styles.topTitle}>{t('ocr')}</Text>
        <View style={styles.topBtn} />
      </View>

      <Text style={styles.subtitle}>{t('ocrSubtitle')}</Text>

      <ScrollView
        style={styles.collectScroll}
        contentContainerStyle={styles.collectContent}
      >
        {pages.length === 0 ? (
          <Pressable
            onPress={() => setPickerOpen(true)}
            style={({ pressed }) => [styles.emptyCard, pressed && styles.pressed]}
          >
            <Ionicons name="text-outline" size={34} color={theme.primary} />
            <Text style={styles.emptyTitle}>{t('ocrEmptyPages')}</Text>
            <Text style={styles.emptyHint}>{t('ocrEmptyPagesHint')}</Text>
          </Pressable>
        ) : (
          <View style={styles.cardGrid}>
            {pages.map((page, index) => (
              <View key={page.id} style={styles.card}>
                <Pressable
                  onPress={() => openCrop(page)}
                  style={styles.cardThumbWrap}
                >
                  <Image
                    source={{ uri: page.uri }}
                    style={styles.cardThumb}
                    resizeMode="cover"
                  />
                  <View style={styles.cardIndex}>
                    <Text style={styles.cardIndexText}>{index + 1}</Text>
                  </View>
                  {page.status === 'done' && (
                    <View style={styles.cardBadge}>
                      <Text style={styles.cardBadgeText}>
                        {tp('ocrLines', page.lines.length)}
                      </Text>
                    </View>
                  )}
                </Pressable>
                <View style={styles.cardActions}>
                  <Pressable
                    onPress={() => openCrop(page)}
                    hitSlop={6}
                    style={styles.cardAction}
                  >
                    <Ionicons name="crop-outline" size={15} color={theme.text} />
                    <Text style={styles.cardActionText}>{t('crop')}</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => removePage(page)}
                    hitSlop={6}
                    style={styles.cardAction}
                  >
                    <Ionicons
                      name="trash-outline"
                      size={15}
                      color={theme.danger}
                    />
                    <Text style={[styles.cardActionText, styles.dangerText]}>
                      {t('delete')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      <View style={[styles.collectFooter, { paddingBottom: insets.bottom + 10 }]}>
        <Pressable
          onPress={() => setCameraOpen(true)}
          disabled={busy !== null}
          style={({ pressed }) => [
            styles.captureBtn,
            pressed && styles.pressed,
            busy !== null && styles.disabled,
          ]}
        >
          <Ionicons name="camera-outline" size={18} color={theme.text} />
          <Text style={styles.captureText}>{t('toolScan')}</Text>
        </Pressable>
        <Pressable
          onPress={() => setPickerOpen(true)}
          disabled={busy !== null}
          style={({ pressed }) => [
            styles.captureBtn,
            pressed && styles.pressed,
            busy !== null && styles.disabled,
          ]}
        >
          <Ionicons name="images-outline" size={18} color={theme.text} />
          <Text style={styles.captureText}>{t('toolImport')}</Text>
        </Pressable>
        <Pressable
          onPress={() => void recognizeAll()}
          disabled={busy !== null || pages.length === 0}
          style={({ pressed }) => [
            styles.startBtn,
            pressed && styles.pressed,
            (busy !== null || pages.length === 0) && styles.disabled,
          ]}
        >
          <Text style={styles.startText}>{t('ocrStart')}</Text>
        </Pressable>
      </View>

      {busy && (
        <View style={styles.overlay}>
          <ActivityIndicator color="#fff" size="large" />
          <Text style={styles.overlayText}>{busyText}</Text>
        </View>
      )}

      {cameraOpen && (
        <View style={StyleSheet.absoluteFill}>
          <CameraScreen
            onCaptured={(uri) => {
              setCameraOpen(false);
              void addImages([uri]);
            }}
            onCancel={() => setCameraOpen(false)}
            onPickGallery={() => {
              setCameraOpen(false);
              setPickerOpen(true);
            }}
          />
        </View>
      )}

      {pickerOpen && (
        <View style={StyleSheet.absoluteFill}>
          <PhotoPickerScreen
            limit={20}
            title={t('ocrAddPages')}
            onCancel={() => setPickerOpen(false)}
            onDone={(uris) => {
              setPickerOpen(false);
              void addImages(uris);
            }}
          />
        </View>
      )}
    </View>
  );
}

/* ------------------------------- 文本行 ------------------------------- */

type LineRowProps = {
  line: OcrLine;
  index: number;
  selected: boolean;
  onLayout: (y: number) => void;
  onChangeText: (text: string) => void;
  onFocus: () => void;
  onRevert: () => void;
  revertLabel: string;
  editedLabel: string;
  lowLabel: string;
};

function LineRow({
  line,
  index,
  selected,
  onLayout,
  onChangeText,
  onFocus,
  onRevert,
  revertLabel,
  editedLabel,
  lowLabel,
}: LineRowProps) {
  const edited = isLineEdited(line);
  const low = isLowConfidence(line);
  return (
    <View
      onLayout={(event) => onLayout(event.nativeEvent.layout.y)}
      style={[
        styles.lineRow,
        selected && styles.lineRowSelected,
        low && !selected && styles.lineRowLow,
      ]}
    >
      <Text style={styles.lineIndex}>{index + 1}</Text>
      <View style={styles.lineBody}>
        <TextInput
          value={line.text}
          onChangeText={onChangeText}
          onFocus={onFocus}
          multiline
          style={styles.lineInput}
          placeholderTextColor={theme.subtext}
        />
        {(low || edited) && (
          <View style={styles.lineTags}>
            {low && (
              <Text style={styles.lineTagLow} numberOfLines={1}>
                {lowLabel} · {Math.round(line.score * 100)}%
              </Text>
            )}
            {edited && <Text style={styles.lineTagEdited}>{editedLabel}</Text>}
          </View>
        )}
      </View>
      {edited && (
        <Pressable
          onPress={onRevert}
          hitSlop={8}
          accessibilityLabel={revertLabel}
          style={styles.revertBtn}
        >
          <Ionicons name="refresh-outline" size={16} color={theme.subtext} />
        </Pressable>
      )}
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
    paddingBottom: 12,
  },
  topBtn: { minWidth: 56 },
  topBtnText: { color: 'rgba(255,255,255,0.88)', fontSize: 15 },
  topPrimary: { color: '#7fb0ff', fontWeight: '600', textAlign: 'right' },
  disabledText: { opacity: 0.4 },
  topTitle: { color: '#fff', fontSize: 16, fontWeight: '700' },
  topCenter: { alignItems: 'center' },
  topSub: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 2 },
  topActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  iconBtn: { padding: 2 },

  subtitle: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  collectScroll: { flex: 1 },
  collectContent: { padding: 16, paddingTop: 4, paddingBottom: 24 },
  cardGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    width: '47.5%',
    flexGrow: 1,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 14,
    overflow: 'hidden',
  },
  cardThumbWrap: { aspectRatio: 0.78, backgroundColor: '#141821' },
  cardThumb: { width: '100%', height: '100%' },
  cardIndex: {
    position: 'absolute',
    left: 8,
    top: 8,
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 5,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardIndexText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  cardBadge: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: 'rgba(47,107,255,0.85)',
  },
  cardBadgeText: { color: '#fff', fontSize: 10, fontWeight: '600' },
  cardActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
  },
  cardAction: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  cardActionText: { color: 'rgba(255,255,255,0.85)', fontSize: 12 },
  dangerText: { color: '#ff6b6b' },

  emptyCard: {
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.25)',
    paddingVertical: 44,
    paddingHorizontal: 20,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  emptyHint: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },

  collectFooter: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
  captureBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
    height: 46,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  captureText: { color: 'rgba(255,255,255,0.9)', fontSize: 14 },
  startBtn: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  startText: { color: '#fff', fontSize: 15, fontWeight: '700' },

  resultBody: { flex: 1 },
  imagePane: {
    flex: 1,
    minHeight: 180,
    backgroundColor: '#0b0d12',
  },
  resultImage: { position: 'absolute' },
  resultImageLoading: {
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
  },
  imageBox: { position: 'absolute' },
  imageStatus: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    padding: 24,
  },
  imageStatusText: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  retryText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  pager: {
    position: 'absolute',
    right: 12,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 14,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  pagerBtn: { padding: 2 },
  pagerText: { color: '#fff', fontSize: 11 },

  listPane: {
    flex: 1,
    backgroundColor: theme.bg,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    marginTop: -12,
    overflow: 'hidden',
  },
  lineList: { flex: 1 },
  lineListContent: { padding: 12, paddingBottom: 24 },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
    marginBottom: 4,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  lineRowSelected: {
    borderColor: theme.primary,
    backgroundColor: '#eef3ff',
  },
  lineRowLow: { borderColor: '#ffd9a8' },
  lineIndex: {
    width: 20,
    textAlign: 'right',
    fontSize: 11,
    color: theme.subtext,
    marginTop: 3,
  },
  lineBody: { flex: 1 },
  lineInput: {
    color: theme.text,
    fontSize: 15,
    lineHeight: 21,
    padding: 0,
    margin: 0,
    minHeight: 22,
  },
  lineTags: { flexDirection: 'row', gap: 8, marginTop: 3 },
  lineTagLow: { fontSize: 10, color: '#c27400' },
  lineTagEdited: { fontSize: 10, color: theme.primary },
  revertBtn: { paddingTop: 3 },
  listEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: 24,
  },
  listEmptyTitle: {
    color: theme.text,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  listEmptyHint: {
    color: theme.subtext,
    fontSize: 12,
    textAlign: 'center',
  },

  resultFooter: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    backgroundColor: theme.bg,
  },
  footerBtn: {
    flex: 1,
    height: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.surfaceAlt,
  },
  footerBtnText: { color: theme.text, fontSize: 14, fontWeight: '600' },
  footerPrimary: { backgroundColor: theme.primary },
  footerPrimaryText: { color: '#fff' },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.45 },

  notice: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(20,24,32,0.92)',
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  noticeText: { color: '#fff', fontSize: 12 },

  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(6,8,12,0.72)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  overlayText: { color: '#fff', fontSize: 13 },

  cropStage: { flex: 1, backgroundColor: '#0b0d12' },
  cropImage: { position: 'absolute' },
  cropBox: { position: 'absolute' },
  cropHint: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    textAlign: 'center',
    paddingTop: 10,
  },
});
