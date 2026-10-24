import type { ComponentProps } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../theme';

export type TabKey = 'home' | 'docs' | 'tools' | 'profile';

type IconName = ComponentProps<typeof Ionicons>['name'];

type Item = {
  key: TabKey;
  label: string;
  icon: IconName;
  activeIcon: IconName;
};

/** 左右各两个，中间的相机单独渲染成一个凸起的圆按钮 */
const LEFT: Item[] = [
  { key: 'home', label: '首页', icon: 'home-outline', activeIcon: 'home' },
  {
    key: 'docs',
    label: '全部文档',
    icon: 'documents-outline',
    activeIcon: 'documents',
  },
];

const RIGHT: Item[] = [
  { key: 'tools', label: '工具箱', icon: 'apps-outline', activeIcon: 'apps' },
  {
    key: 'profile',
    label: '我的',
    icon: 'person-outline',
    activeIcon: 'person',
  },
];

type Props = {
  active: TabKey;
  onChange: (tab: TabKey) => void;
  onScan: () => void;
};

export default function TabBar({ active, onChange, onScan }: Props) {
  const insets = useSafeAreaInsets();

  const renderItem = (item: Item) => {
    const focused = active === item.key;
    return (
      <Pressable
        key={item.key}
        accessibilityRole="button"
        accessibilityLabel={item.label}
        accessibilityState={{ selected: focused }}
        style={styles.item}
        onPress={() => onChange(item.key)}
      >
        <Ionicons
          name={focused ? item.activeIcon : item.icon}
          size={22}
          color={focused ? theme.primary : theme.subtext}
        />
        <Text style={[styles.label, focused && styles.labelActive]}>
          {item.label}
        </Text>
      </Pressable>
    );
  };

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 6) }]}>
      {LEFT.map(renderItem)}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="相机"
        style={styles.cameraSlot}
        onPress={onScan}
      >
        {/* 凸起的主按钮：负 margin 让它跨在底栏上沿 */}
        <View style={styles.cameraBtn}>
          <Ionicons name="camera" size={26} color="#fff" />
        </View>
        <Text style={styles.cameraLabel}>相机</Text>
      </Pressable>

      {RIGHT.map(renderItem)}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingTop: 8,
    backgroundColor: theme.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    shadowColor: '#1a1f2e',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: -3 },
    elevation: 12,
    overflow: 'visible',
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 2,
    paddingBottom: 4,
  },
  label: {
    fontSize: 10,
    fontWeight: '600',
    color: theme.subtext,
    marginTop: 3,
  },
  labelActive: { color: theme.primary },
  cameraSlot: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  cameraBtn: {
    width: 54,
    height: 54,
    borderRadius: 27,
    marginTop: -22,
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: theme.surface,
    shadowColor: theme.primaryDark,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  cameraLabel: {
    fontSize: 10,
    fontWeight: '700',
    color: theme.primary,
    marginTop: 3,
    marginBottom: 4,
  },
});
