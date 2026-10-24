"""Python 绑定自检（标准库即可）。

    python -I tests/python_test.py [sample.jpg] [imagecore-cli]
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "python"))

from imagecore import BW, ENHANCE, GRAY, ImageCore  # noqa: E402

failures = 0


def check(ok: bool, name: str) -> None:
    global failures
    print(("PASS" if ok else "FAIL") + "  " + name)
    if not ok:
        failures += 1


def test_synthetic(core: ImageCore) -> None:
    check("image-core" in core.version(), "version string")

    pixels = bytearray([
        200, 10, 10, 255,
        10, 200, 10, 255,
        10, 10, 200, 255,
        128, 128, 128, 255,
    ])
    core.process_rgba(pixels, 4, 1, GRAY)
    neutral = all(pixels[i] == pixels[i + 1] == pixels[i + 2] for i in range(0, 16, 4))
    alpha = all(pixels[i + 3] == 255 for i in range(0, 16, 4))
    check(neutral, "gray keeps R=G=B")
    check(alpha, "gray keeps alpha")
    check(abs(pixels[0] - 56) <= 1, "gray luma curve")

    bw = bytearray([
        200, 10, 10, 255,
        10, 200, 10, 255,
        10, 10, 200, 255,
        128, 128, 128, 255,
    ])
    core.process_rgba(bw, 4, 1, BW)
    check(all(bw[i] in (0, 255) and bw[i] == bw[i + 1] == bw[i + 2]
              for i in range(0, 16, 4)), "bw outputs only 0/255")

    enhance = bytearray([200, 10, 10, 255])
    core.process_rgba(enhance, 1, 1, ENHANCE)
    check(218 <= enhance[0] <= 222 and enhance[1] <= 2 and enhance[2] <= 2
          and enhance[3] == 255, "enhance stretches dark pixels")

    original = bytearray([200, 10, 10, 255])
    core.process_rgba(original, 1, 1, 0)
    check(bytes(original) == bytes([200, 10, 10, 255]), "original is a no-op")

    try:
        core.process_rgba(bytearray(12), 1, 1, GRAY)
        check(False, "undersized buffer rejected")
    except ValueError:
        check(True, "undersized buffer rejected")

    try:
        core.process_rgba(bytearray(4), 1, 1, 77)
        check(False, "unknown filter rejected")
    except ValueError:
        check(True, "unknown filter rejected")


def test_file(core: ImageCore, sample: Path, cli: Path | None) -> None:
    if cli is not None:
        os.environ["IMAGECORE_CLI"] = str(cli)
    try:
        output = Path(tempfile.gettempdir()) / "imagecore_python_test.jpg"
        result = core.filter_file(sample, output, "gray", quality=85, max_dim=800)
    except Exception as exc:  # noqa: BLE001 - 自检需要报告任何失败
        check(False, f"filter_file: {exc}")
        return
    check(output.exists() and output.stat().st_size > 0, "filter_file writes output")
    check(result.get("filter") == "gray", "filter_file reports filter")
    check(result.get("width", 0) > 0 and result.get("height", 0) > 0,
          f"filter_file reports size {result.get('width')}x{result.get('height')}")
    check(max(result["width"], result["height"]) <= 800, "max_dim respected")
    print("      " + json.dumps(result, ensure_ascii=False))


def main() -> int:
    core = ImageCore()
    test_synthetic(core)

    sample = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    cli = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if sample and sample.exists():
        test_file(core, sample, cli)
    else:
        print("SKIP  sample image (no path given)")

    print(f"\n{'OK' if failures == 0 else 'FAILED'} ({failures} failure"
          f"{'' if failures == 1 else 's'})")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
