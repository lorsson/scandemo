import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import type { ScanDoc } from '../types';

const INDEX_KEY = 'scans.index.v1';
const BASE_DIR = `${FileSystem.documentDirectory ?? ''}scans/`;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(BASE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(BASE_DIR, { intermediates: true });
  }
}

export async function loadDocs(): Promise<ScanDoc[]> {
  const raw = await AsyncStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as ScanDoc[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveIndex(docs: ScanDoc[]): Promise<void> {
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(docs));
}

export async function persistImage(base64: string, id: string): Promise<string> {
  await ensureDir();
  const path = `${BASE_DIR}${id}.jpg`;
  await FileSystem.writeAsStringAsync(path, base64, { encoding: 'base64' as any });
  return path;
}

export async function removeImage(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // 忽略删除失败
  }
}
