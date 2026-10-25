/**
 * 轻量多语言层（无第三方 i18n 依赖）。
 *
 * - 英文词典是唯一类型来源：所有其他语言的键必须与英文键一一对应，
 *   漏翻/多键在 `tsc --noEmit` 阶段就会报错。
 * - 支持 en / zh / zh-Hant / ja / ko / fr / de / es / pt；
 *   简体中文写在本文件，其余 7 种在 `locales/` 下各自一个模块。
 * - 文案用 `{name}` 占位符；复数按 `key_one` / `key_other` 两套键，
 *   中文、日文、韩文两套键写同样的文本（没有单复数变化）。
 * - 语言选择持久化在 AsyncStorage；默认跟随系统（expo-localization），
 *   中文按脚本/地区区分简繁，未支持的语言回退到英文。
 * - `useI18n()` 订阅语言变化，切换后界面立即重渲染；非组件代码用
 *   `t()` / `tp()` 读当前语言。
 */
import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';

import de from './locales/de';
import es from './locales/es';
import fr from './locales/fr';
import ja from './locales/ja';
import ko from './locales/ko';
import pt from './locales/pt';
import zhHant from './locales/zh-Hant';

export const LOCALES = [
  'en',
  'zh',
  'zh-Hant',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'pt',
] as const;
export type Locale = (typeof LOCALES)[number];

/** 用户设置：跟随系统，或固定某种语言 */
export type LocalePreference = 'system' | Locale;

const STORAGE_KEY = 'settings.locale.v1';

