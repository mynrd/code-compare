const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const DOTNET_PATTERNS = [
  '*.cs', '*.csproj', '*.fsproj', '*.vbproj',
  '*.sln', '*.slnx',
  '*.razor', '*.cshtml', '*.vbhtml',
  '*.resx', '*.config',
  '*.props', '*.targets',
  '*.xaml',
  'appsettings*.json', 'global.json', 'nuget.config',
  'Directory.Build.*', 'Directory.Packages.*',
  '*.runsettings'
];
const ANGULAR_PATTERNS = [
  '*.ts', '*.tsx',
  '*.js', '*.jsx', '*.mjs', '*.cjs',
  '*.html', '*.scss', '*.sass', '*.css', '*.less',
  'angular.json', 'package.json', 'package-lock.json',
  'tsconfig*.json', 'karma.conf.js', 'jest.config.*',
  '.eslintrc*', '.prettierrc*', '.browserslistrc'
];
const DEFAULT_FILE_SCAN = {
  activeGroup: '',
  groups: [
    { name: 'Dotnet', patterns: DOTNET_PATTERNS },
    { name: 'Angular', patterns: ANGULAR_PATTERNS },
    { name: 'Dotnet and Angular', patterns: [...new Set([...DOTNET_PATTERNS, ...ANGULAR_PATTERNS])] }
  ]
};

const DEFAULT_COMPARE_OPTIONS = {
  ignoreWhitespace: false,
  ignoreComments: false,
  ignoreLineBreaks: false
};

const DEFAULT_CONFIG = {
  ignores: ['.git', 'node_modules', 'dist', 'build', '.vs', 'bin', 'obj', '.next', '.cache'],
  lastMode: 'folder',
  lastLeft: '',
  lastRight: '',
  recent: [],
  fileScan: DEFAULT_FILE_SCAN,
  compareOptions: DEFAULT_COMPARE_OPTIONS
};

