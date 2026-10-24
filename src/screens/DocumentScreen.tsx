import { useState } from 'react';
import {
  Alert,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as MediaLibrary from 'expo-media-library/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../theme';
import type { ScanDoc } from '../types';
import { FILTER_LABELS } from '../types';

type Props = {
  doc: ScanDoc;
  onBack: () => void;
  onDelete: (doc: ScanDoc) => void;
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function DocumentScreen({ doc, onBack, onDelete }: Props) {
  const [exporting, setExporting] = useState(false);
  const insets = useSafeAreaInsets();

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const perm = await MediaLibrary.requestPermissionsAsync(true);
      if (!perm.granted) {
        Alert.alert('未获得相册权限', '请在系统设置中允许访问相册后重试。');
        return;
      }
      await MediaLibrary.saveToLibraryAsync(doc.uri);
      Alert.alert('已保存', '扫描件已导出到系统相册。');
    } catch (e) {
      Alert.alert('导出失败', `无法写入相册：${(e as Error)?.message ?? '未知错误'}`);
    } finally {
      setExporting(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert('删除文档', '确定删除这份扫描件吗？', [
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
        <View style={{ width: 44 }} />
      </View>

      <View style={styles.imageWrap}>
        <Image source={{ uri: doc.uri }} style={styles.image} resizeMode="contain" />
      </View>

      <View style={styles.metaBar}>
        <View>
          <Text style={styles.metaTitle}>{FILTER_LABELS[doc.filter]}模式</Text>
          <Text style={styles.metaSub}>扫描时间 {formatDate(doc.createdAt)}</Text>
        </View>
      </View>

      <View style={[styles.actions, { paddingBottom: 16 + insets.bottom }]}>
        <Pressable
          style={({ pressed }) => [styles.actionBtn, pressed && { opacity: 0.8 }]}
          onPress={handleExport}
          disabled={exporting}
        >
          <Text style={styles.actionText}>{exporting ? '导出中…' : '导出到相册'}</Text>
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
  topTitle: { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1, textAlign: 'center' },
  imageWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
  image: { width: '100%', height: '100%' },
  metaBar: { paddingHorizontal: 20, paddingVertical: 12 },
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
