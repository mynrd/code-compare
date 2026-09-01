const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../renderer/compare-core.js');

const NO_OPTS = { ignoreWhitespace: false, ignoreComments: false, ignoreLineBreaks: false };

describe('anyCompareOpt', () => {
  test('false for empty / disabled options', () => {
    assert.equal(core.anyCompareOpt(null), false);
    assert.equal(core.anyCompareOpt({}), false);
    assert.equal(core.anyCompareOpt(NO_OPTS), false);
  });
  test('true when any option is on', () => {
    assert.equal(core.anyCompareOpt({ ignoreWhitespace: true }), true);
    assert.equal(core.anyCompareOpt({ ignoreComments: true }), true);
    assert.equal(core.anyCompareOpt({ ignoreLineBreaks: true }), true);
  });
});

describe('normalizeText', () => {
  test('normalizes CRLF and CR to LF', () => {
    assert.equal(core.normalizeText('a\r\nb\rc', {}), 'a\nb\nc');
  });
  test('ignoreWhitespace trims and collapses', () => {
    assert.equal(core.normalizeText('  a\t\tb  ', { ignoreWhitespace: true }), 'a b');
  });
  test('ignoreComments strips block and line comments', () => {
    assert.equal(core.normalizeText('a /* x */ b', { ignoreComments: true }), 'a  b');
    assert.equal(core.normalizeText('code // trailing', { ignoreComments: true }), 'code ');
  });
  test('ignoreComments keeps URLs (://) intact', () => {
    assert.equal(
      core.normalizeText('url = "http://x.com"', { ignoreComments: true }),
      'url = "http://x.com"');
  });
  test('ignoreLineBreaks drops blank lines', () => {
    assert.equal(core.normalizeText('a\n\n\nb', { ignoreLineBreaks: true }), 'a\nb');
  });
});

describe('splitLines', () => {
  test('splits and drops single trailing empty line', () => {
    assert.deepEqual(core.splitLines('a\nb\n'), ['a', 'b']);
    assert.deepEqual(core.splitLines('a\nb'), ['a', 'b']);
  });
  test('keeps interior blank lines', () => {
    assert.deepEqual(core.splitLines('a\n\nb\n'), ['a', '', 'b']);
  });
  test('empty string yields no lines', () => {
    assert.deepEqual(core.splitLines(''), []);
  });
});

describe('maskBlockComments', () => {
  test('replaces comment chars with spaces, preserving newlines', () => {
    const out = core.maskBlockComments('a/*x\ny*/b');
    assert.equal(out, 'a   \n   b');
    assert.equal(out.split('\n').length, 2);
  });
});

describe('textToKeys / textsEqualUnderOptions', () => {
  test('no options: strict equality', () => {
    assert.equal(core.textsEqualUnderOptions('a\nb', 'a\nb', NO_OPTS), true);
    assert.equal(core.textsEqualUnderOptions('a\nb', 'a\nc', NO_OPTS), false);
  });
  test('ignoreWhitespace equates differently-indented text', () => {
    const o = { ...NO_OPTS, ignoreWhitespace: true };
    assert.equal(core.textsEqualUnderOptions('  a;\n\tb;', 'a;\nb;', o), true);
    assert.equal(core.textsEqualUnderOptions('a b', 'ab', o), false);
  });
  test('ignoreComments equates texts differing only in comments', () => {
    const o = { ...NO_OPTS, ignoreComments: true };
    assert.equal(core.textsEqualUnderOptions('x = 1; // one', 'x = 1; // uno', o), true);
    assert.equal(core.textsEqualUnderOptions('x = 1;/*a*/', 'x = 1;/*b*/', o), true);
  });
  test('ignoreLineBreaks equates texts differing only in blank lines', () => {
    const o = { ...NO_OPTS, ignoreLineBreaks: true };
    assert.equal(core.textsEqualUnderOptions('a\n\nb', 'a\nb', o), true);
    assert.equal(core.textsEqualUnderOptions('a\nb', 'b\na', o), false);
  });
  test('multi-line block comment does not shift line keys', () => {
    const keys = core.textToKeys('a\n/* x\n y */\nb', { ignoreComments: true, ignoreWhitespace: true });
    assert.deepEqual(keys, ['a', '', '', 'b']);
  });
});

