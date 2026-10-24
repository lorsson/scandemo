import type { ComponentProps } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import appConfig from '../../app.json';
import {
  isNativeFilterAvailable,
  nativeCoreVersion,
} from '../lib/filterNative';
import { useI18n, type LocalePreference } from '../lib/i18n';
import { shadow, theme } from '../theme';
import type { PdfDoc, ScanDoc } from '../types';

type Props = {
  docs: ScanDoc[];
  pdfs: PdfDoc[];
};

export default function ProfileScreen({ docs, pdfs }: Props) {
  const insets = useSafeAreaInsets();
  const { t, preference, setPreference } = useI18n();
  const native = isNativeFilterAvailable();
  const engine = native ? t('nativeEngine') : t('canvasEngine');
  const engineHint = native
    ? t('nativeEngineHint')
    : t('canvasEngineHint');
  const pageCount =
    pdfs.reduce((sum, pdf) => sum + pdf.pageCount, 0) +
    docs.reduce((sum, doc) => sum + doc.pages.length, 0);
  const languageOptions: { value: LocalePreference; label: string }[] = [
    { value: 'system', label: t('languageSystem') },
    { value: 'zh', label: t('languageChinese') },
    { value: 'en', label: t('languageEnglish') },
  ];

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
            <Text style={styles.name}>{t('appName')}</Text>
            <Text style={styles.version}>
              {t('versionLine', { version: appConfig.expo.version })}
            </Text>
          </View>
        </View>

        <View style={styles.stats}>
          <Stat label={t('statScans')} value={docs.length} />
          <View style={styles.statDivider} />
          <Stat label="PDF" value={pdfs.length} />
          <View style={styles.statDivider} />
          <Stat label={t('statTotalPages')} value={pageCount} />
        </View>

        <View style={styles.card}>
          <InfoRow
            icon="hardware-chip-outline"
            title={t('algorithmEngine')}
            value={engine}
            hint={engineHint}
            accent={native ? theme.success : '#e08a00'}
          />
          <View style={styles.separator} />
          <InfoRow
            icon="code-slash-outline"
            title={t('engineVersion')}
            value={nativeCoreVersion() ?? t('notLoaded')}
          />
          <View style={styles.separator} />
          <InfoRow
            icon="folder-outline"
            title={t('storageLocation')}
            value={t('appSandbox')}
            hint={t('appSandboxHint')}
          />
        </View>

        <View style={styles.card}>
          <InfoRow icon="shield-checkmark-outline" title={t('privacy')} value={t('onDeviceOnly')} />
          <View style={styles.separator} />
          <InfoRow icon="phone-portrait-outline" title={t('platform')} value="Android · iOS" />
        </View>

        <View style={styles.card}>
          <View style={styles.langHeader}>
            <Text style={styles.langTitle}>{t('language')}</Text>
            <Text style={styles.langHint}>{t('languageHint')}</Text>
          </View>
          <View style={styles.langRow}>
            {languageOptions.map((option) => {
              const selected = preference === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => setPreference(option.value)}
                  style={[styles.langChip, selected && styles.langChipOn]}
                >
                  {selected && (
                    <Ionicons
                      name="checkmark"
                      size={13}
                      color="#fff"
                      style={styles.langCheck}
                    />
                  )}
                  <Text
                    style={[
                      styles.langChipText,
                      selected && styles.langChipTextOn,
                    ]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Text style={styles.footer}>{t('profileFooter')}</Text>
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
  langHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingTop: 14,
    paddingBottom: 10,
    gap: 8,
  },
  langTitle: { fontSize: 14, fontWeight: '600', color: theme.text },
  langHint: { flexShrink: 1, fontSize: 10, color: theme.subtext },
  langRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingBottom: 16,
  },
  langChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceAlt,
  },
  langChipOn: {
    backgroundColor: theme.primary,
    borderColor: theme.primary,
  },
  langCheck: { marginRight: 5 },
  langChipText: { fontSize: 12, fontWeight: '600', color: theme.text },
  langChipTextOn: { color: '#fff' },
  footer: {
    textAlign: 'center',
    fontSize: 11,
    color: theme.subtext,
    marginTop: 24,
  },
});
