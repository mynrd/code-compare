const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const fsCore = require('../lib/fs-core.js');

let base;

async function mkFixture(structure) {
  // structure: { 'rel/path.txt': 'content' | Buffer }
  const dir = await fsp.mkdtemp(path.join(base, 'fx-'));
  for (const [rel, content] of Object.entries(structure)) {
    const abs = path.join(dir, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }
  return dir;
}

before(async () => {
  base = await fsp.mkdtemp(path.join(os.tmpdir(), 'code-compare-test-'));
});
after(async () => {
  await fsp.rm(base, { recursive: true, force: true });
});

describe('globToRegex', () => {
  test('* matches any run, case-insensitive', () => {
    const rx = fsCore.globToRegex('*.cs');
    assert.ok(rx.test('Program.cs'));
    assert.ok(rx.test('FOO.CS'));
    assert.ok(!rx.test('Program.csproj'));
  });
  test('? matches one character', () => {
    const rx = fsCore.globToRegex('a?.txt');
    assert.ok(rx.test('ab.txt'));
    assert.ok(!rx.test('abc.txt'));
  });
  test('dots are literal', () => {
    const rx = fsCore.globToRegex('a.b');
    assert.ok(!rx.test('aXb'));
  });
  test('prefix patterns like appsettings*.json', () => {
    const rx = fsCore.globToRegex('appsettings*.json');
    assert.ok(rx.test('appsettings.json'));
    assert.ok(rx.test('appsettings.Development.json'));
    assert.ok(!rx.test('settings.json'));
  });
});

describe('compileFileScan', () => {
  const scan = {
    activeGroup: 'Dotnet',
    groups: [{ name: 'Dotnet', patterns: ['*.cs', '*.csproj'] }]
  };
  test('returns matcher for the active group', () => {
    const m = fsCore.compileFileScan(scan);
    assert.ok(m('A.cs'));
    assert.ok(!m('a.ts'));
  });
  test('null when no active group or empty patterns', () => {
    assert.equal(fsCore.compileFileScan({ ...scan, activeGroup: '' }), null);
    assert.equal(fsCore.compileFileScan(null), null);
    assert.equal(fsCore.compileFileScan({ activeGroup: 'X', groups: [{ name: 'X', patterns: [] }] }), null);
  });
});

describe('compileIgnores', () => {
  test('separates basenames from path patterns and normalizes slashes', () => {
    const { basenames, paths } = fsCore.compileIgnores(['node_modules', 'a\\b', '/c/d/', '', null]);
    assert.ok(basenames.has('node_modules'));
    assert.deepEqual(paths.sort(), ['a/b', 'c/d']);
  });
});

describe('walk', () => {
  test('lists files recursively with posix rel paths and sizes', async () => {
    const dir = await mkFixture({ 'a.txt': 'aa', 'sub/b.txt': 'bbb' });
    const map = await fsCore.walk(dir, [], null);
    assert.deepEqual([...map.keys()].sort(), ['a.txt', 'sub/b.txt']);
    assert.equal(map.get('sub/b.txt').size, 3);
  });
  test('honors basename ignores anywhere in the tree', async () => {
    const dir = await mkFixture({ 'keep.txt': 'x', 'node_modules/skip.txt': 'x', 'sub/node_modules/deep.txt': 'x' });
    const map = await fsCore.walk(dir, ['node_modules'], null);
    assert.deepEqual([...map.keys()], ['keep.txt']);
  });
  test('honors relative-path ignores from the root', async () => {
    const dir = await mkFixture({ 'a/b/skip.txt': 'x', 'other/b/keep.txt': 'x' });
    const map = await fsCore.walk(dir, ['a/b'], null);
    assert.deepEqual([...map.keys()], ['other/b/keep.txt']);
  });
  test('applies the active file-scan group', async () => {
    const dir = await mkFixture({ 'a.cs': 'x', 'b.ts': 'x', 'sub/c.cs': 'x' });
    const scan = { activeGroup: 'CS', groups: [{ name: 'CS', patterns: ['*.cs'] }] };
    const map = await fsCore.walk(dir, [], scan);
    assert.deepEqual([...map.keys()].sort(), ['a.cs', 'sub/c.cs']);
  });
  test('nonexistent root yields empty map', async () => {
    const map = await fsCore.walk(path.join(base, 'nope'), [], null);
    assert.equal(map.size, 0);
  });
});

describe('hashFile / isTextFile', () => {
  test('same content hashes equal, different content differs', async () => {
    const dir = await mkFixture({ 'a.txt': 'hello', 'b.txt': 'hello', 'c.txt': 'other' });
    const [ha, hb, hc] = await Promise.all([
      fsCore.hashFile(path.join(dir, 'a.txt')),
      fsCore.hashFile(path.join(dir, 'b.txt')),
      fsCore.hashFile(path.join(dir, 'c.txt'))
    ]);
    assert.equal(ha, hb);
    assert.notEqual(ha, hc);
  });
  test('detects binary via NUL byte', async () => {
    const dir = await mkFixture({ 'text.txt': 'plain', 'bin.dat': Buffer.from([1, 2, 0, 3]) });
    assert.equal(await fsCore.isTextFile(path.join(dir, 'text.txt')), true);
    assert.equal(await fsCore.isTextFile(path.join(dir, 'bin.dat')), false);
  });
  test('missing file counts as not-text', async () => {
    assert.equal(await fsCore.isTextFile(path.join(base, 'missing')), false);
  });
});

describe('readForDiff', () => {
  test('reads text files', async () => {
    const dir = await mkFixture({ 'a.txt': 'line1\nline2' });
    const r = await fsCore.readForDiff(path.join(dir, 'a.txt'));
    assert.deepEqual(r, { binary: false, tooLarge: false, size: 11, text: 'line1\nline2' });
  });
  test('flags binary files without reading text', async () => {
    const dir = await mkFixture({ 'b.dat': Buffer.from([0, 1, 2]) });
    const r = await fsCore.readForDiff(path.join(dir, 'b.dat'));
    assert.equal(r.binary, true);
    assert.equal(r.text, '');
  });
  test('flags too-large files (injectable limit)', async () => {
    const dir = await mkFixture({ 'big.txt': 'x'.repeat(100) });
    const r = await fsCore.readForDiff(path.join(dir, 'big.txt'), { maxBytes: 10 });
    assert.equal(r.tooLarge, true);
    assert.equal(r.size, 100);
  });
});

describe('normalizedEqual', () => {
  test('true when files match under options', async () => {
    const dir = await mkFixture({ 'l.cs': '  x = 1; // a\n', 'r.cs': 'x = 1; // b\n' });
    const eq = await fsCore.normalizedEqual(
      path.join(dir, 'l.cs'), path.join(dir, 'r.cs'),
      { ignoreWhitespace: true, ignoreComments: true });
    assert.equal(eq, true);
  });
  test('false for binary files', async () => {
    const dir = await mkFixture({ 'l.dat': Buffer.from([0]), 'r.dat': Buffer.from([0]) });
    const eq = await fsCore.normalizedEqual(
      path.join(dir, 'l.dat'), path.join(dir, 'r.dat'), { ignoreWhitespace: true });
    assert.equal(eq, false);
  });
});

describe('compareFolders', () => {
  test('classifies same / modified / only-left / only-right', async () => {
    const left = await mkFixture({
      'same.txt': 'identical',
      'mod.txt': 'left version',
      'onlyleft.txt': 'L',
      'sub/deep.txt': 'deep'
    });
    const right = await mkFixture({
      'same.txt': 'identical',
      'mod.txt': 'right version!',
      'onlyright.txt': 'R',
      'sub/deep.txt': 'deep'
    });
    const res = await fsCore.compareFolders(left, right, {});
    const byPath = Object.fromEntries(res.items.map(i => [i.path, i.status]));
    assert.deepEqual(byPath, {
      'same.txt': 'same',
      'mod.txt': 'modified',
      'onlyleft.txt': 'only-left',
      'onlyright.txt': 'only-right',
      'sub/deep.txt': 'same'
    });
    // sorted by path
    assert.deepEqual(res.items.map(i => i.path), [...res.items.map(i => i.path)].sort());
  });
  test('same size but different content is modified (hash check)', async () => {
    const left = await mkFixture({ 'f.txt': 'aaaa' });
    const right = await mkFixture({ 'f.txt': 'bbbb' });
    const res = await fsCore.compareFolders(left, right, {});
    assert.equal(res.items[0].status, 'modified');
  });
  test('compare options can turn modified into same', async () => {
    const left = await mkFixture({ 'f.cs': '  int x = 1;\n' });
    const right = await mkFixture({ 'f.cs': 'int x = 1;\n' });
    const strict = await fsCore.compareFolders(left, right, {});
    assert.equal(strict.items[0].status, 'modified');
    const relaxed = await fsCore.compareFolders(left, right, {
      compareOptions: { ignoreWhitespace: true }
    });
    assert.equal(relaxed.items[0].status, 'same');
  });
  test('respects ignores and file scan', async () => {
    const left = await mkFixture({ 'a.cs': 'x', 'skip/b.cs': 'x', 'c.ts': 'x' });
    const right = await mkFixture({ 'a.cs': 'x' });
    const res = await fsCore.compareFolders(left, right, {
      ignores: ['skip'],
      fileScan: { activeGroup: 'CS', groups: [{ name: 'CS', patterns: ['*.cs'] }] }
    });
    assert.deepEqual(res.items.map(i => i.path), ['a.cs']);
  });
});

describe('readPair', () => {
  test('reads both sides when present, null for missing side', async () => {
    const left = await mkFixture({ 'f.txt': 'L' });
    const right = await mkFixture({ 'g.txt': 'R' });
    const pair = await fsCore.readPair({ leftRoot: left, rightRoot: right, relPath: 'f.txt' });
    assert.equal(pair.left.text, 'L');
    assert.equal(pair.right, null);
  });
});

describe('copyFileEnsuringDir / deleteFile', () => {
  test('copy creates missing directories', async () => {
    const src = await mkFixture({ 'f.txt': 'data' });
    const dstDir = await fsp.mkdtemp(path.join(base, 'dst-'));
    const dst = path.join(dstDir, 'nested/deep/f.txt');
    const r = await fsCore.copyFileEnsuringDir(path.join(src, 'f.txt'), dst);
    assert.equal(r.ok, true);
    assert.equal(await fsp.readFile(dst, 'utf8'), 'data');
  });
  test('copy with missing args fails cleanly', async () => {
    assert.equal((await fsCore.copyFileEnsuringDir(null, 'x')).ok, false);
    assert.equal((await fsCore.copyFileEnsuringDir('x', null)).ok, false);
  });
  test('delete removes the file; deleting again fails', async () => {
    const dir = await mkFixture({ 'gone.txt': 'x' });
    const abs = path.join(dir, 'gone.txt');
    assert.equal((await fsCore.deleteFile(abs)).ok, true);
    assert.equal((await fsCore.deleteFile(abs)).ok, false);
    assert.equal((await fsCore.deleteFile(null)).ok, false);
  });
});
