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
  Alert,
  BackHandler,
  Image,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as Sharing from 'expo-sharing';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import CropOverlay, {
  handlePoint as cropHandlePoint,
  isQuadConvex,
  type ActiveHandle,
  type CropHandle,
} from '../components/CropOverlay';
import CropLoupe, {
  LOUPE_DISTANCE,
  LOUPE_SIZE,
} from '../components/CropLoupe';
import PhotoPickerScreen from './PhotoPickerScreen';
import { isNativeGeometryAvailable } from '../../modules/image-core';
import { isAbortError, throwIfAborted } from '../lib/abort';
import {
  FULL_QUAD,
  MIN_QUAD_AREA,
  isFullQuad,
  isUsableQuad,
  quadArea,
  quadToArray,
} from '../lib/crop';
import { getDetectionServerUrl } from '../lib/detectionConfig';
import { detectOnServer } from '../lib/detectionServer';
import {
  detectDocumentQuad,
  isEdgeDetectionAvailable,
} from '../lib/documentDetection';
import { filterWithCanvas, warpWithCanvas } from '../lib/filterEngine';
import {
  isNativeAdjustAvailable,
  isNativeFilterAvailable,
} from '../lib/filterNative';
import { useI18n } from '../lib/i18n';
import {
  ADJUST_KEYS,
  ADJUST_RANGE,
  adjustLabel,
  IMPORT_FILTER,
  SCAN_FILTERS,
  ZERO_ADJUST,
  isZeroAdjust,
  sameAdjust,
  sanitizeAdjust,
  type AdjustKey,
  type PageAdjust,
} from '../lib/filters';
import { applyFilter, stripDataUrl } from '../lib/filterRunner';
import {
  getImageSize,
  readBase64,
  resizeImage,
  rotateImage,
  warpPerspective,
} from '../lib/imagePipeline';
import { deletePageFiles } from '../lib/pageStore';
import { renderPageBase64 } from '../lib/pageRender';
import { generatePdf } from '../lib/pdf';
import { getPdfLimits } from '../lib/pdfLimits';
import { pdfFileName, savePdfToUser } from '../lib/savePdf';
import {
  SCAN_MAX_DIM,
  importScanPages,
  replaceScanPageSource,
  replaceScanPageSourceFromFile,
  saveScanPage,
  scanProjectDir,
} from '../lib/storage';
import { theme } from '../theme';
import { filterLabel } from '../types';
import type {
  DocPage,
  DocumentQuad,
  FilterKey,
  Rotation,
} from '../types';

type Props = {
  /** 本次编辑的草稿 id，同时也是草稿目录名 */
  draftId: string;
  initialUris: string[];
  /**
   * 是否把识别到的四角直接切边。相机拍照为 true；
   * 相册导入为 false，保留原始图，识别结果只作为「裁剪」初值。
   */
  autoCrop?: boolean;
  /** 文档默认标题（第一张图片的文件名），编辑器里可改 */
  title: string;
  onCancel: () => void;
};

type Busy =
  | { kind: 'import'; done: number; total: number }
  | { kind: 'apply'; done: number; total: number }
  | { kind: 'pdf'; done: number; total: number }
  | { kind: 'export'; done: number; total: number }
  | { kind: 'detect'; done: number; total: number }
  | { kind: 'autocrop'; done: number; total: number }
  | { kind: 'detectServer' }
  | { kind: 'crop' }
  | { kind: 'replace' }
  | null;

/** 算法缩略图的长边；11 个算法都基于这一张小图生成 */
const THUMB_BASE_DIM = 260;
/** 第二步调节时的预览长边，兼顾清晰度和拖动响应 */
const PREVIEW_BASE_DIM = 900;
/** 裁剪时图片四周留白：手柄半径 22，留 26 保证贴边手柄也能按到 */
const CROP_INSET = 26;
/**
 * 裁剪框的触摸区域向图片外扩出的边距。
 * 手柄压在图片边界上，有一半在图片外面；触摸区域不跟着扩出去，
 * 贴边手柄的外半截就按不到（触摸事件到不了裁剪框视图）。
 * 必须小于 CROP_INSET，扩出去的部分才不会超出预览舞台。
 */
const CROP_GRAB_PAD = CROP_INSET - 4;

/**
 * 扫描文档编辑器（导入 → 翻页 → 算法 / 微调 / 裁剪 → 保存）。
 *
 * 交互按「扫描全能王」的导入编辑页设计：
 *   - 左右滑动或点页码两侧三角翻页
 *   - 按住「对比」显示原图，松手回到处理后的图
 *   - 算法缩略图来自当前页，点一次应用、再点一次进入对比度/亮度/细节微调
 *   - 「应用到所有页」把当前算法批量套到全部页面
 *   - 底部：继续导入 / 左右旋转 / 四角裁剪 / 提取文字 / 保存成图片 / 保存成 PDF
 *
 * 所有编辑都从 originalUri 重新渲染，不在上一次的结果上叠加压缩；
 * 只有裁剪是破坏性的（结果写成新的 originalUri）。
 */
