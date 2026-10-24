'use strict';

// 渲染进程：只做界面和调用 preload 暴露的 API，不碰文件系统。
// 真正的算法在 imagecore 命令行里（common/image_core.cpp）。

const api = window.imagecore;

const $ = (id) => document.getElementById(id);

const els = {
  version: $('version'),
  openBtn: $('openBtn'),
  pickBtn: $('pickBtn'),
  filters: $('filters'),
  quality: $('quality'),
  qualityValue: $('qualityValue'),
  maxDim: $('maxDim'),
  applyBtn: $('applyBtn'),
  saveBtn: $('saveBtn'),
  revealBtn: $('revealBtn'),
  metaName: $('metaName'),
  metaSize: $('metaSize'),
  metaBytes: $('metaBytes'),
  metaMs: $('metaMs'),
  stage: $('stage'),
  empty: $('empty'),
  compare: $('compare'),
  resultImg: $('resultImg'),
  originalImg: $('originalImg'),
  stageBadge: $('stageBadge'),
  badgeFilter: $('badgeFilter'),
  compareBtn: $('compareBtn'),
  dropOverlay: $('dropOverlay'),
  status: $('status'),
  stats: $('stats'),
};

const FILTER_LABELS = {
  original: '原图',
  gray: '灰度',
  bw: '黑白',
  enhance: '增强',
};

const state = {
  file: null,     // { path, name, bytes, url }
  result: null,   // { outputPath, url, width, height, ms, bytes }
  filter: 'enhance',
  quality: Number(els.quality.value),
  maxDim: Number(els.maxDim.value),
  busy: false,
};

let jobId = 0;
let announced = false;

/* ---------- 小工具 ---------- */

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function setStatus(message, isError) {
  els.status.textContent = message;
  els.status.classList.toggle('error', Boolean(isError));
}

function setBusy(busy) {
  state.busy = busy;
  els.applyBtn.classList.toggle('busy', busy);
  els.applyBtn.disabled = busy || !state.file;
  els.openBtn.disabled = busy;
}

function setImage(img, url) {
  return new Promise((resolve) => {
    if (!url) {
      img.removeAttribute('src');
      resolve();
      return;
    }
    img.onload = () => resolve();
    img.onerror = () => resolve();
    img.src = url;
  });
}

function showImage() {
  els.empty.hidden = true;
  els.compare.hidden = false;
  els.stageBadge.hidden = false;
}

/* ---------- 打开文件 ---------- */