describe('diffOps (LCS)', () => {
  test('identical sequences are all eq', () => {
    const ops = core.diffOps(['a', 'b'], ['a', 'b']);
    assert.deepEqual(ops.map(o => o.type), ['eq', 'eq']);
  });
  test('pure insertion', () => {
    const ops = core.diffOps(['a', 'c'], ['a', 'b', 'c']);
    assert.deepEqual(ops.map(o => o.type), ['eq', 'add', 'eq']);
  });
  test('pure deletion', () => {
    const ops = core.diffOps(['a', 'b', 'c'], ['a', 'c']);
    assert.deepEqual(ops.map(o => o.type), ['eq', 'del', 'eq']);
  });
  test('empty vs non-empty', () => {
    assert.deepEqual(core.diffOps([], ['x']).map(o => o.type), ['add']);
    assert.deepEqual(core.diffOps(['x'], []).map(o => o.type), ['del']);
    assert.deepEqual(core.diffOps([], []), []);
  });
  test('preserves longest common subsequence', () => {
    const ops = core.diffOps(['a', 'x', 'b', 'y', 'c'], ['a', 'b', 'c']);
    const eqCount = ops.filter(o => o.type === 'eq').length;
    assert.equal(eqCount, 3);
  });
});

describe('mergeBlocks', () => {
  test('groups consecutive same-type ops', () => {
    const blocks = core.mergeBlocks([
      { type: 'eq', i: 0, j: 0 },
      { type: 'del', i: 1 }, { type: 'del', i: 2 },
      { type: 'add', j: 1 },
      { type: 'eq', i: 3, j: 2 }
    ]);
    assert.deepEqual(blocks.map(b => b.type), ['eq', 'del', 'add', 'eq']);
    assert.deepEqual(blocks[1].left, [1, 2]);
    assert.deepEqual(blocks[2].right, [1]);
  });
});

describe('buildRows', () => {
  test('identical texts produce only eq rows with matching numbers', () => {
    const rows = core.buildRows('a\nb\n', 'a\nb\n', {});
    assert.deepEqual(rows.map(r => r.type), ['eq', 'eq']);
    assert.equal(rows[1].leftLine, 2);
    assert.equal(rows[1].rightLine, 2);
  });
  test('changed line becomes a mod row (del/add pairing)', () => {
    const rows = core.buildRows('a\nB\nc\n', 'a\nX\nc\n', {});
    assert.deepEqual(rows.map(r => r.type), ['eq', 'mod', 'eq']);
    assert.equal(rows[1].leftCode, 'B');
    assert.equal(rows[1].rightCode, 'X');
  });
  test('uneven del/add block pairs then leaves leftovers', () => {
    const rows = core.buildRows('a\np\nq\nz\n', 'a\nP\nz\n', {});
    assert.deepEqual(rows.map(r => r.type), ['eq', 'mod', 'del', 'eq']);
    assert.equal(rows[2].leftCode, 'q');
    assert.equal(rows[2].rightLine, '');
  });
  test('insertion produces add rows with blank left side', () => {
    const rows = core.buildRows('a\nc\n', 'a\nb\nc\n', {});
    assert.deepEqual(rows.map(r => r.type), ['eq', 'add', 'eq']);
    assert.equal(rows[1].leftLine, '');
    assert.equal(rows[1].rightCode, 'b');
    assert.equal(rows[2].rightLine, 3);
  });
  test('leftMissing renders whole right file as add rows', () => {
    const rows = core.buildRows(null, 'x\ny\n', { leftMissing: true });
    assert.deepEqual(rows.map(r => r.type), ['add', 'add']);
    assert.equal(rows[1].rightLine, 2);
  });
  test('rightMissing renders whole left file as del rows', () => {
    const rows = core.buildRows('x\ny\n', null, { rightMissing: true });
    assert.deepEqual(rows.map(r => r.type), ['del', 'del']);
    assert.equal(rows[0].leftCode, 'x');
  });
  test('ignoreWhitespace makes indent-only differences eq but shows original text', () => {
    const rows = core.buildRows('  a;\n', 'a;\n', {
      compareOptions: { ...NO_OPTS, ignoreWhitespace: true }
    });
    assert.deepEqual(rows.map(r => r.type), ['eq']);
    assert.equal(rows[0].leftCode, '  a;');
    assert.equal(rows[0].rightCode, 'a;');
  });
  test('ignoreComments pairs lines differing only in trailing comment', () => {
    const rows = core.buildRows('x = 1; // a\n', 'x = 1; // b\n', {
      compareOptions: { ...NO_OPTS, ignoreComments: true }
    });
    assert.deepEqual(rows.map(r => r.type), ['eq']);
  });
});

