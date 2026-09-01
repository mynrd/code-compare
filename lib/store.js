// Config + pending-edit (temp) stores, parameterized by paths so they can be
// tested without Electron. main.js binds them to app.getPath('userData').
const path = require('path');
const fsp = require('fs').promises;
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

const RECENT_MAX = 10;

function sanitizeFileScan(fsCfg) {
  if (!fsCfg || !Array.isArray(fsCfg.groups)) return DEFAULT_FILE_SCAN;
  const groups = fsCfg.groups
    .filter(g => g && typeof g.name === 'string' && Array.isArray(g.patterns))
    .map(g => ({
      name: g.name,
      patterns: g.patterns.filter(p => typeof p === 'string' && p.trim()).map(p => p.trim())
    }));
  const activeGroup = typeof fsCfg.activeGroup === 'string'
    && groups.some(g => g.name === fsCfg.activeGroup)
    ? fsCfg.activeGroup : '';
  return { activeGroup, groups: groups.length ? groups : DEFAULT_FILE_SCAN.groups };
}

function createConfigStore(configFile) {
  async function load() {
    try {
      const raw = await fsp.readFile(configFile, 'utf8');
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

  async function save(patch) {
    const cur = await load();
    const next = { ...cur, ...patch };
    if (Array.isArray(next.recent)) next.recent = next.recent.slice(0, RECENT_MAX);
    await fsp.mkdir(path.dirname(configFile), { recursive: true });
    await fsp.writeFile(configFile, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }

  return { load, save };
}

function createTempStore(dir) {
  function keyFor(absPath, side) {
    return crypto.createHash('sha1').update(absPath + '|' + side).digest('hex');
  }
  function fileFor(absPath, side) {
    return path.join(dir, keyFor(absPath, side) + '.json');
  }
  async function ensure() {
    await fsp.mkdir(dir, { recursive: true });
  }

  async function write({ absPath, side, text }) {
    if (!absPath || (side !== 'left' && side !== 'right')) {
      return { ok: false, error: 'bad args' };
    }
    try {
      await ensure();
      const payload = { absPath, side, text: String(text), ts: Date.now() };
      await fsp.writeFile(fileFor(absPath, side), JSON.stringify(payload), 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  async function read({ absPath, side }) {
    if (!absPath) return null;
    try {
      const raw = await fsp.readFile(fileFor(absPath, side), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function remove({ absPath, side }) {
    if (!absPath) return { ok: false, error: 'missing path' };
    try {
      await fsp.unlink(fileFor(absPath, side));
      return { ok: true };
    } catch (err) {
      if (err && err.code === 'ENOENT') return { ok: true };
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  async function list() {
    try {
      await ensure();
      const names = await fsp.readdir(dir);
      const out = [];
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        try {
          const raw = await fsp.readFile(path.join(dir, n), 'utf8');
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
  }

  async function apply({ absPath, side }) {
    if (!absPath) return { ok: false, error: 'missing path' };
    try {
      const raw = await fsp.readFile(fileFor(absPath, side), 'utf8');
      const payload = JSON.parse(raw);
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      await fsp.writeFile(absPath, payload.text, 'utf8');
      await fsp.unlink(fileFor(absPath, side)).catch(() => {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  }

  return { write, read, remove, list, apply, fileFor };
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_FILE_SCAN,
  DEFAULT_COMPARE_OPTIONS,
  RECENT_MAX,
  sanitizeFileScan,
  createConfigStore,
  createTempStore
};
