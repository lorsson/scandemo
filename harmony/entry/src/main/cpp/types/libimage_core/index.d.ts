/**
 * Type definitions for libimage_core.so (NAPI bridge over the shared C++ kernel).
 */

/**
 * Pixel buffer contract: width*height little-endian uint32 values, each
 * 0xAARRGGBB. Request `BGRA_8888` from the HarmonyOS decoder so the memory
 * order (B,G,R,A) yields exactly that integer.
 */
export const processPixels: (buffer: ArrayBuffer, width: number, height: number, filter: number) => number;

export const version: () => string;