describe('charDiff', () => {
  test('null for identical lines', () => {
    assert.equal(core.charDiff('abc', 'abc'), null);
  });
  test('finds differing middle with common prefix and suffix', () => {
    const d = core.charDiff('let count = 1;', 'let count = 2;');
    assert.equal(d.prefix, 'let count = '.length);
    assert.equal(d.aMid, '1');
    assert.equal(d.bMid, '2');
    assert.equal(d.suffix, 1);
  });
  test('pure insertion in middle', () => {
    const d = core.charDiff('ac', 'abc');
    assert.equal(d.aMid, '');
    assert.equal(d.bMid, 'b');
    assert.equal('ac'.slice(0, d.prefix) + d.bMid + 'ac'.slice('ac'.length - d.suffix), 'abc');
  });
  test('completely different lines', () => {
    const d = core.charDiff('aaa', 'bbb');
    assert.equal(d.prefix, 0);
    assert.equal(d.suffix, 0);
    assert.equal(d.aMid, 'aaa');
    assert.equal(d.bMid, 'bbb');
  });
  test('one side empty', () => {
    const d = core.charDiff('', 'xyz');
    assert.equal(d.aMid, '');
    assert.equal(d.bMid, 'xyz');
  });
  test('prefix/suffix never overlap', () => {
    const d = core.charDiff('aa', 'aaa');
    assert.ok(d.prefix + d.suffix <= 2);
    assert.equal('aa'.slice(0, d.prefix) + d.bMid + 'aa'.slice(2 - d.suffix), 'aaa');
  });
});

// Helper: build rows from texts, then merge and return joined results.
function setup(leftText, rightText) {
  const rows = core.buildRows(leftText, rightText, {});
  return { rows, left: core.splitLines(leftText), right: core.splitLines(rightText) };
}

describe('mergeLine', () => {
  test('mod to-right replaces the right line', () => {
    const { rows, left, right } = setup('a\nB\nc\n', 'a\nX\nc\n');
    const res = core.mergeLine(rows, 1, 'to-right', left, right);
    assert.equal(res.changed, true);
    assert.equal(res.side, 'right');
    assert.deepEqual(res.right, ['a', 'B', 'c']);
    assert.deepEqual(res.left, ['a', 'B', 'c']);
  });
  test('mod to-left replaces the left line', () => {
    const { rows, left, right } = setup('a\nB\nc\n', 'a\nX\nc\n');
    const res = core.mergeLine(rows, 1, 'to-left', left, right);
    assert.equal(res.side, 'left');
    assert.deepEqual(res.left, ['a', 'X', 'c']);
  });
  test('del to-right inserts the left-only line into the right side', () => {
    const { rows, left, right } = setup('a\nb\nc\n', 'a\nc\n');
    // rows: eq(a), del(b), eq(c)
    const res = core.mergeLine(rows, 1, 'to-right', left, right);
    assert.deepEqual(res.right, ['a', 'b', 'c']);
  });
  test('del to-right at top of file inserts at position 0', () => {
    const { rows, left, right } = setup('first\na\n', 'a\n');
    const res = core.mergeLine(rows, 0, 'to-right', left, right);
    assert.deepEqual(res.right, ['first', 'a']);
  });
  test('del to-left removes the left-only line', () => {
    const { rows, left, right } = setup('a\nb\nc\n', 'a\nc\n');
    const res = core.mergeLine(rows, 1, 'to-left', left, right);
    assert.deepEqual(res.left, ['a', 'c']);
  });
  test('add to-right removes the right-only line', () => {
    const { rows, left, right } = setup('a\nc\n', 'a\nb\nc\n');
    const res = core.mergeLine(rows, 1, 'to-right', left, right);
    assert.deepEqual(res.right, ['a', 'c']);
  });
  test('add to-left inserts the right-only line into the left side', () => {
    const { rows, left, right } = setup('a\nc\n', 'a\nb\nc\n');
    const res = core.mergeLine(rows, 1, 'to-left', left, right);
    assert.deepEqual(res.left, ['a', 'b', 'c']);
  });
  test('eq row is a no-op', () => {
    const { rows, left, right } = setup('a\nb\n', 'a\nb\n');
    const res = core.mergeLine(rows, 0, 'to-right', left, right);
    assert.equal(res.changed, false);
    assert.deepEqual(res.right, right);
  });
  test('does not mutate its inputs', () => {
    const { rows, left, right } = setup('a\nB\n', 'a\nX\n');
    const leftCopy = left.slice(), rightCopy = right.slice();
    core.mergeLine(rows, 1, 'to-right', left, right);
    assert.deepEqual(left, leftCopy);
    assert.deepEqual(right, rightCopy);
  });
});

