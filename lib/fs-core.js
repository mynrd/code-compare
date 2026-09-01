// Filesystem-facing comparison logic. No Electron dependency so it can be
// unit-tested directly with fixture directories.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { normalizeText, anyCompareOpt } = require('../renderer/compare-core.js');

const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;

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

async function readForDiff(abs, opts) {
  const maxBytes = (opts && opts.maxBytes) || MAX_DIFF_BYTES;
  const stat = await fsp.stat(abs);
  if (stat.size > maxBytes) return { binary: false, tooLarge: true, size: stat.size, text: '' };
  const fd = await fsp.open(abs, 'r');
  try {
    const sniff = Buffer.alloc(Math.min(BINARY_SNIFF_BYTES, stat.size));
    await fd.read(sniff, 0, sniff.length, 0);
    if (sniff.includes(0)) return { binary: true, tooLarge: false, size: stat.size, text: '' };
  } finally { await fd.close(); }
  const text = await fsp.readFile(abs, 'utf8');
  return { binary: false, tooLarge: false, size: stat.size, text };
}

async function compareFolders(left, right, { ignores, fileScan, compareOptions } = {}) {
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
}

async function readPair({ leftRoot, rightRoot, relPath }) {
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
}

async function copyFileEnsuringDir(src, dst) {
  if (!src || !dst) return { ok: false, error: 'missing path' };
  try {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

async function deleteFile(abs) {
  if (!abs) return { ok: false, error: 'missing path' };
  try {
    await fsp.unlink(abs);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

module.exports = {
  MAX_DIFF_BYTES,
  BINARY_SNIFF_BYTES,
  globToRegex,
  compileFileScan,
  compileIgnores,
  walk,
  hashFile,
  isTextFile,
  normalizedEqual,
  readForDiff,
  compareFolders,
  readPair,
  copyFileEnsuringDir,
  deleteFile
};
