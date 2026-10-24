package com.imagecore;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.util.Iterator;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;

/**
 * Java 命令行入口：用 ImageIO 解码/编码，算法走 JNI。
 *
 * <pre>
 * java -Djava.awt.headless=true -Dimagecore.library=.../image_core.dll \
 *      -cp classes com.imagecore.ImageCoreCli enhance in.jpg out.jpg [quality]
 * </pre>
 */
public final class ImageCoreCli {
    private ImageCoreCli() {}

    public static void main(String[] args) throws IOException {
        if (args.length == 1 && ("-v".equals(args[0]) || "--version".equals(args[0]))) {
            System.out.println(ImageCore.version());
            return;
        }
        if (args.length < 3) {
            System.err.println(
                    "usage: ImageCoreCli <original|gray|bw|enhance> <input> <output> [quality]");
            System.exit(2);
        }

        final int filter = ImageCore.filterId(args[0]);
        if (filter < 0) {
            System.err.println("error: unknown filter '" + args[0] + "'");
            System.exit(2);
        }
        final File input = new File(args[1]);
        final File output = new File(args[2]);
        int quality = 90;
        if (args.length >= 4) {
            try {
                quality = Integer.parseInt(args[3]);
            } catch (NumberFormatException e) {
                System.err.println("error: quality must be 1-100");
                System.exit(2);
            }
            if (quality < 1 || quality > 100) {
                System.err.println("error: quality must be 1-100");
                System.exit(2);
            }
        }

        final BufferedImage image = ImageIO.read(input);
        if (image == null) {
            System.err.println("error: cannot read image '" + input + "'");
            System.exit(3);
        }
        final int width = image.getWidth();
        final int height = image.getHeight();

        final long start = System.nanoTime();
        final int[] pixels = image.getRGB(0, 0, width, height, null, 0, width);
        final int rc = ImageCore.processArgb(pixels, width, height, filter);
        if (rc != 0) {
            System.err.println("error: filter failed (code " + rc + ")");
            System.exit(4);
        }
        image.setRGB(0, 0, width, height, pixels, 0, width);

        write(output, image, quality);
        final long ms = (System.nanoTime() - start) / 1_000_000L;
        System.out.printf(
                "{\"ok\":true,\"input\":\"%s\",\"output\":\"%s\",\"width\":%d,\"height\":%d,"
                        + "\"filter\":\"%s\",\"ms\":%d}%n",
                escape(input.getPath()), escape(output.getPath()), width, height,
                args[0].toLowerCase(java.util.Locale.ROOT), ms);
    }

    private static void write(File file, BufferedImage image, int quality) throws IOException {
        final String name = file.getName().toLowerCase(java.util.Locale.ROOT);
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
            writeJpeg(file, image, quality);
            return;
        }
        final String format = name.endsWith(".png") ? "png" : null;
        if (format == null || !ImageIO.write(image, format, file)) {
            throw new IOException("unsupported output format: " + file.getName());
        }
    }

    private static void writeJpeg(File file, BufferedImage image, int quality) throws IOException {
        final Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
        if (!writers.hasNext()) {
            throw new IOException("no JPEG writer available");
        }
        final ImageWriter writer = writers.next();
        final ImageWriteParam param = writer.getDefaultWriteParam();
        param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        param.setCompressionQuality(quality / 100.0f);

        // JPEG 不支持 alpha：先铺白底，避免透明区域变黑
        final BufferedImage rgb = new BufferedImage(image.getWidth(), image.getHeight(),
                BufferedImage.TYPE_INT_RGB);
        final java.awt.Graphics2D g = rgb.createGraphics();
        g.drawImage(image, 0, 0, java.awt.Color.WHITE, null);
        g.dispose();

        try (ImageOutputStream stream = ImageIO.createImageOutputStream(file)) {
            writer.setOutput(stream);
            writer.write(null, new IIOImage(rgb, null, null), param);
        } finally {
            writer.dispose();
        }
    }

    private static String escape(String text) {
        return text.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
