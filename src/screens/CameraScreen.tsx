import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useI18n } from '../lib/i18n';
import { theme } from '../theme';

type Props = {
  onCaptured: (uri: string) => void;
  onCancel: () => void;
  onPickGallery: () => void;
};

export default function CameraScreen({ onCaptured, onCancel, onPickGallery }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [capturing, setCapturing] = useState(false);
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  const handleShoot = async () => {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const pic = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (pic?.uri) {
        onCaptured(pic.uri);
      }
    } catch {
      Alert.alert(t('captureFailedTitle'), t('captureFailedBody'));
    } finally {
      setCapturing(false);
    }
  };

  if (!permission) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permIcon}>📷</Text>
        <Text style={styles.permTitle}>{t('cameraPermissionTitle')}</Text>
        <Text style={styles.permHint}>{t('cameraPermissionHint')}</Text>
        <Pressable style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>{t('grantPermission')}</Text>
        </Pressable>
        <Pressable onPress={onCancel} style={styles.permCancel}>
          <Text style={styles.permCancelText}>{t('back')}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />

      <View style={[styles.topBar, { top: 12 + insets.top }]}>
        <Pressable hitSlop={12} style={styles.roundBtn} onPress={onCancel}>
          <Text style={styles.roundIcon}>✕</Text>
        </Pressable>
        <Text style={styles.topTitle}>{t('scanDocumentTitle')}</Text>
        <View style={{ width: 40 }} />
      </View>

      <View pointerEvents="none" style={styles.frameWrap}>
        <View style={styles.frame} />
        <Text style={styles.frameHint}>{t('frameHint')}</Text>
      </View>

      <View style={[styles.bottomBar, { bottom: 16 + insets.bottom }]}>
        <Pressable style={styles.sideBtn} onPress={onPickGallery}>
          <Text style={styles.sideIcon}>🖼️</Text>
          <Text style={styles.sideLabel}>{t('library')}</Text>
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.shutter, pressed && { opacity: 0.7 }]}
          onPress={handleShoot}
          disabled={capturing}
        >
          <View style={styles.shutterInner}>
            {capturing && <ActivityIndicator color={theme.primary} />}
          </View>
        </Pressable>

        <View style={styles.sideBtn} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: {
    flex: 1,
    backgroundColor: theme.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 30,
  },
  permIcon: { fontSize: 48, marginBottom: 14 },
  permTitle: { fontSize: 18, fontWeight: '700', color: theme.text },
  permHint: { fontSize: 13, color: theme.subtext, marginTop: 8, marginBottom: 22 },
  permBtn: {
    backgroundColor: theme.primary,
    borderRadius: 12,
    paddingVertical: 13,
    paddingHorizontal: 40,
  },
  permBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  permCancel: { marginTop: 16 },
  permCancelText: { color: theme.subtext, fontSize: 14 },
  topBar: {
    position: 'absolute',
    top: 48,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  roundBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundIcon: { color: '#fff', fontSize: 18, fontWeight: '700' },
  topTitle: { color: '#fff', fontSize: 16, fontWeight: '600' },
  frameWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  frame: {
    width: '84%',
    aspectRatio: 0.72,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    borderRadius: 10,
  },
  frameHint: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    marginTop: 14,
  },
  bottomBar: {
    position: 'absolute',
    bottom: 44,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 40,
  },
  sideBtn: { width: 56, alignItems: 'center' },
  sideIcon: { fontSize: 24 },
  sideLabel: { color: '#fff', fontSize: 11, marginTop: 4 },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
