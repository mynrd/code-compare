// Pure comparison / diff / merge logic shared by the renderer (as
// window.CompareCore) and the main process + tests (via require()).
// Keep this file free of DOM, Electron and fs dependencies.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CompareCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- compare options ----------

  function anyCompareOpt(opts) {
    return !!(opts && (opts.ignoreWhitespace || opts.ignoreComments || opts.ignoreLineBreaks));
  }

  // Whole-text normalization used for the "are these files equal" fast path
  // (folder scan). Line-splitting comparison below uses textToKeys instead.
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

  // Replace block-comment characters with spaces so line numbering is kept
  // while their content is ignored.
  function maskBlockComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  }

  function buildCompareKey(line, opts) {
    let k = line;
    if (opts.ignoreComments) {
      k = k.replace(/(^|[^:])\/\/.*$/, '$1');
    }
    if (opts.ignoreWhitespace) {
      k = k.trim().replace(/\s+/g, ' ');
    }
    return k;
  }

  function textToKeys(text, opts) {
    let t = text;
    if (opts.ignoreComments) t = maskBlockComments(t);
    const lines = t.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.map(l => buildCompareKey(l, opts));
  }

  function textsEqualUnderOptions(a, b, opts) {
    if (!anyCompareOpt(opts)) return a === b;
    let aKeys = textToKeys(a, opts);
    let bKeys = textToKeys(b, opts);
    if (opts.ignoreLineBreaks) {
      aKeys = aKeys.filter(l => l.length > 0);
      bKeys = bKeys.filter(l => l.length > 0);
    }
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) if (aKeys[i] !== bKeys[i]) return false;
    return true;
  }

  // ---------- line diff (LCS) ----------

  function splitLines(s) {
    const arr = s.split('\n');
    if (arr.length && arr[arr.length - 1] === '') arr.pop();
    return arr;
  }

  function diffOps(aKeys, bKeys) {
    const n = aKeys.length, m = bKeys.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (aKeys[i] === bKeys[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (aKeys[i] === bKeys[j]) { out.push({ type: 'eq', i, j }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', i }); i++; }
      else { out.push({ type: 'add', j }); j++; }
    }
    while (i < n) { out.push({ type: 'del', i }); i++; }
    while (j < m) { out.push({ type: 'add', j }); j++; }
    return out;
  }

  function mergeBlocks(ops) {
    const blocks = [];
    for (const op of ops) {
      const last = blocks[blocks.length - 1];
      if (last && last.type === op.type) {
        if (op.type === 'eq') { last.left.push(op.i); last.right.push(op.j); }
        else if (op.type === 'del') last.left.push(op.i);
        else last.right.push(op.j);
      } else if (op.type === 'eq') {
        blocks.push({ type: 'eq', left: [op.i], right: [op.j] });
      } else if (op.type === 'del') {
        blocks.push({ type: 'del', left: [op.i], right: [] });
      } else {
        blocks.push({ type: 'add', left: [], right: [op.j] });
      }
    }
    return blocks;
  }

  // Build the side-by-side row model.
  // opts: { leftMissing, rightMissing, compareOptions }
  // Row: { type: 'eq'|'mod'|'del'|'add',
  //        leftLine: number|'', leftCode: string,
  //        rightLine: number|'', rightCode: string }
  function buildRows(leftText, rightText, opts) {
    opts = opts || {};
    const co = opts.compareOptions || {};
    if (opts.leftMissing) {
      return splitLines(rightText).map((ln, i) => ({
        type: 'add', leftLine: '', leftCode: '', rightLine: i + 1, rightCode: ln
      }));
    }
    if (opts.rightMissing) {
      return splitLines(leftText).map((ln, i) => ({
        type: 'del', leftLine: i + 1, leftCode: ln, rightLine: '', rightCode: ''
      }));
    }
    const leftDisp = splitLines(leftText);
    const rightDisp = splitLines(rightText);
    const leftKeys = textToKeys(leftText, co);
    const rightKeys = textToKeys(rightText, co);
    while (leftKeys.length < leftDisp.length) leftKeys.push('');
    while (rightKeys.length < rightDisp.length) rightKeys.push('');
    while (leftKeys.length > leftDisp.length) leftKeys.pop();
    while (rightKeys.length > rightDisp.length) rightKeys.pop();

    const ops = diffOps(leftKeys, rightKeys);
    const blocks = mergeBlocks(ops);
    const rows = [];
    let lN = 1, rN = 1;
    for (let b = 0; b < blocks.length; b++) {
      const block = blocks[b];
      if (block.type === 'eq') {
        for (let z = 0; z < block.left.length; z++) {
          rows.push({
            type: 'eq',
            leftLine: lN++, leftCode: leftDisp[block.left[z]],
            rightLine: rN++, rightCode: rightDisp[block.right[z]]
          });
        }
      } else if (block.type === 'del') {
        const next = blocks[b + 1];
        if (next && next.type === 'add') {
          const max = Math.max(block.left.length, next.right.length);
          for (let z = 0; z < max; z++) {
            const hasL = z < block.left.length, hasR = z < next.right.length;
            rows.push({
              type: hasL && hasR ? 'mod' : (hasL ? 'del' : 'add'),
              leftLine: hasL ? lN++ : '',
              leftCode: hasL ? leftDisp[block.left[z]] : '',
              rightLine: hasR ? rN++ : '',
              rightCode: hasR ? rightDisp[next.right[z]] : ''
            });
          }
          b++;
        } else {
          for (const li of block.left) {
            rows.push({ type: 'del', leftLine: lN++, leftCode: leftDisp[li], rightLine: '', rightCode: '' });
          }
        }
      } else if (block.type === 'add') {
        for (const ri of block.right) {
          rows.push({ type: 'add', leftLine: '', leftCode: '', rightLine: rN++, rightCode: rightDisp[ri] });
        }
      }
    }
    return rows;
  }

  // ---------- intra-line diff ----------

  // Common-prefix/suffix character diff between two lines. Returns null when
  // the lines are identical, otherwise { prefix, suffix, aMid, bMid } where
  // prefix/suffix are the shared lengths and aMid/bMid the differing middles.
  function charDiff(a, b) {
    a = String(a); b = String(b);
    if (a === b) return null;
    const max = Math.min(a.length, b.length);
    let p = 0;
    while (p < max && a[p] === b[p]) p++;
    let s = 0;
    while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
    return { prefix: p, suffix: s, aMid: a.slice(p, a.length - s), bMid: b.slice(p, b.length - s) };
  }

  // ---------- merge (copy a line / block to the other side) ----------

  function prevLineNum(rows, idx, key) {
    for (let i = idx - 1; i >= 0; i--) {
      const v = rows[i][key];
      if (v !== '' && v != null) return v;
    }
    return 0;
  }

  // Merge a single row's change into the other side.
  //  - 'mod' + to-right : replace the right line with the left line
  //  - 'del' + to-right : insert the left-only line into the right side
  //  - 'add' + to-right : delete the right-only line (right matches left)
  // (mirrored for to-left). Inputs are never mutated; returns fresh arrays.
  function mergeLine(rows, idx, direction, leftLines, rightLines) {
    const left = leftLines.slice(), right = rightLines.slice();
    const r = rows && rows[idx];
    if (!r || r.type === 'eq') return { left, right, changed: false, side: null };
    if (direction === 'to-right') {
      if (r.type === 'mod') right[r.rightLine - 1] = left[r.leftLine - 1];
      else if (r.type === 'del') right.splice(prevLineNum(rows, idx, 'rightLine'), 0, left[r.leftLine - 1]);
      else right.splice(r.rightLine - 1, 1);
      return { left, right, changed: true, side: 'right' };
    }
    if (r.type === 'mod') left[r.leftLine - 1] = right[r.rightLine - 1];
    else if (r.type === 'add') left.splice(prevLineNum(rows, idx, 'leftLine'), 0, right[r.rightLine - 1]);
    else left.splice(r.leftLine - 1, 1);
    return { left, right, changed: true, side: 'left' };
  }

  // [start, end] inclusive indices of the contiguous changed block containing
  // idx, or null when rows[idx] is an unchanged row.
  function hunkRange(rows, idx) {
    if (!rows || !rows[idx] || rows[idx].type === 'eq') return null;
    let s = idx, e = idx;
    while (s > 0 && rows[s - 1].type !== 'eq') s--;
    while (e < rows.length - 1 && rows[e + 1].type !== 'eq') e++;
    return [s, e];
  }

  // Merge the whole changed block containing idx. Rows are applied bottom-up
  // so earlier line numbers in the same snapshot stay valid while later lines
  // shift under inserts/deletes.
  function mergeHunk(rows, idx, direction, leftLines, rightLines) {
    const range = hunkRange(rows, idx);
    if (!range) return { left: leftLines.slice(), right: rightLines.slice(), changed: false, side: null };
    let left = leftLines.slice(), right = rightLines.slice();
    for (let i = range[1]; i >= range[0]; i--) {
      const res = mergeLine(rows, i, direction, left, right);
      left = res.left; right = res.right;
    }
    return { left, right, changed: true, side: direction === 'to-right' ? 'right' : 'left' };
  }

  // ---------- folder tree ----------

  function mkDir(name, path) {
    return {
      name, path, isDir: true, children: new Map(),
      counts: { 'only-left': 0, 'only-right': 0, modified: 0, same: 0 }
    };
  }

  function aggregate(node) {
    if (!node.isDir) return;
    for (const child of node.children.values()) {
      if (child.isDir) {
        aggregate(child);
        for (const k of Object.keys(node.counts)) node.counts[k] += child.counts[k];
      } else {
        node.counts[child.item.status]++;
      }
    }
    node.status = (node.counts.modified || node.counts['only-left'] || node.counts['only-right'])
      ? 'modified' : 'same';
  }

  function buildTree(items) {
    const root = mkDir('', '');
    for (const it of items) {
      const parts = it.path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const name = parts[i];
        if (!node.children.has(name)) {
          node.children.set(name, mkDir(name, parts.slice(0, i + 1).join('/')));
        }
        node = node.children.get(name);
      }
      const fileName = parts[parts.length - 1];
      node.children.set(fileName, { name: fileName, path: it.path, isDir: false, item: it });
    }
    aggregate(root);
    return root;
  }

  return {
    anyCompareOpt,
    normalizeText,
    maskBlockComments,
    buildCompareKey,
    textToKeys,
    textsEqualUnderOptions,
    splitLines,
    diffOps,
    mergeBlocks,
    buildRows,
    charDiff,
    mergeLine,
    mergeHunk,
    hunkRange,
    buildTree
  };
});
