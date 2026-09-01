const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const store = require('../lib/store.js');

let base;
before(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'code-compare-store-'));
});
after(async () => {
  await fsp.rm(base, { recursive: true, force: true });
});

async function freshConfigStore() {
  const dir = await fsp.mkdtemp(path.join(base, 'cfg-'));
  return store.createConfigStore(path.join(dir, 'config.json'));
}

async function freshTempStore() {
  const dir = await fsp.mkdtemp(path.join(base, 'tmp-'));
  return store.createTempStore(path.join(dir, '.temp'));
}

describe('sanitizeFileScan', () => {
  test('falls back to defaults on garbage', () => {
    assert.deepEqual(store.sanitizeFileScan(null), store.DEFAULT_FILE_SCAN);
    assert.deepEqual(store.sanitizeFileScan({ groups: 'nope' }), store.DEFAULT_FILE_SCAN);
  });
  test('drops malformed groups and trims patterns', () => {
    const out = store.sanitizeFileScan({
      activeGroup: 'ok',
      groups: [
        { name: 'ok', patterns: [' *.cs ', '', 42, '*.ts'] },
        { name: 7, patterns: [] },
        null
      ]
    });
    assert.equal(out.groups.length, 1);
    assert.deepEqual(out.groups[0].patterns, ['*.cs', '*.ts']);
    assert.equal(out.activeGroup, 'ok');
  });
  test('clears activeGroup that names no surviving group', () => {
    const out = store.sanitizeFileScan({
      activeGroup: 'ghost',
      groups: [{ name: 'real', patterns: ['*.cs'] }]
    });
    assert.equal(out.activeGroup, '');
  });
  test('restores default groups when all groups filtered out', () => {
    const out = store.sanitizeFileScan({ activeGroup: '', groups: [null] });
    assert.deepEqual(out.groups, store.DEFAULT_FILE_SCAN.groups);
  });
});

describe('config store', () => {
  test('load returns defaults when file is missing', async () => {
    const cfg = await (await freshConfigStore()).load();
    assert.deepEqual(cfg, store.DEFAULT_CONFIG);
  });
  test('save then load round-trips a patch', async () => {
    const s = await freshConfigStore();
    await s.save({ lastMode: 'file', lastLeft: '/a', lastRight: '/b' });
    const cfg = await s.load();
    assert.equal(cfg.lastMode, 'file');
    assert.equal(cfg.lastLeft, '/a');
    assert.equal(cfg.lastRight, '/b');
    // untouched keys keep defaults
    assert.deepEqual(cfg.ignores, store.DEFAULT_CONFIG.ignores);
  });
  test('load sanitizes corrupt values', async () => {
    const s = await freshConfigStore();
    await s.save({});
    // Corrupt on disk behind the store's back
    const cfg1 = await s.load();
    await s.save({ lastMode: 'weird', ignores: 'not-an-array', compareOptions: { ignoreWhitespace: 'yes' } });
    const cfg = await s.load();
    assert.equal(cfg.lastMode, 'folder');
    assert.deepEqual(cfg.ignores, store.DEFAULT_CONFIG.ignores);
    assert.equal(cfg.compareOptions.ignoreWhitespace, true);
    assert.equal(cfg.compareOptions.ignoreComments, false);
    assert.deepEqual(cfg1.recent, []);
  });
  test('load survives invalid JSON', async () => {
    const dir = await fsp.mkdtemp(path.join(base, 'cfg-'));
    const file = path.join(dir, 'config.json');
    await fsp.writeFile(file, '{ not json', 'utf8');
    const cfg = await store.createConfigStore(file).load();
    assert.deepEqual(cfg, store.DEFAULT_CONFIG);
  });
  test('recent list is capped at RECENT_MAX', async () => {
    const s = await freshConfigStore();
    const recent = Array.from({ length: 25 }, (_, i) => ({ mode: 'file', left: 'l' + i, right: 'r' + i }));
    await s.save({ recent });
    const cfg = await s.load();
    assert.equal(cfg.recent.length, store.RECENT_MAX);
    assert.equal(cfg.recent[0].left, 'l0');
  });
});

describe('temp store', () => {
  test('write / read round-trip per (path, side)', async () => {
    const t = await freshTempStore();
    await t.write({ absPath: '/x/f.txt', side: 'left', text: 'hello' });
    const p = await t.read({ absPath: '/x/f.txt', side: 'left' });
    assert.equal(p.text, 'hello');
    assert.equal(p.side, 'left');
    assert.equal(p.absPath, '/x/f.txt');
    // other side untouched
    assert.equal(await t.read({ absPath: '/x/f.txt', side: 'right' }), null);
  });
  test('write rejects bad args', async () => {
    const t = await freshTempStore();
    assert.equal((await t.write({ absPath: '', side: 'left', text: 'x' })).ok, false);
    assert.equal((await t.write({ absPath: '/x', side: 'middle', text: 'x' })).ok, false);
  });
  test('list returns all pending edits', async () => {
    const t = await freshTempStore();
    await t.write({ absPath: '/a', side: 'left', text: '1' });
    await t.write({ absPath: '/b', side: 'right', text: '2' });
    const all = await t.list();
    assert.equal(all.length, 2);
    const sides = all.map(e => e.side).sort();
    assert.deepEqual(sides, ['left', 'right']);
  });
  test('remove is idempotent (ENOENT is ok)', async () => {
    const t = await freshTempStore();
    await t.write({ absPath: '/a', side: 'left', text: '1' });
    assert.equal((await t.remove({ absPath: '/a', side: 'left' })).ok, true);
    assert.equal((await t.remove({ absPath: '/a', side: 'left' })).ok, true);
    assert.equal((await t.remove({ absPath: '' })).ok, false);
    assert.equal(await t.read({ absPath: '/a', side: 'left' }), null);
  });
  test('apply writes the target file and clears the temp entry', async () => {
    const t = await freshTempStore();
    const dir = await fsp.mkdtemp(path.join(base, 'apply-'));
    const target = path.join(dir, 'sub', 'file.txt');
    await t.write({ absPath: target, side: 'right', text: 'edited content' });
    const r = await t.apply({ absPath: target, side: 'right' });
    assert.equal(r.ok, true);
    assert.equal(await fsp.readFile(target, 'utf8'), 'edited content');
    assert.equal(await t.read({ absPath: target, side: 'right' }), null);
  });
  test('apply with no pending edit fails cleanly', async () => {
    const t = await freshTempStore();
    const r = await t.apply({ absPath: '/nowhere/f.txt', side: 'left' });
    assert.equal(r.ok, false);
    assert.equal((await t.apply({ absPath: '' })).ok, false);
  });
});