/** 英文文案（类型来源） */
const en = {
  // ---- 通用 ----
  appName: 'Scan Demo',
  cancel: 'Cancel',
  delete: 'Delete',
  remove: 'Remove',
  back: 'Back',
  done: 'Done',
  close: 'Close',
  retry: 'Retry',
  ok: 'OK',
  save: 'Save',
  share: 'Share',
  reset: 'Reset',
  confirm: 'Confirm',
  start: 'Start',
  preview: 'Preview',
  unknownError: 'Unknown error',
  pageCount_one: '{count} page',
  pageCount_other: '{count} pages',
  documentCount_one: '{count} document',
  documentCount_other: '{count} documents',
  pdfCount_one: '{count} PDF',
  pdfCount_other: '{count} PDFs',
  scanCount_one: '{count} scan',
  scanCount_other: '{count} scans',
  selectedCount_one: '{count} selected',
  selectedCount_other: '{count} selected',
  pageN: 'Page {n}',
  pageOfPages: 'Page {current} / {total}',
  editPageTitle: 'Edit page {n}',

  // ---- 底部导航 ----
  tabHome: 'Home',
  tabDocs: 'Documents',
  tabTools: 'Tools',
  tabProfile: 'Me',
  tabCamera: 'Camera',

  // ---- 首页 ----
  homeSubtitle: 'Document scanning · Smart enhancement · Everywhere',
  homeScan: 'Scan',
  homeScanHint: 'Use the camera',
  homeImport: 'Import',
  homeImportHint: 'From your library',
  homeSample: 'Sample',
  homeSampleHint: 'Try without a camera',
  imageToPdf: 'Images to PDF',
  imageToPdfHint: 'Multi-select · Auto enhance · Reorder · Export',
  pdfDocuments: 'PDFs',
  recentScans: 'Recent scans',
  pendingRegeneration: 'Needs regenerate',
  generated: 'Generated',
  documentMeta: '{pages} · {status} · {date}',
  recentMeta: '{pages} · {date}',
  emptyHomeTitle: 'No scans yet',
  emptyHomeHint: 'Tap Scan, Import or Sample above to start',
  homeFooter:
    'One codebase for Android + iOS · Long-press a document to delete · Data stays on this device',
  sampleLoadFailedTitle: 'Couldn’t load the sample',
  sampleLoadFailedBody:
    'Try taking a photo or importing an image from your library instead.',
  sampleDocumentTitle: 'Sample document',
  importImages: 'Import images',
  saveFailedTitle: 'Save failed',
  deletePdfTitle: 'Delete PDF',
  deletePdfBody:
    'This removes the PDF and all its source images. This can’t be undone.',

  // ---- 全部文档 ----
  allDocuments: 'All documents',
  docsSummary: '{pdfs} · {scans}',
  filterAll: 'All',
  filterPdf: 'PDF',
  filterScan: 'Scans',
  emptyDocsAll: 'No documents yet',
  emptyDocsPdf: 'No PDFs yet',
  emptyDocsScan: 'No scans yet',
  emptyDocsScanHint: 'Tap the camera button below to start scanning',
  emptyDocsPdfHint: 'Turn images into a PDF you can flip through anytime',
  deleteA11y: 'Delete',

  // ---- 工具箱 ----
  toolsTitle: 'Tools',
  toolsSubtitle: 'Scan, convert and organize',
  toolPdfHint: 'Multi-select · Auto enhance',
  toolScan: 'Scan',
  toolScanHint: 'Auto-enhance after capture',
  toolImport: 'Import images',
  toolImportHint: 'From your library',
  toolSample: 'Sample',
  toolSampleHint: 'Quick try without a camera',
  comingSoon: 'Coming soon',
  reservedApi: 'Planned',
  autoCrop: 'Auto crop',
  autoCropHint: 'Find the page corners automatically',
  annotate: 'Annotate',
  annotateHint: 'Handwriting and text notes',
  ocr: 'Text recognition',
  ocrHint: 'Extract text from images',
  soonTag: 'Soon',
  toolsFooter:
    'Everything is processed on this device. Images are only sent to a server you configure, and only when you tap Crop.',

  // ---- 我的 ----
  nativeEngine: 'Native C++',
  canvasEngine: 'WebView Canvas',
  nativeEngineHint: 'Images go straight to the algorithm, no base64',
  canvasEngineHint: 'Expo Go fallback — a development build is recommended',
  versionLine: 'Version {version} · Data stays on this device',
  statScans: 'Scans',
  statTotalPages: 'Pages',
  algorithmEngine: 'Algorithm engine',
  engineVersion: 'Engine version',
  notLoaded: 'Not loaded',
  storageLocation: 'Storage',
  appSandbox: 'App sandbox',
  appSandboxHint: 'Removed when the app is uninstalled',
  privacy: 'Privacy',
  onDeviceOnly: 'On-device by default',
  platform: 'Platform',
  profileFooter: 'Android + iOS + HarmonyOS share the same C++ algorithms',
  language: 'Language',
  languageSystem: 'System default',
  languageChinese: '简体中文',
  languageTraditionalChinese: '繁體中文',
  languageEnglish: 'English',
  languageJapanese: '日本語',
  languageKorean: '한국어',
  languageFrench: 'Français',
  languageGerman: 'Deutsch',
  languageSpanish: 'Español',
  languagePortuguese: 'Português',
  languageHint: 'Changes the app immediately',

  // ---- 相机 ----
  captureFailedTitle: 'Capture failed',
  captureFailedBody:
    'This device or emulator may not have a working camera. Try importing an image or the sample document.',
  cameraPermissionTitle: 'Camera access needed',
  cameraPermissionHint: 'Used to photograph documents for scanning',
  grantPermission: 'Allow access',
  scanDocumentTitle: 'Scan a document',
  frameHint: 'Fit the document inside the frame',
  library: 'Library',

  // ---- 相册选择器 ----
  selectImages: 'Select images',
  readingLibrary: 'Reading your library…',
  libraryPermissionTitle: 'No photo access',
  libraryPermissionHint:
    'Reading photos requires library access. You can enable it in Settings.',
  openSettings: 'Open Settings',
  libraryReadFailed: 'Couldn’t read your library',
  noPhotosTitle: 'No photos yet',
  noPhotosHint: 'Take a few photos first, then come back.',
  selectedNth: 'Selected #{n}',
  selectThisImage: 'Select this image',
  maxSelectable: 'Up to {count} images',
  doneWithCount: 'Done ({count})',
  deselect: 'Deselect',
  addImages: 'Add images',
  retakePage: 'Retake this page',

  // ---- 扫描文档详情 ----
  photoPermissionAlertTitle: 'Photo access needed',
  photoPermissionAlertBody:
    'Allow photo access in system settings and try again.',
  exportedTitle: 'Saved',
  exportedBody_one: '{count} page exported to your photo library.',
  exportedBody_other: '{count} pages exported to your photo library.',
  exportFailedTitle: 'Export failed',
  exportPartial: 'Exported {exported} pages; writing the rest failed: {message}',
  exportNone: 'Couldn’t write to your photo library: {message}',
  deleteDocumentTitle: 'Delete document',
  deleteDocumentBody: 'Delete this scan? It has {pages}.',
  emptyDocument: 'This document has no pages',
  rotated: 'Rotated {degrees}°',
  scannedAt: 'Scanned {date}',
  exportingProgress: 'Exporting {done}/{total}',
  exportPagesToLibrary: 'Export {count} pages to Library',
  exportToLibrary: 'Export to Library',

  // ---- 扫描编辑器 ----
  importFailedTitle: 'Import failed',
  imageReadFailed: 'Couldn’t read the image. Please choose it again.',
  pageLimitTitle: 'Page limit reached',
  scanPageLimitBody:
    'A document can have up to {limit} pages. Start a new document for more images.',
  processingFailed: 'Processing failed: {message}',
  retakeFailedTitle: 'Retake failed',
  deleteOrRetakeBody:
    'Delete this page, or retake it to replace the photo?',
  retakeThisPageAction: 'Retake page',
  reselectThisPageAction: 'Reselect page',
  cancelThisPageAction: 'Cancel this page',
  deleteThisPageAction: 'Delete page',
  invalidAreaTitle: 'Invalid selection',
  convexQuadBody:
    'The four corners must form a convex quadrilateral — edges can’t cross or cave in.',
  cropTooSmallTitle: 'Crop area too small',
  cropTooSmallBody:
    'Drag the corners or edges so the frame covers the document.',
  cropFailedTitle: 'Crop failed',
  savedToLibraryBody_one: '{count} page saved to your photo library.',
  savedToLibraryBody_other: '{count} pages saved to your photo library.',
  savedPartial: 'Saved {saved} pages; writing the rest failed: {message}',
  shareUnavailableTitle: 'Sharing unavailable',
  shareUnavailableBody: 'This device doesn’t support the system share sheet.',
  shareSheetFailed: 'Couldn’t open the share sheet',
  shareOptionsBody:
    'Share the current image, this page as a PDF, or the whole document as a PDF.',
  shareThisImage: 'Share this image',
  shareThisPage: 'Share this page',
  shareDocument: 'Share document',
  shareImageFailed: 'Couldn’t share the image',
  pdfCreateFailed: 'Couldn’t create the PDF',
  docNamePlaceholder: 'PDF name',
  pdfNameA11y: 'PDF document name',
  noPagesYet: 'No pages yet',
  noPagesHint: 'Tap Import below to add images',
  deleteCurrentPage: 'Delete current page',
  importingProgress: 'Importing {done}/{total}',
  applyingProgress: 'Processing {done}/{total}',
  creatingPdf: 'Creating PDF…',
  creatingPdfProgress: 'Creating PDF {done}/{total}',
  savingToLibraryProgress: 'Saving to library {done}/{total}',
  cropping: 'Cropping…',
  replacingImage: 'Replacing image…',
  generatingPreview: 'Generating preview…',
  previousPage: 'Previous page',
  nextPage: 'Next page',
  holdToCompare: 'Hold to view the original',
  original: 'Original',
  compare: 'Compare',
  cropHintValid: 'Drag the corners or edges to frame the document',
  cropHintInvalid:
    'Invalid area: the four points must form a convex quadrilateral',
  imageProcessing: 'Image processing',
  applyToAllPages: 'Apply to all pages',
  discardAdjust: 'Discard adjustments',
  saveAdjust: 'Save adjustments',
  adjustAppliesAll: 'Applies to all pages · ',
  adjustHint: '✓ save, ✕ discard',
  importMore: 'Import',
  rotateLeft: 'Left',
  rotateRight: 'Right',
  rotateLeftA11y: 'Rotate left',
  rotateRightA11y: 'Rotate right',
  crop: 'Crop',
  extractText: 'Extract text',
  ocrComingTitle: 'Extract text',
  ocrComingBody: 'OCR text recognition is still in development.',
  ocrSubtitle:
    'Capture or import pages, adjust the crop, then extract the text.',
  ocrAddPages: 'Add pages',
  ocrStart: 'Recognize text',
  ocrRecognize: 'Recognize',
  ocrRecognizeAgain: 'Recognize again',
  ocrImporting: 'Importing {done}/{total}',
  ocrDetecting: 'Detecting document edges…',
  ocrCropping: 'Cropping…',
  ocrRecognizing: 'Recognizing {done}/{total}',
  ocrRecognizingOne: 'Recognizing text…',
  ocrImportFailedTitle: 'Import failed',
  ocrCropFailedTitle: 'Crop failed',
  ocrNeedsServerTitle: 'Text recognition service not set',
  ocrNeedsServerBody:
    'Set the document service address in Profile first. Pages are sent to that server for text recognition.',
  ocrFailedTitle: 'Recognition failed',
  ocrFailedBody_one:
    '{count} page could not be recognized. Check the server and try again.',
  ocrFailedBody_other:
    '{count} pages could not be recognized. Check the server and try again.',
  ocrNoTextPage: 'No text was found on this page.',
  ocrNoText: 'Nothing to copy yet.',
  ocrCopied: 'Copied to clipboard',
  ocrDefaultTitle: 'Recognized text',
  ocrExportedTitle: 'Text saved',
  ocrExportFailedTitle: 'Couldn’t save the text',
  ocrCopyAll: 'Copy all text',
  ocrExportTxt: 'Export TXT',
  ocrResultHint: 'Recognized text will appear here',
  ocrSelectHint: 'Tap a box on the image or a line below to locate it',
  ocrEmptyPages: 'No pages yet',
  ocrEmptyPagesHint:
    'Capture a photo or import images, then extract the text.',
  ocrLines_one: '{count} line',
  ocrLines_other: '{count} lines',
  ocrCropHint: 'Drag the corners or edges to frame the text area',
  ocrRevert: 'Restore original text',
  ocrEdited: 'Edited',
  ocrLowConfidence: 'Check',
  ocrDeletePageTitle: 'Delete page',
  ocrDeletePageBody: 'Remove this page from the recognition?',
  saveAllImages: 'Save all images',
  saveAsPdf: 'Save as PDF',
  pdfSavedTitle: 'PDF saved',
  pdfSavedBody: '{name} was saved to the folder you chose.',
  pdfSavedToAppBody: '{name} was saved inside the app.\n{path}',
  saveToPhoneFolder: 'Save to phone…',
  pdfReadyPath: 'File location: {path}',
  overwritePdfTitle: 'File already exists',
  overwritePdfBody:
    'A file named {name} already exists in that folder. Replace it?',
  replaceFileAction: 'Replace',
  savePdfFailedTitle: 'Couldn’t save the PDF',
  savePdfFolderBlocked:
    'That folder can’t be written to — the system file service returned an error. Pick another folder (for example “Documents” or internal storage) and try again.',
  chooseAnotherFolder: 'Choose another folder',
  busyTitle: 'Still working',
  busyBody: 'The current operation hasn’t finished yet.',
  keepWaiting: 'Keep waiting',
  discardAndLeave: 'Discard and leave',
  discardEditsTitle: 'Exit and discard edits?',
  discardEditsBody_one: 'The imported page won’t be saved.',
  discardEditsBody_other: '{count} imported pages won’t be saved.',
  keepEditing: 'Keep editing',
  exitEdit: 'Exit',
  exitEditingAction: 'Exit editing',
  pickerAddTitle: 'Add images',

  // ---- 单页编辑器 ----
  imageReadFailedShort: 'Couldn’t read the image',
  filterFailed: 'Filter failed: {message}',
  rotationFailed: 'Rotation failed',
  savingLabel: 'Saving',
  savingEllipsis: 'Saving…',
  processingEllipsis: 'Processing…',
  filter: 'Filter',
  pageTools: 'Page tools',
  cropReservedTitle: 'Crop (API reserved)',
  cropReservedBody:
    'An ONNX model will detect the document corners and apply perspective correction. No model is bundled in this version; the detection and crop APIs live in src/lib/documentDetection.ts, and results are stored in PdfPage.cropQuad.',
  annotateReservedTitle: 'Annotations (API reserved)',
  annotateReservedBody:
    'Annotations are stored as normalized coordinates in PdfPage.annotations. The rendering layer (Canvas / native compositing) is not implemented yet.',
  resetToOriginal: 'Reset to original',
  saveThenRegenerate:
    'After saving, return to the PDF page and tap Regenerate PDF.',
  leftShort: 'Left',
  rightShort: 'Right',
  saveA11y: 'Save',

  // ---- PDF 排版 -
  pageLimitPdfBody:
    'This device supports up to {limit} pages per PDF. Split longer documents into several PDFs.',
  removePageTitle: 'Remove page',
  removePageBody: 'Remove page {n}?',
  applyFailedTitle: 'Couldn’t apply filter',
  applyAllTitle: 'Apply to all pages',
  applyAllOriginalBody:
    'All {count} pages will be reset to their originals (rotation kept). Manual adjustments will be overwritten.',
  applyAllFilterBody_one:
    '“{filter}” will be applied to {count} page. Manually adjusted pages will be overwritten.',
  applyAllFilterBody_other:
    '“{filter}” will be applied to {count} pages. Manually adjusted pages will be overwritten.',
  pdfCreatedTitle: 'PDF created',
  pdfCreatedBody_one: '{count} page. Tap Share PDF to export.',
  pdfCreatedBody_other: '{count} pages. Tap Share PDF to export.',
  createFailedTitle: 'Couldn’t create the PDF',
  shareFailedTitle: 'Sharing failed',
  regeneratePdf: 'Regenerate PDF',
  createPdf: 'Create PDF',
  sharePdf: 'Share PDF',
  read: 'Read',
  applyOnImport: 'Apply on import',
  applyOnImportHint:
    'New images use this filter. Tap ✎ on a page to adjust it individually.',
  restoreAllOriginals: '↺ Restore all originals',
  applyFilterToDocument: 'Apply “{filter}” to the whole document',
  noPagesAddImages: 'No pages yet — add some images.',
  pagesOutOfDate:
    'Pages have changed, so the current PDF is out of date. Regenerate before sharing.',
  reorderThenCreate: 'Reorder with ↑ ↓, then create the PDF.',
  pdfUpToDate: 'PDF up to date · {count} pages',
  reorderHint: '{count} pages · reorder with ↑ ↓',
  emptyPdfTitle: 'Turn photos into a PDF',
  emptyPdfHint:
    'Multi-select and reorder. New images use the filter selected above ({filter}); pages can still be adjusted separately.',
  filterMode: '{filter} mode',
  movePageUp: 'Move page {n} up',
  movePageDown: 'Move page {n} down',
  removePageN: 'Remove page {n}',
  addImagesPlus: '＋ Add images',
  importingImages: 'Importing images',
  applyingFilter: 'Applying filter',
  creatingPdfTitle: 'Creating PDF',
  layoutWriting: 'Writing pages…',
  pdfFooterHint:
    'Tap ✎ to enhance or rotate a single page (crop and annotations are planned).{memory} Up to {limit} pages per PDF; page images shrink as the document grows (≤8 pages 1800px · ≤25 pages 1500px · more 1200px, lower on low-memory devices).',
  memoryHint: 'This device has about {gb} GB of RAM. ',

  // ---- PDF 阅读器 ----
  layout: 'Layout',
  editThisPage: '✎ Edit this page · page {n}',
  readerEmpty: 'This document has no pages',
  readerEmptyHint: 'Go to Layout to add images.',
  readerDirty:
    'Pages have changed and the PDF is out of date. Regenerate it from Layout.',

  // ---- 算法与微调 ----
  filterOriginal: 'Original',
  filterShadow: 'De-shadow',
  filterDehand: 'Remove handwriting',
  filterHd: 'HD',
  filterBrighten: 'Brighten',
  filterSharpen: 'Sharpen',
  filterInksave: 'Ink saver',
  filterEnhance: 'Enhance',
  filterGray: 'Grayscale',
  filterBw: 'B&W',
  filterInvert: 'Invert',
  adjustContrast: 'Contrast',
  adjustBrightness: 'Brightness',
  adjustDetail: 'Detail',

  // ---- 默认名称与错误 ----
  defaultScanTitle: 'Scan',
  defaultPdfTitle: 'PDF document',
  defaultDocumentName: 'Document',
  errorCancelled: 'Cancelled',
  errorImageProcessing: 'Image processing failed',
  errorEngineTimeout: 'The filter engine took too long to start',
  errorEngineNotReady: 'The filter engine isn’t ready',
  errorProcessingTimeout: 'Image processing timed out',
  errorMissingImageData: 'Missing processed image data',
  errorAtLeastOneImage: 'Add at least one image',
  errorPdfPageLimit: 'This device supports up to {limit} pages per PDF',
  errorOcrNotConnected:
    'Document edge detection isn’t available yet (ONNX API reserved)',
  errorPerspectiveNotImplemented:
    'Perspective crop isn’t implemented yet: ONNX detection is wired up but the warp step is missing',
  cropA11y:
    'Crop area. Drag the four corners or the middle of an edge to adjust.',

  // ---- 文档检测 ----
  detectionServer: 'Document detection service',
  detectionServerHint:
    'Optional. When you tap Crop, model_1228 on this server re-detects the corners.',
  detectionServerPlaceholder: 'http://192.168.1.10:10000',
  detectionServerTest: 'Test connection',
  detectionServerTesting: 'Testing…',
  detectionServerReachable: 'Reachable',
  detectionServerUnreachable: 'Unreachable',
  detectionServerClear: 'Clear',
  detectionServerSaved: 'Saved',
  detecting: 'Detecting edges…',
  detectingProgress: 'Detecting {done}/{total}',
  autoCropping: 'Cropping…',
  autoCroppingProgress: 'Cropping {done}/{total}',
  detectingServer: 'Detecting on server…',
  liveDetectHint: 'Align the document inside the frame',
  liveCorners: 'Corners',
} as const;

