'use strict';

// 把 Electron 界面和构建好的 imagecore 打成一个可以双击运行的目录：
//
//   npm run package
//   npm run package -- win32 x64
//
// 产物在 electron/dist/Scan Demo-<platform>-<arch>/，里面 Scan Demo(.exe)
// 就是入口；imagecore 和动态库通过 extraResources 放进 resources/。

const path = require('node:path');
const fs = require('node:fs');

// packager 会按 electron 版本重新下载一次运行时（GitHub Releases）。
// 国内直连经常超时，默认走 npmmirror；要用官方源就自己设 ELECTRON_MIRROR。
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR
  || 'https://npmmirror.com/mirrors/electron/';

const { packager } = require('@electron/packager');

const here = __dirname;
const repo = path.resolve(here, '..', '..', '..', '..');
const APP_NAME = 'Scan Demo';

const args = process.argv.slice(2);
const platform = args[0] || process.platform;
const arch = args[1] || process.arch;

const isWin = platform === 'win32';
const cliName = isWin ? 'imagecore.exe' : 'imagecore';
const libName = isWin
  ? 'image_core.dll'
  : platform === 'darwin' ? 'libimage_core.dylib' : 'libimage_core.so';

const buildDirs = ['desktop', 'desktop/Release', 'desktop-cmake', 'desktop-cmake/Release'];
const cli = [process.env.IMAGECORE_CLI, ...buildDirs.map((dir) => path.join(repo, 'build', dir, cliName))]
  .filter(Boolean)
  .find((candidate) => fs.existsSync(candidate));

if (!cli) {
  console.error(`找不到 ${cliName}。先构建桌面目标，再用 IMAGECORE_CLI 指定路径：`);
  console.error('  cmake --build build/desktop-cmake --parallel');
  process.exit(1);
}

const extraResource = [cli];
const lib = path.join(path.dirname(cli), libName);
if (fs.existsSync(lib)) extraResource.push(lib);

// Windows 用 .ico，macOS 用 .icns（没生成时用 png，Linux 也可以）
const icon = isWin
  ? path.join(here, 'assets', 'icon.ico')
  : path.join(here, 'assets', 'icon.png');

console.log(`imagecore: ${cli}`);
console.log(`icon: ${fs.existsSync(icon) ? icon : '(默认)'}`);

packager({
  dir: here,
  name: APP_NAME,
  out: path.join(here, 'dist'),
  platform,
  arch,
  overwrite: true,
  asar: true,
  prune: true,
  extraResource,
  icon: fs.existsSync(icon) ? icon : undefined,
  ignore: [/^\/dist(\/|$)/],
}).then((paths) => {
  for (const dir of paths) {
    console.log(`打包完成: ${dir}`);
    console.log(`  入口: ${path.join(dir, isWin ? `${APP_NAME}.exe` : APP_NAME)}`);
  }
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
