package com.imagecore;

/**
 * 共享 C++ 算法的 Java 绑定（JNI）。
 *
 * <pre>{@code
 * int[] pixels = image.getRGB(0, 0, w, h, null, 0, w);   // 0xAARRGGBB
 * ImageCore.processArgb(pixels, w, h, ImageCore.ENHANCE);
 * image.setRGB(0, 0, w, h, pixels, 0, w);
 * }</pre>
 *
 * 动态库加载顺序：
 *   1. -Dimagecore.library=<绝对路径>
 *   2. java.library.path 里的 image_core（Windows: image_core.dll）
 */
public final class ImageCore {
    public static final int ORIGINAL = 0;
    public static final int GRAY = 1;
    public static final int BW = 2;
    public static final int ENHANCE = 3;

    private static boolean loaded;

    private ImageCore() {}

    private static synchronized void ensureLoaded() {
        if (loaded) {
            return;
        }
        String explicit = System.getProperty("imagecore.library");
        if (explicit != null && !explicit.isEmpty()) {
            System.load(new java.io.File(explicit).getAbsolutePath());
        } else {
            System.loadLibrary("image_core");
        }
        loaded = true;
    }

    /** 形如 "image-core/0.1.0"。 */
    public static String version() {
        ensureLoaded();
        return nativeVersion();
    }

    /** 原地处理 0xAARRGGBB 像素数组；返回 0 表示成功。 */
    public static int processArgb(int[] pixels, int width, int height, int filter) {
        ensureLoaded();
        return nativeProcessArgb(pixels, width, height, filter);
    }

    /** 原地处理 RGBA 字节数组（长度 >= width*height*4）；返回 0 表示成功。 */
    public static int processRgba(byte[] pixels, int width, int height, int filter) {
        ensureLoaded();
        return nativeProcessRgba(pixels, width, height, filter);
    }

    /** "original" / "gray" / "bw" / "enhance" → 滤镜编号；未知名称返回 -1。 */
    public static int filterId(String name) {
        switch (name.toLowerCase(java.util.Locale.ROOT)) {
            case "original":
            case "none":
                return ORIGINAL;
            case "gray":
            case "grey":
                return GRAY;
            case "bw":
            case "binary":
                return BW;
            case "enhance":
                return ENHANCE;
            default:
                return -1;
        }
    }

    private static native String nativeVersion();

    private static native int nativeProcessArgb(int[] pixels, int width, int height, int filter);

    private static native int nativeProcessRgba(byte[] pixels, int width, int height, int filter);
}
