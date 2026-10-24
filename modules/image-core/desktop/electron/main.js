'use strict';

// Electron 主进程：窗口、文件对话框，以及调用 imagecore 命令行。
//
// 算法仍然只有一份（common/image_core.cpp）：这里通过桌面构建产物
// imagecore（CLI）调用它，所以 UI 进程里没有任何原生依赖，Python/Java/CI
// 用的是同一个可执行文件和同一个 C ABI。

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const FILTERS = new Set(['original', 'gray', 'bw', 'enhance']);
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.bmp', '.tga'];
const MAX_PREVIEW_BYTES = 24 * 1024 * 1024;

const argv = process.argv.slice(process.defaultApp ? 2 : 1);
const smokeIndex = argv.indexOf('--smoke-test');
const shotIndex = argv.indexOf('--screenshot');

function cliFileName() {
  return process.platform === 'win32' ? 'imagecore.exe' : 'imagecore';
}

function cliCandidates() {
  const name = cliFileName();
  const here = __dirname;
  const repo = path.resolve(here, '..', '..', '..', '..');
  const build = (dir) => path.join(repo, 'build', dir, name);
  const resources = process.resourcesPath || '';
  const list = [
    process.env.IMAGECORE_CLI,
    // 打包后：imagecore(.exe) 通过 extraResources 放在 resources/bin 或 resources 根
    resources ? path.join(resources, 'bin', name) : null,
    resources ? path.join(resources, name) : null,
    path.join(here, name), // 开发时把 exe 拷到这里也能找到
    build('desktop'),
    build('desktop/Release'),
    build('desktop-cmake'),
    build('desktop-cmake/Release'),
  ].filter(Boolean);

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) list.push(path.join(dir, name));
  }
  return list;
}

function resolveCli() {
  for (const candidate of cliCandidates()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续找下一个
    }
  }
  return null;
}

function runCli(cli, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `imagecore 退出码 ${code}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`无法解析 imagecore 输出：${line}`));
      }
    });
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function mimeOf(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.png': return 'image/png';
    case '.bmp': return 'image/bmp';
    case '.tga': return 'image/x-tga';
    default: return 'image/jpeg';
  }
}

async function toDataUrl(file) {
  const stat = await fsp.stat(file);
  if (stat.size > MAX_PREVIEW_BYTES) return null;
  const buffer = await fsp.readFile(file);
  return `data:${mimeOf(file)};base64,${buffer.toString('base64')}`;
}

async function describeFile(file) {
  const stat = await fsp.stat(file);
  return {
    path: file,
    name: path.basename(file),
    bytes: stat.size,
    url: await toDataUrl(file),
  };
}

let outputCounter = 0;

async function processImage(options) {
  const cli = resolveCli();
  if (!cli) {
    throw new Error('找不到 imagecore（先构建 desktop 目标，或用 IMAGECORE_CLI 指定路径）');
  }
  const inputPath = options && options.inputPath;
  if (typeof inputPath !== 'string' || !fs.existsSync(inputPath)) {
    throw new Error('输入文件不存在');
  }

  const filter = FILTERS.has(options.filter) ? options.filter : 'enhance';
  const quality = clampInt(options.quality, 1, 100, 90);
  const maxDim = clampInt(options.maxDim, 0, 8000, 0);

  const outDir = path.join(app.getPath('temp'), 'imagecore-desktop');
  await fsp.mkdir(outDir, { recursive: true });
  const ext = path.extname(inputPath).toLowerCase();
  const outExt = ['.png', '.bmp', '.tga'].includes(ext) ? ext : '.jpg';
  const outputPath = path.join(
    outDir,
    `out-${Date.now()}-${(outputCounter += 1)}${outExt}`,
  );

  const info = await runCli(cli, [
    '-f', filter,
    '-q', String(quality),
    '-m', String(maxDim),
    inputPath,
    outputPath,
  ]);

  return {
    ...info,
    outputPath,
    bytes: (await fsp.stat(outputPath)).size,
    url: await toDataUrl(outputPath),
  };
}

function registerIpc() {
  ipcMain.handle('version', async () => {
    const cli = resolveCli();
    if (!cli) return 'imagecore 未构建';
    const child = spawn(cli, ['--version'], { windowsHide: true });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    return new Promise((resolve) => {
      child.on('close', () => resolve(out.trim() || 'unknown'));
      child.on('error', () => resolve('unknown'));
    });
  });

  ipcMain.handle('pick-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'tga'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return describeFile(result.filePaths[0]);
  });

  ipcMain.handle('open', async (_event, filePath) => {
    if (typeof filePath !== 'string' || !fs.existsSync(filePath)) {
      throw new Error('文件不存在');
    }
    if (!IMAGE_EXTS.includes(path.extname(filePath).toLowerCase())) {
      throw new Error(`不支持的格式：${path.extname(filePath) || '无扩展名'}`);
    }
    return describeFile(filePath);
  });

  ipcMain.handle('process', (_event, options) => processImage(options));

  ipcMain.handle('save-as', async (_event, options) => {
    const sourcePath = options && options.sourcePath;
    if (typeof sourcePath !== 'string' || !fs.existsSync(sourcePath)) {
      throw new Error('没有可保存的结果');
    }
    const result = await dialog.showSaveDialog({
      title: '另存为',
      defaultPath: options.suggestedName || path.basename(sourcePath),
      filters: [{ name: '图片', extensions: [path.extname(sourcePath).slice(1)] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fsp.copyFile(sourcePath, result.filePath);
    return { canceled: false, filePath: result.filePath };
  });

  ipcMain.handle('reveal', async (_event, filePath) => {
    if (typeof filePath === 'string' && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return true;
    }
    return false;
  });
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const win = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 860,
    minHeight: 580,
    title: 'Scan Demo',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#f4f5f7',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  return win;
}

async function runSmokeTest(input) {
  try {
    const info = await processImage({ inputPath: path.resolve(input), filter: 'enhance', quality: 90, maxDim: 0 });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      input: path.resolve(input),
      output: info.outputPath,
      width: info.width,
      height: info.height,
      filter: info.filter,
      ms: info.ms,
      bytes: info.bytes,
    })}\n`);
    app.exit(0);
  } catch (error) {
    process.stderr.write(`smoke test failed: ${error.message}\n`);
    app.exit(1);
  }
}