export type MessageKey = keyof typeof en;

type PluralSuffix = '_one' | '_other';
/** 复数基名，例如 `pageCount`（对应 pageCount_one / pageCount_other） */
export type PluralKey = {
  [K in MessageKey]: K extends `${infer Base}${PluralSuffix}` ? Base : never;
}[MessageKey];

type MessageParams = Record<string, string | number>;

/** 中文文案：Record 保证每个英文键都有对应翻译 */
const zh: Record<MessageKey, string> = {
  appName: '扫描 Demo',
  cancel: '取消',
  delete: '删除',
  remove: '移除',
  back: '返回',
  done: '完成',
  close: '关闭',
  retry: '重试',
  ok: '好',
  save: '保存',
  share: '分享',
  reset: '重置',
  confirm: '确定',
  start: '开始',
  preview: '预览',
  unknownError: '未知错误',
  pageCount_one: '{count} 页',
  pageCount_other: '{count} 页',
  documentCount_one: '{count} 份文档',
  documentCount_other: '{count} 份文档',
  pdfCount_one: '{count} 份 PDF',
  pdfCount_other: '{count} 份 PDF',
  scanCount_one: '{count} 份扫描',
  scanCount_other: '{count} 份扫描',
  selectedCount_one: '已选 {count} 张',
  selectedCount_other: '已选 {count} 张',
  pageN: '第 {n} 页',
  pageOfPages: '第 {current} / {total} 页',
  editPageTitle: '编辑第 {n} 页',

  tabHome: '首页',
  tabDocs: '全部文档',
  tabTools: '工具箱',
  tabProfile: '我的',
  tabCamera: '相机',

  homeSubtitle: '文档扫描 · 智能增强 · 多端通用',
  homeScan: '拍照扫描',
  homeScanHint: '调用相机',
  homeImport: '导入图片',
  homeImportHint: '从相册选择',
  homeSample: '示例文档',
  homeSampleHint: '免相机体验',
  imageToPdf: '图片转 PDF',
  imageToPdfHint: '多选 · 自动算法 · 调整顺序 · 导出',
  pdfDocuments: 'PDF 文档',
  recentScans: '最近扫描',
  pendingRegeneration: '待重新生成',
  generated: '已生成',
  documentMeta: '{pages} · {status} · {date}',
  recentMeta: '{pages} · {date}',
  emptyHomeTitle: '还没有扫描记录',
  emptyHomeHint: '点击上方「拍照扫描 / 导入图片 / 示例文档」开始',
  homeFooter:
    'Android + iOS 同一套代码 · 长按文档可快速删除 · 数据只保存在本机',
  sampleLoadFailedTitle: '加载示例失败',
  sampleLoadFailedBody: '请改用拍照或相册导入。',
  sampleDocumentTitle: '示例文档',
  importImages: '导入图片',
  saveFailedTitle: '保存失败',
  deletePdfTitle: '删除 PDF',
  deletePdfBody: '将删除 PDF 和全部源图片，无法恢复。',

  allDocuments: '全部文档',
  docsSummary: '{pdfs} · {scans}',
  filterAll: '全部',
  filterPdf: 'PDF',
  filterScan: '扫描',
  emptyDocsAll: '还没有文档',
  emptyDocsPdf: '还没有 PDF 文档',
  emptyDocsScan: '还没有扫描记录',
  emptyDocsScanHint: '点底部的相机按钮开始扫描',
  emptyDocsPdfHint: '把图片整理成 PDF，随时翻页查看',
  deleteA11y: '删除',

  toolsTitle: '工具箱',
  toolsSubtitle: '扫描、转换与整理',
  toolPdfHint: '多选图片 · 自动算法',
  toolScan: '拍照扫描',
  toolScanHint: '拍摄后自动增强',
  toolImport: '导入图片',
  toolImportHint: '从相册选择',
  toolSample: '示例文档',
  toolSampleHint: '不用相机快速体验',
  comingSoon: '即将上线',
  reservedApi: '预留接口',
  autoCrop: '自动切边',
  autoCropHint: '自动找到纸张四角',
  annotate: '批注',
  annotateHint: '手写与文字标注',
  ocr: '文字识别',
  ocrHint: '提取图片里的文字',
  soonTag: '敬请期待',
  toolsFooter:
    '所有处理都在本机完成；只有配置了识别服务并点「裁剪」时，当前图片才会发给该服务。',

  nativeEngine: '原生 C++',
  canvasEngine: 'WebView Canvas',
  nativeEngineHint: '文件直接进算法，不走 base64',
  canvasEngineHint: 'Expo Go 兜底路径，建议用开发版',
  versionLine: '版本 {version} · 数据只保存在本机',
  statScans: '扫描文档',
  statTotalPages: '总页数',
  algorithmEngine: '算法引擎',
  engineVersion: '引擎版本',
  notLoaded: '未加载',
  storageLocation: '存储位置',
  appSandbox: '应用沙盒',
  appSandboxHint: '卸载 App 会一并删除',
  privacy: '隐私',
  onDeviceOnly: '默认全部本机处理',
  platform: '平台',
  profileFooter: 'Android + iOS + HarmonyOS 共用同一份 C++ 算法',
  language: '语言',
  languageSystem: '跟随系统',
  languageChinese: '简体中文',
  languageTraditionalChinese: '繁體中文',
  languageEnglish: 'English',
  languageJapanese: '日本語',
  languageKorean: '한국어',
  languageFrench: 'Français',
  languageGerman: 'Deutsch',
  languageSpanish: 'Español',
  languagePortuguese: 'Português',
  languageHint: '切换后界面立即生效',

  captureFailedTitle: '拍照失败',
  captureFailedBody:
    '当前设备/模拟器可能没有可用相机。可以使用「导入图片」或「示例文档」。',
  cameraPermissionTitle: '需要相机权限',
  cameraPermissionHint: '用于拍摄文档进行扫描',
  grantPermission: '授予权限',
  scanDocumentTitle: '拍摄文档',
  frameHint: '将文档置于框内',
  library: '相册',

  selectImages: '选择图片',
  readingLibrary: '正在读取相册…',
  libraryPermissionTitle: '没有相册访问权限',
  libraryPermissionHint: '读取照片需要相册权限，可以在系统设置里开启。',
  openSettings: '打开系统设置',
  libraryReadFailed: '相册读取失败',
  noPhotosTitle: '相册里还没有照片',
  noPhotosHint: '先用相机拍几张再回来导入。',
  selectedNth: '已选第 {n} 张',
  selectThisImage: '选择这张图片',
  maxSelectable: '最多可选 {count} 张',
  doneWithCount: '完成 ({count})',
  deselect: '取消选择',
  addImages: '添加图片',
  retakePage: '重拍此页',

  photoPermissionAlertTitle: '未获得相册权限',
  photoPermissionAlertBody: '请在系统设置中允许访问相册后重试。',
  exportedTitle: '已保存',
  exportedBody_one: '{count} 页已导出到系统相册。',
  exportedBody_other: '{count} 页已导出到系统相册。',
  exportFailedTitle: '导出失败',
  exportPartial: '已导出 {exported} 页，后续页面写入失败：{message}',
  exportNone: '无法写入相册：{message}',
  deleteDocumentTitle: '删除文档',
  deleteDocumentBody: '确定删除这份扫描件吗？共 {pages}。',
  emptyDocument: '文档没有页面',
  rotated: '旋转 {degrees}°',
  scannedAt: '扫描时间 {date}',
  exportingProgress: '导出中 {done}/{total}',
  exportPagesToLibrary: '导出 {count} 页到相册',
  exportToLibrary: '导出到相册',

  importFailedTitle: '导入失败',
  imageReadFailed: '图片读取失败，请重新选择。',
  pageLimitTitle: '已达页数上限',
  scanPageLimitBody: '单个文档最多 {limit} 页，更多图片请新建文档。',
  processingFailed: '处理失败：{message}',
  retakeFailedTitle: '重拍失败',
  deleteOrRetakeBody: '要删除这一页，还是重新拍一张替换它？',
  retakeThisPageAction: '重拍此页',
  reselectThisPageAction: '重选此页',
  cancelThisPageAction: '取消此页',
  deleteThisPageAction: '删除此页',
  invalidAreaTitle: '无效区域',
  convexQuadBody: '四个点要围成凸四边形，边不能交叉或凹陷。',
  cropTooSmallTitle: '裁剪区域太小',
  cropTooSmallBody: '拖动四角或四边，让裁剪范围覆盖文档区域。',
  cropFailedTitle: '裁剪失败',
  savedToLibraryBody_one: '{count} 页已保存到系统相册。',
  savedToLibraryBody_other: '{count} 页已保存到系统相册。',
  savedPartial: '已保存 {saved} 页，后续页面写入失败：{message}',
  shareUnavailableTitle: '无法分享',
  shareUnavailableBody: '当前设备不支持系统分享。',
  shareSheetFailed: '打开分享面板失败',
  shareOptionsBody: '可以分享当前图片、把当前页转成 PDF 分享，或分享整份文档。',
  shareThisImage: '分享此图',
  shareThisPage: '分享此页',
  shareDocument: '分享文档',
  shareImageFailed: '分享图片失败',
  pdfCreateFailed: '生成 PDF 失败',
  docNamePlaceholder: 'PDF 文档名称',
  pdfNameA11y: 'PDF 文档名称',
  noPagesYet: '还没有页面',
  noPagesHint: '点下方「继续导入」添加图片',
  deleteCurrentPage: '删除当前页',
  importingProgress: '正在导入 {done}/{total}',
  applyingProgress: '正在处理 {done}/{total}',
  creatingPdf: '正在生成 PDF…',
  creatingPdfProgress: '正在生成 PDF {done}/{total}',
  savingToLibraryProgress: '正在保存到相册 {done}/{total}',
  cropping: '正在裁剪…',
  replacingImage: '正在替换图片…',
  generatingPreview: '预览生成中…',
  previousPage: '上一页',
  nextPage: '下一页',
  holdToCompare: '按住查看原图',
  original: '原图',
  compare: '对比',
  cropHintValid: '智能裁剪预览：拖动四角或四边，框住文档区域',
  cropHintInvalid: '无效区域：四个点要围成凸四边形，边不能交叉或凹陷',
  imageProcessing: '图像处理',
  applyToAllPages: '应用到所有页',
  discardAdjust: '放弃调节',
  saveAdjust: '保存调节',
  adjustAppliesAll: '调节将应用到所有页 · ',
  adjustHint: '✓ 保存，✕ 放弃',
  importMore: '继续导入',
  rotateLeft: '左转',
  rotateRight: '右转',
  rotateLeftA11y: '左转',
  rotateRightA11y: '右转',
  crop: '裁剪',
  extractText: '提取文字',
  ocrComingTitle: '提取文字',
  ocrComingBody: 'OCR 文字识别功能正在开发中。',
  ocrSubtitle: '拍照或导入图片，调整裁剪后提取文字。',
  ocrAddPages: '添加图片',
  ocrStart: '识别文字',
  ocrRecognize: '识别',
  ocrRecognizeAgain: '重新识别',
  ocrImporting: '正在导入 {done}/{total}',
  ocrDetecting: '正在识别文档边缘…',
  ocrCropping: '正在裁剪…',
  ocrRecognizing: '正在识别 {done}/{total}',
  ocrRecognizingOne: '正在识别文字…',
  ocrImportFailedTitle: '导入失败',
  ocrCropFailedTitle: '裁剪失败',
  ocrNeedsServerTitle: '尚未配置文字识别服务',
  ocrNeedsServerBody:
    '请先在「我的」里填写文档识别服务地址，图片会上传到该服务识别文字。',
  ocrFailedTitle: '识别失败',
  ocrFailedBody_one: '{count} 页识别失败，请检查服务后重试。',
  ocrFailedBody_other: '{count} 页识别失败，请检查服务后重试。',
  ocrNoTextPage: '这一页没有检测到文字。',
  ocrNoText: '还没有可复制的内容。',
  ocrCopied: '已复制到剪贴板',
  ocrDefaultTitle: '识别文字',
  ocrExportedTitle: '文本已保存',
  ocrExportFailedTitle: '保存文本失败',
  ocrCopyAll: '复制全部',
  ocrExportTxt: '导出 TXT',
  ocrResultHint: '识别出的文字会显示在这里',
  ocrSelectHint: '点图片上的框或下面的文字行即可定位',
  ocrEmptyPages: '还没有图片',
  ocrEmptyPagesHint: '拍照或导入图片，然后提取文字。',
  ocrLines_one: '{count} 行',
  ocrLines_other: '{count} 行',
  ocrCropHint: '拖动四角或边，只框住需要识别的文字区域',
  ocrRevert: '恢复原文',
  ocrEdited: '已改',
  ocrLowConfidence: '需校对',
  ocrDeletePageTitle: '删除图片',
  ocrDeletePageBody: '把这页从识别里移除？',
  saveAllImages: '保存所有图片',
  saveAsPdf: '保存成 PDF',
  pdfSavedTitle: 'PDF 已保存',
  pdfSavedBody: '{name} 已保存到所选文件夹。',
  pdfSavedToAppBody: '{name} 已保存在 App 内。\n{path}',
  saveToPhoneFolder: '另存到手机…',
  pdfReadyPath: '文件位置：{path}',
  overwritePdfTitle: '文件已存在',
  overwritePdfBody: '所选文件夹里已有同名文件 {name}，要替换吗？',
  replaceFileAction: '替换',
  savePdfFailedTitle: '保存 PDF 失败',
  savePdfFolderBlocked:
    '无法写入所选文件夹：系统文件服务返回了错误。请换一个文件夹（例如「文档」或内部存储）再试。',
  chooseAnotherFolder: '换个文件夹',
  busyTitle: '正在处理',
  busyBody: '当前操作还没有完成。',
  keepWaiting: '继续等待',
  discardAndLeave: '放弃并返回',
  discardEditsTitle: '退出并放弃编辑？',
  discardEditsBody_one: '已导入的 {count} 页不会保存。',
  discardEditsBody_other: '已导入的 {count} 页不会保存。',
  keepEditing: '继续编辑',
  exitEdit: '退出',
  exitEditingAction: '退出编辑',
  pickerAddTitle: '添加图片',

  imageReadFailedShort: '图片读取失败',
  filterFailed: '滤镜处理失败：{message}',
  rotationFailed: '旋转失败',
  savingLabel: '保存中',
  savingEllipsis: '保存中…',
  processingEllipsis: '处理中…',
  filter: '滤镜',
  pageTools: '单页工具',
  cropReservedTitle: '切边（接口已预留）',
  cropReservedBody:
    '将调用 ONNX 模型识别文档四角，再做透视校正。当前版本没有打包模型；检测/切边接口见 src/lib/documentDetection.ts，结果保存在 PdfPage.cropQuad。',
  annotateReservedTitle: '手动批注（接口已预留）',
  annotateReservedBody:
    '批注会以归一化坐标保存在 PdfPage.annotations，渲染层（Canvas / 原生合成）尚未实现。',
  resetToOriginal: '恢复原图',
  saveThenRegenerate: '保存后回到 PDF 页，再点「重新生成 PDF」。',
  leftShort: '左转',
  rightShort: '右转',
  saveA11y: '保存',

  pageLimitPdfBody:
    '本机单次最多 {limit} 页。更多页面请拆成多个 PDF。',
  removePageTitle: '移除页面',
  removePageBody: '确定移除第 {n} 页吗？',
  applyFailedTitle: '应用失败',
  applyAllTitle: '应用到全部页面',
  applyAllOriginalBody:
    '将把 {count} 页全部恢复为原图（旋转保留），手动调整会被覆盖。',
  applyAllFilterBody_one:
    '将对 {count} 页执行「{filter}」，手动调整过的页面会被覆盖。',
  applyAllFilterBody_other:
    '将对 {count} 页执行「{filter}」，手动调整过的页面会被覆盖。',
  pdfCreatedTitle: 'PDF 已生成',
  pdfCreatedBody_one: '{count} 页，可点击「分享 PDF」导出。',
  pdfCreatedBody_other: '{count} 页，可点击「分享 PDF」导出。',
  createFailedTitle: '生成失败',
  shareFailedTitle: '分享失败',
  regeneratePdf: '重新生成 PDF',
  createPdf: '生成 PDF',
  sharePdf: '分享 PDF',
  read: '阅读',
  applyOnImport: '导入时自动执行',
  applyOnImportHint: '新导入的图片会自动套用该算法；单页仍可点 ✎ 单独调整。',
  restoreAllOriginals: '↺ 全部恢复原图',
  applyFilterToDocument: '对整个文档执行「{filter}」',
  noPagesAddImages: '还没有页面，先添加图片。',
  pagesOutOfDate:
    '页面已调整，当前 PDF 是旧版本；分享前请重新生成。',
  reorderThenCreate: '按 ↑ ↓ 调整顺序，然后生成 PDF。',
  pdfUpToDate: 'PDF 已生成 · {count} 页',
  reorderHint: '共 {count} 页 · 可上下调整顺序',
  emptyPdfTitle: '把照片变成 PDF',
  emptyPdfHint:
    '支持多选、调整顺序。导入时会自动执行上方选中的算法（当前：{filter}），之后仍可单页调整。',
  filterMode: '{filter}模式',
  movePageUp: '第 {n} 页上移',
  movePageDown: '第 {n} 页下移',
  removePageN: '移除第 {n} 页',
  addImagesPlus: '＋ 添加图片',
  importingImages: '正在导入图片',
  applyingFilter: '正在应用算法',
  creatingPdfTitle: '正在生成 PDF',
  layoutWriting: '正在排版输出…',
  pdfFooterHint:
    '点 ✎ 可对单页做增强 / 旋转（切边、批注为预留接口）。{memory}单次最多 {limit} 页；页数越多，单页会自动压缩（≤8 页 1800px · ≤25 页 1500px · 更多 1200px，低内存机型再降一档）。',
  memoryHint: '本机内存约 {gb} GB，',

  layout: '排版',
  editThisPage: '✎ 编辑本页 · 第 {n} 页',
  readerEmpty: '这个文档还没有页面',
  readerEmptyHint: '先去「✎ 排版」添加图片。',
  readerDirty: '页面已调整，PDF 是旧版；去排版处重新生成',

  filterOriginal: '原图',
  filterShadow: '去阴影',
  filterDehand: '去除手写',
  filterHd: '高清',
  filterBrighten: '增亮',
  filterSharpen: '增强锐化',
  filterInksave: '省墨',
  filterEnhance: '增强',
  filterGray: '灰度',
  filterBw: '黑白',
  filterInvert: '反色',
  adjustContrast: '对比度',
  adjustBrightness: '亮度',
  adjustDetail: '细节',

  defaultScanTitle: '扫描文档',
  defaultPdfTitle: 'PDF 文档',
  defaultDocumentName: '文档',
  errorCancelled: '已取消',
  errorImageProcessing: '图片处理失败',
  errorEngineTimeout: '滤镜引擎启动超时',
  errorEngineNotReady: '滤镜引擎未就绪',
  errorProcessingTimeout: '图片处理超时',
  errorMissingImageData: '缺少处理后的图片数据',
  errorAtLeastOneImage: '至少需要一张图片',
  errorPdfPageLimit: '本机单次最多生成 {limit} 页',
  errorOcrNotConnected: '文档边缘检测尚未接入（预留了 ONNX 接口）',
  errorPerspectiveNotImplemented:
    '透视切边尚未实现：ONNX 检测已接入，但缺少 warp 步骤',
  cropA11y: '裁剪区域，拖动四个角点或四条边的中点调整',

  // ---- 文档检测 ----
  detectionServer: '文档识别服务',
  detectionServerHint:
    '可选。点「裁剪」时用该服务上的 model_1228 重新识别四角。',
  detectionServerPlaceholder: 'http://192.168.1.10:10000',
  detectionServerTest: '测试连接',
  detectionServerTesting: '测试中…',
  detectionServerReachable: '连接正常',
  detectionServerUnreachable: '无法连接',
  detectionServerClear: '清除',
  detectionServerSaved: '已保存',
  detecting: '正在识别边缘…',
  detectingProgress: '正在识别 {done}/{total}',
  autoCropping: '正在切边…',
  autoCroppingProgress: '正在切边 {done}/{total}',
  detectingServer: '服务端识别中…',
  liveDetectHint: '把文档放进取景框',
  liveCorners: '四角',
};

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  en,
  zh,
  'zh-Hant': zhHant,
  ja,
  ko,
  fr,
  de,
  es,
  pt,
};

