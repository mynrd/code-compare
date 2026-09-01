const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');
const gitCore = require('../lib/git-core.js');

// Sync probe so the whole suite can be skipped when git is absent.
const GIT_OK = (() => {
  const r = spawnSync('git', ['--version'], { stdio: 'ignore' });
  return !r.error && r.status === 0;
})();

const C_TXT = ['c line 1', 'c line 2', 'c line 3', 'c line 4', 'c line 5', ''].join('\n');
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01, 0x02, 0x00, 0xff]);

let base;    // temp parent
let repo;    // realpath'd repo root
let shas;    // { first, second, third, feature }

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function write(rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('git-core', { skip: GIT_OK ? false : 'git is not on PATH' }, () => {
  before(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-compare-git-')));
    repo = path.join(base, 'repo');
    fs.mkdirSync(repo);
    git(['init', '-b', 'master', '-q']);
    git(['config', 'user.name', 'Test User']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'commit.gpgsign', 'false']);

    // commit 1 (root): a.txt, dir/b.txt, a path with a space, a deletable file, a binary
    write('a.txt', 'a original\nkeep me\n');
    write('dir/b.txt', 'b contents\n');
    write('dir with space/c.txt', C_TXT);
    write('gone.txt', 'temporary\n');
    fs.writeFileSync(path.join(repo, 'bin.dat'), BINARY);
    git(['add', '-A']);
    git(['commit', '-qm', 'first commit adds fixtures']);

    // commit 2: modify a.txt, distinctive subject word + pickaxe needle, other author
    write('a.txt', 'a original\nkeep me\nNEEDLE_42\n');
    git(['add', '-A']);
    git(['commit', '-qm', 'second commit pickaxe-target', '--author=Grace Hopper <grace@example.com>']);

    // commit 3: delete gone.txt
    git(['rm', '-q', 'gone.txt']);
    git(['commit', '-qm', 'third commit removes gone.txt']);

    // feature branch: add / modify / delete / rename
    git(['checkout', '-q', '-b', 'feature']);
    write('new.txt', 'brand new\n');
    write('a.txt', 'a original\nkeep me\nNEEDLE_42\nfeature line\n');
    git(['rm', '-q', 'dir/b.txt']);
    git(['mv', 'dir with space/c.txt', 'dir with space/c2.txt']);
    git(['add', '-A']);
    git(['commit', '-qm', 'feature commit']);

    shas = {
      first: git(['rev-list', '--max-parents=0', 'HEAD']),
      second: git(['rev-parse', 'master~1']),
      third: git(['rev-parse', 'master']),
      feature: git(['rev-parse', 'feature'])
    };

    // back to master with an uncommitted working-tree edit
    git(['checkout', '-q', 'master']);
    write('a.txt', 'a original\nkeep me\nNEEDLE_42\nUNCOMMITTED\n');
  });

  after(() => {
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  describe('hasGit', () => {
    test('reports git present and caches the probe', async () => {
      assert.equal(await gitCore.hasGit(), true);
      assert.equal(await gitCore.hasGit(), true);
    });
  });

  describe('repoRoot', () => {
    test('resolves the root from the repo directory', async () => {
      assert.equal(await gitCore.repoRoot(repo), repo);
    });
    test('resolves the root from a subdirectory', async () => {
      assert.equal(await gitCore.repoRoot(path.join(repo, 'dir with space')), repo);
    });
    test('null for a non-repo directory', async () => {
      const plain = fs.mkdtempSync(path.join(base, 'plain-'));
      assert.equal(await gitCore.repoRoot(plain), null);
    });
    test('null for a missing directory and for no argument', async () => {
      assert.equal(await gitCore.repoRoot(path.join(base, 'does-not-exist')), null);
      assert.equal(await gitCore.repoRoot(''), null);
    });
  });

  describe('currentBranch / listBranches', () => {
    test('current branch is master', async () => {
      assert.equal(await gitCore.currentBranch(repo), 'master');
    });
    test('null on a detached HEAD', async () => {
      git(['checkout', '-q', '--detach', 'master']);
      try {
        assert.equal(await gitCore.currentBranch(repo), null);
      } finally {
        git(['checkout', '-q', 'master']);
      }
    });
    test('lists local branches sorted with the current one marked', async () => {
      const branches = await gitCore.listBranches(repo);
      assert.deepEqual(branches, [
        { name: 'feature', current: false },
        { name: 'master', current: true }
      ]);
    });
  });

  describe('diffNameStatus', () => {
    test('classifies added / modified / deleted / renamed with oldPath', async () => {
      const items = await gitCore.diffNameStatus(repo, 'master', 'feature');
      const byPath = Object.fromEntries(items.map(i => [i.path, i]));
      assert.equal(byPath['new.txt'].status, 'added');
      assert.equal(byPath['a.txt'].status, 'modified');
      assert.equal(byPath['dir/b.txt'].status, 'deleted');
      const renamed = byPath['dir with space/c2.txt'];
      assert.equal(renamed.status, 'renamed');
      assert.equal(renamed.oldPath, 'dir with space/c.txt');
      assert.equal(items.length, 4);
    });
    test('reversing the refs flips added and deleted', async () => {
      const items = await gitCore.diffNameStatus(repo, 'feature', 'master');
      const byPath = Object.fromEntries(items.map(i => [i.path, i.status]));
      assert.equal(byPath['new.txt'], 'deleted');
      assert.equal(byPath['dir/b.txt'], 'added');
    });
    test('rejects with git stderr for a bad ref', async () => {
      await assert.rejects(
        () => gitCore.diffNameStatus(repo, 'master', 'no-such-ref'),
        (err) => /no-such-ref/.test(err.message)
      );
    });
  });

  describe('showFile', () => {
    test('returns committed text for a ref, ignoring the working tree', async () => {
      const r = await gitCore.showFile(repo, 'HEAD', 'a.txt');
      assert.equal(r.binary, false);
      assert.equal(r.tooLarge, false);
      assert.equal(r.text, 'a original\nkeep me\nNEEDLE_42\n');
      assert.equal(r.size, Buffer.byteLength(r.text));
      assert.ok(!r.text.includes('UNCOMMITTED'));
    });
    test('reads a path containing a space from another branch', async () => {
      const r = await gitCore.showFile(repo, 'feature', 'dir with space/c2.txt');
      assert.equal(r.text, C_TXT);
    });
    test('null when the path does not exist at that ref', async () => {
      assert.equal(await gitCore.showFile(repo, 'HEAD', 'new.txt'), null);
      assert.equal(await gitCore.showFile(repo, 'HEAD', 'never-existed.txt'), null);
    });
    test('flags a binary blob without text', async () => {
      const r = await gitCore.showFile(repo, 'HEAD', 'bin.dat');
      assert.equal(r.binary, true);
      assert.equal(r.text, '');
      assert.equal(r.size, BINARY.length);
    });
    test('rejects for a bad ref rather than returning null', async () => {
      await assert.rejects(
        () => gitCore.showFile(repo, 'no-such-ref', 'a.txt'),
        (err) => /no-such-ref/.test(err.message)
      );
    });
  });

  describe('log', () => {
    test('returns newest-first records with parents and ISO dates', async () => {
      const entries = await gitCore.log(repo, {});
      assert.equal(entries.length, 3);
      assert.deepEqual(entries.map(e => e.subject), [
        'third commit removes gone.txt',
        'second commit pickaxe-target',
        'first commit adds fixtures'
      ]);
      const head = entries[0];
      assert.equal(head.sha, shas.third);
      assert.equal(head.short, shas.third.slice(0, head.short.length));
      assert.deepEqual(head.parents, [shas.second]);
      assert.deepEqual(entries[2].parents, []);
      assert.ok(!Number.isNaN(Date.parse(head.date)));
    });
    test('honors ref, limit and skip', async () => {
      const one = await gitCore.log(repo, { ref: 'feature', limit: 1 });
      assert.equal(one.length, 1);
      assert.equal(one[0].sha, shas.feature);
      const skipped = await gitCore.log(repo, { ref: 'feature', skip: 1, limit: 1 });
      assert.equal(skipped[0].sha, shas.third);
    });
    test('grep matches the subject case-insensitively as a fixed string', async () => {
      const hits = await gitCore.log(repo, { grep: 'PICKAXE-Target' });
      assert.deepEqual(hits.map(h => h.sha), [shas.second]);
      assert.equal((await gitCore.log(repo, { grep: 'no such subject' })).length, 0);
    });
    test('author filters by commit author', async () => {
      const hits = await gitCore.log(repo, { author: 'Grace' });
      assert.deepEqual(hits.map(h => h.sha), [shas.second]);
    });
    test('a hex-looking grep also matches by sha prefix', async () => {
      const hits = await gitCore.log(repo, { grep: shas.first.slice(0, 7) });
      assert.deepEqual(hits.map(h => h.sha), [shas.first]);
    });
    test('a sha prefix is found even when the commit is past the first page', async () => {
      // limit 1 means the first page holds only the newest commit; the root
      // commit must still be reachable by its prefix.
      const hits = await gitCore.log(repo, { grep: shas.first.slice(0, 7), limit: 1 });
      assert.deepEqual(hits.map(h => h.sha), [shas.first]);
    });
    test('pickaxe finds the commit that introduced the text', async () => {
      const hits = await gitCore.log(repo, { pickaxe: 'NEEDLE_42' });
      assert.deepEqual(hits.map(h => h.sha), [shas.second]);
    });
    test('path follows a file across a rename', async () => {
      const hits = await gitCore.log(repo, { ref: 'feature', path: 'dir with space/c2.txt' });
      const seen = hits.map(h => h.sha);
      assert.ok(seen.includes(shas.feature), 'rename commit is listed');
      assert.ok(seen.includes(shas.first), '--follow reaches the pre-rename commit');
    });
    test('rejects with git stderr for a bad ref', async () => {
      await assert.rejects(
        () => gitCore.log(repo, { ref: 'no-such-ref' }),
        (err) => /no-such-ref/.test(err.message)
      );
    });
  });

  describe('commitFiles', () => {
    test('lists every file of a root commit as added', async () => {
      const items = await gitCore.commitFiles(repo, shas.first);
      const byPath = Object.fromEntries(items.map(i => [i.path, i.status]));
      assert.deepEqual(byPath, {
        'a.txt': 'added',
        'bin.dat': 'added',
        'dir/b.txt': 'added',
        'dir with space/c.txt': 'added',
        'gone.txt': 'added'
      });
    });
    test('reports rename with oldPath plus the other changes', async () => {
      const items = await gitCore.commitFiles(repo, shas.feature);
      const byPath = Object.fromEntries(items.map(i => [i.path, i]));
      assert.equal(byPath['new.txt'].status, 'added');
      assert.equal(byPath['a.txt'].status, 'modified');
      assert.equal(byPath['dir/b.txt'].status, 'deleted');
      assert.equal(byPath['dir with space/c2.txt'].status, 'renamed');
      assert.equal(byPath['dir with space/c2.txt'].oldPath, 'dir with space/c.txt');
    });
    test('reports a deletion', async () => {
      const items = await gitCore.commitFiles(repo, shas.third);
      assert.deepEqual(items, [{ path: 'gone.txt', status: 'deleted' }]);
    });
  });

  describe('parentOf', () => {
    test('returns the first parent sha', async () => {
      assert.equal(await gitCore.parentOf(repo, shas.third), shas.second);
      assert.equal(await gitCore.parentOf(repo, shas.second), shas.first);
    });
    test('null for the root commit', async () => {
      assert.equal(await gitCore.parentOf(repo, shas.first), null);
    });
  });

  describe('parsers', () => {
    test('parseNameStatusZ maps C/T to modified and keeps the new path', () => {
      const items = gitCore.parseNameStatusZ('C75\x00src/a.txt\x00src/b.txt\x00T\x00link.txt\x00');
      assert.deepEqual(items, [
        { path: 'src/b.txt', status: 'modified' },
        { path: 'link.txt', status: 'modified' }
      ]);
    });
    test('parseLog tolerates empty trailing records', () => {
      const rec = ['abc', 'abc', 'subj', 'me', '2020-01-01T00:00:00+00:00', 'p1 p2'].join('\x00') + '\x1e\n';
      assert.deepEqual(gitCore.parseLog(rec), [{
        sha: 'abc', short: 'abc', subject: 'subj', author: 'me',
        date: '2020-01-01T00:00:00+00:00', parents: ['p1', 'p2']
      }]);
    });
  });
});