function normalizeText(text, opts) {
  let t = String(text).replace(/\r\n?/g, '\n');
  if (opts && opts.ignoreComments) {
    t = t.replace(/\/\*[\s\S]*?\*\//g, '');
    t = t.split('\n').map(l => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  }
  if (opts && opts.ignoreWhitespace) {
    t = t.split('\n').map(l => l.trim().replace(/\s+/g, ' ')).join('\n');
  }
  if (opts && opts.ignoreLineBreaks) {
    t = t.split('\n').filter(l => l.length > 0).join('\n');
  }
  return t;
}

function anyCompareOpt(opts) {
  return !!(opts && (opts.ignoreWhitespace || opts.ignoreComments || opts.ignoreLineBreaks));
}
const RECENT_MAX = 10;

const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function tempDir() {
  return path.join(app.getPath('userData'), '.temp');
}

function tempKey(absPath, side) {
  return crypto.createHash('sha1').update(absPath + '|' + side).digest('hex');
}

function tempFilePath(absPath, side) {
  return path.join(tempDir(), tempKey(absPath, side) + '.json');
}

async function ensureTempDir() {
  await fsp.mkdir(tempDir(), { recursive: true });
}

function sanitizeFileScan(fs) {
  if (!fs || !Array.isArray(fs.groups)) return DEFAULT_FILE_SCAN;
  const groups = fs.groups
    .filter(g => g && typeof g.name === 'string' && Array.isArray(g.patterns))
    .map(g => ({
      name: g.name,
      patterns: g.patterns.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
    }));
  const activeGroup = typeof fs.activeGroup === 'string'
    && groups.some(g => g.name === fs.activeGroup)
    ? fs.activeGroup : '';
  return { activeGroup, groups: groups.length ? groups : DEFAULT_FILE_SCAN.groups };
}

async function loadConfig() {
  try {
    const raw = await fsp.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ignores: Array.isArray(parsed.ignores) ? parsed.ignores : DEFAULT_CONFIG.ignores,
      lastMode: parsed.lastMode === 'file' ? 'file' : 'folder',
      lastLeft: typeof parsed.lastLeft === 'string' ? parsed.lastLeft : '',
      lastRight: typeof parsed.lastRight === 'string' ? parsed.lastRight : '',
      recent: Array.isArray(parsed.recent) ? parsed.recent.slice(0, RECENT_MAX) : [],
      fileScan: sanitizeFileScan(parsed.fileScan),
      compareOptions: {
        ignoreWhitespace: !!(parsed.compareOptions && parsed.compareOptions.ignoreWhitespace),
        ignoreComments: !!(parsed.compareOptions && parsed.compareOptions.ignoreComments),
        ignoreLineBreaks: !!(parsed.compareOptions && parsed.compareOptions.ignoreLineBreaks)
      }
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(patch) {
  const cur = await loadConfig();
  const next = { ...cur, ...patch };
  if (Array.isArray(next.recent)) next.recent = next.recent.slice(0, RECENT_MAX);
  await fsp.writeFile(configPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('pick-file', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('load-config', loadConfig);
ipcMain.handle('save-config', (_e, cfg) => saveConfig(cfg));

function globToRegex(pat) {
  const esc = String(pat).replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

function compileFileScan(fileScan) {
  if (!fileScan || !fileScan.activeGroup) return null;
  const group = (fileScan.groups || []).find(g => g.name === fileScan.activeGroup);
  if (!group || !group.patterns || !group.patterns.length) return null;
  const rxs = group.patterns.map(globToRegex);
  return (basename) => rxs.some(r => r.test(basename));
}

function compileIgnores(list) {
  const basenames = new Set();
  const paths = [];
  for (const raw of list || []) {
    if (!raw) continue;
    const norm = String(raw).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
    if (!norm) continue;
    if (norm.includes('/')) paths.push(norm);
    else basenames.add(norm);
  }
  return { basenames, paths };
}

async function walk(root, ignores, fileScan) {
  const { basenames, paths: pathIgnores } = compileIgnores(ignores);
  const matches = compileFileScan(fileScan);
  const out = new Map();
  async function recur(dir, rel) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (basenames.has(e.name)) continue;
      const rp = rel ? path.posix.join(rel, e.name) : e.name;
      if (pathIgnores.some(p => rp === p || rp.startsWith(p + '/'))) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        await recur(abs, rp);
      } else if (e.isFile()) {
        if (matches && !matches(e.name)) continue;
        let stat;
        try { stat = await fsp.stat(abs); } catch { continue; }
        out.set(rp, { abs, size: stat.size });
      }
    }
  }
  await recur(root, '');
  return out;
}

async function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const s = fs.createReadStream(abs);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

async function isTextFile(abs) {
  try {
    const fd = await fsp.open(abs, 'r');
    try {
      const buf = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await fd.read(buf, 0, BINARY_SNIFF_BYTES, 0);
      return !buf.slice(0, bytesRead).includes(0);
    } finally { await fd.close(); }
  } catch { return false; }
}

async function normalizedEqual(absL, absR, opts) {
  try {
    if (!(await isTextFile(absL)) || !(await isTextFile(absR))) return false;
    const [a, b] = await Promise.all([fsp.readFile(absL, 'utf8'), fsp.readFile(absR, 'utf8')]);
    return normalizeText(a, opts) === normalizeText(b, opts);
  } catch { return false; }
}

ipcMain.handle('compare-folders', async (_e, { left, right, ignores, fileScan, compareOptions }) => {
  const [L, R] = await Promise.all([
    walk(left, ignores || [], fileScan),
    walk(right, ignores || [], fileScan)
  ]);
  const useNorm = anyCompareOpt(compareOptions);
  const allPaths = new Set([...L.keys(), ...R.keys()]);
  const items = [];
  for (const rp of allPaths) {
    const l = L.get(rp);
    const r = R.get(rp);
    if (l && !r) { items.push({ path: rp, status: 'only-left', leftSize: l.size }); continue; }
    if (!l && r) { items.push({ path: rp, status: 'only-right', rightSize: r.size }); continue; }
    let status;
    if (l.size === r.size) {
      const [hl, hr] = await Promise.all([hashFile(l.abs), hashFile(r.abs)]);
      status = hl === hr ? 'same' : 'modified';
    } else {
      status = 'modified';
    }
    if (status === 'modified' && useNorm) {
      if (await normalizedEqual(l.abs, r.abs, compareOptions)) status = 'same';
    }
    items.push({ path: rp, status, leftSize: l.size, rightSize: r.size });
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return { left, right, items };
});

async function readForDiff(abs) {
  const stat = await fsp.stat(abs);
  if (stat.size > MAX_DIFF_BYTES) return { binary: false, tooLarge: true, size: stat.size, text: '' };
  const fd = await fsp.open(abs, 'r');
  try {
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stat.size));
    await fd.read(sniff, 0, sniff.length, 0);
    if (sniff.includes(0)) return { binary: true, tooLarge: false, size: stat.size, text: '' };
  } finally { await fd.close(); }
  const text = await fsp.readFile(abs, 'utf8');
  return { binary: false, tooLarge: false, size: stat.size, text };
}

ipcMain.handle('compare-files', async (_e, { leftPath, rightPath }) => {
  const result = { leftPath, rightPath, left: null, right: null, error: null };
  try {
    if (leftPath) result.left = await readForDiff(leftPath);
    if (rightPath) result.right = await readForDiff(rightPath);
  } catch (err) {
    result.error = String(err && err.message || err);
  }
  return result;
});

ipcMain.handle('copy-file', async (_e, { src, dst }) => {
  if (!src || !dst) return { ok: false, error: 'missing path' };
  try {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('delete-file', async (_e, { abs }) => {
  if (!abs) return { ok: false, error: 'missing path' };
  try {
    await fsp.unlink(abs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('temp-write', async (_e, { absPath, side, text }) => {
  if (!absPath || (side !== 'left' && side !== 'right')) {
    return { ok: false, error: 'bad args' };
  }
  try {
    await ensureTempDir();
    const payload = { absPath, side, text: String(text), ts: Date.now() };
    await fsp.writeFile(tempFilePath(absPath, side), JSON.stringify(payload), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('temp-read', async (_e, { absPath, side }) => {
  if (!absPath) return null;
  try {
    const raw = await fsp.readFile(tempFilePath(absPath, side), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
});

ipcMain.handle('temp-delete', async (_e, { absPath, side }) => {
  if (!absPath) return { ok: false, error: 'missing path' };
  try {
    await fsp.unlink(tempFilePath(absPath, side));
    return { ok: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true };
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('temp-list', async () => {
  try {
    await ensureTempDir();
    const names = await fsp.readdir(tempDir());
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      try {
        const raw = await fsp.readFile(path.join(tempDir(), n), 'utf8');
        const p = JSON.parse(raw);
        if (p && p.absPath && (p.side === 'left' || p.side === 'right')) {
          out.push({ absPath: p.absPath, side: p.side, ts: p.ts });
        }
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
});

ipcMain.handle('apply-temp', async (_e, { absPath, side }) => {
  if (!absPath) return { ok: false, error: 'missing path' };
  try {
    const raw = await fsp.readFile(tempFilePath(absPath, side), 'utf8');
    const payload = JSON.parse(raw);
    await fsp.mkdir(path.dirname(absPath), { recursive: true });
    await fsp.writeFile(absPath, payload.text, 'utf8');
    await fsp.unlink(tempFilePath(absPath, side)).catch(() => {});
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('read-pair', async (_e, { leftRoot, rightRoot, relPath }) => {
  const result = { left: null, right: null };
  if (leftRoot) {
    const p = path.join(leftRoot, relPath);
    if (fs.existsSync(p)) result.left = await readForDiff(p);
  }
  if (rightRoot) {
    const p = path.join(rightRoot, relPath);
    if (fs.existsSync(p)) result.right = await readForDiff(p);
  }
  return result;
});
