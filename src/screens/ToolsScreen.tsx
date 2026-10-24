import type { ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n, type MessageKey } from '../lib/i18n';
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

const UPCOMING: {
  key: string;
  labelKey: MessageKey;
  hintKey: MessageKey;
  icon: IconName;
}[] = [
  {
    key: 'crop',
    labelKey: 'autoCrop',
    hintKey: 'autoCropHint',
    icon: 'scan-outline',
  },
  {
    key: 'annotate',
    labelKey: 'annotate',
    hintKey: 'annotateHint',
    icon: 'pencil-outline',
  },
  {
    key: 'ocr',
    labelKey: 'ocr',
    hintKey: 'ocrHint',
    icon: 'text-outline',
  },
];

export default function ToolsScreen({
  onCreatePdf,
  onScan,
  onImport,
  onSample,
}: Props) {
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  const tools: Tool[] = [
    {
      key: 'pdf',
      label: t('imageToPdf'),
      hint: t('toolPdfHint'),
      icon: 'document-text-outline',
      color: theme.primary,
      onPress: onCreatePdf,
    },
    {
      key: 'scan',
      label: t('toolScan'),
      hint: t('toolScanHint'),
      icon: 'camera-outline',
      color: '#0f9f75',
      onPress: onScan,
    },
    {
      key: 'import',
      label: t('toolImport'),
      hint: t('toolImportHint'),
      icon: 'images-outline',
      color: '#8a5cf6',
      onPress: onImport,
    },
    {
      key: 'sample',
      label: t('toolSample'),
      hint: t('toolSampleHint'),
      icon: 'sparkles-outline',
      color: '#e08a00',
      onPress: onSample,
    },
  ];

  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.title}>{t('toolsTitle')}</Text>
        <Text style={styles.subtitle}>{t('toolsSubtitle')}</Text>
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
          <Text style={styles.sectionTitle}>{t('comingSoon')}</Text>
          <Text style={styles.sectionHint}>{t('reservedApi')}</Text>
        </View>

        <View style={styles.list}>
          {UPCOMING.map((item) => (
            <View key={item.key} style={[styles.row, styles.rowDisabled]}>
              <Ionicons name={item.icon} size={20} color={theme.subtext} />
              <View style={styles.rowMeta}>
                <Text style={styles.rowTitle}>{t(item.labelKey)}</Text>
                <Text style={styles.rowHint}>{t(item.hintKey)}</Text>
              </View>
              <View style={styles.soonTag}>
                <Text style={styles.soonText}>{t('soonTag')}</Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.footer}>{t('toolsFooter')}</Text>
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