async function openFile(filePath) {
  if (!filePath) return;
  try {
    setStatus('正在打开…');
    const file = await api.openFile(filePath);
    if (!file) return;

    state.file = file;
    state.result = null;
    els.metaName.textContent = file.name;
    els.metaName.title = file.path;
    els.metaSize.textContent = '—';
    els.metaBytes.textContent = fmtBytes(file.bytes);
    els.metaMs.textContent = '—';
    els.saveBtn.disabled = true;
    els.revealBtn.disabled = true;
    els.applyBtn.disabled = false;

    await setImage(els.originalImg, file.url);
    els.stageBadge.hidden = true;

    // 旧结果先留在原地，等新结果出来再替换：直接清空会闪一下破图
    await apply();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function pickFile() {
  try {
    const file = await api.pickFile();
    if (file) {
      state.file = file;
      await openFile(file.path);
    }
  } catch (error) {
    setStatus(error.message, true);
  }
}

/* ---------- 处理 ---------- */

async function apply() {
  if (!state.file) return;
  const id = ++jobId;
  setBusy(true);
  setStatus(`正在应用「${FILTER_LABELS[state.filter]}」…`);
  let outcome = { ok: false, error: 'cancelled' };

  try {
    const info = await api.process({
      inputPath: state.file.path,
      filter: state.filter,
      quality: state.quality,
      maxDim: state.maxDim,
    });
    if (id !== jobId) return; // 已有更新的请求，丢弃这次结果

    state.result = info;
    if (info.url) {
      await setImage(els.resultImg, info.url);
      els.compare.classList.remove('showing-original');
      showImage();
    }
    els.stageBadge.hidden = false;
    els.badgeFilter.textContent = FILTER_LABELS[info.filter] || info.filter;

    els.metaName.textContent = state.file.name;
    els.metaSize.textContent = `${info.width} × ${info.height}`;
    els.metaBytes.textContent = `${fmtBytes(state.file.bytes)} → ${fmtBytes(info.bytes)}`;
    els.metaMs.textContent = `${info.ms} ms`;

    els.saveBtn.disabled = false;
    els.revealBtn.disabled = false;
    els.stats.textContent = `${info.width} × ${info.height} · ${info.filter} · ${info.ms} ms`;
    setStatus(
      info.url ? '完成' : '结果超过 24 MB，无法预览；可以直接另存为',
      !info.url,
    );
    outcome = { ok: true };
  } catch (error) {
    if (id !== jobId) return;
    setStatus(error.message, true);
    outcome = { ok: false, error: error.message };
  } finally {
    if (id === jobId) {
      setBusy(false);
      // 截图模式下主进程靠这个信号知道界面已经画完（放在 setBusy 之后，
      // 截图里按钮就是可用状态）
      if (!announced) {
        announced = true;
        api.previewReady(outcome);
      }
    }
  }
}

/* ---------- 保存 / 定位 ---------- */

function suggestedName() {
  const base = (state.file && state.file.name || 'output').replace(/\.[^.]+$/, '');
  const ext = state.result ? state.result.outputPath.replace(/^.*(?=\.[^.]+$)/, '') : '.jpg';
  return `${base}_${state.filter}${ext}`;
}

async function saveAs() {
  if (!state.result) return;
  try {
    const res = await api.saveAs({
      sourcePath: state.result.outputPath,
      suggestedName: suggestedName(),
    });
    if (res && !res.canceled) setStatus(`已保存到 ${res.filePath}`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function reveal() {
  if (!state.result) return;
  const ok = await api.reveal(state.result.outputPath);
  if (!ok) setStatus('文件不存在', true);
}

/* ---------- 对比原图 ---------- */

let comparing = false;

function setComparing(on) {
  if (comparing === on) return;
  comparing = on;
  if (!state.result) return;
  els.compare.classList.toggle('showing-original', on);
  els.stageBadge.querySelector('.badge-btn').textContent = on ? '松开回到结果' : '按住看原图';
}

/* ---------- 事件 ---------- */

els.openBtn.addEventListener('click', pickFile);
els.pickBtn.addEventListener('click', pickFile);
els.applyBtn.addEventListener('click', apply);
els.saveBtn.addEventListener('click', saveAs);
els.revealBtn.addEventListener('click', reveal);

function selectFilter(filter, rerun) {
  if (!FILTER_LABELS[filter]) return;
  state.filter = filter;
  for (const item of els.filters.querySelectorAll('button')) {
    const active = item.dataset.filter === filter;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  }
  if (rerun && state.file) apply();
}

els.filters.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-filter]');
  if (button) selectFilter(button.dataset.filter, true);
});

els.quality.addEventListener('input', () => {
  state.quality = Number(els.quality.value);
  els.qualityValue.textContent = String(state.quality);
});

els.quality.addEventListener('change', () => {
  if (state.file) apply();
});

els.maxDim.addEventListener('change', () => {
  state.maxDim = Number(els.maxDim.value);
  if (state.file) apply();
});

// 按住看原图（鼠标 / 触摸）
els.compareBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  setComparing(true);
});
for (const type of ['pointerup', 'pointercancel', 'pointerleave']) {
  els.compareBtn.addEventListener(type, () => setComparing(false));
}

// 按住空格也能看原图
window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !event.repeat) {
    event.preventDefault();
    setComparing(true);
  }
});
window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    event.preventDefault();
    setComparing(false);
  }
});

// 拖拽
let dragDepth = 0;

function hasFiles(event) {
  if (!api.dragDropReady) return false;
  return Boolean(event.dataTransfer) &&
    Array.from(event.dataTransfer.types || []).includes('Files');
}

window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  els.stage.classList.add('dragover');
  els.dropOverlay.hidden = false;
});

window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    els.stage.classList.remove('dragover');
    els.dropOverlay.hidden = true;
  }
});

window.addEventListener('drop', async (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  els.stage.classList.remove('dragover');
  els.dropOverlay.hidden = true;

  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;
  const filePath = api.pathForFile(file);
  if (!filePath) {
    setStatus('无法读取拖入文件，请改用「打开图片」', true);
    return;
  }
  await openFile(filePath);
});

// 主进程在截图模式下会先推一个文件过来（可同时指定滤镜）
api.onInitialFile((filePath, filter) => {
  if (filter) selectFilter(filter, false);
  openFile(filePath);
});

/* ---------- 启动 ---------- */

if (!api.dragDropReady) {
  const hint = document.querySelector('.empty-hint');
  if (hint) hint.textContent = '点击下方按钮选择 · 支持 JPEG / PNG / BMP / TGA';
}

api.version().then((version) => {
  els.version.textContent = `桌面端 · ${version}`;
}).catch(() => {
  els.version.textContent = '桌面端 · 共享 C++ 算法';
});
