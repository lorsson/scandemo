import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  StyleSheet,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import HomeScreen from './src/screens/HomeScreen';
import DocsScreen from './src/screens/DocsScreen';
import ToolsScreen from './src/screens/ToolsScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import CameraScreen from './src/screens/CameraScreen';
import PhotoPickerScreen from './src/screens/PhotoPickerScreen';
import ScanEditorScreen from './src/screens/ScanEditorScreen';
import EditorScreen from './src/screens/EditorScreen';
import DocumentScreen from './src/screens/DocumentScreen';
import PdfScreen from './src/screens/PdfScreen';
import PdfReaderScreen from './src/screens/PdfReaderScreen';
import TabBar, { type TabKey } from './src/components/TabBar';
import {
  discardScanDraft,
  loadDocs,
  removeScanDoc,
  saveIndex,
} from './src/lib/storage';
import { resolveBundledAsset } from './src/lib/imagePipeline';
import { titleFromUri } from './src/lib/format';
import { FilterEngineHost } from './src/lib/filterEngine';
import { getPdfLimits, initPdfLimits } from './src/lib/pdfLimits';
import {
  loadPdfs,
  removePdfProject,
  savePageEdit,
  savePdfIndex,
} from './src/lib/pdfStorage';
import { theme } from './src/theme';
import type { FilterKey, PdfDoc, Rotation, ScanDoc } from './src/types';

type Route =
  | { name: 'home' }
  | { name: 'camera' }
  | {
      name: 'picker';
      title: string;
      /** 取消后回到哪里：首页或相机 */
      returnTo: 'home' | 'camera';
    }
  | {
      name: 'scanEditor';
      /** 草稿 id：同时也是保存后的 ScanDoc id 和项目目录名 */
      draftId: string;
      sourceUris: string[];
      title: string;
    }
  | { name: 'doc'; doc: ScanDoc }
  | { name: 'pdf'; doc: PdfDoc }
  | { name: 'pdfReader'; doc: PdfDoc; initialPage?: number }
  | {
      name: 'pageEditor';
      doc: PdfDoc;
      pageId: string;
      /** 编辑保存/取消后回到哪里：排版页还是阅读器 */
      backTo?: 'pdf' | 'pdfReader';
    };

/** 页面改动时间至少晚于上一次生成 1ms，保证 dirty 判定成立 */
function nextUpdatedAt(generatedAt: number | null): number {
  return Math.max(Date.now(), (generatedAt ?? 0) + 1);
}