/** 中文按脚本/地区区分简繁，其余语言按 languageCode 匹配 */
function detectSystemLocale(): Locale {
  try {
    const locale = getLocales()[0];
    const code = locale?.languageCode?.toLowerCase();
    switch (code) {
      case 'zh': {
        const script = locale?.languageScriptCode?.toLowerCase();
        const region = (
          locale?.languageRegionCode ??
          locale?.regionCode ??
          ''
        ).toUpperCase();
        return script === 'hant' ||
          region === 'TW' ||
          region === 'HK' ||
          region === 'MO'
          ? 'zh-Hant'
          : 'zh';
      }
      case 'ja':
        return 'ja';
      case 'ko':
        return 'ko';
      case 'fr':
        return 'fr';
      case 'de':
        return 'de';
      case 'es':
        return 'es';
      case 'pt':
        return 'pt';
      default:
        return 'en';
    }
  } catch {
    return 'en';
  }
}

function isLocale(value: string | null): value is Locale {
  return value !== null && (LOCALES as readonly string[]).includes(value);
}

let preference: LocalePreference = 'system';
let currentLocale: Locale = detectSystemLocale();
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function resolve(pref: LocalePreference): Locale {
  return pref === 'system' ? detectSystemLocale() : pref;
}

function format(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

function lookup(locale: Locale, key: MessageKey): string {
  return dictionaries[locale][key] ?? en[key] ?? key;
}

/** 读取已保存的语言偏好（App 启动时调用一次） */
export async function initI18n(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEY);
    if (saved === 'system' || isLocale(saved)) {
      preference = saved;
      const next = resolve(saved);
      if (next !== currentLocale) {
        currentLocale = next;
        emit();
      } else {
        // 偏好从 system 改成同一个语言时也要刷新选择器的选中态
        emit();
      }
    }
  } catch {
    // 读取失败时继续跟随系统
  }
}

