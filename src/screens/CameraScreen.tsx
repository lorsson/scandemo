import { useCallback, useRef, useState } from 'react';
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

import {
  getNativeCameraView,
  type CameraIssuePayload,
  type LiveQuadPayload,
  type NativeCameraViewHandle,
} from '../../modules/image-core';
import LiveQuadOverlay from '../components/LiveQuadOverlay';
import { useI18n } from '../lib/i18n';
import { theme } from '../theme';

type Props = {
  onCaptured: (uri: string) => void;
  onCancel: () => void;
  onPickGallery: () => void;
};

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const;

/** 模块级取一次：Android 开发构建里有原生 CameraX 视图，其余环境为 null */
const NativeCameraView = getNativeCameraView();

function formatPercent(value: number): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(1)}%`;
}

export default function CameraScreen({ onCaptured, onCancel, onPickGallery }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const nativeCameraRef = useRef<NativeCameraViewHandle | null>(null);
  const [liveQuad, setLiveQuad] = useState<number[] | null>(null);
  const [capturing, setCapturing] = useState(false);
  /** 开发构建里的相机/模型诊断信息；正式包不显示 */
  const [issue, setIssue] = useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const { t } = useI18n();

  const handleQuad = useCallback(
    (event: { nativeEvent: LiveQuadPayload }) => {
      const { detected, quad } = event.nativeEvent;
      setLiveQuad(detected && quad && quad.length === 8 ? quad : null);
    },
    [],
  );

  const handleError = useCallback((event: { nativeEvent: CameraIssuePayload }) => {
    const { kind, message } = event.nativeEvent;
    console.warn(`[image-core] ${kind}: ${message}`);
    // 检测模型挂了不影响预览和拍照，只在调试阶段提示一句
    if (__DEV__) setIssue(`${kind}: ${message}`);
  }, []);

  const handleShoot = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      if (NativeCameraView) {
        const pic = await nativeCameraRef.current?.takePicture();
        // ref 还没挂上时不能静默什么都不做，否则快门看起来没反应
        if (!pic?.uri) throw new Error('native camera not ready');
        onCaptured(pic.uri);
      } else if (cameraRef.current) {
        const pic = await cameraRef.current.takePictureAsync({ quality: 0.9 });
        if (pic?.uri) onCaptured(pic.uri);
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
      {NativeCameraView ? (
        <NativeCameraView
          ref={nativeCameraRef}
          style={StyleSheet.absoluteFill}
          onQuad={handleQuad}
          onError={handleError}
        />
      ) : (
        <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
      )}

      <View style={[styles.topBar, { top: 12 + insets.top }]}>
        <Pressable hitSlop={12} style={styles.roundBtn} onPress={onCancel}>
          <Text style={styles.roundIcon}>✕</Text>
        </Pressable>
        <Text style={styles.topTitle}>{t('scanDocumentTitle')}</Text>
        <View style={{ width: 40 }} />
      </View>

      {__DEV__ && issue ? (
        <View
          pointerEvents="none"
          style={[styles.issueBanner, { top: 60 + insets.top }]}
        >
          <Text style={styles.issueText} numberOfLines={3}>
            {issue}
          </Text>
        </View>
      ) : null}

      {NativeCameraView && liveQuad ? (
        <>
          <LiveQuadOverlay quad={liveQuad} />
          <View
            pointerEvents="none"
            style={[styles.liveInfo, { top: 64 + insets.top }]}
          >
            <Text style={styles.liveTitle}>{t('liveCorners')}</Text>
            {CORNER_LABELS.map((label, index) => (
              <Text key={label} style={styles.liveCoord}>
                {label} {formatPercent(liveQuad[index * 2])},{' '}
                {formatPercent(liveQuad[index * 2 + 1])}
              </Text>
            ))}
          </View>
        </>
      ) : (
        <View pointerEvents="none" style={styles.frameWrap}>
          <View style={styles.frame} />
          <Text style={styles.frameHint}>
            {t(NativeCameraView ? 'liveDetectHint' : 'frameHint')}
          </Text>
        </View>
      )}

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
  issueBanner: {
    position: 'absolute',
    left: 16,
    right: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(200,60,40,0.85)',
  },
  issueText: { color: '#fff', fontSize: 12 },
  liveInfo: {
    position: 'absolute',
    right: 16,
    minWidth: 120,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  liveTitle: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  liveCoord: {
    color: '#fff',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
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