describe('hunkRange', () => {
  test('finds the contiguous changed block around an index', () => {
    const { rows } = setup('a\nX\nY\nb\n', 'a\nb\n');
    // rows: eq, del, del, eq
    assert.deepEqual(core.hunkRange(rows, 1), [1, 2]);
    assert.deepEqual(core.hunkRange(rows, 2), [1, 2]);
  });
  test('returns null on eq rows', () => {
    const { rows } = setup('a\nX\n', 'a\nY\n');
    assert.equal(core.hunkRange(rows, 0), null);
  });
});

describe('mergeHunk', () => {
  test('multi-line deletion block copies right in original order', () => {
    const { rows, left, right } = setup('a\np\nq\nr\nz\n', 'a\nz\n');
    const res = core.mergeHunk(rows, 1, 'to-right', left, right);
    assert.deepEqual(res.right, ['a', 'p', 'q', 'r', 'z']);
  });
  test('mixed mod + leftover del block to-right makes right equal left', () => {
    const { rows, left, right } = setup('a\np\nq\nz\n', 'a\nP\nz\n');
    const res = core.mergeHunk(rows, 1, 'to-right', left, right);
    assert.deepEqual(res.right, left);
  });
  test('mixed block to-left makes left equal right', () => {
    const { rows, left, right } = setup('a\np\nq\nz\n', 'a\nP\nz\n');
    const res = core.mergeHunk(rows, 2, 'to-left', left, right);
    assert.deepEqual(res.left, right);
  });
  test('add block to-right deletes the right-only lines', () => {
    const { rows, left, right } = setup('a\nz\n', 'a\n1\n2\nz\n');
    const res = core.mergeHunk(rows, 1, 'to-right', left, right);
    assert.deepEqual(res.right, ['a', 'z']);
  });
  test('after merging every hunk to-right, right equals left', () => {
    const L = 'one\ntwo\nthree\nfour\nfive\n';
    const R = 'one\nTWO\nfour\nextra\nfive\n';
    let left = core.splitLines(L), right = core.splitLines(R);
    // Merge hunks one at a time, re-diffing between merges (as the UI does).
    for (let guard = 0; guard < 10; guard++) {
      const rows = core.buildRows(left.join('\n') + '\n', right.join('\n') + '\n', {});
      const idx = rows.findIndex(r => r.type !== 'eq');
      if (idx < 0) break;
      const res = core.mergeHunk(rows, idx, 'to-right', left, right);
      left = res.left; right = res.right;
    }
    assert.deepEqual(right, left);
    assert.deepEqual(right, core.splitLines(L));
  });
  test('no-op on eq row', () => {
    const { rows, left, right } = setup('a\n', 'a\n');
    const res = core.mergeHunk(rows, 0, 'to-right', left, right);
    assert.equal(res.changed, false);
  });
});

describe('buildTree', () => {
  const items = [
    { path: 'src/a.cs', status: 'modified', leftSize: 1, rightSize: 2 },
    { path: 'src/sub/b.cs', status: 'same', leftSize: 1, rightSize: 1 },
    { path: 'readme.md', status: 'only-left', leftSize: 5 },
    { path: 'new.md', status: 'only-right', rightSize: 5 }
  ];
  test('builds nested directories and aggregates counts', () => {
    const tree = core.buildTree(items);
    assert.equal(tree.counts.modified, 1);
    assert.equal(tree.counts.same, 1);
    assert.equal(tree.counts['only-left'], 1);
    assert.equal(tree.counts['only-right'], 1);
    const src = tree.children.get('src');
    assert.equal(src.isDir, true);
    assert.equal(src.counts.modified, 1);
    assert.equal(src.status, 'modified');
    const sub = src.children.get('sub');
    assert.equal(sub.status, 'same');
    assert.equal(sub.children.get('b.cs').item.status, 'same');
  });
  test('root status is same only when nothing changed', () => {
    const tree = core.buildTree([{ path: 'x/y.txt', status: 'same', leftSize: 1, rightSize: 1 }]);
    assert.equal(tree.status, 'same');
    assert.equal(tree.children.get('x').status, 'same');
  });
});
