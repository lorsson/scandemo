# Vendored stb headers

Source: https://github.com/nothings/stb (branch `master`, fetched 2026-10-24 via
jsDelivr CDN; raw.githubusercontent.com truncates large files on this network).

| File | Version | SHA-256 |
|---|---|---|
| `stb_image.h` | 2.30 | `594c2fe35d49488b4382dbfaec8f98366defca819d916ac95becf3e75f4200b3` |
| `stb_image_write.h` | 1.16 | `cbd5f0ad7a9cf4468affb36354a1d2338034f2c12473cf1a8e32053cb6914a05` |

License: public domain / MIT (dual), see the header comments.

Only used by the command-line tool and the host self-test. The shared library
(`image_core`) and the JNI/ctypes paths never link stb — they operate on pixel
buffers supplied by the caller.
