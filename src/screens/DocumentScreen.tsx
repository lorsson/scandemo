import { useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatDate } from '../lib/format';
import { theme } from '../theme';
import type { ScanDoc } from '../types';
import { FILTER_LABELS } from '../types';

type Props = {
  doc: ScanDoc;
  onBack: () => void;
  onDelete: (doc: ScanDoc) => void;
};

export default function DocumentScreen({ doc, onBack, onDelete }: Props) {
  const [index, setIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(0);
  const insets = useSafeAreaInsets();

  const pages = doc.pages;
  const current = pages[Math.min(index, pages.length - 1)];

  /** 导出全部页面到系统相册；逐页写，失败时提示已导出的页数 */
  const handleExport = async () => {
    if (exporting || pages.length === 0) return;
    setExporting(true);
    setExported(0);
    let done = 0;
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        Alert.alert('未获得相册权限', '请在系统设置中允许访问相册后重试。');
        return;
      }
      for (let i = 0; i < pages.length; i++) {
        await MediaLibrary.saveToLibraryAsync(pages[i].uri);
        done = i + 1;
        setExported(done);
      }
      Alert.alert('已保存', `${pages.length} 页已导出到系统相册。`);
    } catch (e) {
      Alert.alert('导出失败', exportFailedMessage(e, done));
    } finally {
      setExporting(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert('删除文档', `确定删除这份扫描件吗？共 ${pages.length} 页。`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => onDelete(doc) },
    ]);
  };

  return (
    <View style={styles.root}>
      <View style={[styles.topBar, { paddingTop: 12 + insets.top }]}>
        <Pressable hitSlop={12} onPress={onBack} style={styles.topBtn}>
          <Text style={styles.topBtnText}>返回</Text>
        </Pressable>
        <Text style={styles.topTitle} numberOfLines={1}>
          {doc.title}
        </Text>
        <Text style={styles.topMeta}>{pages.length} 页</Text>
      </View>

      <View style={styles.imageWrap}>
        {current ? (
          <Image
            source={{ uri: current.uri }}
            style={styles.image}
            resizeMode="contain"
          />
        ) : (
          <Text style={styles.emptyText}>文档没有页面</Text>
        )}
      </View>

      {pages.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.strip}
          contentContainerStyle={styles.stripContent}
        >
          {pages.map((page, i) => {
            const selected = i === index;
            return (
              <Pressable
                key={page.id}
                accessibilityRole="button"
                accessibilityLabel={`第 ${i + 1} 页`}
                accessibilityState={{ selected }}
                onPress={() => setIndex(i)}
                style={[styles.thumbWrap, selected && styles.thumbWrapActive]}
              >
                <Image source={{ uri: page.thumbUri }} style={styles.thumb} />
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      <View style={styles.metaBar}>
        <View style={styles.metaText}>
          <Text style={styles.metaTitle}>
            {pages.length > 1 ? `第 ${index + 1} / ${pages.length} 页` : '1 页'}
            {current
              ? ` · ${FILTER_LABELS[current.filter]}${
                  current.rotation ? ` · 旋转 ${current.rotation}°` : ''
                }`
              : ''}
          </Text>
          <Text style={styles.metaSub}>扫描时间 {formatDate(doc.createdAt)}</Text>
        </View>
      </View>

      <View style={[styles.actions, { paddingBottom: 16 + insets.bottom }]}>
        <Pressable
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.8 }]}
          onPress={handleExport}
          disabled={exporting || pages.length === 0}
        >
          <Text style={styles.actionText}>
            {exporting
              ? `导出中 ${exported}/${pages.length}`
              : pages.length > 1
                ? `导出 ${pages.length} 页到相册`
                : '导出到相册'}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.deleteBtn, pressed && { opacity: 0.8 }]}
          onPress={confirmDelete}
        >
          <Text style={styles.deleteText}>删除</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** 导出到一半失败：告诉用户已保存了几页，避免重复导出 */
function exportFailedMessage(error: unknown, exported: number): string {
  const message = error instanceof Error ? error.message : '未知错误';
  return exported > 0
    ? `已导出 ${exported} 页，后续页面写入失败：${message}`
    : `无法写入相册：${message}`;
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
  topBtn: { minWidth: 44 },
  topBtnText: { color: '#c9ced8', fontSize: 15 },
  topTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
    textAlign: 'center',
  },
  topMeta: { minWidth: 44, textAlign: 'right', color: '#8a90a0', fontSize: 12 },
  imageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  image: { width: '100%', height: '100%' },
  emptyText: { color: '#8a90a0', fontSize: 14 },
  strip: {
    maxHeight: 92,
    backgroundColor: '#0f1219',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#232838',
  },
  stripContent: {
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
  },
  thumbWrap: {
    width: 46,
    height: 62,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: 'transparent',
    overflow: 'hidden',
    backgroundColor: '#232838',
  },
  thumbWrapActive: { borderColor: '#6ea0ff' },
  thumb: { width: '100%', height: '100%' },
  metaBar: { paddingHorizontal: 20, paddingVertical: 12 },
  metaText: { flex: 1 },
  metaTitle: { color: '#fff', fontSize: 15, fontWeight: '700' },
  metaSub: { color: '#8a90a0', fontSize: 12, marginTop: 4 },
  actions: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingBottom: 34,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: theme.primary,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  actionText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  deleteBtn: {
    width: 96,
    backgroundColor: '#2a2f3d',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  deleteText: { color: '#ff9a9a', fontWeight: '700', fontSize: 15 },
});
