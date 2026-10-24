import type { ComponentProps } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import appConfig from '../../app.json';
import {
  isNativeFilterAvailable,
  nativeCoreVersion,
} from '../lib/filterNative';
import { shadow, theme } from '../theme';
import type { PdfDoc, ScanDoc } from '../types';

type Props = {
  docs: ScanDoc[];
  pdfs: PdfDoc[];
};

export default function ProfileScreen({ docs, pdfs }: Props) {
  const insets = useSafeAreaInsets();
  const native = isNativeFilterAvailable();
  const engine = native ? '原生 C++' : 'WebView Canvas';
  const engineHint = native
    ? '文件直接进算法，不走 base64'
    : 'Expo Go 兜底路径，建议用开发版';
  const pageCount =
    pdfs.reduce((sum, pdf) => sum + pdf.pageCount, 0) +
    docs.reduce((sum, doc) => sum + doc.pages.length, 0);

  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 24 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.profile}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={30} color={theme.primary} />
          </View>
          <View style={styles.profileMeta}>
            <Text style={styles.name}>扫描 Demo</Text>
            <Text style={styles.version}>
              版本 {appConfig.expo.version} · 数据只保存在本机
            </Text>
          </View>
        </View>

        <View style={styles.stats}>
          <Stat label="扫描文档" value={docs.length} />
          <View style={styles.statDivider} />
          <Stat label="PDF" value={pdfs.length} />
          <View style={styles.statDivider} />
          <Stat label="总页数" value={pageCount} />
        </View>

        <View style={styles.card}>
          <InfoRow
            icon="hardware-chip-outline"
            title="算法引擎"
            value={engine}
            hint={engineHint}
            accent={native ? theme.success : '#e08a00'}
          />
          <View style={styles.separator} />
          <InfoRow
            icon="code-slash-outline"
            title="引擎版本"
            value={nativeCoreVersion() ?? '未加载'}
          />
          <View style={styles.separator} />
          <InfoRow
            icon="folder-outline"
            title="存储位置"
            value="应用沙盒"
            hint="卸载 App 会一并删除"
          />
        </View>

        <View style={styles.card}>
          <InfoRow icon="shield-checkmark-outline" title="隐私" value="全部本机处理" />
          <View style={styles.separator} />
          <InfoRow icon="phone-portrait-outline" title="平台" value="Android · iOS" />
        </View>

        <Text style={styles.footer}>
          Android + iOS + HarmonyOS 共用同一份 C++ 算法
        </Text>
      </ScrollView>
    </View>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function InfoRow({
  icon,
  title,
  value,
  hint,
  accent,
}: {
  icon: ComponentProps<typeof Ionicons>['name'];
  title: string;
  value: string;
  hint?: string;
  accent?: string;
}) {
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={19} color={theme.subtext} />
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.rowTitle}>{title}</Text>
        {hint ? <Text style={styles.rowHint}>{hint}</Text> : null}
      </View>
      <Text style={[styles.rowValue, accent ? { color: accent } : null]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 24 },
  profile: { flexDirection: 'row', alignItems: 'center' },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#e8efff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileMeta: { flex: 1, marginLeft: 14 },
  name: { fontSize: 22, fontWeight: '800', color: theme.text },
  version: { fontSize: 12, color: theme.subtext, marginTop: 4 },
  stats: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: theme.surface,
    borderRadius: 16,
    paddingVertical: 18,
    marginTop: 20,
    ...shadow,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800', color: theme.text },
  statLabel: { fontSize: 11, color: theme.subtext, marginTop: 4 },
  statDivider: { width: StyleSheet.hairlineWidth, height: 28, backgroundColor: theme.border },
  card: {
    backgroundColor: theme.surface,
    borderRadius: 16,
    marginTop: 16,
    paddingHorizontal: 14,
    ...shadow,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.border,
    marginLeft: 34,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 10,
  },
  rowIcon: { width: 24, alignItems: 'center' },
  rowMeta: { flex: 1 },
  rowTitle: { fontSize: 14, fontWeight: '600', color: theme.text },
  rowHint: { fontSize: 11, color: theme.subtext, marginTop: 2 },
  rowValue: { fontSize: 13, color: theme.subtext, maxWidth: '45%', textAlign: 'right' },
  footer: {
    textAlign: 'center',
    fontSize: 11,
    color: theme.subtext,
    marginTop: 24,
  },
});
