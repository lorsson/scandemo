import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';

import HomeScreen from './src/screens/HomeScreen';
import CameraScreen from './src/screens/CameraScreen';
import EditorScreen from './src/screens/EditorScreen';
import DocumentScreen from './src/screens/DocumentScreen';
import PdfScreen from './src/screens/PdfScreen';
import { loadDocs, persistImage, removeImage, saveIndex } from './src/lib/storage';
import { resolveBundledAsset } from './src/lib/imagePipeline';
import { FilterEngineHost } from './src/lib/filterEngine';
import { initPdfLimits } from './src/lib/pdfLimits';
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
  | { name: 'editor'; sourceUri: string; title: string }
  | { name: 'doc'; doc: ScanDoc }
  | { name: 'pdf'; doc: PdfDoc }
  | { name: 'pageEditor'; doc: PdfDoc; pageId: string };

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

  const goEditor = (sourceUri: string, title: string) =>
    setRoute({ name: 'editor', sourceUri, title });

  const handleSample = async () => {
    try {
      const uri = await resolveBundledAsset(require('./assets/sample_doc.jpg'));
      goEditor(uri, '示例文档');
    } catch {
      Alert.alert('加载示例失败', '请改用拍照或相册导入。');
    }
  };

  const handleImport = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('未获得相册权限', '请在系统设置中允许访问相册。');
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    if (!res.canceled && res.assets[0]?.uri) {
      goEditor(res.assets[0].uri, '导入图片');
    }
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

  const handleOpenPdf = (pdf: PdfDoc) => setRoute({ name: 'pdf', doc: pdf });

  const handleEditPage = (pdf: PdfDoc, pageId: string) =>
    setRoute({ name: 'pageEditor', doc: pdf, pageId });

  /** 单页编辑保存：写新文件 + 缩略图，更新 doc，回到 PDF 排版页重新生成 */
  const handlePageSave = async (
    pdf: PdfDoc,
    pageId: string,
    payload: {
      base64: string;
      filter: FilterKey;
      rotation: Rotation;
    },
  ) => {
    const page = pdf.pages.find((item) => item.id === pageId);
    if (!page) {
      setRoute({ name: 'pdf', doc: pdf });
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
      setRoute({ name: 'pdf', doc: nextDoc });
    } catch (error) {
      Alert.alert(
        '保存失败',
        error instanceof Error ? error.message : '未知错误',
      );
      setRoute({ name: 'pdf', doc: pdf });
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

  const handleSave = async ({
    base64,
    filter,
    title,
  }: {
    base64: string;
    filter: FilterKey;
    title: string;
  }) => {
    const id = `${Date.now()}`;
    const uri = await persistImage(base64, id);
    const doc: ScanDoc = {
      id,
      uri,
      thumbUri: uri,
      filter,
      createdAt: Date.now(),
      title: makeTitle(title),
    };
    const next = [doc, ...docs];
    setDocs(next);
    await saveIndex(next);
    setRoute({ name: 'home' });
  };

  const handleDelete = async (doc: ScanDoc) => {
    await removeImage(doc.uri);
    const next = docs.filter((d) => d.id !== doc.id);
    setDocs(next);
    await saveIndex(next);
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
    route.name === 'editor' ||
    route.name === 'doc' ||
    route.name === 'pageEditor';

  return (
    <SafeAreaProvider>
      <StatusBar style={darkScreen ? 'light' : 'dark'} />
      <FilterEngineHost />
      {route.name === 'home' && (
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

      {route.name === 'camera' && (
        <CameraScreen
          onCaptured={(uri) => goEditor(uri, '拍照扫描')}
          onCancel={() => setRoute({ name: 'home' })}
          onPickGallery={handleImport}
        />
      )}

      {route.name === 'editor' && (
        <EditorScreen
          sourceUri={route.sourceUri}
          title={route.title}
          onCancel={() => setRoute({ name: 'home' })}
          onSave={handleSave}
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
          onEditPage={(pageId) => {
            // route.doc 是打开时的快照；增删/排序后的最新版本在 ref 里
            const latest =
              pdfsRef.current.find((item) => item.id === route.doc.id) ??
              route.doc;
            handleEditPage(latest, pageId);
          }}
        />
      )}

      {route.name === 'pageEditor' &&
        (() => {
          const pageIndex = route.doc.pages.findIndex(
            (item) => item.id === route.pageId,
          );
          const page = route.doc.pages[pageIndex];
          if (!page) return null;
          return (
            <EditorScreen
              sourceUri={page.originalUri}
              title={`编辑第 ${pageIndex + 1} 页`}
              maxDim={1800}
              initialFilter={page.filter}
              initialRotation={page.rotation}
              showPageTools
              onCancel={() => setRoute({ name: 'pdf', doc: route.doc })}
              onSave={(payload) =>
                handlePageSave(route.doc, page.id, payload)
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
});
