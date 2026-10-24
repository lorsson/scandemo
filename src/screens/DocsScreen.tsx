import { useMemo, useState } from 'react';
import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatDate } from '../lib/format';
import { shadow, theme } from '../theme';
import type { PdfDoc, ScanDoc } from '../types';

type Filter = 'all' | 'pdf' | 'scan';

type Props = {
  docs: ScanDoc[];
  pdfs: PdfDoc[];
  onOpenDoc: (doc: ScanDoc) => void;
  onOpenPdf: (pdf: PdfDoc) => void;
  onDeleteDoc: (doc: ScanDoc) => void;
  onDeletePdf: (pdf: PdfDoc) => void;
  onCreatePdf: () => void;
};

type Row =
  | { kind: 'pdf'; id: string; time: number; pdf: PdfDoc }
  | { kind: 'scan'; id: string; time: number; doc: ScanDoc };

function isPdfDirty(pdf: PdfDoc): boolean {
  return !pdf.uri || pdf.generatedAt === null || pdf.updatedAt > pdf.generatedAt;
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'pdf', label: 'PDF' },
  { key: 'scan', label: '扫描' },
];

export default function DocsScreen({
  docs,
  pdfs,
  onOpenDoc,
  onOpenPdf,
  onDeleteDoc,
  onDeletePdf,
  onCreatePdf,
}: Props) {
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<Filter>('all');

  const rows = useMemo<Row[]>(() => {
    const all: Row[] = [
      ...pdfs.map((pdf) => ({
        kind: 'pdf' as const,
        id: pdf.id,
        time: pdf.updatedAt,
        pdf,
      })),
      ...docs.map((doc) => ({
        kind: 'scan' as const,
        id: doc.id,
        time: doc.createdAt,
        doc,
      })),
    ];
    return all
      .filter((row) => filter === 'all' || row.kind === filter)
      .sort((a, b) => b.time - a.time);
  }, [docs, pdfs, filter]);

  const countLabel = `${pdfs.length} 份 PDF · ${docs.length} 份扫描`;

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>全部文档</Text>
        <Text style={styles.subtitle}>{countLabel}</Text>
      </View>

      <View style={styles.chips}>
        {FILTERS.map((item) => {
          const active = filter === item.key;
          return (
            <Pressable
              key={item.key}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              onPress={() => setFilter(item.key)}
              style={[styles.chip, active && styles.chipActive]}
            >
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView
        style={styles.listScroll}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      >
        {rows.length === 0 ? (
          <View style={styles.empty}>
            <Ionicons
              name="folder-open-outline"
              size={44}
              color={theme.subtext}
            />
            <Text style={styles.emptyTitle}>
              {filter === 'all'
                ? '还没有文档'
                : filter === 'pdf'
                  ? '还没有 PDF 文档'
                  : '还没有扫描记录'}
            </Text>
            <Text style={styles.emptyHint}>
              {filter === 'scan'
                ? '点底部的相机按钮开始扫描'
                : '把图片整理成 PDF，随时翻页查看'}
            </Text>
            {filter !== 'scan' && (
              <Pressable
                accessibilityRole="button"
                onPress={onCreatePdf}
                style={styles.emptyBtn}
              >
                <Text style={styles.emptyBtnText}>图片转 PDF</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <View style={styles.list}>
            {rows.map((row) =>
              row.kind === 'pdf' ? (
                <PdfRow
                  key={`pdf-${row.id}`}
                  pdf={row.pdf}
                  onOpen={() => onOpenPdf(row.pdf)}
                  onDelete={() => onDeletePdf(row.pdf)}
                />
              ) : (
                <ScanRow
                  key={`scan-${row.id}`}
                  doc={row.doc}
                  onOpen={() => onOpenDoc(row.doc)}
                  onDelete={() => onDeleteDoc(row.doc)}
                />
              ),
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function PdfRow({
  pdf,
  onOpen,
  onDelete,
}: {
  pdf: PdfDoc;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const dirty = isPdfDirty(pdf);
  const cover = pdf.pages[0]?.thumbUri;
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onOpen}
      onLongPress={onDelete}
    >
      {cover ? (
        <Image source={{ uri: cover }} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.placeholder]}>
          <Text style={styles.placeholderText}>PDF</Text>
        </View>
      )}
      <View style={styles.meta}>
        <View style={styles.titleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {pdf.title}
          </Text>
          <View style={styles.tag}>
            <Text style={styles.tagText}>PDF</Text>
          </View>
        </View>
        <Text style={styles.rowSub}>
          {pdf.pageCount} 页 · {dirty ? '待重新生成' : '已生成'} ·{' '}
          {formatDate(pdf.updatedAt)}
        </Text>
      </View>
      <Pressable
        hitSlop={10}
        accessibilityLabel="删除"
        style={styles.deleteBtn}
        onPress={onDelete}
      >
        <Text style={styles.deleteText}>✕</Text>
      </Pressable>
    </Pressable>
  );
}

function ScanRow({
  doc,
  onOpen,
  onDelete,
}: {
  doc: ScanDoc;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const cover = doc.pages[0]?.thumbUri;
  return (
    <Pressable
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onOpen}
      onLongPress={onDelete}
    >
      {cover ? (
        <Image source={{ uri: cover }} style={styles.thumb} />
      ) : (
        <View style={styles.thumb} />
      )}
      <View style={styles.meta}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {doc.title}
        </Text>
        <Text style={styles.rowSub}>
          {doc.pages.length} 页 · {formatDate(doc.createdAt)}
        </Text>
      </View>
      <Pressable
        hitSlop={10}
        accessibilityLabel="删除"
        style={styles.deleteBtn}
        onPress={onDelete}
      >
        <Text style={styles.deleteText}>✕</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { paddingHorizontal: 20, paddingBottom: 14 },
  title: { fontSize: 30, fontWeight: '800', color: theme.text },
  subtitle: { fontSize: 13, color: theme.subtext, marginTop: 4 },
  chips: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
  },
  chipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { fontSize: 13, fontWeight: '600', color: theme.subtext },
  chipTextActive: { color: '#fff' },
  listScroll: { flex: 1 },
  listContent: { paddingHorizontal: 20, paddingBottom: 24 },
  list: { gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderRadius: 14,
    padding: 10,
    ...shadow,
  },
  pressed: { opacity: 0.8 },
  thumb: {
    width: 46,
    height: 60,
    borderRadius: 8,
    backgroundColor: theme.surfaceAlt,
  },
  placeholder: { alignItems: 'center', justifyContent: 'center' },
  placeholderText: { fontSize: 11, fontWeight: '800', color: theme.danger },
  meta: { flex: 1, marginLeft: 12 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowTitle: { flexShrink: 1, fontSize: 15, fontWeight: '600', color: theme.text },
  tag: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: '#fdeeee',
  },
  tagText: { fontSize: 9, fontWeight: '800', color: theme.danger },
  rowSub: { fontSize: 12, color: theme.subtext, marginTop: 4 },
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
    paddingVertical: 40,
    paddingHorizontal: 20,
    alignItems: 'center',
    ...shadow,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: theme.text,
    marginTop: 12,
  },
  emptyHint: {
    fontSize: 12,
    color: theme.subtext,
    marginTop: 6,
    textAlign: 'center',
  },
  emptyBtn: {
    marginTop: 16,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: theme.primary,
  },
  emptyBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },
});