function makeTitle(base: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${base} ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export default function App() {
  const [docs, setDocs] = useState<ScanDoc[]>([]);
  const [pdfs, setPdfs] = useState<PdfDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState<Route>({ name: 'home' });
  /** 底部 tab 独立于页面路由：进入相机/编辑器再回来仍停在原来的 tab */
  const [tab, setTab] = useState<TabKey>('home');
  const pdfsRef = useRef<PdfDoc[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [loadedDocs, loadedPdfs] = await Promise.all([loadDocs(), loadPdfs()]);
      if (!cancelled) {
        setDocs(loadedDocs);
        pdfsRef.current = loadedPdfs;
        setPdfs(loadedPdfs);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // PDF 页数上限取决于设备内存，启动时探测一次并缓存
  useEffect(() => {
    void initPdfLimits();
  }, []);

  // 底部 tab 页按返回键先回首页，首页再按才退出（与常见的扫描类 App 一致）
  useEffect(() => {
    if (route.name !== 'home') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (tab === 'home') return false;
      setTab('home');
      return true;
    });
    return () => sub.remove();
  }, [route.name, tab]);

  const commitPdfs = useCallback((next: PdfDoc[]) => {
    pdfsRef.current = next;
    setPdfs(next);
    void savePdfIndex(next);
  }, []);

  const handleUpdatePdf = useCallback(
    (updated: PdfDoc) => {
      const prev = pdfsRef.current;
      const exists = prev.some((pdf) => pdf.id === updated.id);
      commitPdfs(
        exists
          ? prev.map((pdf) => (pdf.id === updated.id ? updated : pdf))
          : [updated, ...prev],
      );
    },
    [commitPdfs],
  );

  /**
   * 打开扫描编辑器：批量图片 → 多页预览/调整 → 导出图片 / PDF。
   * 标题默认取第一张图片的文件名，编辑器里还能改。
   */
  const goScanEditor = (sourceUris: string[], name?: string) => {
    if (sourceUris.length === 0) return;
    setRoute({
      name: 'scanEditor',
      draftId: `${Date.now()}`,
      sourceUris,
      title: titleFromUri(name || sourceUris[0]),
    });
  };

  const handleSample = async () => {
    try {
      const uri = await resolveBundledAsset(require('./assets/sample_doc.jpg'));
      goScanEditor([uri], '示例文档');
    } catch {
      Alert.alert('加载示例失败', '请改用拍照或相册导入。');
    }
  };

  /** 相册批量导入：先打开应用内选择器，选完一次性进编辑器 */
  const handleImport = () =>
    setRoute({ name: 'picker', title: '导入图片', returnTo: 'home' });

  /** 取消导入：草稿文件（含已导入的页面）全部丢弃 */
  const handleScanCancel = (draftId: string) => {
    setRoute({ name: 'home' });
    void discardScanDraft(draftId);
  };

  /**
   * 新建 PDF：先建一份空草稿并进入排版页，让用户在导入前就能选算法。
   *
   * 空草稿不写入索引——第一次导入页面时 PdfScreen 的 onUpdate 才落库，
   * 避免首页出现 0 页的空文档。导入过程本身在 PdfScreen 里显示进度。
   */
  const handleCreatePdf = () => {
    const now = Date.now();
    setRoute({
      name: 'pdf',
      doc: {
        id: `${now}`,
        title: makeTitle('PDF 文档'),
        pages: [],
        uri: null,
        pageCount: 0,
        createdAt: now,
        updatedAt: now,
        generatedAt: null,
        defaultFilter: 'enhance',
      },
    });
  };

  /** 首页点 PDF 记录：直接打开内置阅读器，先读再改 */
  const handleOpenPdf = (pdf: PdfDoc) =>
    setRoute({ name: 'pdfReader', doc: pdf });

  /** 从排版页/阅读器打开单页编辑器 */
  const handleEditPage = (
    pdf: PdfDoc,
    pageId: string,
    backTo: 'pdf' | 'pdfReader' = 'pdf',
  ) => setRoute({ name: 'pageEditor', doc: pdf, pageId, backTo });

  /** 单页编辑保存：写新文件 + 缩略图，更新 doc，回到排版页或阅读器 */
  const handlePageSave = async (
    pdf: PdfDoc,
    pageId: string,
    payload: {
      base64: string;
      filter: FilterKey;
      rotation: Rotation;
    },
    backTo: 'pdf' | 'pdfReader' = 'pdf',
  ) => {
    /** 依据来源决定编辑完成后回哪里 */
    const to = (d: PdfDoc): Route =>
      backTo === 'pdfReader'
        ? { name: 'pdfReader', doc: d }
        : { name: 'pdf', doc: d };

    const page = pdf.pages.find((item) => item.id === pageId);
    if (!page) {
      setRoute(to(pdf));
      return;
    }

    try {
      const updatedPage = await savePageEdit(
        pdf.id,
        page,
        payload.base64,
        { filter: payload.filter, rotation: payload.rotation },
      );
      const nextDoc: PdfDoc = {
        ...pdf,
        pages: pdf.pages.map((item) =>
          item.id === pageId ? updatedPage : item,
        ),
        pageCount: pdf.pages.length,
        updatedAt: nextUpdatedAt(pdf.generatedAt),
      };
      commitPdfs(
        pdfsRef.current.some((item) => item.id === pdf.id)
          ? pdfsRef.current.map((item) =>
              item.id === pdf.id ? nextDoc : item,
            )
          : [nextDoc, ...pdfsRef.current],
      );
      setRoute(to(nextDoc));
    } catch (error) {
      Alert.alert(
        '保存失败',
        error instanceof Error ? error.message : '未知错误',
      );
      setRoute(to(pdf));
    }
  };

  const handleDeletePdf = (pdf: PdfDoc) => {
    Alert.alert('删除 PDF', '将删除 PDF 和全部源图片，无法恢复。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          commitPdfs(pdfsRef.current.filter((item) => item.id !== pdf.id));
          await removePdfProject(pdf.id, pdf.uri);
          setRoute((current) =>
            current.name === 'pdf' && current.doc.id === pdf.id
              ? { name: 'home' }
              : current,
          );
        },
      },
    ]);
  };

  const handleDelete = async (doc: ScanDoc) => {
    const next = docs.filter((d) => d.id !== doc.id);
    setDocs(next);
    await saveIndex(next);
    await removeScanDoc(doc);
    setRoute({ name: 'home' });
  };

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={theme.primary} size="large" />
      </View>
    );
  }

  // PDF 排版页是浅色界面，状态栏文字保持深色
  const darkScreen =
    route.name === 'camera' ||
    route.name === 'scanEditor' ||
    route.name === 'doc' ||
    route.name === 'pageEditor';

  return (
    <SafeAreaProvider>
      <StatusBar style={darkScreen ? 'light' : 'dark'} />
      <FilterEngineHost />
      {route.name === 'home' && (
        <View style={styles.shell}>
          <View style={styles.shellBody}>
            {tab === 'home' && (
              <HomeScreen
                docs={docs}
                pdfs={pdfs}
                onScan={() => setRoute({ name: 'camera' })}
                onImport={handleImport}
                onSample={handleSample}
                onCreatePdf={handleCreatePdf}
                onOpenDoc={(doc) => setRoute({ name: 'doc', doc })}
                onDeleteDoc={handleDelete}
                onOpenPdf={handleOpenPdf}
                onDeletePdf={handleDeletePdf}
              />
            )}
            {tab === 'docs' && (
              <DocsScreen
                docs={docs}
                pdfs={pdfs}
                onOpenDoc={(doc) => setRoute({ name: 'doc', doc })}
                onOpenPdf={handleOpenPdf}
                onDeleteDoc={handleDelete}
                onDeletePdf={handleDeletePdf}
                onCreatePdf={handleCreatePdf}
              />
            )}
            {tab === 'tools' && (
              <ToolsScreen
                onCreatePdf={handleCreatePdf}
                onScan={() => setRoute({ name: 'camera' })}
                onImport={handleImport}
                onSample={handleSample}
              />
            )}
            {tab === 'profile' && <ProfileScreen docs={docs} pdfs={pdfs} />}
          </View>
          <TabBar
            active={tab}
            onChange={setTab}
            onScan={() => setRoute({ name: 'camera' })}
          />
        </View>
      )}

      {route.name === 'camera' && (
        <CameraScreen
          onCaptured={(uri) => goScanEditor([uri])}
          onCancel={() => setRoute({ name: 'home' })}
          onPickGallery={() =>
            setRoute({ name: 'picker', title: '导入图片', returnTo: 'camera' })
          }
        />
      )}

      {route.name === 'picker' && (
        <PhotoPickerScreen
          limit={getPdfLimits().pageLimit}
          title={route.title}
          onCancel={() =>
            setRoute(
              route.returnTo === 'camera' ? { name: 'camera' } : { name: 'home' },
            )
          }
          onDone={(uris, names) => goScanEditor(uris, names[0])}
        />
      )}

      {route.name === 'scanEditor' && (
        <ScanEditorScreen
          key={route.draftId}
          draftId={route.draftId}
          initialUris={route.sourceUris}
          title={route.title}
          onCancel={() => handleScanCancel(route.draftId)}
        />
      )}

      {route.name === 'doc' && (
        <DocumentScreen
          doc={route.doc}
          onBack={() => setRoute({ name: 'home' })}
          onDelete={handleDelete}
        />
      )}

      {route.name === 'pdf' && (
        <PdfScreen
          key={route.doc.id}
          doc={route.doc}
          onBack={() => setRoute({ name: 'home' })}
          onUpdate={handleUpdatePdf}
          onRead={() =>
            setRoute({
              name: 'pdfReader',
              doc:
                pdfsRef.current.find((item) => item.id === route.doc.id) ??
                route.doc,
            })
          }
          onEditPage={(pageId) => {
            // route.doc 是打开时的快照；增删/排序后的最新版本在 ref 里
            const latest =
              pdfsRef.current.find((item) => item.id === route.doc.id) ??
              route.doc;
            handleEditPage(latest, pageId, 'pdf');
          }}
        />
      )}

      {route.name === 'pdfReader' &&
        (() => {
          const latest =
            pdfsRef.current.find((item) => item.id === route.doc.id) ??
            route.doc;
          return (
            <PdfReaderScreen
              key={route.doc.id}
              doc={latest}
              initialPage={route.initialPage}
              onBack={() => setRoute({ name: 'home' })}
              onEditLayout={() => setRoute({ name: 'pdf', doc: latest })}
              onEditPage={(pageId) =>
                handleEditPage(latest, pageId, 'pdfReader')
              }
            />
          );
        })()}

      {route.name === 'pageEditor' &&
        (() => {
          const pageIndex = route.doc.pages.findIndex(
            (item) => item.id === route.pageId,
          );
          const page = route.doc.pages[pageIndex];
          if (!page) return null;
          const backTo = route.backTo ?? 'pdf';
          const backDest = (d: PdfDoc): Route =>
            backTo === 'pdfReader'
              ? { name: 'pdfReader', doc: d }
              : { name: 'pdf', doc: d };
          return (
            <EditorScreen
              sourceUri={page.originalUri}
              title={`编辑第 ${pageIndex + 1} 页`}
              maxDim={1800}
              initialFilter={page.filter}
              initialRotation={page.rotation}
              showPageTools
              onCancel={() => setRoute(backDest(route.doc))}
              onSave={(payload) =>
                handlePageSave(route.doc, page.id, payload, backTo)
              }
            />
          );
        })()}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shell: { flex: 1 },
  shellBody: { flex: 1 },
});