/** 组件外读取当前语言 */
export function getLocale(): Locale {
  return currentLocale;
}

export function getLocalePreference(): LocalePreference {
  return preference;
}

/** 切换语言（持久化） */
export function setLocalePreference(next: LocalePreference): void {
  preference = next;
  currentLocale = resolve(next);
  void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  emit();
}

/** 组件外翻译：`t('pageCount_one', { count: 1 })` */
export function t(key: MessageKey, params?: MessageParams): string {
  return format(lookup(currentLocale, key), params);
}

/** 组件外复数翻译：按 count 选择 `_one` / `_other` */
export function tp(
  key: PluralKey,
  count: number,
  params?: MessageParams,
): string {
  // 法语把 0 也当作单数（CLDR：one = 0,1），其余语言只在 1 时用单数
  const singular = currentLocale === 'fr' ? count <= 1 : count === 1;
  const suffix: PluralSuffix = singular ? '_one' : '_other';
  return t(`${key}${suffix}` as MessageKey, { count, ...params });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return version;
}

/**
 * 组件内使用：语言切换后自动重渲染。
 *
 * 返回的 `t` / `tp` 是模块级函数（调用时才读当前语言），引用稳定，
 * 不会让 useCallback / useMemo 拿到切换前的旧语言。
 */
export function useI18n() {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    locale: currentLocale,
    preference,
    setPreference: setLocalePreference,
    t,
    tp,
  };
}