export default function ScanEditorScreen({
  draftId,
  initialUris,
  autoCrop = false,
  title,
  onCancel,
}: Props) {
  const insets = useSafeAreaInsets();
  const { t, tp } = useI18n();
  /** 文档名：默认取第一张图片的文件名，可在顶部直接改 */
  const [docTitle, setDocTitle] = useState(title);
  const titleInputRef = useRef<ComponentRef<typeof TextInput>>(null);
  const [pages, setPages] = useState<DocPage[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  /** 相册选择器的用途：追加页 / 重拍当前页 */
  const [pickerMode, setPickerMode] = useState<'add' | 'replace' | null>(null);

  /** 算法是否应用到所有页（默认勾选） */
  const [applyAll, setApplyAll] = useState(true);
  /** 按住「对比」时显示原图 */
  const [compare, setCompare] = useState(false);

  /** 当前页（含旋转）的原图：对比、裁剪、算法缩略图、微调预览共用 */
  const [baseUri, setBaseUri] = useState<string | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  /** 当前页各算法的预览图（data URI） */
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  /** 第二步微调面板 */
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustKey, setAdjustKey] = useState<AdjustKey>('contrast');
  const [draftAdjust, setDraftAdjust] = useState<PageAdjust>(ZERO_ADJUST);
  /** 微调过程中的实时预览（data URI） */
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  /** 四角裁剪 */
  const [cropMode, setCropMode] = useState(false);
  const [quad, setQuad] = useState<DocumentQuad>(FULL_QUAD);
  /**
   * 裁剪时显示的底图。页面有裁剪前原图（cropBaseUri）时用它，
   * 这样用户能看到完整原图、把切多的部分拉回来；否则就是当前页的源图。
   */
  const [cropUri, setCropUri] = useState<string | null>(null);
  const [cropSize, setCropSize] = useState<{
    width: number;
    height: number;
  } | null>(null);
  /**
   * 拖动中的手柄。放大镜画在页面最外层：允许超出图片边界，
   * 超出部分保持透明，只有图片区域被放大。
   */
  const [loupe, setLoupe] = useState<{
    handle: CropHandle;
    edgeAngle: number | null;
    /** -1 上方、+1 下方，按下时定死，拖动中不翻转 */
    side: number;
  } | null>(null);

  /** 舞台尺寸与在预览区内的位置 */
  const [stage, setStage] = useState({ width: 0, height: 0, x: 0, y: 0 });
  /** 预览区在页面根节点内的位置（放大镜用根节点坐标） */
  const [areaOffset, setAreaOffset] = useState({ x: 0, y: 0 });

  const pagesRef = useRef<DocPage[]>([]);
  const activeRef = useRef(0);
  const running = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const started = useRef(false);
  /** 每页上次识别到的四角：服务端/端侧都失败时作为裁剪初值 */
  const suggestionsRef = useRef(new Map<string, DocumentQuad>());
  /** 递增序号：切页/再次点裁剪后丢弃过期的识别结果 */
  const cropRequestRef = useRef(0);
  /** 裁剪底图是旋转出来的临时文件，退出裁剪时删掉 */
  const cropTempRef = useRef<string | null>(null);
  /** 手动裁剪时的服务端/端侧识别请求，切页或关闭裁剪就中止 */
  const cropDetectAbortRef = useRef<AbortController | null>(null);
  const draftRef = useRef<PageAdjust>(ZERO_ADJUST);
  const previewSeq = useRef(0);
  /** 旋转后的原图缓存（临时文件在卸载时清理） */
  const baseCache = useRef(new Map<string, { uri: string; temp: boolean }>());
  /** 每页每旋转角的算法缩略图缓存（native 产物是缓存文件，要记下来删） */
  const thumbCache = useRef(
    new Map<string, { uris: Record<string, string>; files: string[] }>(),
  );
  /** 微调预览用的中尺寸图缓存（文件 uri） */
  const mediumCache = useRef(new Map<string, string>());
  /** 微调预览的 Canvas base64 缓存，只有原生不支持微调时才用 */
  const mediumBase64Cache = useRef(new Map<string, string>());
  /** 当前显示中的预览临时文件，切走/关闭时删除 */
  const previewFiles = useRef<string[]>([]);
  /**
   * 事件回调里读它而不是闭包里的 applyAll：JS 线程正忙（生成缩略图）时
   * 组件可能还没重渲染，直接读 state 会拿到勾选前的旧值。
   */
  const applyAllRef = useRef(true);
  const selectPageRef = useRef<(index: number) => void>(() => {});
  const gestureEnabledRef = useRef(true);

  const limit = getPdfLimits().pageLimit;
  const activePage = pages[active] ?? pages[0];
  const canInteract = !busy;

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    applyAllRef.current = applyAll;
  }, [applyAll]);

  useEffect(() => {
    gestureEnabledRef.current = !cropMode && !busy;
  }, [cropMode, busy]);

  useEffect(() => {
    draftRef.current = draftAdjust;
  }, [draftAdjust]);

  const commit = useCallback((next: DocPage[]) => {
    pagesRef.current = next;
    setPages(next);
  }, []);

  const begin = useCallback((state: Busy) => {
    running.current = true;
    setBusy(state);
  }, []);

  const end = useCallback(() => {
    running.current = false;
    setBusy(null);
  }, []);

  /** 退出裁剪：中止在途识别，清掉底图和旋转临时文件 */
  const closeCrop = useCallback(() => {
    cropRequestRef.current += 1;
    // 不动 cropDetectAbortRef：在途任务要靠它匹配自己，把忙碌态收尾
    cropDetectAbortRef.current?.abort();
    setCropMode(false);
    setCropUri(null);
    setCropSize(null);
    setQuad(FULL_QUAD);
    const temp = cropTempRef.current;
    cropTempRef.current = null;
    if (temp) {
      void FileSystem.deleteAsync(temp, { idempotent: true }).catch(() => {});
    }
  }, []);

  const selectPage = useCallback(
    (index: number) => {
      const total = pagesRef.current.length;
      if (!total) return;
      const next = Math.max(0, Math.min(total - 1, index));
      if (next === activeRef.current) return;
      activeRef.current = next;
      setActive(next);
      setCompare(false);
      // 切页后，上一页的在途识别结果不再适用
      closeCrop();
      setAdjustOpen(false);
      setPreviewUri(null);
      previewSeq.current++;
    },
    [closeCrop],
  );

  useEffect(() => {
    selectPageRef.current = selectPage;
  }, [selectPage]);

  /** 当前页 + 旋转角对应的原图；旋转结果按 key 缓存，避免重复转码 */
  const getBase = useCallback(async (page: DocPage): Promise<string> => {
    const key = `${page.id}:${page.rotation}:${page.originalUri}`;
    const hit = baseCache.current.get(key);
    if (hit) return hit.uri;
    if (page.rotation === 0) {
      baseCache.current.set(key, { uri: page.originalUri, temp: false });
      return page.originalUri;
    }
    const uri = await rotateImage(
      page.originalUri,
      page.rotation as 90 | 180 | 270,
    );
    baseCache.current.set(key, { uri, temp: true });
    return uri;
  }, []);

  /**
   * 裁剪底图：有裁剪前原图就用它（并套上当前旋转角），否则用当前源图。
   *
   * 相机自动切边之后，「当前源图」已经是紧贴文档的结果，拿它继续裁剪只会
   * 越裁越小；底图让用户能重新框到完整画面。旋转角在裁剪结果里会被烘焙，
   * 所以底图只需要按页面当前的 rotation 转一次。
   */
  const getCropSource = useCallback(
    async (page: DocPage): Promise<{ uri: string; temp: boolean }> => {
      const base = page.cropBaseUri;
      if (!base) return { uri: await getBase(page), temp: false };
      if (page.rotation === 0) return { uri: base, temp: false };
      return {
        uri: await rotateImage(base, page.rotation as 90 | 180 | 270),
        temp: true,
      };
    },
    [getBase],
  );

  // 卸载时清掉旋转产生的临时文件
  useEffect(() => {
    const cache = baseCache.current;
    return () => {
      cropDetectAbortRef.current?.abort();
      for (const item of cache.values()) {
        if (item.temp) {
          void FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
        }
      }
      cache.clear();
    };
  }, []);

  /** 裁剪/替换源图后，这一页的旋转缓存、缩略图缓存都失效 */
  const invalidatePageCache = useCallback((pageId: string) => {
    for (const [key, entry] of [...thumbCache.current.entries()]) {
      if (!key.startsWith(`${pageId}:`)) continue;
      thumbCache.current.delete(key);
      for (const uri of entry.files) {
        void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    }
    for (const key of [...mediumCache.current.keys()]) {
      if (!key.startsWith(`${pageId}:`)) continue;
      const uri = mediumCache.current.get(key);
      mediumCache.current.delete(key);
      mediumBase64Cache.current.delete(key);
      if (uri) {
        void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    }
    for (const [key, item] of [...baseCache.current.entries()]) {
      if (!key.startsWith(`${pageId}:`)) continue;
      if (item.temp) {
        void FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {});
      }
      baseCache.current.delete(key);
    }
  }, []);

  /**
   * 导入后识别四角：逐页跑端侧 DocCornerNet，只有结果通过凸性/面积校验才采用。
   *
   * `crop` 为 true（相机拍照）时直接切边；为 false（相册导入）时保留原始图，
   * 只把四角存成「裁剪」初值——模型切多了还能重新裁，原图也一直都在。
   *
   * 单张失败（模型没把握、解码失败、磁盘错误）只保留原图，不影响整批导入；
   * 用户随时可以在编辑器里手动点「裁剪」重新识别或调整。
   */
  const autoCropPages = useCallback(
    async (
      added: DocPage[],
      signal: AbortSignal,
      /** 每页的最新落盘版本（切边/重渲染后），导入中止时用来清理文件 */
      onPage?: (page: DocPage) => void,
      /** false 时只识别不切边 */
      crop = true,
    ): Promise<DocPage[]> => {
      if (!isEdgeDetectionAvailable() || !isNativeGeometryAvailable()) {
        added.forEach((page) => onPage?.(page));
        return added;
      }
      const result: DocPage[] = [];
      const total = added.length;
      for (let index = 0; index < added.length; index += 1) {
        throwIfAborted(signal);
        const page = added[index];
        let next = page;
        try {
          setBusy({ kind: 'detect', done: index, total });
          const detection = await detectDocumentQuad(page.originalUri, { signal });
          if (detection && isUsableQuad(detection.quad) && !crop) {
            // 相册导入：不破坏原图，只留作「裁剪」时的四角初值
            suggestionsRef.current.set(page.id, detection.quad);
          } else if (detection && isUsableQuad(detection.quad)) {
            setBusy({ kind: 'autocrop', done: index, total });
            const warpedUri = await warpPerspective(
              page.originalUri,
              quadToArray(detection.quad),
            );
            try {
              next = await replaceScanPageSourceFromFile(
                draftId,
                page,
                warpedUri,
                { signal },
              );
            } finally {
              await FileSystem.deleteAsync(warpedUri, {
                idempotent: true,
              }).catch(() => {});
            }
            invalidatePageCache(page.id);
            // 源图已经被拉正，切边前的四角坐标对不上新图，不能留作裁剪初值
            suggestionsRef.current.delete(page.id);

            // 与手动裁剪确认一致：切边后重新套用当前的算法/微调
            const keepAdjust = sanitizeAdjust(page.adjust);
            if (page.filter !== 'original' || !isZeroAdjust(keepAdjust)) {
              const base64 = await renderPageBase64(next, {
                filter: page.filter,
                rotation: 0,
                adjust: keepAdjust,
              });
              next = await saveScanPage(draftId, next, base64, {
                filter: page.filter,
                rotation: 0,
                adjust: keepAdjust,
              });
            }
          }
        } catch (e) {
          if (isAbortError(e)) throw e;
          console.warn('[scan] auto crop failed:', e);
        }
        result.push(next);
        onPage?.(next);
      }
      return result;
    },
    [draftId, invalidatePageCache],
  );

  const addImages = useCallback(
    /** `crop` 只有相机拍照首次进入时为 true，其余（相册导入/追加页）都保留原图 */
    async (uris: string[], selectFirst: boolean, crop = false) => {
      if (!uris.length || running.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      /** 本次导入落盘的最新页面版本，取消时按它删文件（切边会换掉原图路径） */
      const tracked = new Map<string, DocPage>();
      let committed = false;
      begin({ kind: 'import', done: 0, total: uris.length });
      setError(null);
      try {
        const added = await importScanPages(draftId, uris, {
          filter: IMPORT_FILTER,
          signal: controller.signal,
          onProgress: (done, total) => setBusy({ kind: 'import', done, total }),
        });
        added.forEach((page) => tracked.set(page.id, page));
        const cropped = await autoCropPages(
          added,
          controller.signal,
          (page) => tracked.set(page.id, page),
          crop,
        );
        const base = pagesRef.current;
        commit([...base, ...cropped]);
        committed = true;
        if (selectFirst && added.length) selectPageRef.current(base.length);
      } catch (e) {
        // 取消导入（还没提交进页面列表）：已经落盘的页面要删掉，不能留下孤儿文件
        if (!committed) {
          for (const page of tracked.values()) void deletePageFiles(page);
        }
        if (!isAbortError(e)) {
          Alert.alert(
            t('importFailedTitle'),
            e instanceof Error ? e.message : t('imageReadFailed'),
          );
        }
      } finally {
        abortRef.current = null;
        end();
      }
    },
    [autoCropPages, begin, commit, draftId, end, t],
  );

  // 首次进入：把选中的图片落盘；不自动跳页，先展示第一张
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void addImages(initialUris, false, autoCrop);
  }, [addImages, initialUris, autoCrop]);

  /** 当前页的原图（含旋转），供对比 / 裁剪 / 缩略图使用 */
  const baseKey = activePage
    ? `${activePage.id}:${activePage.rotation}:${activePage.originalUri}`
    : '';

  useEffect(() => {
    let cancelled = false;
    // 翻页/旋转后立刻丢掉上一页的派生状态，避免预览里闪一帧旧图
    /* eslint-disable react-hooks/set-state-in-effect */
    setBaseUri(null);
    setImageSize(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (!baseKey) return;
    const page = pagesRef.current[activeRef.current];
    if (!page) return;
    getBase(page)
      .then(async (uri) => {
        if (cancelled) return;
        setBaseUri(uri);
        try {
          const size = await getImageSize(uri);
          if (!cancelled) setImageSize(size);
        } catch {
          // 尺寸拿不到时只是无法显示裁剪框，预览仍然可用
        }
      })
      .catch(() => {
        if (!cancelled) setBaseUri(page.originalUri);
      });
    return () => {
      cancelled = true;
    };
  }, [baseKey, getBase]);

  // 生成算法缩略图：以当前页（含旋转）的小图为输入，逐个算法出图。
  // 有原生库时每一步约 10ms，11 张全出来 0.2s 左右；Expo Go 回退到 Canvas。
  useEffect(() => {
    let cancelled = false;
    // 切页后先清空，缩略图在异步回调里逐张补上
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThumbs({});
    if (!baseKey) return;
    const cached = thumbCache.current.get(baseKey);
    if (cached) {
      setThumbs(cached.uris);
      return;
    }
    const page = pagesRef.current[activeRef.current];
    if (!page) return;

    (async () => {
      // 本次生成出来的临时文件；早退或被切页打断时全部删掉
      const created: string[] = [];
      let stored = false;
      try {
        const base = await getBase(page);
        // alwaysEncode：顺带把 EXIF 旋转烤进像素，原生解码不认 EXIF
        const small = await resizeImage(base, THUMB_BASE_DIM, 0.8, true);
        created.push(small);
        const uris: Record<string, string> = { original: small };
        if (!cancelled) setThumbs({ ...uris });
        for (const key of SCAN_FILTERS) {
          if (cancelled) return;
          if (key === 'original') continue;
          try {
            const out = await applyFilter(small, key);
            if (out.temp) created.push(out.uri);
            uris[key] = out.uri;
          } catch {
            uris[key] = small;
          }
          if (!cancelled) setThumbs({ ...uris });
        }
        if (cancelled) return;
        thumbCache.current.set(baseKey, { uris, files: created });
        stored = true;
      } catch (e) {
        console.warn(
          `[scan-editor] 生成算法缩略图失败: ${(e as Error)?.message ?? e}`,
        );
      } finally {
        // 没进缓存说明这批文件没人会用，立刻清理
        if (cancelled || !stored) {
          for (const uri of created) {
            void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [baseKey, getBase]);

  /** 渲染一组页面：从各自的原图重算，逐页写文件、逐页更新界面 */
  const runEdits = useCallback(
    async (
      targets: DocPage[],
      plan: (page: DocPage) => {
        filter: FilterKey;
        rotation: Rotation;
        adjust: PageAdjust;
      },
    ) => {
      if (running.current || targets.length === 0) return;
      begin({ kind: 'apply', done: 0, total: targets.length });
      setError(null);
      try {
        let done = 0;
        for (const page of targets) {
          const edit = plan(page);
          const unchanged =
            edit.filter === page.filter &&
            edit.rotation === page.rotation &&
            sameAdjust(edit.adjust, sanitizeAdjust(page.adjust));
          if (!unchanged) {
            const base64 = await renderPageBase64(page, edit);
            const updated = await saveScanPage(draftId, page, base64, edit);
            commit(
              pagesRef.current.map((item) =>
                item.id === page.id ? updated : item,
              ),
            );
          }
          done++;
          setBusy({ kind: 'apply', done, total: targets.length });
        }
      } catch (e) {
        setError(
          t('processingFailed', {
            message: (e as Error)?.message ?? t('unknownError'),
          }),
        );
      } finally {
        end();
      }
    },
    [begin, commit, draftId, end, t],
  );

  const handleAdd = useCallback(() => {
    if (running.current) return;
    if (limit - pagesRef.current.length <= 0) {
      Alert.alert(
        t('pageLimitTitle'),
        t('scanPageLimitBody', { limit }),
      );
      return;
    }
    setPickerMode('add');
  }, [limit, t]);

  const openAdjust = useCallback(() => {
    const page = pagesRef.current[activeRef.current];
    if (!page) return;
    const base = sanitizeAdjust(page.adjust);
    draftRef.current = base;
    setDraftAdjust(base);
    setAdjustKey('contrast');
    setPreviewUri(null);
    setAdjustOpen(true);
  }, []);

  const closeAdjust = useCallback(() => {
    previewSeq.current++;
    setAdjustOpen(false);
    setPreviewUri(null);
    setPreviewBusy(false);
    // 预览图不再需要，缓存里的中尺寸原图可以留着复用
    const files = previewFiles.current;
    previewFiles.current = [];
    for (const uri of files) {
      void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  }, []);

  /**
   * 微调时的实时预览：只处理 ~900px 的图，滑动结束才触发。
   * 原生支持微调时直接出文件（约 100ms），否则回退到 Canvas 的 data URI。
   */
  const renderAdjustPreview = useCallback(
    async (next: PageAdjust) => {
      const page = pagesRef.current[activeRef.current];
      if (!page) return;
      const token = ++previewSeq.current;
      setPreviewBusy(true);
      try {
        const key = `${page.id}:${page.rotation}:${page.originalUri}`;
        let medium = mediumCache.current.get(key);
        if (!medium) {
          const base = await getBase(page);
          medium = await resizeImage(base, PREVIEW_BASE_DIM, 0.85, true);
          mediumCache.current.set(key, medium);
        }

        if (isNativeFilterAvailable() && isNativeAdjustAvailable()) {
          const out = await applyFilter(medium, page.filter, next);
          if (token !== previewSeq.current) {
            if (out.temp) {
              void FileSystem.deleteAsync(out.uri, { idempotent: true }).catch(
                () => {},
              );
            }
            return;
          }
          const stale = previewFiles.current;
          previewFiles.current = out.temp ? [out.uri] : [];
          for (const uri of stale) {
            void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          }
          setPreviewUri(out.uri);
          return;
        }

        let b64 = mediumBase64Cache.current.get(key);
        if (!b64) {
          b64 = await readBase64(medium);
          mediumBase64Cache.current.set(key, b64);
        }
        const url = await filterWithCanvas(b64, page.filter, next);
        if (token === previewSeq.current) setPreviewUri(url);
      } catch (e) {
        console.warn(`[scan-editor] 微调预览失败: ${(e as Error)?.message ?? e}`);
      } finally {
        if (token === previewSeq.current) setPreviewBusy(false);
      }
    },
    [getBase],
  );

  const updateDraft = useCallback((key: AdjustKey, value: number) => {
    const next = { ...draftRef.current, [key]: value };
    draftRef.current = next;
    setDraftAdjust(next);
  }, []);

  const confirmAdjust = useCallback(() => {
    const page = pagesRef.current[activeRef.current];
    const next = draftRef.current;
    closeAdjust();
    if (!page) return;
    if (sameAdjust(next, sanitizeAdjust(page.adjust))) return;
    // 读 ref：勾选后立刻点「✓」时，state 可能还没落到这个闭包里
    const targets = applyAllRef.current ? pagesRef.current : [page];
    void runEdits(targets, (item) => ({
      filter: item.filter,
      rotation: item.rotation,
      adjust: next,
    }));
  }, [closeAdjust, runEdits]);

  /** 点算法方块：第一次应用；再点同一个进入第二步微调 */
  const handleFilterPress = useCallback(
    (key: FilterKey) => {
      const page = pagesRef.current[activeRef.current];
      if (!page || running.current) return;
      setPreviewUri(null);
      setAdjustOpen(false);

      // 读 ref：勾选动作和点算法之间可能没来得及重渲染
      const all = applyAllRef.current;
      if (key === page.filter) {
        // 已经用了这个算法：勾了「应用到所有页」时先把差异页补齐，否则进第二步
        const others = all
          ? pagesRef.current.filter((item) => item.filter !== key)
          : [];
        if (others.length === 0) {
          openAdjust();
          return;
        }
        void runEdits(others, (item) => ({
          filter: key,
          rotation: item.rotation,
          adjust: ZERO_ADJUST,
        }));
        return;
      }

      const list = all ? pagesRef.current : [page];
      void runEdits(list, (item) => ({
        filter: key,
        rotation: item.rotation,
        adjust: ZERO_ADJUST,
      }));
    },
    [openAdjust, runEdits],
  );

  const handleRotate = useCallback(
    (deg: 90 | 270) => {
      const page = pagesRef.current[activeRef.current];
      if (!page || running.current) return;
      // 四角是按旋转前的画面算的，转完就对不上了
      suggestionsRef.current.delete(page.id);
      void runEdits([page], (item) => ({
        filter: item.filter,
        rotation: ((item.rotation + deg) % 360) as Rotation,
        adjust: sanitizeAdjust(item.adjust),
      }));
    },
    [runEdits],
  );

  // 离开编辑器时把缓存文件清掉（**不能**动页面自己的文件）
  useEffect(
    () => () => {
      const files: string[] = [...previewFiles.current];
      previewFiles.current = [];
      if (cropTempRef.current) {
        files.push(cropTempRef.current);
        cropTempRef.current = null;
      }
      for (const entry of thumbCache.current.values()) files.push(...entry.files);
      for (const uri of mediumCache.current.values()) files.push(uri);
      thumbCache.current.clear();
      mediumCache.current.clear();
      mediumBase64Cache.current.clear();
      for (const uri of files) {
        void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    },
    [],
  );

  /**
   * 重拍当前页：换成新照片，替换源图后沿用文档当前的算法与微调。
   * 与导入一致，先缩到工作尺寸（alwaysEncode 会把 EXIF 旋转烤进像素）。
   */
  const handleReplacePage = useCallback(
    async (uri: string) => {
      const page = pagesRef.current[activeRef.current];
      if (!page || running.current) return;
      begin({ kind: 'replace' });
      setError(null);
      try {
        const resized = await resizeImage(uri, SCAN_MAX_DIM, 0.92, true);
        const base64 = stripDataUrl(await readBase64(resized));
        if (resized !== uri) {
          await FileSystem.deleteAsync(resized, { idempotent: true }).catch(
            () => {},
          );
        }
        let next = await replaceScanPageSource(draftId, page, base64);
        // 重拍换的是整张图：上一张图（包括它的裁剪前原图）都不再需要
        if (next.cropBaseUri && next.cropBaseUri !== next.originalUri) {
          await FileSystem.deleteAsync(next.cropBaseUri, {
            idempotent: true,
          }).catch(() => {});
        }
        next = { ...next, cropBaseUri: null, cropped: false };
        invalidatePageCache(page.id);
        suggestionsRef.current.delete(page.id);
        const filter = page.filter;
        const adjust = sanitizeAdjust(page.adjust);
        if (filter !== 'original' || !isZeroAdjust(adjust)) {
          const rendered = await renderPageBase64(next, {
            filter,
            rotation: 0,
            adjust,
          });
          next = await saveScanPage(draftId, next, rendered, {
            filter,
            rotation: 0,
            adjust,
          });
        }
        commit(
          pagesRef.current.map((item) => (item.id === page.id ? next : item)),
        );
        closeCrop();
        setAdjustOpen(false);
        setPreviewUri(null);
      } catch (e) {
        Alert.alert(
          t('retakeFailedTitle'),
          (e as Error)?.message ?? t('unknownError'),
        );
      } finally {
        end();
      }
    },
    [begin, closeCrop, commit, draftId, end, invalidatePageCache, t],
  );

  /** 图片右上角的删除：三选一 —— 删除此页 / 重拍此页 / 取消 */
  const handleRemove = useCallback(() => {
    if (running.current) return;
    const index = activeRef.current;
    const page = pagesRef.current[index];
    if (!page) return;
    Alert.alert(
      t('pageN', { n: index + 1 }),
      t('deleteOrRetakeBody'),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('retakeThisPageAction'),
          onPress: () => setPickerMode('replace'),
        },
        {
          text: t('deleteThisPageAction'),
          style: 'destructive',
          onPress: () => {
            const next = pagesRef.current.filter((item) => item.id !== page.id);
            commit(next);
            const nextIndex = Math.max(0, Math.min(index, next.length - 1));
            activeRef.current = nextIndex;
            setActive(nextIndex);
            setCropMode(false);
            setAdjustOpen(false);
            setPreviewUri(null);
            invalidatePageCache(page.id);
            suggestionsRef.current.delete(page.id);
            void deletePageFiles(page);
          },
        },
      ],
    );
  }, [commit, invalidatePageCache, t]);

  /**
   * 手动点「裁剪」：先用服务端 model_1228 重新识别一次，再退端侧 DocCornerNet，
   * 最后用导入时的结果兜底。全部失败就保持整图四角，让用户手动拖。
   *
   * 检测期间裁剪框已经打开（先显示整图），结果回来再预填，避免按钮点下去没反应。
   *
   * 已经裁过一次的页（`page.cropped`）不再让端侧模型猜：紧贴文档的图没有背景
   * 边界线索，DocCornerNet 会把顶部切掉，框和画面就错位了。这种页只认服务端
   * 结果（model_1228 对满幅文档很稳），拿不到就保持整图，让用户自己拖。
   */
  const handleCropStart = useCallback(() => {
    const page = pagesRef.current[activeRef.current];
    if (!page || !baseUri || running.current) return;
    // 有裁剪前原图时，检测对象就是完整原图，模型不会因为画面已贴边而往里缩
    const alreadyCropped = page.cropped === true && !page.cropBaseUri;
    closeAdjust();

    const pageId = page.id;
    const requestId = ++cropRequestRef.current;
    // 切页 / 再次点击 / 关掉裁剪后，旧结果直接丢弃
    const isStale = () =>
      cropRequestRef.current !== requestId ||
      pagesRef.current[activeRef.current]?.id !== pageId;

    // 上一轮还没结束的识别先中止（比如服务端卡住时用户又点了一次）
    cropDetectAbortRef.current?.abort();
    const controller = new AbortController();
    cropDetectAbortRef.current = controller;
    const { signal } = controller;

    void (async () => {
      let started = false;
      try {
        const source = await getCropSource(page);
        if (isStale() || signal.aborted) {
          if (source.temp) {
            void FileSystem.deleteAsync(source.uri, { idempotent: true }).catch(
              () => {},
            );
          }
          return;
        }
        if (source.temp) cropTempRef.current = source.uri;
        let sourceUri = source.uri;

        // 底图尺寸决定裁剪框的位置；先显示图片，识别结果随后再预填
        setCropUri(sourceUri);
        setCropSize(null);
        setQuad(FULL_QUAD);
        setCropMode(true);

        // 裁剪框按底图尺寸摆放；尺寸拿不到就只能看整图，先等它
        let size = await getImageSize(sourceUri).catch(() => null);
        if (isStale() || signal.aborted) return;
        if (!size && sourceUri !== baseUri) {
          // 底图文件丢了（旧索引 / 被清理）：退回当前源图，裁剪照常可用
          if (source.temp) {
            void FileSystem.deleteAsync(sourceUri, { idempotent: true }).catch(
              () => {},
            );
            cropTempRef.current = null;
          }
          sourceUri = baseUri;
          setCropUri(null);
          size = await getImageSize(sourceUri).catch(() => null);
          if (isStale() || signal.aborted) return;
        }
        if (size) setCropSize(size);

        let found: DocumentQuad | null = null;

        const serverUrl = await getDetectionServerUrl();
        const allowLocal = !alreadyCropped && isEdgeDetectionAvailable();
        // 已经裁过、又没配服务端：没有可信的识别来源，整图四角就是正确答案
        if (!serverUrl && !allowLocal) return;

        started = true;
        begin({ kind: serverUrl ? 'detectServer' : 'detect', done: 0, total: 1 });

        if (serverUrl && !isStale()) {
          try {
            const remote = await detectOnServer(sourceUri, serverUrl, { signal });
            if (remote && isUsableQuad(remote.quad)) found = remote.quad;
          } catch (error) {
            // 服务端不可达/超时就当作没配置，继续走端侧
            if (!isAbortError(error)) {
              console.warn('[scan] server detection failed:', error);
            }
          }
        }

        if (!found && allowLocal && !signal.aborted && !isStale()) {
          setBusy({ kind: 'detect', done: 0, total: 1 });
          const local = await detectDocumentQuad(sourceUri, { signal });
          if (local && isUsableQuad(local.quad)) found = local.quad;
        }

        if (!found && allowLocal && !signal.aborted) {
          const suggestion = suggestionsRef.current.get(pageId);
          if (suggestion && isUsableQuad(suggestion)) found = suggestion;
        }

        if (found && isUsableQuad(found) && !isStale() && !signal.aborted) {
          setQuad(found);
          suggestionsRef.current.set(pageId, found);
        }
      } catch (error) {
        if (!isAbortError(error)) {
          console.warn('[scan] crop detection failed:', error);
        }
      } finally {
        if (cropDetectAbortRef.current === controller) {
          cropDetectAbortRef.current = null;
          if (started) end();
        }
      }
    })();
  }, [baseUri, begin, closeAdjust, end, getCropSource]);

  const handleCropConfirm = useCallback(async () => {
    const page = pagesRef.current[activeRef.current];
    if (!page || running.current) return;
    const sourceUri = cropUri ?? baseUri;
    // 整图四角：本来就没裁过的页等于「不改」；有裁剪前原图时等于「恢复原图」，
    // 走一遍恒等透视校正把结果换回完整画面
    if (isFullQuad(quad) && (!page.cropBaseUri || !sourceUri)) {
      closeCrop();
      return;
    }
    if (!isQuadConvex(quad)) {
      Alert.alert(t('invalidAreaTitle'), t('convexQuadBody'));
      return;
    }
    if (quadArea(quad) < MIN_QUAD_AREA) {
      Alert.alert(t('cropTooSmallTitle'), t('cropTooSmallBody'));
      return;
    }
    if (!sourceUri) return;
    begin({ kind: 'crop' });
    setError(null);
    try {
      // 原生 C++ 透视校正直接写文件，省掉 base64 往返；
      // Expo Go 没有原生模块时才退回 WebView canvas。
      let next: DocPage;
      if (isNativeGeometryAvailable()) {
        const warpedUri = await warpPerspective(sourceUri, quadToArray(quad));
        try {
          next = await replaceScanPageSourceFromFile(draftId, page, warpedUri);
        } finally {
          await FileSystem.deleteAsync(warpedUri, { idempotent: true }).catch(
            () => {},
          );
        }
      } else {
        const source = await readBase64(sourceUri);
        const warped = await warpWithCanvas(source, quad);
        next = await replaceScanPageSource(
          draftId,
          page,
          stripDataUrl(warped),
        );
      }
      invalidatePageCache(page.id);
      suggestionsRef.current.delete(page.id);
      const keepAdjust = sanitizeAdjust(page.adjust);
      if (page.filter !== 'original' || !isZeroAdjust(keepAdjust)) {
        const base64 = await renderPageBase64(next, {
          filter: page.filter,
          rotation: 0,
          adjust: keepAdjust,
        });
        next = await saveScanPage(draftId, next, base64, {
          filter: page.filter,
          rotation: 0,
          adjust: keepAdjust,
        });
      }
      commit(pagesRef.current.map((item) => (item.id === page.id ? next : item)));
      closeCrop();
    } catch (e) {
      Alert.alert(
        t('cropFailedTitle'),
        (e as Error)?.message ?? t('unknownError'),
      );
    } finally {
      end();
    }
  }, [
    baseUri,
    begin,
    closeCrop,
    commit,
    cropUri,
    draftId,
    end,
    invalidatePageCache,
    quad,
    t,
  ]);

  /** 所有页处理后的图片存进系统相册 */
  const handleSaveAllImages = async () => {
    const list = pagesRef.current;
    if (!list.length || running.current) return;
    begin({ kind: 'export', done: 0, total: list.length });
    let saved = 0;
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        Alert.alert(
          t('photoPermissionAlertTitle'),
          t('photoPermissionAlertBody'),
        );
        return;
      }
      for (const page of list) {
        await MediaLibrary.saveToLibraryAsync(page.uri);
        saved += 1;
        setBusy({ kind: 'export', done: saved, total: list.length });
      }
      Alert.alert(t('exportedTitle'), tp('savedToLibraryBody', saved));
    } catch (e) {
      const message = (e as Error)?.message ?? t('unknownError');
      Alert.alert(
        t('saveFailedTitle'),
        saved > 0 ? t('savedPartial', { saved, message }) : message,
      );
    } finally {
      end();
    }
  };

  /** 把已生成的 PDF 交给系统分享面板 */
  const sharePdf = async (uri: string) => {
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        Alert.alert(
          t('shareUnavailableTitle'),
          t('shareUnavailableBody'),
          [{ text: t('ok'), style: 'cancel' }],
        );
        return;
      }
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        UTI: 'com.adobe.pdf',
        dialogTitle: docTitle,
      });
    } catch (e) {
      Alert.alert(
        t('shareSheetFailed'),
        (e as Error)?.message ?? t('unknownError'),
      );
    }
  };

  /**
   * 生成整份 PDF，返回沙盒文件路径。
   * 生成失败（含用户取消）返回 null；忙碌态在返回前已经结束。
   */
  const buildPdf = async (): Promise<string | null> => {
    const list = pagesRef.current;
    if (!list.length || running.current) return null;
    const controller = new AbortController();
    abortRef.current = controller;
    begin({ kind: 'pdf', done: 0, total: list.length });
    // 沙盒里的文件名直接用作保存 / 分享时的文件名
    const out = `${scanProjectDir(draftId)}${pdfFileName(docTitle)}`;
    try {
      await generatePdf(
        list.map((page) => page.uri),
        out,
        {
          signal: controller.signal,
          onProgress: (done, total) => setBusy({ kind: 'pdf', done, total }),
        },
      );
      return out;
    } catch (e) {
      if (!isAbortError(e)) {
        Alert.alert(
          t('pdfCreateFailed'),
          (e as Error)?.message ?? t('unknownError'),
        );
      }
      return null;
    } finally {
      abortRef.current = null;
      // PDF 已经落盘，下面只是弹系统面板；别让「正在生成」一直挂着
      end();
    }
  };

  /** 顶部右侧「分享」：生成后直接拉起系统分享面板 */
  const handleSharePdf = async () => {
    const out = await buildPdf();
    if (out) await sharePdf(out);
  };

  /** 底部「保存成 PDF」：生成后弹系统保存框，让用户选保存位置 */
  const handleSavePdf = async () => {
    const out = await buildPdf();
    if (!out) return;
    const name = pdfFileName(docTitle);
    try {
      const outcome = await savePdfToUser(out);
      if (outcome === 'saved') {
        Alert.alert(t('pdfSavedTitle'), t('pdfSavedBody', { name }), [
          { text: t('done'), style: 'cancel' },
          { text: t('share'), onPress: () => void sharePdf(out) },
        ]);
      } else if (outcome === 'unavailable') {
        Alert.alert(t('pdfCreatedTitle'), t('pdfReadyPath', { path: out }));
      }
    } catch (e) {
      Alert.alert(
        t('savePdfFailedTitle'),
        (e as Error)?.message ?? t('unknownError'),
      );
    }
  };

  const handleCancel = useCallback(() => {
    if (running.current) {
      Alert.alert(t('busyTitle'), t('busyBody'), [
        { text: t('keepWaiting'), style: 'cancel' },
        {
          text: t('discardAndLeave'),
          style: 'destructive',
          onPress: () => {
            abortRef.current?.abort();
            onCancel();
          },
        },
      ]);
      return;
    }
    if (pagesRef.current.length === 0) {
      onCancel();
      return;
    }
    Alert.alert(
      t('discardEditsTitle'),
      tp('discardEditsBody', pagesRef.current.length),
      [
        { text: t('keepEditing'), style: 'cancel' },
        { text: t('back'), style: 'destructive', onPress: onCancel },
      ],
    );
  }, [onCancel, t, tp]);

  // 安卓返回键等同「返回」；改标题时先收起键盘，裁剪模式下先退出裁剪
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (titleInputRef.current?.isFocused()) {
        titleInputRef.current.blur();
        return true;
      }
      if (cropMode) {
        closeCrop();
        return true;
      }
      if (adjustOpen) {
        closeAdjust();
        return true;
      }
      handleCancel();
      return true;
    });
    return () => sub.remove();
  }, [adjustOpen, closeAdjust, closeCrop, cropMode, handleCancel]);

  /** 左右滑动翻页；裁剪 / 处理中不抢手势，避免和拖点冲突 */
  const swipe = useMemo(
    () =>
      // 手势回调只在用户拖动时执行，这里读 ref 是为了拿到最新的页码/可用状态
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_e, gesture) =>
          gestureEnabledRef.current &&
          Math.abs(gesture.dx) > 16 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderRelease: (_e, gesture) => {
          if (!gestureEnabledRef.current) return;
          if (Math.abs(gesture.dx) < 48) return;
          selectPageRef.current(
            activeRef.current + (gesture.dx < 0 ? 1 : -1),
          );
        },
      }),
    [],
  );

  const onStageLayout = (event: LayoutChangeEvent) => {
    const { width, height, x, y } = event.nativeEvent.layout;
    setStage({ width, height, x, y });
  };

  /** 预览区（舞台的父级）在根节点里的偏移 */
  const onAreaLayout = (event: LayoutChangeEvent) => {
    const { x, y } = event.nativeEvent.layout;
    setAreaOffset({ x, y });
  };

  /** 图片在舞台里按 contain 显示后的实际矩形，裁剪框按它定位 */
  const stageRect = useMemo(() => {
    // 裁剪时按裁剪底图（可能是裁剪前原图，尺寸与当前页不同）定位
    const sourceSize = cropMode ? cropSize : imageSize;
    if (!sourceSize || !stage.width || !stage.height) return null;
    // 留出边距，否则贴边的裁剪手柄有一半落在舞台外，按不到
    const availW = Math.max(1, stage.width - CROP_INSET * 2);
    const availH = Math.max(1, stage.height - CROP_INSET * 2);
    const scale = Math.min(
      availW / sourceSize.width,
      availH / sourceSize.height,
    );
    const width = sourceSize.width * scale;
    const height = sourceSize.height * scale;
    return {
      x: (stage.width - width) / 2,
      y: (stage.height - height) / 2,
      width,
      height,
    };
  }, [cropMode, cropSize, imageSize, stage]);

  /** 按下手柄：把放大镜的锚点交给页面最外层的放大镜层 */
  const handleActiveHandle = (active: ActiveHandle | null) => {
    if (!active || !stageRect) {
      setLoupe(null);
      return;
    }
    const point = cropHandlePoint(quad, active.handle);
    // 朝上还是朝下只在这里决定一次，避免拖动中跨过阈值时镜子跳到另一侧
    const above =
      point.y * stageRect.height >= LOUPE_DISTANCE + LOUPE_SIZE / 2;
    setLoupe({
      handle: active.handle,
      edgeAngle: active.edgeAngle,
      side: above ? -1 : 1,
    });
  };

  /**
   * 放大镜位置：镜心与手柄保持固定的屏幕偏移，1:1 跟手，
   * 不做任何夹取——允许超出图片边界，超出部分是透明的。
   */
  const loupeLayout = (() => {
    if (!cropMode || !loupe || !stageRect) return null;
    const point = cropHandlePoint(quad, loupe.handle);
    const focusX = point.x * stageRect.width;
    const focusY = point.y * stageRect.height;
    return {
      focusX,
      focusY,
      imageWidth: stageRect.width,
      imageHeight: stageRect.height,
      left:
        areaOffset.x + stage.x + stageRect.x + focusX - LOUPE_SIZE / 2,
      top:
        areaOffset.y +
        stage.y +
        stageRect.y +
        focusY +
        loupe.side * LOUPE_DISTANCE -
        LOUPE_SIZE / 2,
      edgeAngle: loupe.edgeAngle,
    };
  })();

  const cropValid = isQuadConvex(quad);

  const compareUri = baseUri ?? activePage?.originalUri ?? '';
  const displayUri = compare
    ? compareUri
    : previewUri ?? activePage?.uri ?? '';
  /**
   * 裁剪时显示的图：底图和当前页源图不是同一张（有裁剪前原图 / 底图按旋转转过）
   * 时必须显示底图本身，否则画面尺寸和裁剪框对不上。
   */
  const cropImageUri =
    cropUri && cropUri !== baseUri ? cropUri : null;
  const cropShownUri = cropImageUri ?? (displayUri || compareUri);

  const busyText = (() => {
    if (!busy) return '';
    switch (busy.kind) {
      case 'import':
        return t('importingProgress', busy);
      case 'apply':
        return t('applyingProgress', busy);
      case 'pdf':
        return busy.done === 0
          ? t('creatingPdf')
          : t('creatingPdfProgress', busy);
      case 'export':
        return t('savingToLibraryProgress', busy);
      case 'detect':
        return busy.total > 1
          ? t('detectingProgress', busy)
          : t('detecting');
      case 'autocrop':
        return busy.total > 1
          ? t('autoCroppingProgress', busy)
          : t('autoCropping');
      case 'detectServer':
        return t('detectingServer');
      case 'crop':
        return t('cropping');
      case 'replace':
        return t('replacingImage');
      default:
        return '';
    }
  })();

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: 12 + insets.top }]}>
        <Pressable hitSlop={12} onPress={handleCancel} style={styles.topBtn}>
          <Text style={styles.topBtnText}>{t('back')}</Text>
        </Pressable>
        <TextInput
          ref={titleInputRef}
          value={docTitle}
          onChangeText={setDocTitle}
          placeholder={t('docNamePlaceholder')}
          placeholderTextColor="rgba(255,255,255,0.35)"
          style={styles.topTitleInput}
          maxLength={60}
          editable={!busy}
          returnKeyType="done"
          selectTextOnFocus
          accessibilityLabel={t('pdfNameA11y')}
        />
        <Pressable
          hitSlop={12}
          onPress={() => void handleSharePdf()}
          style={styles.topBtn}
          disabled={busy !== null || pages.length === 0}
        >
          <Text
            style={[
              styles.topBtnText,
              styles.saveText,
              (busy !== null || pages.length === 0) && styles.disabledText,
            ]}
          >
            {t('share')}
          </Text>
        </Pressable>
      </View>

      <View style={styles.previewArea} onLayout={onAreaLayout}>
        <View
          style={styles.previewStage}
          onLayout={onStageLayout}
          {...(cropMode ? {} : swipe.panHandlers)}
        >
          {activePage ? (
            cropMode && stageRect ? (
              <View
                style={[
                  styles.cropBox,
                  {
                    // 外扩一圈：贴边手柄有一半在图片外，触摸区域要包住它
                    left: stageRect.x - CROP_GRAB_PAD,
                    top: stageRect.y - CROP_GRAB_PAD,
                    width: stageRect.width + CROP_GRAB_PAD * 2,
                    height: stageRect.height + CROP_GRAB_PAD * 2,
                  },
                ]}
              >
                {/* 所见即所得：按当前算法处理后的画面取景，裁剪后再重新套算法；
                    有裁剪前原图时显示原图，保证画面和裁剪框同尺寸 */}
                <Image
                  source={{ uri: cropShownUri }}
                  style={[
                    styles.cropImage,
                    {
                      left: CROP_GRAB_PAD,
                      top: CROP_GRAB_PAD,
                      width: stageRect.width,
                      height: stageRect.height,
                    },
                  ]}
                  resizeMode="contain"
                />
                <CropOverlay
                  width={stageRect.width}
                  height={stageRect.height}
                  inset={CROP_GRAB_PAD}
                  quad={quad}
                  onChange={setQuad}
                  onActiveHandle={handleActiveHandle}
                />
              </View>
            ) : (
              <Image
                source={{ uri: displayUri }}
                style={styles.previewImage}
                resizeMode="contain"
              />
            )
          ) : (
            <View style={styles.emptyPreview}>
              <Text style={styles.emptyIcon}>🖼️</Text>
              <Text style={styles.emptyText}>{t('noPagesYet')}</Text>
              <Text style={styles.emptyHint}>{t('noPagesHint')}</Text>
            </View>
          )}

          {!cropMode && activePage && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('deleteCurrentPage')}
              hitSlop={8}
              onPress={handleRemove}
              style={({ pressed }) => [
                styles.stageDelete,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.stageDeleteText}>✕</Text>
            </Pressable>
          )}

          {(busy?.kind === 'import' ||
            busy?.kind === 'detect' ||
            busy?.kind === 'autocrop') && (
            <View style={styles.overlay}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.overlayText}>{busyText}</Text>
            </View>
          )}
          {(busy?.kind === 'apply' ||
            busy?.kind === 'detectServer' ||
            busy?.kind === 'crop' ||
            busy?.kind === 'replace' ||
            busy?.kind === 'pdf' ||
            busy?.kind === 'export') && (
            <View style={styles.processingPill}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.processingText}>{busyText}</Text>
            </View>
          )}
          {previewBusy && !busy && (
            <View style={styles.processingPill}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.processingText}>{t('generatingPreview')}</Text>
            </View>
          )}
          {error && <Text style={styles.error}>{error}</Text>}
        </View>
      </View>

      {/* 页码居中；「对比」和页码在同一水平线，删除按钮挪到图片右上角 */}
      <View style={styles.pagerRow}>
        <View style={styles.pagerSide} />
        <View style={styles.pagerCenter}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('previousPage')}
            disabled={!canInteract || active <= 0}
            onPress={() => selectPage(active - 1)}
            style={({ pressed }) => [
              styles.pagerBtn,
              (!canInteract || active <= 0) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <View style={[styles.pagerTri, styles.pagerTriLeft]} />
          </Pressable>
          <Text style={styles.pageLabel}>
            {pages.length ? `${active + 1} / ${pages.length}` : '0 / 0'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('nextPage')}
            disabled={!canInteract || active >= pages.length - 1}
            onPress={() => selectPage(active + 1)}
            style={({ pressed }) => [
              styles.pagerBtn,
              (!canInteract || active >= pages.length - 1) && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <View style={[styles.pagerTri, styles.pagerTriRight]} />
          </Pressable>
        </View>
        <View style={[styles.pagerSide, styles.pagerSideRight]}>
          {!cropMode && activePage && (
            // 按住显示原图：常态高亮「对比」，按住时高亮「原图」
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('holdToCompare')}
              onPressIn={() => setCompare(true)}
              onPressOut={() => setCompare(false)}
              style={({ pressed }) => [
                styles.comparePill,
                (compare || pressed) && styles.comparePillActive,
              ]}
            >
              <View
                style={[
                  styles.compareIcon,
                  compare && styles.compareIconActive,
                ]}
              >
                <View
                  style={[
                    styles.compareIconHalf,
                    compare && styles.compareIconHalfActive,
                  ]}
                />
              </View>
              <Text
                style={[
                  styles.comparePillText,
                  styles.comparePillTextDim,
                  compare && styles.comparePillTextOn,
                ]}
              >
                {t('original')}
              </Text>
              <Text
                style={[
                  styles.compareDivider,
                  compare && styles.comparePillTextOn,
                ]}
              >
                |
              </Text>
              <Text
                style={[
                  styles.comparePillText,
                  compare && styles.comparePillTextOn,
                ]}
              >
                {t('compare')}
              </Text>
            </Pressable>
          )}
        </View>
      </View>

      <View style={[styles.toolbar, { paddingBottom: 10 + insets.bottom }]}>
        {cropMode ? (
          <View style={styles.cropBar}>
            <Text
              style={[styles.cropHint, !cropValid && styles.cropHintInvalid]}
            >
              {cropValid ? t('cropHintValid') : t('cropHintInvalid')}
            </Text>
            <View style={styles.cropActions}>
              <Pressable
                onPress={closeCrop}
                disabled={busy !== null}
                style={({ pressed }) => [
                  styles.cropAction,
                  pressed && styles.pressed,
                  busy !== null && styles.disabled,
                ]}
              >
                <Text style={styles.cropActionText}>{t('cancel')}</Text>
              </Pressable>
              <Pressable
                onPress={() => setQuad(FULL_QUAD)}
                disabled={busy !== null}
                style={({ pressed }) => [
                  styles.cropAction,
                  pressed && styles.pressed,
                  busy !== null && styles.disabled,
                ]}
              >
                <Text style={styles.cropActionText}>{t('reset')}</Text>
              </Pressable>
              <Pressable
                onPress={() => void handleCropConfirm()}
                disabled={!cropValid || busy !== null || !baseUri || !stageRect}
                style={({ pressed }) => [
                  styles.cropAction,
                  styles.cropActionPrimary,
                  pressed && styles.pressed,
                  (!cropValid || busy !== null || !baseUri || !stageRect) &&
                    styles.disabled,
                ]}
              >
                <Text style={[styles.cropActionText, styles.cropActionPrimaryText]}>
                  {t('confirm')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>{t('imageProcessing')}</Text>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: applyAll }}
                onPress={() => setApplyAll((value) => !value)}
                style={({ pressed }) => [
                  styles.checkRow,
                  pressed && styles.pressed,
                ]}
              >
                <View
                  style={[styles.checkbox, applyAll && styles.checkboxOn]}
                >
                  {applyAll && <Text style={styles.checkMark}>✓</Text>}
                </View>
                <Text style={styles.checkLabel}>{t('applyToAllPages')}</Text>
              </Pressable>
            </View>

            {adjustOpen ? (
              <View style={styles.adjustPanel}>
                <View style={styles.adjustTop}>
                  <View style={styles.adjustChips}>
                    {ADJUST_KEYS.map((key) => {
                      const selected = adjustKey === key;
                      return (
                        <Pressable
                          key={key}
                          accessibilityRole="button"
                          accessibilityState={{ selected }}
                          onPress={() => setAdjustKey(key)}
                          style={[
                            styles.adjustChip,
                            selected && styles.adjustChipOn,
                          ]}
                        >
                          <Text
                            style={[
                              styles.adjustChipText,
                              selected && styles.adjustChipTextOn,
                            ]}
                          >
                            {adjustLabel(key)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  <View style={styles.adjustActions}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('discardAdjust')}
                      onPress={closeAdjust}
                      style={({ pressed }) => [
                        styles.adjustAction,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.adjustActionText}>✕</Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('saveAdjust')}
                      disabled={busy !== null}
                      onPress={confirmAdjust}
                      style={({ pressed }) => [
                        styles.adjustAction,
                        styles.adjustActionConfirm,
                        pressed && styles.pressed,
                        busy !== null && styles.disabled,
                      ]}
                    >
                      <Text
                        style={[
                          styles.adjustActionText,
                          styles.adjustActionConfirmText,
                        ]}
                      >
                        ✓
                      </Text>
                    </Pressable>
                  </View>
                </View>

                <View style={styles.sliderRow}>
                  <ValueSlider
                    value={draftAdjust[adjustKey]}
                    min={ADJUST_RANGE[adjustKey].min}
                    max={ADJUST_RANGE[adjustKey].max}
                    onValueChange={(value) => updateDraft(adjustKey, value)}
                    onSlidingComplete={(value) => {
                      updateDraft(adjustKey, value);
                      void renderAdjustPreview({
                        ...draftRef.current,
                        [adjustKey]: value,
                      });
                    }}
                  />
                  <Text style={styles.adjustValue}>
                    {formatAdjustValue(adjustKey, draftAdjust[adjustKey])}
                  </Text>
                </View>
                <Text style={styles.adjustHint}>
                  {applyAll ? t('adjustAppliesAll') : ''}
                  {t('adjustHint')}
                </Text>
              </View>
            ) : (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filterContent}
              >
                {SCAN_FILTERS.map((key) => {
                  const selected = activePage?.filter === key;
                  const thumb = thumbs[key] ?? activePage?.thumbUri;
                  return (
                    <Pressable
                      key={key}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={filterLabel(key)}
                      disabled={!canInteract || !activePage}
                      onPress={() => handleFilterPress(key)}
                      style={({ pressed }) => [
                        styles.filterTile,
                        selected && styles.filterTileOn,
                        pressed && !selected && styles.pressed,
                        (!canInteract || !activePage) && styles.disabled,
                      ]}
                    >
                      {thumb ? (
                        <Image
                          source={{ uri: thumb }}
                          style={styles.filterThumb}
                          resizeMode="cover"
                        />
                      ) : (
                        <View style={[styles.filterThumb, styles.filterThumbEmpty]} />
                      )}
                      <Text
                        style={[
                          styles.filterName,
                          selected && styles.filterNameOn,
                        ]}
                        numberOfLines={1}
                      >
                        {filterLabel(key)}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}

            <View style={styles.toolRow}>
              <ToolButton
                glyph="＋"
                label={t('importMore')}
                disabled={!canInteract}
                onPress={handleAdd}
              />
              <ToolButton
                glyph="↺"
                label={t('rotateLeft')}
                disabled={!canInteract || !activePage}
                onPress={() => handleRotate(270)}
              />
              <ToolButton
                glyph="↻"
                label={t('rotateRight')}
                disabled={!canInteract || !activePage}
                onPress={() => handleRotate(90)}
              />
              <ToolButton
                glyph="⌗"
                label={t('crop')}
                disabled={!canInteract || !activePage}
                onPress={handleCropStart}
              />
              <ToolButton
                glyph="T"
                label={t('extractText')}
                disabled={!canInteract || !activePage}
                onPress={() =>
                  Alert.alert(t('ocrComingTitle'), t('ocrComingBody'))
                }
              />
            </View>

            <View style={styles.exportRow}>
              <Pressable
                accessibilityRole="button"
                disabled={!canInteract || pages.length === 0}
                onPress={() => void handleSaveAllImages()}
                style={({ pressed }) => [
                  styles.exportBtn,
                  pressed && styles.pressed,
                  (!canInteract || pages.length === 0) && styles.disabled,
                ]}
              >
                <Text style={styles.exportText}>{t('saveAllImages')}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={!canInteract || pages.length === 0}
                onPress={() => void handleSavePdf()}
                style={({ pressed }) => [
                  styles.exportBtn,
                  styles.exportPrimary,
                  pressed && styles.pressed,
                  (!canInteract || pages.length === 0) && styles.disabled,
                ]}
              >
                <Text style={[styles.exportText, styles.exportPrimaryText]}>
                  {t('saveAsPdf')}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </View>

      {pickerMode !== null && (
        <View style={StyleSheet.absoluteFill}>
          <PhotoPickerScreen
            limit={pickerMode === 'add' ? limit - pages.length : 1}
            title={
              pickerMode === 'add' ? t('pickerAddTitle') : t('retakePage')
            }
            onCancel={() => setPickerMode(null)}
            onDone={(uris) => {
              const mode = pickerMode;
              setPickerMode(null);
              if (!uris.length) return;
              if (mode === 'replace') {
                void handleReplacePage(uris[0]);
              } else {
                void addImages(uris, true);
              }
            }}
          />
        </View>
      )}

      {/* 放大镜画在最外层：可以超出图片和预览区边界，超出部分透明 */}
      {loupeLayout && (
        <CropLoupe
          uri={cropShownUri}
          imageWidth={loupeLayout.imageWidth}
          imageHeight={loupeLayout.imageHeight}
          focusX={loupeLayout.focusX}
          focusY={loupeLayout.focusY}
          left={loupeLayout.left}
          top={loupeLayout.top}
          edgeAngle={loupeLayout.edgeAngle}
        />
      )}
    </View>
  );
}

function formatAdjustValue(key: AdjustKey, value: number): string {
  if (key === 'detail') return String(value);
  return value > 0 ? `+${value}` : String(value);
}

function ToolButton({
  glyph,
  label,
  onPress,
  disabled,
}: {
  glyph: string;
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolBtn,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={styles.toolGlyph}>{glyph}</Text>
      <Text style={styles.toolLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * 无第三方依赖的滑动条。
 * 拖动时只更新数值，松手才触发 onSlidingComplete（用来重算预览）。
 */
function ValueSlider({
  value,
  min,
  max,
  onValueChange,
  onSlidingComplete,
}: {
  value: number;
  min: number;
  max: number;
  onValueChange: (value: number) => void;
  onSlidingComplete: (value: number) => void;
}) {
  const widthRef = useRef(0);
  const valueRef = useRef(value);
  const changeRef = useRef(onValueChange);
  const completeRef = useRef(onSlidingComplete);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    changeRef.current = onValueChange;
  }, [onValueChange]);
  useEffect(() => {
    completeRef.current = onSlidingComplete;
  }, [onSlidingComplete]);

  const responder = useMemo(() => {
    const update = (locationX: number) => {
      const width = widthRef.current;
      if (!width) return;
      const ratio = Math.min(1, Math.max(0, locationX / width));
      const next = Math.round(min + ratio * (max - min));
      if (next === valueRef.current) return;
      valueRef.current = next;
      changeRef.current(next);
    };
    // 回调只在拖动时执行；value/complete 通过 ref 取最新值
    // eslint-disable-next-line react-hooks/refs
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => update(event.nativeEvent.locationX),
      onPanResponderMove: (event) => update(event.nativeEvent.locationX),
      onPanResponderRelease: () => completeRef.current(valueRef.current),
      onPanResponderTerminate: () => completeRef.current(valueRef.current),
    });
  }, [min, max]);

  const ratio = max === min ? 0 : (value - min) / (max - min);
  const percent = `${Math.min(100, Math.max(0, ratio * 100))}%` as const;

  return (
    <View
      style={styles.sliderTrackArea}
      onLayout={(event) => {
        widthRef.current = event.nativeEvent.layout.width;
      }}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={styles.sliderTrack}>
        <View style={[styles.sliderFill, { width: percent }]} />
      </View>
      <View pointerEvents="none" style={[styles.sliderThumb, { left: percent }]} />
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
    paddingBottom: 10,
  },
  topBtn: { minWidth: 52 },
  topBtnText: { color: '#c9ced8', fontSize: 15 },
  saveText: { color: '#6ea0ff', fontWeight: '700', textAlign: 'right' },
  disabledText: { color: '#5b6270' },
  topTitleInput: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
    paddingVertical: 4,
    paddingHorizontal: 8,
    marginHorizontal: 4,
    borderRadius: 8,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.18)',
  },
  previewArea: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  previewStage: { flex: 1, overflow: 'hidden' },
  previewImage: { width: '100%', height: '100%' },
  cropBox: { position: 'absolute' },
  // 按像素尺寸摆在触摸区域里，见 CROP_GRAB_PAD
  cropImage: { position: 'absolute' },
  emptyPreview: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { fontSize: 40, marginBottom: 10 },
  emptyText: { color: '#dfe4ee', fontSize: 15, fontWeight: '600' },
  emptyHint: { color: '#7f8698', fontSize: 12, marginTop: 6 },
  // 删除按钮：图片（舞台）右上角
  stageDelete: {
    position: 'absolute',
    top: 10,
    right: 10,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(20,24,33,0.72)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stageDeleteText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  // 「原图 | 对比」：图标 + 两个词，按住时整只高亮
  comparePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    height: 28,
    paddingHorizontal: 7,
    borderRadius: 8,
    backgroundColor: '#e9edf5',
  },
  comparePillActive: { backgroundColor: 'rgba(47,107,255,0.95)' },
  compareIcon: {
    width: 13,
    height: 11,
    borderRadius: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#7f8698',
    overflow: 'hidden',
    marginRight: 1,
  },
  compareIconHalf: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '50%',
    backgroundColor: '#111318',
  },
  compareIconActive: { borderColor: '#fff' },
  compareIconHalfActive: { backgroundColor: '#fff' },
  comparePillText: { color: '#111318', fontSize: 10, fontWeight: '700' },
  comparePillTextDim: { color: '#8a90a0', fontWeight: '600' },
  comparePillTextOn: { color: '#fff' },
  compareDivider: { color: '#b3b9c6', fontSize: 10 },
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
  processingPill: {
    position: 'absolute',
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(20,24,33,0.88)',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  processingText: { color: '#fff', fontSize: 12 },
  error: {
    position: 'absolute',
    bottom: 8,
    color: '#ff9a9a',
    fontSize: 13,
  },
  pagerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  // 左右都是 flex:1，中间页码组保持居中；右边放「原图|对比」
  pagerSide: { flex: 1 },
  pagerSideRight: { alignItems: 'flex-end' },
  pagerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  pagerBtn: {
    width: 38,
    height: 28,
    borderRadius: 8,
    backgroundColor: '#e9edf5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 用 border 画三角，避免 ◀ / ▶ 在 Android 上被渲染成 emoji
  pagerTri: {
    width: 0,
    height: 0,
    borderTopWidth: 6,
    borderBottomWidth: 6,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
  },
  pagerTriLeft: { borderRightWidth: 9, borderRightColor: '#111318' },
  pagerTriRight: { borderLeftWidth: 9, borderLeftColor: '#111318' },
  pageLabel: {
    minWidth: 56,
    textAlign: 'center',
    color: '#dfe4ee',
    fontSize: 13,
    fontWeight: '600',
  },
  toolbar: {
    backgroundColor: '#141821',
    paddingHorizontal: 16,
    paddingTop: 8,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  sectionTitle: { color: '#dfe4ee', fontSize: 13, fontWeight: '700' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  checkbox: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: '#4a5266',
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  checkMark: { color: '#fff', fontSize: 12, fontWeight: '800', lineHeight: 15 },
  checkLabel: { color: '#9aa3b5', fontSize: 12 },
  filterContent: { gap: 8, paddingBottom: 4, paddingRight: 4 },
  filterTile: {
    width: 58,
    borderRadius: 10,
    padding: 3,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
  },
  filterTileOn: { borderColor: theme.primary, backgroundColor: 'rgba(47,107,255,0.12)' },
  filterThumb: {
    width: 48,
    height: 48,
    borderRadius: 7,
    backgroundColor: '#232838',
  },
  filterThumbEmpty: { backgroundColor: '#232838' },
  filterName: { color: '#9aa3b5', fontSize: 10, marginTop: 4, textAlign: 'center' },
  filterNameOn: { color: '#fff', fontWeight: '700' },
  adjustPanel: { paddingBottom: 2 },
  adjustTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  adjustChips: { flexDirection: 'row', gap: 8, flex: 1 },
  adjustChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: '#232838',
  },
  adjustChipOn: { backgroundColor: theme.primary },
  adjustChipText: { color: '#c9ced8', fontSize: 12, fontWeight: '600' },
  adjustChipTextOn: { color: '#fff' },
  adjustActions: { flexDirection: 'row', gap: 8 },
  adjustAction: {
    width: 38,
    height: 32,
    borderRadius: 9,
    backgroundColor: '#232838',
    alignItems: 'center',
    justifyContent: 'center',
  },
  adjustActionConfirm: { backgroundColor: theme.primary },
  adjustActionText: { color: '#dfe4ee', fontSize: 15, fontWeight: '700' },
  adjustActionConfirmText: { color: '#fff' },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 },
  sliderTrackArea: {
    flex: 1,
    height: 32,
    justifyContent: 'center',
  },
  sliderTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: '#2c3242',
    overflow: 'hidden',
  },
  sliderFill: { height: 4, backgroundColor: theme.primary },
  sliderThumb: {
    position: 'absolute',
    top: 8,
    width: 16,
    height: 16,
    marginLeft: -8,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 3,
    borderColor: theme.primary,
  },
  adjustValue: {
    minWidth: 34,
    textAlign: 'right',
    color: '#dfe4ee',
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  adjustHint: { color: '#7f8698', fontSize: 11, marginTop: 6 },
  toolRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  toolBtn: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: '#1c212c',
  },
  toolGlyph: { color: '#dfe4ee', fontSize: 16, lineHeight: 20, fontWeight: '600' },
  toolLabel: { color: '#9aa3b5', fontSize: 10, marginTop: 2 },
  exportRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  exportBtn: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#232838',
    alignItems: 'center',
  },
  exportPrimary: { backgroundColor: theme.primary },
  exportText: { color: '#dfe4ee', fontSize: 13, fontWeight: '700' },
  exportPrimaryText: { color: '#fff' },
  cropBar: { paddingVertical: 4 },
  cropHint: { color: '#9aa3b5', fontSize: 12, textAlign: 'center' },
  // 非凸四边形（边交叉/凹陷）：边框和提示一起变红
  cropHintInvalid: { color: '#ff453a', fontWeight: '600' },
  cropActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  cropAction: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 10,
    backgroundColor: '#232838',
    alignItems: 'center',
  },
  cropActionPrimary: { backgroundColor: theme.primary },
  cropActionText: { color: '#dfe4ee', fontSize: 13, fontWeight: '700' },
  cropActionPrimaryText: { color: '#fff' },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.4 },
});
