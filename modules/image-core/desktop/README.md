# 桌面端共享算法（Windows / macOS / Linux）

手机端的算法已经在 `modules/image-core/common/` 里，由 JNI / ObjC++ / NAPI
三份桥接调用。这里把同一份 C++ 源码再编成**桌面可用的三样东西**：

| 产物 | 用途 |
|---|---|
| `image_core.dll` / `libimage_core.dylib` / `.so` | 稳定 C ABI + JNI，供 Python ctypes、Java、Qt/WinUI/SwiftUI 调用 |
| `imagecore` 命令行工具 | 脚本、批处理、桌面 UI 直接 `exec`；支持 JPEG/PNG/BMP/TGA |
| `image_core_selftest` | 无第三方依赖的自检，`ctest` 即跑 |

仓库里带了一个 Electron 界面（[§6](#6-桌面界面electron)），Windows / macOS / Linux
都能跑，处理时调用上面的命令行工具。想换成 WinUI/WPF、SwiftUI、Qt、JavaFX、
Tkinter 也可以，只要调用同一个库或同一个命令行工具，算法就永远只有一份。

---

## 1. C ABI

头文件：[`common/image_core_c.h`](../common/image_core_c.h)

```c
const char* ic_version(void);

/* width*height 个 uint32，0xAARRGGBB（little-endian 内存顺序 B,G,R,A） */
int32_t ic_process_argb32(uint32_t* pixels, int32_t width, int32_t height, int32_t filter);

/* width*height*4 字节，行优先 R,G,B,A */
int32_t ic_process_rgba(uint8_t* pixels, int32_t width, int32_t height, int32_t filter);
```

- `filter`：`IC_FILTER_ORIGINAL(0)` / `GRAY(1)` / `BW(2)` / `ENHANCE(3)`，与 JS 的
  `FilterKey` 一一对应。
- 原地处理，不分配内存，不抛异常；返回 `IC_OK(0)` / `IC_ERR_ARGUMENT(-1)` /
  `IC_ERR_FILTER(-2)`。
- 函数无全局状态，多线程可并发调用不同缓冲区。

## 2. 命令行

```bash
imagecore -f enhance -q 90 -m 1600 input.jpg output.jpg
imagecore --filter bw scan.png scan_bw.png
imagecore --version
```

| 参数 | 说明 |
|---|---|
| `-f, --filter` | `original` / `gray` / `bw` / `enhance`，默认 `enhance` |
| `-q, --quality` | JPEG 质量 1–100，默认 90 |
| `-m, --max-dim` | 最长边缩到不超过该值（面积平均降采样），0 = 不缩放 |
| 输出格式 | 按扩展名：`.jpg/.jpeg`、`.png`、`.bmp`、`.tga` |

成功时向 stdout 打印一行 JSON：

```json
{"ok":true,"input":"in.jpg","output":"out.jpg","width":1200,"height":1600,"filter":"enhance","ms":41}
```

退出码：`0` 成功，`2` 参数错误，`3` 读写失败，`4` 算法错误。

### Windows：双击 / 拖拽

`imagecore` 是控制台程序，不带参数双击只会打印用法然后退出（看起来像闪退）。
构建时会自动把 [`win/imagecore-drop.cmd`](win/imagecore-drop.cmd) 复制到 exe 旁边：

```text
build\desktop\imagecore-drop.cmd   ← 把图片拖到它上面即可
```

- 拖一张或多张：每张输出 `原名_enhance.jpg`，重名自动加 `-1`、`-2`。
- 命令行：`imagecore-drop.cmd 输入.jpg [输出.jpg]`。
- 换滤镜：`set IMAGECORE_FILTER=bw` 后再拖（`original|gray|bw|enhance`）。
- 处理完窗口会停住显示结果，按键才关闭。

## 3. Python

零依赖（标准库 `ctypes`）：[`python/imagecore.py`](python/imagecore.py)

```python
from imagecore import ImageCore, ENHANCE

core = ImageCore()                 # 自动找 image_core.dll / .dylib / .so
print(core.version())

# A. 进程内处理像素（配 Pillow / numpy 使用）
from PIL import Image
img = Image.open("in.jpg").convert("RGBA")
buf = bytearray(img.tobytes())
core.process_rgba(buf, img.width, img.height, ENHANCE)
Image.frombytes("RGBA", img.size, bytes(buf)).save("out.jpg", quality=90)

# B. 直接处理文件（内部调用 imagecore 命令行）
print(core.filter_file("in.jpg", "out.jpg", "enhance", quality=90, max_dim=1600))
```

查找路径可用环境变量覆盖：`IMAGECORE_LIB`（库文件）、`IMAGECORE_LIB_DIR`（库目录）、
`IMAGECORE_CLI`（命令行工具）。也可以当 CLI 用：

```bash
python imagecore.py enhance in.jpg out.jpg --quality 90
```

## 4. Java

JNI 绑定：[`java/com/imagecore/ImageCore.java`](java/com/imagecore/ImageCore.java)，
命令行示例：[`ImageCoreCli.java`](java/com/imagecore/ImageCoreCli.java)。

```java
import com.imagecore.ImageCore;

BufferedImage img = ImageIO.read(new File("in.jpg"));
int w = img.getWidth(), h = img.getHeight();
int[] pixels = img.getRGB(0, 0, w, h, null, 0, w);   // 0xAARRGGBB
ImageCore.processArgb(pixels, w, h, ImageCore.ENHANCE);
img.setRGB(0, 0, w, h, pixels, 0, w);
ImageIO.write(img, "jpg", new File("out.jpg"));
```

运行时要让 JVM 找到动态库，二选一：

```bash
java -Djava.awt.headless=true -Dimagecore.library=/abs/path/image_core.dll \
     -cp classes com.imagecore.ImageCoreCli enhance in.jpg out.jpg 90
```

或把库所在目录加进 `-Djava.library.path=...`，然后省略 `imagecore.library`。

## 5. 构建

需要 CMake ≥ 3.20 和 C++17 编译器。JNI 是可选项：找得到 JDK 就编进同一个动态库，
找不到只跳过 Java 绑定。

### Windows（MinGW-w64）

```bat
winget install -e BrechtSanders.WinLibs.POSIX.UCRT   :: 自带 cmake / mingw32-make
cmake -S modules\image-core\desktop -B build\desktop -G "MinGW Makefiles" ^
      -DCMAKE_BUILD_TYPE=Release -DJAVA_HOME="C:\Program Files\Microsoft\jdk-17..."
cmake --build build\desktop --parallel
ctest --test-dir build\desktop --output-on-failure
```

产物：`build/desktop/image_core.dll`、`build/desktop/imagecore.exe`。
MinGW 默认会加 `lib` 前缀（`libimage_core.dll`），CMakeLists 里已用 `PREFIX ""`
改回 `image_core.dll`，这样 JVM 的 `System.loadLibrary("image_core")` 能直接找到。
运行库（libstdc++ / libwinpthread）静态链接进产物，DLL 只依赖 `KERNEL32` 与 UCRT。

### macOS（Xcode Command Line Tools）

```bash
cmake -S modules/image-core/desktop -B build/desktop \
      -DCMAKE_BUILD_TYPE=Release \
      -DJAVA_HOME="$(/usr/libexec/java_home)"
cmake --build build/desktop --parallel
ctest --test-dir build/desktop --output-on-failure
```

产物：`build/desktop/libimage_core.dylib`、`build/desktop/imagecore`。

### Linux

```bash
cmake -S modules/image-core/desktop -B build/desktop -DCMAKE_BUILD_TYPE=Release
cmake --build build/desktop --parallel
ctest --test-dir build/desktop --output-on-failure
```

### 手动跑自检

```bash
build/desktop/image_core_selftest assets/sample_doc.jpg
python -I modules/image-core/desktop/tests/python_test.py assets/sample_doc.jpg build/desktop/imagecore.exe
```

Python 绑定会自动在 `build/desktop`（含 `Release/` 子目录）里找库和命令行工具，
所以只要按上面的路径构建就无需设置环境变量；换目录时用 `IMAGECORE_LIB` /
`IMAGECORE_LIB_DIR` / `IMAGECORE_CLI` 覆盖。

Java 自检（先 `javac` 编译到 `classes/`）：

```bash
# Windows 的 javac 默认按 GBK 读源码，必须显式 -encoding UTF-8
javac -encoding UTF-8 -d classes modules/image-core/desktop/java/com/imagecore/*.java
java -Djava.awt.headless=true -Dimagecore.library=build/desktop/image_core.dll \
     -cp classes com.imagecore.SelfTest assets/sample_doc.jpg
```

## 6. 桌面界面（Electron）

[`electron/`](electron/) 是一个双击就能用的界面：拖拽打开、四个滤镜切换、
质量 / 最长边、按住看原图、另存为、在文件夹中显示。

```bash
cd modules/image-core/desktop/electron
npm install
npm start                      # 开发模式
npm run package                # 打包（当前平台）
npm run package -- win32 x64   # 指定平台 / 架构
```

`imagecore` 由脚本自动在 `build/desktop`、`build/desktop/Release`、
`build/desktop-cmake`、`build/desktop-cmake/Release` 里找，也可以用
`IMAGECORE_CLI` 指定。打包产物在 `electron/dist/`：

```text
dist/Scan Demo-win32-x64/Scan Demo.exe      ← 双击运行
dist/Scan Demo-win32-x64/resources/imagecore.exe
dist/Scan Demo-win32-x64/resources/image_core.dll
```

设计上刻意**不引入原生 Node 模块**：主进程用 `spawn` 调用 `imagecore`，
渲染进程 `contextIsolation: true` + `sandbox: true`，只通过
[`preload.js`](electron/preload.js) 暴露几个 IPC 函数。算法因此仍然只有
`common/image_core.cpp` 一份，和 Python / Java 用的是同一个可执行文件。

两个验证用的命令行开关（也方便 CI / 截图）：

```bash
electron . --smoke-test assets/sample_doc.jpg          # 只跑处理流程，打印 JSON
electron . --screenshot in.jpg out.png --filter=bw    # 启动界面、处理、截图、退出
```

## 7. 与手机端的关系

同一份 `common/image_core.cpp`：

| 平台 | 入口 |
|---|---|
| Android | `android/src/main/cpp/jni_bridge.cpp` |
| iOS | `ios/ImageCoreBridge.mm` |
| 鸿蒙 | `harmony/.../napi_init.cpp` |
| 桌面 / 任意 FFI | `common/image_core_c.cpp`（本目录） |

共享内核的像素契约见 [DESIGN.md §6](../../../docs/DESIGN.md) 与 §8.4。滤镜编号
`0/1/2/3` 在 JS、Kotlin、Swift、ArkTS、C ABI、Python、Java 里各有一份字面量，
开发机上用 `D:\tools-src\wsl\lib\cross_contract_check.js` 做一致性检查（不在仓库内）；
改动编号时要同时改这份脚本和 `tests/selftest.cpp`。
