package com.imagecore;

import java.awt.image.BufferedImage;
import java.io.File;

import javax.imageio.ImageIO;

/**
 * Java 绑定自检（无第三方测试框架）。
 *
 * <pre>
 * java -Djava.awt.headless=true -Dimagecore.library=.../image_core.dll \
 *      -cp classes com.imagecore.SelfTest [sample.jpg]
 * </pre>
 */
public final class SelfTest {
    private static int failures;

    private SelfTest() {}

    public static void main(String[] args) throws Exception {
        testSynthetic();
        if (args.length > 0) {
            testFile(new File(args[0]));
        } else {
            System.out.println("SKIP  sample image (no path given)");
        }
        System.out.printf("%n%s (%d failure%s)%n", failures == 0 ? "OK" : "FAILED",
                failures, failures == 1 ? "" : "s");
        System.exit(failures == 0 ? 0 : 1);
    }

    private static void check(boolean ok, String name) {
        System.out.println((ok ? "PASS" : "FAIL") + "  " + name);
        if (!ok) {
            failures++;
        }
    }

    private static int channel(int argb, int shift) {
        return (argb >> shift) & 0xff;
    }

    private static void testSynthetic() {
        check(ImageCore.version().contains("image-core"), "version string");

        int[] gray = {0xFFC80A0A, 0xFF0AC80A, 0xFF0A0AC8, 0xFF808080};
        check(ImageCore.processArgb(gray, 4, 1, ImageCore.GRAY) == 0, "gray ok");
        boolean neutral = true;
        boolean alphaOk = true;
        for (int px : gray) {
            final int r = channel(px, 16);
            final int g = channel(px, 8);
            final int b = channel(px, 0);
            if (r != g || g != b) neutral = false;
            if (channel(px, 24) != 255) alphaOk = false;
        }
        check(neutral, "gray keeps R=G=B");
        check(alphaOk, "gray keeps alpha");
        // (200,10,10) → luma 66 → (66-128)*1.15+128 ≈ 56
        check(Math.abs(channel(gray[0], 16) - 56) <= 1, "gray luma curve");

        int[] bw = {0xFFC80A0A, 0xFF0AC80A, 0xFF0A0AC8, 0xFF808080};
        check(ImageCore.processArgb(bw, 4, 1, ImageCore.BW) == 0, "bw ok");
        boolean binary = true;
        for (int px : bw) {
            final int v = channel(px, 16);
            if ((v != 0 && v != 255) || v != channel(px, 8) || v != channel(px, 0)) {
                binary = false;
            }
        }
        check(binary, "bw outputs only 0/255");

        int[] enhance = {0xFFC80A0A, 0xFF0AC80A, 0xFF0A0AC8, 0xFF808080};
        check(ImageCore.processArgb(enhance, 4, 1, ImageCore.ENHANCE) == 0, "enhance ok");
        final int r = channel(enhance[0], 16);
        check(r >= 218 && r <= 222 && channel(enhance[0], 8) <= 2
                && channel(enhance[0], 0) <= 2, "enhance stretches dark pixels");

        int[] original = {0xFFC80A0A};
        check(ImageCore.processArgb(original, 1, 1, ImageCore.ORIGINAL) == 0,
                "original is a no-op");
        check(original[0] == 0xFFC80A0A, "original leaves pixels untouched");

        check(ImageCore.processArgb(new int[0], 1, 1, ImageCore.GRAY) != 0,
                "undersized array rejected");
        check(ImageCore.filterId("enhance") == ImageCore.ENHANCE, "filterId(enhance)");
        check(ImageCore.filterId("nope") == -1, "filterId(unknown)");
    }

    private static void testFile(File file) throws Exception {
        final BufferedImage image = ImageIO.read(file);
        if (image == null) {
            check(false, "sample: cannot read " + file);
            return;
        }
        final int width = image.getWidth();
        final int height = image.getHeight();
        final int[] pixels = image.getRGB(0, 0, width, height, null, 0, width);
        check(ImageCore.processArgb(pixels, width, height, ImageCore.GRAY) == 0,
                "sample: gray ok (" + width + "x" + height + ")");
        boolean neutral = true;
        for (int px : pixels) {
            if (channel(px, 16) != channel(px, 8) || channel(px, 8) != channel(px, 0)) {
                neutral = false;
                break;
            }
        }
        check(neutral, "sample: every pixel neutral");
    }
}
