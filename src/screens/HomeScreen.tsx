import { useMemo } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { formatDate } from '../lib/format';
import { shadow, theme } from '../theme';
import type { PdfDoc, ScanDoc } from '../types';

type Props = {
  docs: ScanDoc[];
  pdfs: PdfDoc[];
  onScan: () => void;
  onImport: () => void;
  onSample: () => void;
  onCreatePdf: () => void;
  onOpenDoc: (doc: ScanDoc) => void;
  onDeleteDoc: (doc: ScanDoc) => void;
  onOpenPdf: (pdf: PdfDoc) => void;
  onDeletePdf: (pdf: PdfDoc) => void;
};

function isPdfDirty(pdf: PdfDoc): boolean {
  return !pdf.uri || pdf.generatedAt === null || pdf.updatedAt > pdf.generatedAt;
}

export default function HomeScreen({
  docs,
  pdfs,
  onScan,
  onImport,
  onSample,
  onCreatePdf,
  onOpenDoc,
  onDeleteDoc,
  onOpenPdf,
  onDeletePdf,
}: Props) {
  const sorted = useMemo(
    () => [...docs].sort((a, b) => b.createdAt - a.createdAt),
    [docs],
  );
  const sortedPdfs = useMemo(
    () => [...pdfs].sort((a, b) => b.updatedAt - a.updatedAt),
    [pdfs],
  );

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>扫描 Demo</Text>
          <Text style={styles.subtitle}>文档扫描 · 智能增强 · 多端通用</Text>
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{docs.length}</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <ActionCard icon="📷" label="拍照扫描" hint="调用相机" onPress={onScan} primary />
        <ActionCard icon="🖼️" label="导入图片" hint="从相册选择" onPress={onImport} />
        <ActionCard icon="📄" label="示例文档" hint="免相机体验" onPress={onSample} />
      </View>

      <Pressable
        style={({ pressed }) => [styles.pdfAction, pressed && styles.pressed]}
        onPress={onCreatePdf}
      >
        <View style={styles.pdfIcon}>
          <Text style={styles.pdfIconText}>PDF</Text>
        </View>
        <View style={styles.pdfActionMeta}>
          <Text style={styles.pdfActionTitle}>图片转 PDF</Text>
          <Text style={styles.pdfActionHint}>多选 · 自动算法 · 调整顺序 · 导出</Text>
        </View>
        <Text style={styles.pdfArrow}>›</Text>
      </Pressable>

      {sortedPdfs.length > 0 && (
        <>
          <View style={styles.sectionHead}>
            <Text style={styles.sectionTitle}>PDF 文档</Text>
            <Text style={styles.sectionHint}>{sortedPdfs.length} 份</Text>
          </View>
          <View style={styles.list}>
            {sortedPdfs.map((pdf) => {
              const dirty = isPdfDirty(pdf);
              const cover = pdf.pages[0]?.thumbUri;
              return (
                <Pressable
                  key={pdf.id}
                  style={({ pressed }) => [styles.docRow, pressed && styles.pressed]}
                  onPress={() => onOpenPdf(pdf)}
                  onLongPress={() => onDeletePdf(pdf)}
                >
                  {cover ? (
                    <Image source={{ uri: cover }} style={styles.thumb} />
                  ) : (
                    <View style={[styles.thumb, styles.pdfPlaceholder]}>
                      <Text style={styles.pdfPlaceholderText}>PDF</Text>
                    </View>
                  )}
                  <View style={styles.docMeta}>
                    <Text style={styles.docTitle} numberOfLines={1}>
                      {pdf.title}
                    </Text>
                    <Text style={styles.docSub}>
                      {pdf.pageCount} 页 · {dirty ? '待重新生成' : '已生成'} ·{' '}
                      {formatDate(pdf.updatedAt)}
                    </Text>
                  </View>
                  <Pressable
                    hitSlop={10}
                    style={styles.deleteBtn}
                    onPress={() => onDeletePdf(pdf)}
                  >
                    <Text style={styles.deleteText}>✕</Text>
                  </Pressable>
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>最近扫描</Text>
        <Text style={styles.sectionHint}>{sorted.length} 份文档</Text>
      </View>

      {sorted.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>🗂️</Text>
          <Text style={styles.emptyText}>还没有扫描记录</Text>
          <Text style={styles.emptyHint}>点击上方「拍照扫描 / 导入图片 / 示例文档」开始</Text>
        </View>
      ) : (
        <View style={styles.list}>
          {sorted.map((doc) => {
            const cover = doc.pages[0]?.thumbUri;
            return (
              <Pressable
                key={doc.id}
                style={({ pressed }) => [styles.docRow, pressed && styles.pressed]}
                onPress={() => onOpenDoc(doc)}
                onLongPress={() => onDeleteDoc(doc)}
              >
                {cover ? (
                  <Image source={{ uri: cover }} style={styles.thumb} />
                ) : (
                  <View style={styles.thumb} />
                )}
                <View style={styles.docMeta}>
                  <Text style={styles.docTitle} numberOfLines={1}>
                    {doc.title}
                  </Text>
                  <Text style={styles.docSub}>
                    {doc.pages.length} 页 · {formatDate(doc.createdAt)}
                  </Text>
                </View>
                <Pressable
                  hitSlop={10}
                  style={styles.deleteBtn}
                  onPress={() => onDeleteDoc(doc)}
                >
                  <Text style={styles.deleteText}>✕</Text>
                </Pressable>
              </Pressable>
            );
          })}
        </View>
      )}

      <Text style={styles.footer}>
        Android + iOS 同一套代码 · 长按文档可快速删除 · 数据只保存在本机
      </Text>
    </ScrollView>
  );
}

function ActionCard({
  icon,
  label,
  hint,
  onPress,
  primary,
}: {
  icon: string;
  label: string;
  hint: string;
  onPress: () => void;
  primary?: boolean;
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.actionCard,
        primary && styles.actionCardPrimary,
        pressed && styles.pressed,
      ]}
      onPress={onPress}
    >
      <Text style={styles.actionIcon}>{icon}</Text>
      <Text style={[styles.actionLabel, primary && styles.actionLabelPrimary]}>
        {label}
      </Text>
      <Text style={[styles.actionHint, primary && styles.actionHintPrimary]}>
        {hint}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  content: { padding: 20, paddingTop: 56, paddingBottom: 40 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 22,
  },
  title: { fontSize: 30, fontWeight: '800', color: theme.text },
  subtitle: { fontSize: 13, color: theme.subtext, marginTop: 4 },
  badge: {
    minWidth: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  actions: { flexDirection: 'row', gap: 12 },
  actionCard: {
    flex: 1,
    backgroundColor: theme.surface,
    borderRadius: 16,
    paddingVertical: 18,
    paddingHorizontal: 10,
    alignItems: 'center',
    ...shadow,
  },
  actionCardPrimary: { backgroundColor: theme.primary },
  actionIcon: { fontSize: 26, marginBottom: 8 },
  actionLabel: { fontSize: 14, fontWeight: '700', color: theme.text },
  actionLabelPrimary: { color: '#fff' },
  actionHint: { fontSize: 11, color: theme.subtext, marginTop: 3 },
  actionHintPrimary: { color: '#dbe4ff' },
  pressed: { opacity: 0.8 },
  pdfAction: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    padding: 14,
    borderRadius: 16,
    backgroundColor: theme.surface,
    ...shadow,
  },
  pdfIcon: {
    width: 42,
    height: 42,
    borderRadius: 11,
    backgroundColor: '#fdeeee',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pdfIconText: { color: theme.danger, fontSize: 12, fontWeight: '800' },
  pdfActionMeta: { flex: 1, marginLeft: 12 },
  pdfActionTitle: { fontSize: 15, fontWeight: '700', color: theme.text },
  pdfActionHint: { fontSize: 11, color: theme.subtext, marginTop: 4 },
  pdfArrow: { fontSize: 24, color: theme.subtext, marginLeft: 8 },
  pdfPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  pdfPlaceholderText: { fontSize: 11, fontWeight: '800', color: theme.danger },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 30,
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: theme.text },
  sectionHint: { fontSize: 12, color: theme.subtext },
  list: { gap: 10 },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderRadius: 14,
    padding: 10,
    ...shadow,
  },
  thumb: {
    width: 46,
    height: 60,
    borderRadius: 8,
    backgroundColor: theme.surfaceAlt,
  },
  docMeta: { flex: 1, marginLeft: 12 },
  docTitle: { fontSize: 15, fontWeight: '600', color: theme.text },
  docSub: { fontSize: 12, color: theme.subtext, marginTop: 4 },
  deleteBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: theme.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deleteText: { color: theme.subtext, fontSize: 14, fontWeight: '700' },
  empty: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    paddingVertical: 44,
    alignItems: 'center',
    ...shadow,
  },
  emptyIcon: { fontSize: 40, marginBottom: 10 },
  emptyText: { fontSize: 15, fontWeight: '600', color: theme.text },
  emptyHint: { fontSize: 12, color: theme.subtext, marginTop: 6 },
  footer: {
    textAlign: 'center',
    fontSize: 11,
    color: theme.subtext,
    marginTop: 28,
  },
});
