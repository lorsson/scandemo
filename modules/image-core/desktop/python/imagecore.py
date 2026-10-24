"""共享图像算法的 Python 绑定（ctypes，无第三方依赖）。

两种用法：

1) 进程内处理像素（需要 numpy/Pillow 时由调用方自己解码）：

    from imagecore import ImageCore, ENHANCE
    core = ImageCore()
    core.process_rgba(bytearray_image, width, height, ENHANCE)

2) 处理图片文件（内部调用同目录/环境变量指定的 imagecore 命令行工具）：

    from imagecore import ImageCore
    core = ImageCore()
    result = core.filter_file("in.jpg", "out.jpg", "enhance", quality=90, max_dim=1600)
    print(result["width"], result["height"])

也可以当命令行用：

    python imagecore.py enhance in.jpg out.jpg [--quality 90] [--max-dim 1600]
"""

from __future__ import annotations

import ctypes
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Sequence, Union

ORIGINAL = 0
GRAY = 1
BW = 2
ENHANCE = 3

FILTER_IDS = {
    "original": ORIGINAL,
    "none": ORIGINAL,
    "gray": GRAY,
    "grey": GRAY,
    "bw": BW,
    "binary": BW,
    "enhance": ENHANCE,
}

_LIB_NAMES = {
    # libimage_core.dll 是 MinGW 默认前缀的产物，老构建里可能存在
    "win32": ("image_core.dll", "libimage_core.dll"),
    "darwin": ("libimage_core.dylib", "image_core.dylib"),
    "linux": ("libimage_core.so",),
}


def _platform_suffixes() -> Sequence[str]:
    if sys.platform.startswith("win"):
        return _LIB_NAMES["win32"]
    if sys.platform == "darwin":
        return _LIB_NAMES["darwin"]
    return _LIB_NAMES["linux"]


def _candidate_dirs() -> list[Path]:
    here = Path(__file__).resolve().parent
    # 仓库根目录：modules/image-core/desktop/python -> 上三层是仓库根；
    # 脚本被单独拷走后路径不够长，退回到脚本所在目录。
    repo = here.parents[3] if len(here.parents) > 3 else here.parent
    dirs = [
        here,
        here.parent / "build",
        here.parent / "build" / "Release",
        here.parent / "build" / "Debug",
        here.parent,
        repo / "build" / "desktop",
        repo / "build" / "desktop" / "Release",
    ]
    env_dir = os.environ.get("IMAGECORE_LIB_DIR")
    if env_dir:
        dirs.insert(0, Path(env_dir))
    return dirs


def find_library() -> Path:
    """按 IMAGECORE_LIB_DIR → 构建目录 → PYTHONPATH 顺序查找动态库。"""
    explicit = os.environ.get("IMAGECORE_LIB")
    if explicit:
        path = Path(explicit)
        if not path.exists():
            raise FileNotFoundError(f"IMAGECORE_LIB does not exist: {path}")
        return path

    for directory in _candidate_dirs():
        for name in _platform_suffixes():
            candidate = directory / name
            if candidate.exists():
                return candidate
    raise FileNotFoundError(
        "找不到 image_core 动态库；设置 IMAGECORE_LIB 指向 "
        + " / ".join(_platform_suffixes())
    )


def find_cli() -> Optional[Path]:
    explicit = os.environ.get("IMAGECORE_CLI")
    if explicit:
        path = Path(explicit)
        return path if path.exists() else None
    for directory in _candidate_dirs():
        for name in ("imagecore.exe", "imagecore"):
            candidate = directory / name
            if candidate.exists():
                return candidate
    found = shutil.which("imagecore")
    return Path(found) if found else None


class ImageCoreError(RuntimeError):
    pass