app.whenReady().then(async () => {
  registerIpc();

  if (smokeIndex >= 0) {
    const input = argv[smokeIndex + 1];
    if (!input) {
      process.stderr.write('usage: electron . --smoke-test <image>\n');
      app.exit(2);
      return;
    }
    await runSmokeTest(input);
    return;
  }

  const win = createWindow();
  let dragDropReady = null;

  win.webContents.on('did-finish-load', async () => {
    if (shotIndex < 0) return;
    // 顺便确认 sandbox 预加载里 webUtils 可用（拖拽依赖它）
    dragDropReady = await win.webContents
      .executeJavaScript('Boolean(window.imagecore && window.imagecore.dragDropReady)')
      .catch(() => false);

    if (argv[shotIndex + 1]) {
      const filterArg = argv.find((arg) => arg.startsWith('--filter='));
      const filter = filterArg ? filterArg.slice('--filter='.length) : null;
      win.webContents.send('initial-file', path.resolve(argv[shotIndex + 1]), filter);
    }
  });

  if (shotIndex >= 0) {
    const target = argv[shotIndex + 2];
    // 渲染进程出错时不至于把调用方挂死
    const guard = setTimeout(() => {
      process.stderr.write('screenshot timeout: 界面 20 秒内没有完成处理\n');
      app.exit(1);
    }, 20000);

    ipcMain.once('preview-ready', async (_event, info) => {
      clearTimeout(guard);
      // 等一帧，让字体和图片解码完成；第一次打包启动时合成器可能还返回旧帧，
      // 所以先丢一张再截。
      await new Promise((resolve) => setTimeout(resolve, 700));
      await win.webContents.capturePage();
      await new Promise((resolve) => setTimeout(resolve, 250));
      const image = await win.webContents.capturePage();
      if (target) await fsp.writeFile(path.resolve(target), image.toPNG());
      process.stdout.write(`${JSON.stringify({
        ok: !!info && info.ok,
        screenshot: target || null,
        dragDropReady,
      })}\n`);
      app.exit(info && info.ok ? 0 : 1);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || shotIndex >= 0 || smokeIndex >= 0) app.quit();
});
