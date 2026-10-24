import type { ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { shadow, theme } from '../theme';

type IconName = ComponentProps<typeof Ionicons>['name'];

type Props = {
  onCreatePdf: () => void;
  onScan: () => void;
  onImport: () => void;
  onSample: () => void;
};

type Tool = {
  key: string;
  label: string;
  hint: string;
  icon: IconName;
  color: string;
  onPress: () => void;
};

const UPCOMING: { key: string; label: string; hint: string; icon: IconName }[] = [
  { key: 'crop', label: '自动切边', hint: '自动找到纸张四角', icon: 'scan-outline' },
  { key: 'annotate', label: '批注', hint: '手写与文字标注', icon: 'pencil-outline' },
  { key: 'ocr', label: '文字识别', hint: '提取图片里的文字', icon: 'text-outline' },
];

export default function ToolsScreen({
  onCreatePdf,
  onScan,
  onImport,
  onSample,
}: Props) {
  const insets = useSafeAreaInsets();

  const tools: Tool[] = [
    {
      key: 'pdf',
      label: '图片转 PDF',
      hint: '多选图片 · 自动算法',
      icon: 'document-text-outline',
      color: theme.primary,
      onPress: onCreatePdf,
    },
    {
      key: 'scan',
      label: '拍照扫描',
      hint: '拍摄后自动增强',
      icon: 'camera-outline',
      color: '#0f9f75',
      onPress: onScan,
    },
    {
      key: 'import',
      label: '导入图片',
      hint: '从相册选择',
      icon: 'images-outline',
      color: '#8a5cf6',
      onPress: onImport,
    },
    {
      key: 'sample',
      label: '示例文档',
      hint: '不用相机快速体验',
      icon: 'sparkles-outline',
      color: '#e08a00',
      onPress: onSample,
    },
  ];

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>工具箱</Text>
        <Text style={styles.subtitle}>扫描、转换与整理</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.grid}>
          {tools.map((tool) => (
            <Pressable
              key={tool.key}
              accessibilityRole="button"
              accessibilityLabel={tool.label}
              onPress={tool.onPress}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            >
              <View style={[styles.iconWrap, { backgroundColor: `${tool.color}14` }]}>
                <Ionicons name={tool.icon} size={26} color={tool.color} />
              </View>
              <Text style={styles.cardTitle}>{tool.label}</Text>
              <Text style={styles.cardHint}>{tool.hint}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>即将上线</Text>
          <Text style={styles.sectionHint}>预留接口</Text>
        </View>

        <View style={styles.list}>
          {UPCOMING.map((item) => (
            <View key={item.key} style={[styles.row, styles.rowDisabled]}>
              <Ionicons name={item.icon} size={20} color={theme.subtext} />
              <View style={styles.rowMeta}>
                <Text style={styles.rowTitle}>{item.label}</Text>
                <Text style={styles.rowHint}>{item.hint}</Text>
              </View>
              <View style={styles.soonTag}>
                <Text style={styles.soonText}>敬请期待</Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.footer}>
          所有处理都在本机完成，图片不会上传到服务器。
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { paddingHorizontal: 20, paddingBottom: 14 },
  title: { fontSize: 30, fontWeight: '800', color: theme.text },
  subtitle: { fontSize: 13, color: theme.subtext, marginTop: 4 },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 24 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    width: '48%',
    flexGrow: 1,
    backgroundColor: theme.surface,
    borderRadius: 16,
    padding: 16,
    ...shadow,
  },
  pressed: { opacity: 0.8 },
  iconWrap: {
    width: 46,
    height: 46,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: theme.text,
    marginTop: 12,
  },
  cardHint: { fontSize: 11, color: theme.subtext, marginTop: 4 },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginTop: 28,
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: theme.text },
  sectionHint: { fontSize: 12, color: theme.subtext },
  list: { gap: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: theme.surface,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    ...shadow,
  },
  rowDisabled: { opacity: 0.65 },
  rowMeta: { flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: '600', color: theme.text },
  rowHint: { fontSize: 11, color: theme.subtext, marginTop: 3 },
  soonTag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: theme.surfaceAlt,
  },
  soonText: { fontSize: 10, fontWeight: '600', color: theme.subtext },
  footer: {
    textAlign: 'center',
    fontSize: 11,
    color: theme.subtext,
    marginTop: 26,
  },
});