class ImageCore:
    """ctypes 封装；像素缓冲必须是可写、连续的（bytearray / memoryview / array）。"""

    def __init__(self, library: Optional[Union[str, Path]] = None) -> None:
        self._lib = ctypes.CDLL(str(library) if library else str(find_library()))
        self._lib.ic_version.restype = ctypes.c_char_p
        self._lib.ic_version.argtypes = []
        uint8_p = ctypes.POINTER(ctypes.c_uint8)
        uint32_p = ctypes.POINTER(ctypes.c_uint32)
        self._lib.ic_process_rgba.restype = ctypes.c_int32
        self._lib.ic_process_rgba.argtypes = [
            uint8_p, ctypes.c_int32, ctypes.c_int32, ctypes.c_int32
        ]
        self._lib.ic_process_argb32.restype = ctypes.c_int32
        self._lib.ic_process_argb32.argtypes = [
            uint32_p, ctypes.c_int32, ctypes.c_int32, ctypes.c_int32
        ]

    def version(self) -> str:
        return self._lib.ic_version().decode("utf-8")

    @staticmethod
    def _check(buffer: Any, needed: int) -> Any:
        try:
            view = memoryview(buffer)
        except TypeError as exc:
            raise TypeError("pixels 必须是可写的内存缓冲区") from exc
        if view.readonly:
            raise TypeError("pixels 必须可写（bytearray / memoryview / array）")
        if view.nbytes < needed:
            raise ValueError(f"缓冲区太小：需要 {needed} 字节，实际 {view.nbytes}")
        if view.nbytes != needed:
            raise ValueError(f"缓冲区大小不匹配：需要 {needed} 字节，实际 {view.nbytes}")
        return view

    @staticmethod
    def _filter_id(name: Union[str, int]) -> int:
        if isinstance(name, int):
            if name not in (ORIGINAL, GRAY, BW, ENHANCE):
                raise ValueError(f"未知滤镜编号 {name}")
            return name
        try:
            return FILTER_IDS[name.lower()]
        except KeyError as exc:
            raise ValueError(f"未知滤镜 '{name}'（可用 original/gray/bw/enhance）") from exc

    def process_rgba(self, pixels: Any, width: int, height: int,
                     filter_name: Union[str, int] = ENHANCE) -> None:
        """原地处理 RGBA 字节缓冲，长度必须恰好 width*height*4。"""
        view = self._check(pixels, width * height * 4)
        buf = (ctypes.c_uint8 * view.nbytes).from_buffer(view)
        if ctypes.addressof(buf) % 4:
            raise ValueError("缓冲区必须 4 字节对齐（切片的偏移要是 4 的倍数）")
        rc = self._lib.ic_process_rgba(buf, width, height, self._filter_id(filter_name))
        if rc != 0:
            raise ImageCoreError(f"ic_process_rgba 失败：{rc}")

    def process_argb32(self, pixels: Any, width: int, height: int,
                       filter_name: Union[str, int] = ENHANCE) -> None:
        """原地处理 0xAARRGGBB 的 uint32 缓冲（如 numpy int32/uint32 数组）。"""
        view = self._check(pixels, width * height * 4)
        buf = (ctypes.c_uint32 * (width * height)).from_buffer(view)
        if ctypes.addressof(buf) % 4:
            raise ValueError("缓冲区必须 4 字节对齐（切片的偏移要是 4 的倍数）")
        rc = self._lib.ic_process_argb32(buf, width, height, self._filter_id(filter_name))
        if rc != 0:
            raise ImageCoreError(f"ic_process_argb32 失败：{rc}")

    def filter_file(self, source: Union[str, Path], target: Union[str, Path],
                    filter_name: str = "enhance", quality: int = 90,
                    max_dim: int = 0) -> Dict[str, Any]:
        """调用命令行工具处理图片文件；返回工具输出的 JSON（含宽高与耗时）。"""
        cli = find_cli()
        if cli is None:
            raise FileNotFoundError("找不到 imagecore 命令行工具；设置 IMAGECORE_CLI")
        command = [str(cli), "-f", filter_name, "-q", str(quality), "-m", str(max_dim),
                   str(source), str(target)]
        completed = subprocess.run(command, capture_output=True, text=True)
        if completed.returncode != 0:
            raise ImageCoreError(completed.stderr.strip() or f"imagecore 退出码 {completed.returncode}")
        return json.loads(completed.stdout.strip().splitlines()[-1])


def main(argv: Sequence[str]) -> int:
    """`python imagecore.py <filter> <in> <out> [--quality N] [--max-dim N]`。"""
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if argv else 2
    cli = find_cli()
    if cli is None:
        print("找不到 imagecore 命令行工具；设置 IMAGECORE_CLI", file=sys.stderr)
        return 3
    return subprocess.call([str(cli), *argv])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
