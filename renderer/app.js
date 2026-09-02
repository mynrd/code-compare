const DEFAULT_IGNORES = ['.git', 'node_modules', 'dist', 'build', '.vs', 'bin', 'obj', '.next', '.cache'];

// Pure diff/merge/tree logic lives in compare-core.js (shared with tests).
const {
  anyCompareOpt,
  textsEqualUnderOptions,
  splitLines,
  buildRows,
  charDiff,
  mergeLine,
  mergeHunk,
  buildTree
} = window.CompareCore;

const state = {
  mode: 'folder',
  left: null,
  right: null,
  ignores: [],
  fileScan: { activeGroup: '', groups: [] },
  selectedGroupIdx: -1,
  activeTab: 'general',
  compareOptions: { ignoreWhitespace: false, ignoreComments: false, ignoreLineBreaks: false },
  currentDiff: null,
  history: [],
  // Row model of the current side-by-side render (from CompareCore.buildRows);
  // needed by the per-line/per-block merge buttons.
  rows: null,
  hunkRows: [],
  changeRows: [],
  hunkIdx: -1,
  zoom: 12,
  recent: [],
  items: [],
  tree: null,
  collapsed: new Set(),
  selected: null,
  showSame: false,
  treeSearch: '',
  // Map<absPath, string> — pending edited text for that side's file.
  // Lives in renderer + mirrored to userData/.temp/ on every keystroke (debounced).
  dirty: new Map(),
  // Per-render line arrays so we can mutate one cell and serialize the side.
  leftDisp: null,
  rightDisp: null,
  leftAbs: null,
  rightAbs: null,
  saveTimers: {},
  // Git mode. Extended by later slices (commit panel / file history); keep the
  // shape additive so nothing here has to be rewritten.
  git: null // set to freshGitState() right below
};

// Commit-panel slice of git state. Split out so switching repositories can
// reset just the commit list without touching the branch selection.
function freshCommitState() {
  return {
    commits: [],
    commitSkip: 0,
    commitQuery: '',
    commitPickaxe: false,
    commitsExhausted: false,
    selectedCommit: null,
    commitFiles: [],
    selectedCommitFile: null,
    // Set by the file-history slice; already threaded into loadCommits().
    historyPath: null
  };
}

function freshGitState() {
  return {
    root: null, branches: [], current: null, base: null, compare: null,
    ...freshCommitState()
  };
}

const $ = (id) => document.getElementById(id);

state.git = freshGitState();

function setMode(m) {
  state.mode = m;
  $('mode-folder').classList.toggle('active', m === 'folder');
  $('mode-file').classList.toggle('active', m === 'file');
  $('mode-git').classList.toggle('active', m === 'git');
  $('main-folder').classList.toggle('file-mode', m === 'file');
  $('main-folder').classList.toggle('git-mode', m === 'git');
  document.querySelector('header').classList.toggle('git-mode', m === 'git');
  state.left = null; state.right = null; state.items = []; state.tree = null;
  state.collapsed = new Set(); state.selected = null;
  $('left-path').value = ''; $('right-path').value = '';
  state.git = freshGitState();
  $('repo-path').value = '';
  setGitError('');
  clearBranchSelects();
  resetCommitsUI();
  renderTree();
  renderDiff(null);
  if (m === 'git') ensureGitAvailable();
  else $('compare-btn').disabled = false;
}

$('mode-folder').onclick = () => setMode('folder');
$('mode-file').onclick = () => setMode('file');
$('mode-git').onclick = () => setMode('git');

// ---------- git mode ----------

// null = not probed yet. Once false we never issue another git call (AC 12).
let gitAvailable = null;

function setGitError(msg) { $('git-error').textContent = msg || ''; }

function errText(e) { return String((e && (e.message || e.error)) || e || 'git command failed'); }

function clearBranchSelects() {
  for (const id of ['git-base', 'git-compare']) {
    const sel = $(id);
    sel.innerHTML = '';
    sel.disabled = true;
  }
  $('git-hint').textContent = '';
}

function disableGitUI() {
  $('repo-path').disabled = true;
  $('pick-repo').disabled = true;
  $('git-base').disabled = true;
  $('git-compare').disabled = true;
  $('compare-btn').disabled = true;
}

// Probe `git` once. Every git-mode entry point funnels through this so that a
// machine without git makes exactly one call and then stops.
async function ensureGitAvailable() {
  if (gitAvailable === false) { setGitError('git not found'); disableGitUI(); return false; }
  if (gitAvailable === true) return true;
  try {
    gitAvailable = !!(await window.api.git.hasGit());
  } catch { gitAvailable = false; }
  if (!gitAvailable) { setGitError('git not found'); disableGitUI(); return false; }
  return true;
}

function mainBranchOf(names) {
  if (names.includes('main')) return 'main';
  if (names.includes('master')) return 'master';
  return names[0] || null;
}

function fillBranchSelects() {
  const g = state.git;
  // The checked-out branch is the one you reach for most, so it goes first;
  // the rest stay in the alphabetical order listBranches produced.
  const ordered = [...g.branches].sort((a, b) => (b.current ? 1 : 0) - (a.current ? 1 : 0));
  for (const [id, key] of [['git-base', 'base'], ['git-compare', 'compare']]) {
    const sel = $(id);
    sel.innerHTML = '';
    for (const b of ordered) {
      const opt = document.createElement('option');
      opt.value = b.name;
      opt.textContent = b.current ? `${b.name} - current` : b.name;
      sel.appendChild(opt);
    }
    sel.disabled = !g.branches.length;
    if (g[key]) sel.value = g[key];
  }
  $('git-hint').textContent = (g.root && !g.current)
    ? 'Detached HEAD — no branch is checked out, so both panes are read-only'
    : '';
}

async function loadRepo(root) {
  let branches = [], current = null;
  try {
    branches = (await window.api.git.listBranches({ root })) || [];
    // `git branch` emits a pseudo-entry like "(HEAD detached at abc123)" when
    // HEAD is detached; it is not a ref anyone can diff against.
    branches = branches.filter(b => !/^\((HEAD detached|no branch)/.test(b.name));
    current = await window.api.git.currentBranch({ root });
  } catch (e) {
    setGitError(errText(e));
    state.git = freshGitState();
    clearBranchSelects();
    updateToolbar();
    return;
  }
  setGitError('');
  $('repo-path').value = root;
  const names = branches.map(b => b.name);
  state.git = {
    ...state.git,
    ...freshCommitState(),
    root,
    branches,
    current: current || null,
    base: mainBranchOf(names),
    compare: (current && names.includes(current)) ? current : mainBranchOf(names)
  };
  fillBranchSelects();
  resetCommitsUI();
  updateToolbar();
  await rememberRepo(root);
}

function resetRepo(msg) {
  setGitError(msg || '');
  state.git = freshGitState();
  state.items = []; state.tree = null; state.selected = null;
  clearBranchSelects();
  resetCommitsUI();
  renderTree();
  renderDiff(null);
}

async function resolveRepoFromInput() {
  if (!(await ensureGitAvailable())) return;
  const dir = normalizePath($('repo-path').value);
  if (!dir) { resetRepo(''); return; }
  if (dir === state.git.root) { setGitError(''); return; }
  let root = null;
  try { root = await window.api.git.repoRoot({ dir }); }
  catch { root = null; }
  if (!root) { resetRepo('Not a git repository'); return; }
  await loadRepo(root);
}

$('repo-path').addEventListener('blur', resolveRepoFromInput);
$('repo-path').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); resolveRepoFromInput(); }
});

$('pick-repo').onclick = async () => {
  if (!(await ensureGitAvailable())) return;
  const r = await window.api.git.pickRepo();
  if (!r || r.canceled) return;
  if (!r.root) { resetRepo(r.error || 'Not a git repository'); return; }
  await loadRepo(r.root);
};

$('git-base').onchange = (e) => {
  state.git.base = e.target.value || null;
  dropHistoryPath();
};
$('git-compare').onchange = (e) => {
  state.git.compare = e.target.value || null;
  // The commit list always follows the Compare ref.
  dropHistoryPath();
  loadCommits({ reset: true });
};

// git status letters -> the folder-tree item statuses the tree/diff code speaks.
const GIT_STATUS_TO_ITEM = {
  added: 'only-right',
  deleted: 'only-left',
  modified: 'modified',
  renamed: 'modified'
};

async function runGitCompare() {
  if (!(await ensureGitAvailable())) return;
  const g = state.git;
  if (!g.root || !g.base || !g.compare) {
    if (!g.root) setGitError('Pick a repository first.');
    return;
  }
  $('summary').textContent = 'Diffing…';
  let entries;
  try {
    entries = await window.api.git.diffNameStatus({ root: g.root, base: g.base, compare: g.compare });
  } catch (e) {
    setGitError(errText(e));
    state.items = []; state.tree = null;
    renderTree(); renderDiff(null);
    return;
  }
  setGitError('');
  state.items = (entries || []).map(e => ({
    path: e.path,
    status: GIT_STATUS_TO_ITEM[e.status] || 'modified',
    gitStatus: e.status,
    oldPath: e.oldPath || null,
    leftSize: null,
    rightSize: null
  }));
  // The tree/summary/toolbar code reads state.left/right; branch names are the
  // meaningful "sides" in git mode.
  state.left = g.base; state.right = g.compare;
  state.tree = buildTree(state.items);
  state.collapsed = new Set();
  state.selected = null;
  state.treeSearch = '';
  $('tree-search').value = '';
  renderTree();
  renderDiff(null);
  dropHistoryPath();
  await loadCommits({ reset: true });
}

// A side is editable only when its branch is the checked-out branch (and HEAD
// is not detached) — that is the only side whose content is the working tree.
function gitEditableSides() {
  const g = state.git;
  if (!g.current) return { left: false, right: false };
  return { left: g.base === g.current, right: g.compare === g.current };
}

// Loads one pane. Editable -> the working-tree file (real path, so the existing
// dirty/temp/Save flow applies). Read-only -> `git show <branch>:<path>`.
async function loadGitSide(branch, relPath, editable) {
  const g = state.git;
  if (editable) {
    const res = await window.api.readPair({ leftRoot: g.root, rightRoot: null, relPath });
    const data = res && res.left ? res.left : null;
    return { data, abs: data ? joinPath(g.root, relPath) : null };
  }
  try {
    return { data: await window.api.git.showFile({ root: g.root, ref: branch, path: relPath }), abs: null };
  } catch (e) {
    setGitError(errText(e));
    return { data: null, abs: null };
  }
}

async function selectItemGit(it) {
  const g = state.git;
  const ed = gitEditableSides();
  // For a rename the base ref only knows the old path.
  const basePath = it.oldPath || it.path;
  const comparePath = it.path;
  const [L, R] = await Promise.all([
    loadGitSide(g.base, basePath, ed.left),
    loadGitSide(g.compare, comparePath, ed.right)
  ]);
  renderDiff({
    leftTitle: `${g.base}: ${basePath}` + (L.data ? '' : ' (missing)'),
    rightTitle: `${g.compare}: ${comparePath}` + (R.data ? '' : ' (missing)'),
    left: L.data,
    right: R.data,
    leftAbs: L.abs,
    rightAbs: R.abs,
    relPath: it.path,
    item: it,
    editable: ed
  });
}

// ---------- commits panel ----------

const COMMIT_PAGE = 200;
// Every request carries a sequence number; a response whose number is stale
// (the user typed again in the meantime) is dropped instead of rendering.
let commitSeq = 0;
let commitSearchTimer = null;

function commitSearchText() { return (state.git.commitQuery || '').trim(); }

function resetCommitsUI() {
  if (commitSearchTimer) { clearTimeout(commitSearchTimer); commitSearchTimer = null; }
  commitSeq++;
  $('commit-search').value = '';
  $('commit-pickaxe').checked = false;
  state.git.historyPath = null;
  syncCommitsHeader();
  renderCommits();
}

// ---- file history (path-filtered commit log) ----

// The Commits pane doubles as a per-file history: the header switches to
// "History: <path>" with a ✕ that drops back to the branch log.
function syncCommitsHeader() {
  const p = state.git.historyPath;
  const title = $('commits-title');
  title.textContent = p ? `History: ${p}` : 'Commits';
  title.classList.toggle('history', !!p);
  title.title = p ? `Commits touching ${p} (git log --follow)` : '';
  $('history-clear').classList.toggle('hidden', !p);
}

// Called from the file-row context menu in git mode.
async function showFileHistory(it) {
  if (state.mode !== 'git' || !it) return;
  const g = state.git;
  // For a rename we follow the NEW path; --follow reaches the old name.
  g.historyPath = it.path;
  g.commitQuery = '';
  g.commitPickaxe = false;
  if (commitSearchTimer) { clearTimeout(commitSearchTimer); commitSearchTimer = null; }
  $('commit-search').value = '';
  $('commit-pickaxe').checked = false;
  syncCommitsHeader();
  await loadCommits({ reset: true });
}

async function clearFileHistory() {
  if (!state.git.historyPath) return;
  state.git.historyPath = null;
  syncCommitsHeader();
  await loadCommits({ reset: true });
}

// Leaves the commit list alone (callers reload it themselves).
function dropHistoryPath() {
  if (!state.git.historyPath) return;
  state.git.historyPath = null;
  syncCommitsHeader();
}

// Merge two log pages (message hits + author hits), newest first.
function mergeCommitLists(a, b) {
  const seen = new Set();
  const out = [];
  for (const c of [...(a || []), ...(b || [])]) {
    if (!c || seen.has(c.sha)) continue;
    seen.add(c.sha);
    out.push(c);
  }
  out.sort((x, y) => (Date.parse(y.date) || 0) - (Date.parse(x.date) || 0));
  return out;
}

// reset -> replace the list and start from skip 0; otherwise append the next
// page starting at the number of commits already shown.
async function loadCommits({ reset } = {}) {
  const g = state.git;
  if (!g.root || !g.compare) { renderCommits(); return; }
  if (!(await ensureGitAvailable())) return;
  const seq = ++commitSeq;
  const text = commitSearchText();
  const skip = reset ? 0 : g.commits.length;
  const base = {
    root: g.root,
    ref: g.compare,
    skip,
    limit: COMMIT_PAGE,
    path: g.historyPath || undefined
  };
  let batch = [];
  try {
    if (text && g.commitPickaxe) {
      // "Search in changes" -> git log -S<text>; grep/author do not apply.
      batch = await window.api.git.log({ ...base, pickaxe: text });
    } else if (text) {
      // Message (git-core also matches sha prefixes for hex-looking text) and
      // author are two separate git invocations, merged newest-first.
      const [byMsg, byAuthor] = await Promise.all([
        window.api.git.log({ ...base, grep: text }),
        window.api.git.log({ ...base, author: text })
      ]);
      batch = mergeCommitLists(byMsg, byAuthor).slice(0, COMMIT_PAGE);
    } else {
      batch = await window.api.git.log(base);
    }
  } catch (e) {
    if (seq !== commitSeq) return;
    setGitError(errText(e));
    return;
  }
  if (seq !== commitSeq) return; // a newer request superseded this one
  batch = batch || [];
  if (reset) {
    g.commits = batch;
    g.selectedCommit = null;
    g.commitFiles = [];
    g.selectedCommitFile = null;
  } else {
    const seen = new Set(g.commits.map(c => c.sha));
    for (const c of batch) if (!seen.has(c.sha)) g.commits.push(c);
  }
  g.commitSkip = g.commits.length;
  g.commitsExhausted = batch.length < COMMIT_PAGE;
  renderCommits();
}

// "3m ago" / "2h ago" / "5d ago" / "3mo ago" / "2y ago".
function relTime(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function renderCommits() {
  const list = $('commit-list');
  const g = state.git;
  const more = $('commit-more');
  list.innerHTML = '';
  const n = g.commits.length;
  $('commits-summary').textContent = n
    ? `${n}${g.commitsExhausted ? '' : '+'} commit${n === 1 ? '' : 's'}`
    : '';
  more.classList.toggle('hidden', !n || g.commitsExhausted);
  more.disabled = !n || g.commitsExhausted;
  if (!n) {
    list.innerHTML = g.root
      ? (commitSearchText() ? '<div class="empty">No commits match the search.</div>'
                            : '<div class="empty">No commits.</div>')
      : '<div class="empty">Pick a repository to list its commits.</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const c of g.commits) {
    frag.appendChild(mkCommitRow(c));
    if (g.selectedCommit && g.selectedCommit.sha === c.sha) {
      frag.appendChild(mkCommitFileList(c));
    }
  }
  list.appendChild(frag);
}

function mkCommitRow(c) {
  const g = state.git;
  const row = document.createElement('div');
  row.className = 'commit-row';
  if (g.selectedCommit && g.selectedCommit.sha === c.sha) row.classList.add('selected');
  row.dataset.sha = c.sha;
  row.innerHTML = '<span class="sha"></span><span class="subject"></span><span class="meta"></span>';
  row.querySelector('.sha').textContent = c.short || c.sha.slice(0, 7);
  row.querySelector('.subject').textContent = c.subject || '';
  const rel = relTime(c.date);
  row.querySelector('.meta').textContent = [c.author, rel].filter(Boolean).join(' · ');
  row.title = `${c.sha}\n${c.subject || ''}\n${c.author || ''}${c.date ? ' — ' + c.date : ''}`;
  row.onclick = () => selectCommit(c);
  return row;
}

function mkCommitFileList(c) {
  const g = state.git;
  const wrap = document.createElement('div');
  wrap.className = 'commit-files';
  if (!g.commitFiles.length) {
    wrap.innerHTML = '<div class="empty">No files in this commit.</div>';
    return wrap;
  }
  for (const f of g.commitFiles) {
    const status = GIT_STATUS_TO_ITEM[f.status] || 'modified';
    const sym = { 'only-left': '◄', 'only-right': '►', 'modified': '≠', 'same': '=' }[status];
    const row = document.createElement('div');
    row.className = `commit-file ${status}`;
    if (g.selectedCommitFile === f.path) row.classList.add('selected');
    row.dataset.path = f.path;
    row.innerHTML = '<span class="badge"></span><span class="path"></span><span class="st"></span>';
    row.querySelector('.badge').textContent = sym;
    row.querySelector('.path').textContent = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
    row.querySelector('.st').textContent = f.status;
    row.title = `${f.status}: ${f.oldPath ? f.oldPath + ' → ' : ''}${f.path}`;
    row.onclick = (e) => { e.stopPropagation(); selectCommitFile(c, f); };
    wrap.appendChild(row);
  }
  return wrap;
}

// Accordion: clicking the selected commit collapses it again.
async function selectCommit(c) {
  const g = state.git;
  if (g.selectedCommit && g.selectedCommit.sha === c.sha) {
    g.selectedCommit = null;
    g.commitFiles = [];
    g.selectedCommitFile = null;
    renderCommits();
    return;
  }
  g.selectedCommit = c;
  g.commitFiles = [];
  g.selectedCommitFile = null;
  renderCommits();
  let files = [];
  try {
    files = (await window.api.git.commitFiles({ root: g.root, sha: c.sha })) || [];
  } catch (e) {
    setGitError(errText(e));
  }
  // The user may have clicked another commit while this was in flight.
  if (!g.selectedCommit || g.selectedCommit.sha !== c.sha) return;
  g.commitFiles = files;
  renderCommits();
  // In history mode the commit row itself is a shortcut to "this file at this
  // commit" — the accordion still lists the commit's other files.
  if (g.historyPath) await selectCommitFile(c, historyFileEntry(files, g.historyPath));
}

// The commit's entry for the followed path. The log is path-filtered so the
// commit did touch it; across a rename the entry may carry the old name.
function historyFileEntry(files, historyPath) {
  return (files || []).find(f => f.path === historyPath)
      || (files || []).find(f => f.oldPath === historyPath)
      || { path: historyPath, status: 'modified' };
}

async function gitShowOrNull(root, ref, path) {
  try {
    return await window.api.git.showFile({ root, ref, path });
  } catch (e) {
    setGitError(errText(e));
    return null;
  }
}

// parent-of-commit on the left, commit on the right; both read-only.
async function selectCommitFile(commit, file) {
  const g = state.git;
  g.selectedCommit = commit;
  g.selectedCommitFile = file.path;
  // Only one thing is highlighted at a time: drop the file-tree selection.
  state.selected = null;
  renderTree();
  renderCommits();

  let parentSha = (commit.parents && commit.parents[0]) || null;
  if (!parentSha) {
    try { parentSha = await window.api.git.parentOf({ root: g.root, sha: commit.sha }); }
    catch { parentSha = null; }
  }
  const leftPath = file.oldPath || file.path;
  const [L, R] = await Promise.all([
    parentSha ? gitShowOrNull(g.root, parentSha, leftPath) : Promise.resolve(null),
    gitShowOrNull(g.root, commit.sha, file.path)
  ]);
  const parentShort = parentSha ? parentSha.slice(0, 7) : null;
  renderDiff({
    leftTitle: parentShort ? `${parentShort}: ${leftPath}` + (L ? '' : ' (missing)') : '(missing)',
    rightTitle: `${commit.short}: ${file.path}` + (R ? '' : ' (missing)'),
    left: L,
    right: R,
    leftAbs: null,
    rightAbs: null,
    relPath: file.path,
    commitFile: { commit, file },
    editable: { left: false, right: false }
  });
}

$('commit-search').addEventListener('input', (e) => {
  state.git.commitQuery = e.target.value;
  if (commitSearchTimer) clearTimeout(commitSearchTimer);
  commitSearchTimer = setTimeout(() => {
    commitSearchTimer = null;
    loadCommits({ reset: true });
  }, 400);
});
$('commit-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === 'Escape') {
    e.preventDefault();
    if (e.key === 'Escape') { e.target.value = ''; state.git.commitQuery = ''; }
    if (commitSearchTimer) { clearTimeout(commitSearchTimer); commitSearchTimer = null; }
    loadCommits({ reset: true });
  }
});
$('commit-pickaxe').onchange = (e) => {
  state.git.commitPickaxe = e.target.checked;
  if (commitSearchTimer) { clearTimeout(commitSearchTimer); commitSearchTimer = null; }
  loadCommits({ reset: true });
};
$('commit-more').onclick = () => loadCommits({ reset: false });

async function pick(side) {
  const p = state.mode === 'folder' ? await window.api.pickFolder() : await window.api.pickFile();
  if (!p) return;
  if (side === 'left') { state.left = p; $('left-path').value = p; }
  else { state.right = p; $('right-path').value = p; }
}
$('pick-left').onclick = () => pick('left');
$('pick-right').onclick = () => pick('right');

function normalizePath(s) { return s.trim().replace(/^["']|["']$/g, ''); }
$('left-path').addEventListener('input', (e) => { state.left = normalizePath(e.target.value) || null; });
$('right-path').addEventListener('input', (e) => { state.right = normalizePath(e.target.value) || null; });

async function runCompare() {
  if (state.mode === 'git') return runGitCompare();
  if (!state.left || !state.right) return;
  await rememberPair();
  if (state.mode === 'folder') {
    $('summary').textContent = 'Scanning…';
    const res = await window.api.compareFolders({
      left: state.left, right: state.right,
      ignores: state.ignores,
      fileScan: state.fileScan,
      compareOptions: state.compareOptions
    });
    state.items = res.items;
    state.tree = buildTree(res.items);
    state.collapsed = new Set();
    autoCollapseSame(state.tree);
    state.selected = null;
    state.treeSearch = '';
    $('tree-search').value = '';
    renderTree();
    renderDiff(null);
  } else {
    const res = await window.api.compareFiles({ leftPath: state.left, rightPath: state.right });
    renderDiff({
      leftTitle: state.left,
      rightTitle: state.right,
      left: res.left,
      right: res.right,
      leftAbs: state.left,
      rightAbs: state.right
    });
  }
}
$('compare-btn').onclick = runCompare;

$('show-same').onchange = (e) => { state.showSame = e.target.checked; renderTree(); };

$('tree-search').addEventListener('input', (e) => {
  state.treeSearch = e.target.value.trim().toLowerCase();
  renderTree();
});
$('tree-search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.target.value = ''; state.treeSearch = ''; renderTree(); }
});

// ---------- recent ----------

async function rememberPair() {
  // Git mode's "sides" are branch names, not paths — nothing useful to recall.
  if (state.mode === 'git') return;
  const entry = { mode: state.mode, left: state.left, right: state.right, ts: Date.now() };
  const filtered = state.recent.filter(r =>
    !(r.mode === entry.mode && r.left === entry.left && r.right === entry.right));
  state.recent = [entry, ...filtered].slice(0, 10);
  await window.api.saveConfig({
    lastMode: state.mode,
    lastLeft: state.left,
    lastRight: state.right,
    recent: state.recent
  });
}

// Git repositories join the same Recent list as folder/file pairs. left/right
// are filled with the root so the entry looks like the others to anything that
// assumes a pair (the config store itself keeps entries verbatim).
async function rememberRepo(root) {
  if (!root) return;
  const entry = { mode: 'git', root, left: root, right: root, ts: Date.now() };
  const filtered = state.recent.filter(r => !(r.mode === 'git' && r.root === root));
  state.recent = [entry, ...filtered].slice(0, 10);
  await window.api.saveConfig({ recent: state.recent });
}

async function openRecentGit(root) {
  if (!root) return;
  setMode('git');
  $('repo-path').value = root;
  if (!(await ensureGitAvailable())) return;
  await loadRepo(root);
}

function renderRecentMenu() {
  const menu = $('recent-menu');
  menu.innerHTML = '';
  if (!state.recent.length) {
    menu.innerHTML = '<div class="popover-empty">No recent compares yet.</div>';
    return;
  }
  for (const r of state.recent) {
    const item = document.createElement('div');
    const isGit = r.mode === 'git';
    item.className = 'popover-item' + (isGit ? ' git' : '');
    if (isGit) {
      item.innerHTML = `
        <div><span class="mode"></span><span class="ts"></span></div>
        <div class="pair"><span class="root"></span></div>`;
      item.querySelector('.mode').textContent = 'git';
      item.querySelector('.ts').textContent = fmtTs(r.ts);
      item.querySelector('.root').textContent = r.root || r.left || '';
      item.onclick = () => {
        closeRecent();
        openRecentGit(r.root || r.left);
      };
    } else {
      item.innerHTML = `
        <div><span class="mode"></span><span class="ts"></span></div>
        <div class="pair"><span class="l"></span><span class="arrow">↔</span><span class="r"></span></div>`;
      item.querySelector('.mode').textContent = r.mode;
      item.querySelector('.ts').textContent = fmtTs(r.ts);
      item.querySelector('.l').textContent = r.left;
      item.querySelector('.r').textContent = r.right;
      item.onclick = () => {
        closeRecent();
        setMode(r.mode);
        state.left = r.left; state.right = r.right;
        $('left-path').value = r.left; $('right-path').value = r.right;
        runCompare();
      };
    }
    menu.appendChild(item);
  }
  const clear = document.createElement('div');
  clear.className = 'popover-clear';
  clear.textContent = 'Clear history';
  clear.onclick = async (e) => {
    e.stopPropagation();
    state.recent = [];
    await window.api.saveConfig({ recent: [] });
    renderRecentMenu();
  };
  menu.appendChild(clear);
}

function fmtTs(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function openRecent() { renderRecentMenu(); $('recent-menu').classList.remove('hidden'); }
function closeRecent() { $('recent-menu').classList.add('hidden'); }
$('recent-btn').onclick = (e) => {
  e.stopPropagation();
  $('recent-menu').classList.contains('hidden') ? openRecent() : closeRecent();
};
document.addEventListener('click', (e) => {
  if (!$('recent-menu').classList.contains('hidden') &&
      !e.target.closest('.recent-wrap')) closeRecent();
});

// ---------- tree ----------

function autoCollapseSame(node) {
  if (!node.isDir) return;
  for (const child of node.children.values()) {
    if (child.isDir) {
      if (child.status === 'same') state.collapsed.add(child.path);
      autoCollapseSame(child);
    }
  }
}

function renderTree() {
  const list = $('tree-list');
  list.innerHTML = '';
  if (!state.tree) {
    list.innerHTML = state.mode === 'git'
      ? '<div class="empty">Pick a repository, choose Base and Compare, then click Compare.</div>'
      : '<div class="empty">Pick two folders and click Compare.</div>';
    $('summary').textContent = '';
    return;
  }
  const c = state.tree.counts;
  const total = c['only-left'] + c['only-right'] + c.modified + c.same;
  if (state.mode === 'git') {
    // added lands on the compare (right) side, deleted on the base (left) side.
    $('summary').textContent = total
      ? `${total} files · ${c.modified}≠ ${c['only-right']}+ ${c['only-left']}−`
      : 'No differences';
  } else {
    $('summary').textContent = total
      ? `${total} files · ${c.modified}≠ ${c['only-left']}◄ ${c['only-right']}► ${c.same}=`
      : '';
  }

  const frag = document.createDocumentFragment();
  if (state.treeSearch) {
    const q = state.treeSearch;
    const matches = state.items.filter(it => it.path.toLowerCase().includes(q));
    for (const it of matches) frag.appendChild(mkFileRow(it, 0));
    if (!frag.childNodes.length) {
      list.innerHTML = '<div class="empty">No files match the search.</div>';
      return;
    }
  } else {
    renderNodeChildren(state.tree, 0, frag);
    if (!frag.childNodes.length) {
      list.innerHTML = '<div class="empty">Nothing to show (try enabling "show unchanged").</div>';
      return;
    }
  }
  list.appendChild(frag);
}

function renderNodeChildren(node, depth, frag) {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of children) {
    if (!state.showSame) {
      if (child.isDir && child.status === 'same') continue;
      if (!child.isDir && child.item.status === 'same') continue;
    }
    if (child.isDir) {
      const collapsed = state.collapsed.has(child.path);
      frag.appendChild(mkDirRow(child, depth, collapsed));
      if (!collapsed) renderNodeChildren(child, depth + 1, frag);
    } else {
      frag.appendChild(mkFileRow(child.item, depth));
    }
  }
}

function mkDirRow(node, depth, collapsed) {
  const row = document.createElement('div');
  row.className = `row dir ${node.status}`;
  const c = node.counts;
  const bits = [];
  if (c.modified) bits.push(`${c.modified}≠`);
  if (c['only-left']) bits.push(`${c['only-left']}◄`);
  if (c['only-right']) bits.push(`${c['only-right']}►`);
  if (c.same) bits.push(`${c.same}=`);
  row.innerHTML = `
    <span class="indent"></span>
    <span class="chev">${collapsed ? '▶' : '▼'}</span>
    <span class="icon">📁</span>
    <span class="path"></span>
    <span class="counts"></span>`;
  row.querySelector('.indent').style.width = (depth * 14) + 'px';
  row.querySelector('.path').textContent = node.name || '/';
  row.querySelector('.counts').textContent = bits.join(' ');
  row.onclick = () => {
    if (state.collapsed.has(node.path)) state.collapsed.delete(node.path);
    else state.collapsed.add(node.path);
    renderTree();
  };
  row.addEventListener('contextmenu', (e) => {
    e.stopPropagation();
    showFolderMenu(e, node);
  });
  return row;
}

function mkFileRow(it, depth) {
  const row = document.createElement('div');
  row.className = `row file ${it.status}`;
  if (state.selected === it.path) row.classList.add('selected');
  const sym = { 'only-left': '◄', 'only-right': '►', 'modified': '≠', 'same': '=' }[it.status];
  row.innerHTML = `
    <span class="indent"></span>
    <span class="chev"></span>
    <span class="badge"></span>
    <span class="path"></span>
    <span class="size"></span>`;
  row.querySelector('.indent').style.width = (depth * 14) + 'px';
  row.querySelector('.badge').textContent = sym;
  row.querySelector('.path').textContent = it.oldPath
    ? `${it.oldPath} → ${it.path}`
    : it.path.split('/').pop();
  if (it.oldPath) row.title = `${it.oldPath} → ${it.path}`;
  row.querySelector('.size').textContent = formatSizes(it);
  row.onclick = () => selectItem(it);
  if (state.mode === 'git') {
    row.addEventListener('contextmenu', (e) => {
      e.stopPropagation();
      showFileMenu(e, it);
    });
  }
  return row;
}

function formatSizes(it) {
  if (it.leftSize == null && it.rightSize == null) return '';
  const l = it.leftSize != null ? fmtBytes(it.leftSize) : '—';
  const r = it.rightSize != null ? fmtBytes(it.rightSize) : '—';
  return `${l} / ${r}`;
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024*1024) return (n/1024).toFixed(1) + ' K';
  return (n/1024/1024).toFixed(2) + ' M';
}

async function selectItem(it) {
  state.selected = it.path;
  if (state.mode === 'git') {
    // File tree and commit panel share the highlight; only one wins.
    state.git.selectedCommitFile = null;
    renderTree();
    renderCommits();
    return selectItemGit(it);
  }
  renderTree();
  const res = await window.api.readPair({
    leftRoot: state.left, rightRoot: state.right, relPath: it.path
  });
  renderDiff({
    leftTitle: it.status === 'only-right' ? '(missing)' : it.path,
    rightTitle: it.status === 'only-left' ? '(missing)' : it.path,
    left: res.left, right: res.right,
    leftAbs: it.status === 'only-right' ? null : joinPath(state.left, it.path),
    rightAbs: it.status === 'only-left' ? null : joinPath(state.right, it.path),
    relPath: it.path,
    item: it
  });
}

function joinPath(root, rel) {
  if (!root) return null;
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const r = root.replace(/[\\/]+$/, '');
  return r + sep + rel.replace(/\//g, sep);
}

// ---------- diff (side-by-side) ----------

function renderDiff(payload) {
  const view = $('diff-view');
  view.innerHTML = '';
  state.currentDiff = payload || null;
  state.hunkRows = []; state.changeRows = []; state.hunkIdx = -1;
  state.rows = null;
  state.leftDisp = null; state.rightDisp = null;
  state.leftAbs = payload ? (payload.leftAbs || null) : null;
  state.rightAbs = payload ? (payload.rightAbs || null) : null;
  const editable = editableFlags();
  applyReadonlyHeaders(editable);
  updateToolbar();
  if (!payload) {
    $('diff-title-left').textContent = 'Left';
    $('diff-title-right').textContent = 'Right';
    drawMinimap();
    return;
  }
  $('diff-title-left').textContent = payload.leftTitle || 'Left';
  $('diff-title-right').textContent = payload.rightTitle || 'Right';

  const L = payload.left, R = payload.right;
  if ((L && L.binary) || (R && R.binary)) {
    view.innerHTML = '<div class="notice">Binary file — diff skipped.</div>';
    drawMinimap(); return;
  }
  if ((L && L.tooLarge) || (R && R.tooLarge)) {
    view.innerHTML = '<div class="notice">File exceeds 5 MB — diff skipped.</div>';
    drawMinimap(); return;
  }
  const rawL = L ? L.text : null;
  const rawR = R ? R.text : null;
  if (rawL == null && rawR == null) {
    view.innerHTML = '<div class="notice">No content.</div>';
    drawMinimap(); return;
  }
  // Display = ORIGINAL text (just normalize EOL so line-splitting is consistent).
  // Comparison uses normalized keys, computed per line inside buildRows.
  // If we have a pending edit for this file, render that instead so the user
  // sees their in-progress work after navigating away and back.
  const dirtyL = state.leftAbs && state.dirty.get(state.leftAbs);
  const dirtyR = state.rightAbs && state.dirty.get(state.rightAbs);
  const baseL = dirtyL != null ? dirtyL : rawL;
  const baseR = dirtyR != null ? dirtyR : rawR;
  const leftText = baseL == null ? null : String(baseL).replace(/\r\n?/g, '\n');
  const rightText = baseR == null ? null : String(baseR).replace(/\r\n?/g, '\n');
  if (leftText != null) state.leftDisp = splitLines(leftText);
  if (rightText != null) state.rightDisp = splitLines(rightText);
  if (leftText == null) { renderSideBySide(view, '', rightText, { leftMissing: true, editable }); drawMinimap(); updateDirtyHeader(); return; }
  if (rightText == null) { renderSideBySide(view, leftText, '', { rightMissing: true, editable }); drawMinimap(); updateDirtyHeader(); return; }
  if (textsEqualUnderOptions(leftText, rightText, state.compareOptions)) {
    view.innerHTML = '<div class="notice">Files are identical' +
      (anyCompareOpt(state.compareOptions) ? ' (under current compare options).' : '.') +
      '</div>';
    drawMinimap();
    updateDirtyHeader();
    return;
  }
  renderSideBySide(view, leftText, rightText, { editable });
  collectHunks();
  updateDirtyHeader();
  updateToolbar();
}

function btn(act) { return document.querySelector(`#toolbar button[data-act="${act}"]`); }

// Which panes accept edits. Folder/File mode never set payload.editable, so
// both sides stay editable exactly as before; git mode narrows it.
function editableFlags() {
  const e = state.currentDiff && state.currentDiff.editable;
  return {
    left: !e || e.left !== false,
    right: !e || e.right !== false
  };
}

function applyReadonlyHeaders(ed) {
  document.querySelector('.diff-header-left').classList.toggle('readonly', ed.left === false);
  document.querySelector('.diff-header-right').classList.toggle('readonly', ed.right === false);
}

function updateToolbar() {
  const d = state.currentDiff;
  const hasItem = !!(d && d.item);
  const hasDiff = !!d;
  const hasPaths = !!(state.left && state.right);

  const isGit = state.mode === 'git';
  const g = state.git;
  // A commit-file view is a pair of historical blobs: nothing to swap, nothing
  // to write. It behaves exactly like the "neither side is current" case.
  const isCommitFile = !!(d && d.commitFile);

  btn('swap').disabled = isGit
    ? (isCommitFile || !(g.root && g.base && g.compare))
    : !hasPaths;
  btn('refresh').disabled = !hasDiff;

  const isOnlyLeft = hasItem && d.item.status === 'only-left';
  const isOnlyRight = hasItem && d.item.status === 'only-right';
  // Whole-file copy is a folder-mode idea; there is no destination folder in
  // git mode, so it is always off there.
  btn('copy-to-right').disabled = isGit || !isOnlyLeft;
  btn('copy-to-left').disabled = isGit || !isOnlyRight;

  const ed = editableFlags();
  // In git mode a side only counts when its branch is the checked-out one.
  const hasEditableSide = !isGit ||
    !!((ed.left && state.leftAbs) || (ed.right && state.rightAbs));

  const curHasDirty =
    (state.leftAbs && state.dirty.has(state.leftAbs)) ||
    (state.rightAbs && state.dirty.has(state.rightAbs));
  const histForCurrent = hasItem ? state.history.filter(h => h.itemPath === d.item.path) : [];
  btn('save').disabled = !curHasDirty || !hasEditableSide;
  btn('save-all').disabled = state.dirty.size === 0 || !hasEditableSide;
  btn('revert').disabled = (!curHasDirty && histForCurrent.length === 0) || !hasEditableSide;

  // Always enabled when there are hunks — the buttons compute their target from
  // the scroll position, so "next" past the last just stays put rather than
  // appearing to do nothing because it was greyed out.
  btn('prev-change').disabled = state.hunkRows.length === 0;
  btn('next-change').disabled = state.hunkRows.length === 0;
}

// ---- Copy actions ----

async function doCopy(direction) {
  const d = state.currentDiff;
  if (!d || !d.item) return;
  let src, dst;
  if (direction === 'to-right') { src = d.leftAbs; dst = joinPath(state.right, d.relPath); }
  else { src = d.rightAbs; dst = joinPath(state.left, d.relPath); }
  if (!src || !dst) return;
  const res = await window.api.copyFile({ src, dst });
  if (!res.ok) { alert('Copy failed: ' + res.error); return; }

  const it = d.item;
  // Push history BEFORE mutating the item, so revert can restore it.
  state.history.push({
    itemPath: it.path,
    action: 'copy',
    direction,
    dstAbs: dst,
    prev: { status: it.status, leftSize: it.leftSize, rightSize: it.rightSize }
  });

  const size = direction === 'to-right' ? it.leftSize : it.rightSize;
  it.status = 'same';
  it.leftSize = size; it.rightSize = size;
  rebuildTreePreserveCollapsed();
  await selectItem(it);
}

function rebuildTreePreserveCollapsed() {
  const saved = state.collapsed;
  state.tree = buildTree(state.items);
  state.collapsed = saved;
  renderTree();
}

// ---- Folder context menu ----

let ctxMenuNode = null;

function showFolderMenu(e, node) {
  if (state.mode !== 'folder') return;
  e.preventDefault();
  ctxMenuNode = node;
  const menu = $('folder-ctx-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.remove('hidden');
}

function hideFolderMenu() {
  $('folder-ctx-menu').classList.add('hidden');
  ctxMenuNode = null;
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#folder-ctx-menu')) hideFolderMenu();
  if (!e.target.closest('#file-ctx-menu')) hideFileMenu();
});

$('ctx-refresh-folder').onclick = (e) => {
  e.stopPropagation();
  const node = ctxMenuNode;
  hideFolderMenu();
  if (node) doRefreshFolder(node);
};

// ---- File context menu (git mode) ----

let ctxMenuItem = null;

function showFileMenu(e, it) {
  if (state.mode !== 'git') return;
  e.preventDefault();
  hideFolderMenu();
  ctxMenuItem = it;
  const menu = $('file-ctx-menu');
  menu.style.left = e.clientX + 'px';
  menu.style.top = e.clientY + 'px';
  menu.classList.remove('hidden');
}

function hideFileMenu() {
  $('file-ctx-menu').classList.add('hidden');
  ctxMenuItem = null;
}

$('ctx-file-history').onclick = (e) => {
  e.stopPropagation();
  const it = ctxMenuItem;
  hideFileMenu();
  if (it) showFileHistory(it);
};

$('history-clear').onclick = (e) => {
  e.stopPropagation();
  clearFileHistory();
};

// ---------- commits pane collapse ----------

function setCommitsCollapsed(collapsed) {
  $('commits-pane').classList.toggle('collapsed', collapsed);
  const btn = $('commits-toggle');
  btn.textContent = collapsed ? '▸' : '▾';
  btn.title = collapsed ? 'Show commits' : 'Hide commits';
  localStorage.setItem('commitsCollapsed', collapsed ? '1' : '0');
}

$('commits-pane').querySelector('.pane-header').onclick = () => {
  setCommitsCollapsed(!$('commits-pane').classList.contains('collapsed'));
};

async function doRefreshFolder(node) {
  // Sub-tree rescan reads two folders off disk — meaningless in git mode.
  if (state.mode !== 'folder') return;
  if (!state.left || !state.right) return;
  const prefix = node.path ? node.path + '/' : '';
  const subLeft = node.path ? joinPath(state.left, node.path) : state.left;
  const subRight = node.path ? joinPath(state.right, node.path) : state.right;

  const res = await window.api.compareFolders({
    left: subLeft, right: subRight,
    ignores: state.ignores,
    fileScan: state.fileScan,
    compareOptions: state.compareOptions
  });

  state.items = state.items.filter(it => !it.path.startsWith(prefix));
  for (const it of res.items) {
    state.items.push({ ...it, path: prefix + it.path });
  }

  rebuildTreePreserveCollapsed();
}

// ---- Save / Save All / Revert ----

async function flushPendingTempWrites() {
  // Flush every queued debounce so the temp files reflect the latest edits
  // before we apply or revert.
  const entries = Object.entries(state.saveTimers);
  for (const [abs, entry] of entries) {
    clearTimeout(entry.id);
    delete state.saveTimers[abs];
    const text = state.dirty.get(abs);
    if (text != null) await window.api.tempWrite({ absPath: abs, side: entry.side, text });
  }
}

async function applyDirtyFor(absPath) {
  const side = absPath === state.leftAbs ? 'left'
             : absPath === state.rightAbs ? 'right'
             : null;
  // For Save-All we may be applying a file that isn't currently open; the temp
  // file itself records the side, but applyTemp on main side reads the temp by
  // (absPath, side). For not-currently-open files we don't know the side here,
  // so try both — apply-temp returns ok:true for ENOENT.
  if (side) {
    const r = await window.api.applyTemp({ absPath, side });
    state.dirty.delete(absPath);
    return r;
  }
  let r = await window.api.applyTemp({ absPath, side: 'left' });
  if (!r.ok) r = await window.api.applyTemp({ absPath, side: 'right' });
  state.dirty.delete(absPath);
  return r;
}

async function doSave() {
  const d = state.currentDiff;
  if (!d) return;
  await flushPendingTempWrites();
  const targets = [];
  if (state.leftAbs && state.dirty.has(state.leftAbs)) targets.push(state.leftAbs);
  if (state.rightAbs && state.dirty.has(state.rightAbs)) targets.push(state.rightAbs);
  if (!targets.length) return;
  for (const abs of targets) {
    const res = await applyDirtyFor(abs);
    if (!res.ok) { alert('Save failed for ' + abs + ': ' + res.error); return; }
  }
  await reloadCurrent();
}

async function doSaveAll() {
  await flushPendingTempWrites();
  // Use temp-list as the authoritative set so Save All works even for files
  // edited in a previous session that we haven't navigated to this run.
  const all = await window.api.tempList();
  if (!all.length) { state.dirty.clear(); updateToolbar(); return; }
  for (const t of all) {
    const res = await window.api.applyTemp({ absPath: t.absPath, side: t.side });
    if (!res.ok) { alert('Save failed for ' + t.absPath + ': ' + res.error); }
    state.dirty.delete(t.absPath);
  }
  await reloadCurrent();
}

async function doRevert() {
  const d = state.currentDiff;
  if (!d) return;
  // Prefer reverting in-flight edits first; if none, fall through to the
  // existing copy-action undo stack.
  const dirtyTargets = [];
  if (state.leftAbs && state.dirty.has(state.leftAbs)) dirtyTargets.push(['left', state.leftAbs]);
  if (state.rightAbs && state.dirty.has(state.rightAbs)) dirtyTargets.push(['right', state.rightAbs]);
  if (dirtyTargets.length) {
    for (const [side, abs] of dirtyTargets) {
      if (state.saveTimers[abs]) { clearTimeout(state.saveTimers[abs]); delete state.saveTimers[abs]; }
      state.dirty.delete(abs);
      await window.api.tempDelete({ absPath: abs, side });
    }
    await reloadCurrent();
    return;
  }
  if (!d.item) return;
  const idx = [...state.history].reverse().findIndex(h => h.itemPath === d.item.path);
  if (idx < 0) return;
  const realIdx = state.history.length - 1 - idx;
  const entry = state.history[realIdx];
  state.history.splice(realIdx, 1);

  if (entry.action === 'copy') {
    const res = await window.api.deleteFile({ abs: entry.dstAbs });
    if (!res.ok) { alert('Revert failed: ' + res.error); return; }
    const it = d.item;
    it.status = entry.prev.status;
    it.leftSize = entry.prev.leftSize;
    it.rightSize = entry.prev.rightSize;
    rebuildTreePreserveCollapsed();
    await selectItem(it);
  }
}

async function reloadCurrent() {
  const d = state.currentDiff;
  if (!d) { updateToolbar(); return; }
  if (state.mode === 'git') {
    if (d.commitFile) await selectCommitFile(d.commitFile.commit, d.commitFile.file);
    else if (d.item) await selectItem(d.item);
    updateToolbar();
    return;
  }
  if (d.item) {
    // re-read pair from disk for the currently-selected folder item.
    // Also recompute its status so the tree updates.
    const it = d.item;
    const res = await window.api.readPair({
      leftRoot: state.left, rightRoot: state.right, relPath: it.path
    });
    // crude status update — match disk sizes; folder rescan would be more
    // correct but is heavier. Leaving full rescan as a manual action.
    if (res.left && res.right) {
      const same = (res.left.text || '') === (res.right.text || '');
      it.status = same ? 'same' : 'modified';
      it.leftSize = res.left.size; it.rightSize = res.right.size;
      rebuildTreePreserveCollapsed();
    }
    await selectItem(it);
  } else if (state.mode === 'file' && state.left && state.right) {
    const res = await window.api.compareFiles({ leftPath: state.left, rightPath: state.right });
    renderDiff({
      leftTitle: state.left, rightTitle: state.right,
      left: res.left, right: res.right,
      leftAbs: state.left, rightAbs: state.right
    });
  }
}

// ---- Refresh / Swap ----

async function doRefresh() {
  const d = state.currentDiff;
  if (!d) return;
  if (d.commitFile) {
    await selectCommitFile(d.commitFile.commit, d.commitFile.file);
  } else if (d.item) {
    await selectItem(d.item);
  } else if (state.mode === 'file' && state.left && state.right) {
    const res = await window.api.compareFiles({ leftPath: state.left, rightPath: state.right });
    renderDiff({
      leftTitle: state.left, rightTitle: state.right,
      left: res.left, right: res.right,
      leftAbs: state.left, rightAbs: state.right
    });
  }
}

async function doSwap() {
  if (state.mode === 'git') {
    const g = state.git;
    if (!g.root || !g.base || !g.compare) return;
    [g.base, g.compare] = [g.compare, g.base];
    $('git-base').value = g.base;
    $('git-compare').value = g.compare;
    await runGitCompare();
    return;
  }
  if (!state.left || !state.right) return;
  if (state.history.length || state.dirty.size) {
    if (!confirm('Pending edits and copy actions will be lost on swap. Continue?')) return;
    state.history = [];
    // Drop dirty buffers from memory and delete their temps.
    for (const abs of [...state.dirty.keys()]) {
      // We don't know the side here; try both — temp-delete is idempotent.
      await window.api.tempDelete({ absPath: abs, side: 'left' });
      await window.api.tempDelete({ absPath: abs, side: 'right' });
    }
    state.dirty.clear();
  }
  [state.left, state.right] = [state.right, state.left];
  $('left-path').value = state.left;
  $('right-path').value = state.right;
  await runCompare();
}

// ---- Prev / Next change ----

function collectHunks() {
  const view = $('diff-view');
  const tbl = view.querySelector('.sbs-table');
  state.hunkRows = [];
  state.changeRows = [];
  state.hunkIdx = -1;
  if (!tbl) { drawMinimap(); return; }
  const rows = tbl.querySelectorAll('tbody tr');
  let inHunk = false;
  for (const tr of rows) {
    const cl = tr.classList;
    const isChange = cl.contains('mod') || cl.contains('del') || cl.contains('add');
    if (isChange) {
      state.changeRows.push(tr);
      if (!inHunk) { state.hunkRows.push(tr); inHunk = true; }
    } else {
      inHunk = false;
    }
  }
  drawMinimap();
}

function viewportTopOffset() {
  // Offset within the scrolling container at which we consider "current".
  // Using top + small padding so "next" picks the first hunk visibly below the top.
  return $('diff-view').scrollTop;
}

function findHunkIdxAtScroll() {
  // Index of the last hunk whose offsetTop <= scrollTop, or -1 if none.
  const top = viewportTopOffset();
  let lo = 0, hi = state.hunkRows.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (state.hunkRows[mid].offsetTop <= top) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found;
}

function jumpHunk(delta) {
  if (!state.hunkRows.length) return;
  // Compute target from scroll position so it works even after manual scrolling
  // or when the stored hunkIdx is stale.
  const atScroll = findHunkIdxAtScroll();
  let newIdx;
  if (delta > 0) {
    // Next: first hunk strictly below the current scroll top.
    newIdx = atScroll + 1;
    if (newIdx >= state.hunkRows.length) newIdx = state.hunkRows.length - 1;
  } else {
    // Prev: hunk at or before current scroll top — if we're already on it,
    // go one earlier; if nothing is at/before us, jump to the last one
    // (handles the "cursor past last" case).
    if (atScroll < 0) {
      newIdx = state.hunkRows.length - 1;
    } else if (atScroll === state.hunkIdx) {
      newIdx = Math.max(0, atScroll - 1);
    } else {
      newIdx = atScroll;
    }
  }
  state.hunkIdx = newIdx;
  document.querySelectorAll('.sbs-table tr.current-hunk').forEach(t => t.classList.remove('current-hunk'));
  const row = state.hunkRows[state.hunkIdx];
  row.classList.add('current-hunk');
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  updateToolbar();
}

// ---- Minimap ----

function drawMinimap() {
  const canvas = $('diff-minimap');
  const view = $('diff-view');
  const tbl = view.querySelector('.sbs-table');
  if (!tbl || !state.changeRows.length) {
    canvas.classList.add('empty');
    return;
  }
  canvas.classList.remove('empty');

  const cssW = canvas.clientWidth || 12;
  const cssH = view.clientHeight || canvas.clientHeight || 200;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  canvas.style.height = cssH + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const total = tbl.offsetHeight || 1;
  const colorFor = (tr) =>
    tr.classList.contains('add') ? '#6a9955' :
    tr.classList.contains('del') ? '#f48771' :
    /* mod */                      '#dcdcaa';

  for (const tr of state.changeRows) {
    const y = Math.floor(tr.offsetTop / total * cssH);
    const h = Math.max(2, Math.floor((tr.offsetHeight || 1) / total * cssH));
    ctx.fillStyle = colorFor(tr);
    ctx.fillRect(0, y, cssW, h);
  }

  // viewport indicator
  const vh = Math.max(8, Math.floor(view.clientHeight / total * cssH));
  const vy = Math.floor(view.scrollTop / total * cssH);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, vy + 0.5, cssW - 1, vh - 1);
}

function minimapClick(e) {
  const view = $('diff-view');
  const canvas = $('diff-minimap');
  const tbl = view.querySelector('.sbs-table');
  if (!tbl || canvas.classList.contains('empty')) return;
  const rect = canvas.getBoundingClientRect();
  const yFrac = (e.clientY - rect.top) / rect.height;
  const target = yFrac * tbl.offsetHeight - view.clientHeight / 2;
  view.scrollTop = Math.max(0, target);
}

// ---- Zoom ----

function applyZoom() {
  document.documentElement.style.setProperty('--diff-font-size', state.zoom + 'px');
  $('zoom-pct').textContent = Math.round(state.zoom / 12 * 100) + '%';
  localStorage.setItem('diffZoom', String(state.zoom));
}
function zoomBy(delta) {
  state.zoom = Math.max(8, Math.min(40, state.zoom + delta));
  applyZoom();
}
function zoomReset() { state.zoom = 12; applyZoom(); }

$('diff-view').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

// Redraw minimap and invalidate "current hunk" highlight on manual scroll.
$('diff-view').addEventListener('scroll', () => {
  drawMinimap();
  // If the user scrolled away from the highlighted hunk, drop the highlight
  // so Prev/Next pick up from where they're actually looking.
  if (state.hunkIdx >= 0) {
    const row = state.hunkRows[state.hunkIdx];
    if (row) {
      const view = $('diff-view');
      const top = view.scrollTop;
      const bot = top + view.clientHeight;
      const rt = row.offsetTop;
      const rb = rt + row.offsetHeight;
      if (rb < top || rt > bot) {
        row.classList.remove('current-hunk');
        state.hunkIdx = -1;
        updateToolbar();
      }
    }
  }
});

$('diff-minimap').addEventListener('click', minimapClick);
window.addEventListener('resize', () => drawMinimap());

// ---- Toolbar wiring ----

document.querySelectorAll('#toolbar button[data-act]').forEach(b => {
  b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (a === 'swap') doSwap();
    else if (a === 'refresh') doRefresh();
    else if (a === 'copy-to-left') doCopy('to-left');
    else if (a === 'copy-to-right') doCopy('to-right');
    else if (a === 'save') doSave();
    else if (a === 'save-all') doSaveAll();
    else if (a === 'revert') doRevert();
    else if (a === 'prev-change') jumpHunk(-1);
    else if (a === 'next-change') jumpHunk(1);
    else if (a === 'zoom-in') zoomBy(1);
    else if (a === 'zoom-out') zoomBy(-1);
    else if (a === 'zoom-reset') zoomReset();
  });
});

// ---- Keyboard shortcuts ----

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (e.shiftKey) doSaveAll(); else doSave();
  } else if (e.altKey && e.key === 'ArrowDown') {
    e.preventDefault(); jumpHunk(1);
  } else if (e.altKey && e.key === 'ArrowUp') {
    e.preventDefault(); jumpHunk(-1);
  } else if (e.altKey && e.key === 'ArrowRight') {
    e.preventDefault(); mergeCurrentHunk('to-right');
  } else if (e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault(); mergeCurrentHunk('to-left');
  } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault(); zoomBy(1);
  } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
    e.preventDefault(); zoomBy(-1);
  } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
    e.preventDefault(); zoomReset();
  }
});

// Fill a code cell; when d (a charDiff result) is present, wrap the differing
// middle of the line in a highlight span (Devart-style intra-line diff).
function setCodeCell(td, text, d, which) {
  if (!d) { td.textContent = text; return; }
  const mid = which === 'a' ? d.aMid : d.bMid;
  td.textContent = '';
  if (d.prefix) td.append(text.slice(0, d.prefix));
  if (mid) {
    const span = document.createElement('span');
    span.className = which === 'a' ? 'inline-del' : 'inline-add';
    span.textContent = mid;
    td.append(span);
  }
  if (d.suffix) td.append(text.slice(text.length - d.suffix));
}

function mergeButton(dir, scope) {
  const b = document.createElement('button');
  b.className = 'merge-btn' + (scope === 'block' ? ' block' : '');
  b.dataset.dir = dir;
  b.dataset.scope = scope;
  b.tabIndex = -1;
  if (scope === 'block') {
    b.textContent = dir === 'to-right' ? '»' : '«';
    b.title = dir === 'to-right' ? 'Copy this block to the right file' : 'Copy this block to the left file';
  } else {
    b.textContent = dir === 'to-right' ? '›' : '‹';
    b.title = dir === 'to-right' ? 'Copy this line to the right file' : 'Copy this line to the left file';
  }
  return b;
}

function renderSideBySide(view, leftText, rightText, opts) {
  const rows = buildRows(leftText, rightText, {
    ...opts, compareOptions: state.compareOptions
  });
  state.rows = rows;
  const tbl = document.createElement('table');
  tbl.className = 'sbs-table';
  tbl.innerHTML = `<colgroup>
    <col class="gutter-col"><col class="code-col">
    <col class="merge-col">
    <col class="gutter-col"><col class="code-col">
  </colgroup>`;
  const tbody = document.createElement('tbody');
  // opts.editable is only supplied by git mode; absent = both sides editable.
  const ed = (opts && opts.editable) || {};
  const roLeft = ed.left === false;
  const roRight = ed.right === false;
  const canEditLeft = !!state.leftAbs && !roLeft;
  const canEditRight = !!state.rightAbs && !roRight;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const tr = document.createElement('tr');
    tr.className = r.type;
    tr.dataset.row = String(i);
    const isChange = r.type !== 'eq';
    const hunkStart = isChange && (i === 0 || rows[i - 1].type === 'eq');
    if (hunkStart) tr.classList.add('hunk-start');
    tr.innerHTML = `
      <td class="gutter gutter-left"></td>
      <td class="code code-left"></td>
      <td class="merge"></td>
      <td class="gutter gutter-right"></td>
      <td class="code code-right"></td>`;
    tr.children[0].textContent = r.leftLine;
    tr.children[3].textContent = r.rightLine;
    const d = r.type === 'mod' ? charDiff(r.leftCode, r.rightCode) : null;
    setCodeCell(tr.children[1], r.leftCode, d, 'a');
    setCodeCell(tr.children[4], r.rightCode, d, 'b');
    if (roLeft) tr.children[1].classList.add('readonly');
    if (roRight) tr.children[4].classList.add('readonly');
    if (canEditLeft && r.leftLine !== '') {
      tr.children[1].contentEditable = 'plaintext-only';
      tr.children[1].dataset.side = 'left';
      tr.children[1].dataset.line = String(r.leftLine);
    }
    if (canEditRight && r.rightLine !== '') {
      tr.children[4].contentEditable = 'plaintext-only';
      tr.children[4].dataset.side = 'right';
      tr.children[4].dataset.line = String(r.rightLine);
    }
    if (isChange) {
      const cell = tr.children[2];
      // Line-level merge arrows; block-level double arrows on the first row
      // of each changed block. Only offer a direction when the target file
      // exists on disk (otherwise use the toolbar Copy for whole files).
      if (canEditLeft && canEditRight && hunkStart) {
        cell.appendChild(mergeButton('to-right', 'block'));
        cell.appendChild(mergeButton('to-left', 'block'));
      }
      if (canEditRight) cell.appendChild(mergeButton('to-right', 'line'));
      if (canEditLeft) cell.appendChild(mergeButton('to-left', 'line'));
    }
    tbody.appendChild(tr);
  }
  tbl.appendChild(tbody);
  view.appendChild(tbl);

  tbl.addEventListener('input', onCellInput);
  tbl.addEventListener('click', (e) => {
    const b = e.target.closest('button.merge-btn');
    if (!b) return;
    e.preventDefault();
    const tr = b.closest('tr');
    doMerge(parseInt(tr.dataset.row, 10), b.dataset.dir, b.dataset.scope);
  });
  // Block Enter to keep one displayed row = one source line. Multi-line
  // restructuring would require re-running the diff mid-keystroke.
  tbl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('td.code[contenteditable]')) {
      e.preventDefault();
    }
  });
}

// ---- Line / block merge (Devart-style copy to the other side) ----

// A merge always writes into the *target* side: 'to-left' writes the left
// file, 'to-right' the right one. Refuse when that target is read-only.
function mergeTargetEditable(direction) {
  const ed = editableFlags();
  return direction === 'to-right' ? ed.right : ed.left;
}

function doMerge(rowIdx, direction, scope) {
  if (!state.rows || Number.isNaN(rowIdx)) return;
  if (!mergeTargetEditable(direction)) return;
  const fn = scope === 'block' ? mergeHunk : mergeLine;
  const res = fn(state.rows, rowIdx, direction, state.leftDisp || [], state.rightDisp || []);
  if (!res.changed) return;
  const abs = res.side === 'right' ? state.rightAbs : state.leftAbs;
  if (!abs) return;
  const lines = res.side === 'right' ? res.right : res.left;
  const text = lines.join('\n');
  state.dirty.set(abs, text);
  scheduleTempWrite(abs, res.side, text);
  // Re-render (renderDiff prefers dirty buffers) but keep the scroll position
  // so repeated merges don't bounce the viewport.
  const view = $('diff-view');
  const st = view.scrollTop;
  renderDiff(state.currentDiff);
  view.scrollTop = st;
  drawMinimap();
}

function mergeCurrentHunk(direction) {
  if (!state.hunkRows.length) return;
  if (!mergeTargetEditable(direction)) return;
  // Use the highlighted hunk if there is one, otherwise the hunk at the top
  // of the viewport (same rule Prev/Next use).
  let tr = state.hunkIdx >= 0 ? state.hunkRows[state.hunkIdx] : null;
  if (!tr) {
    const at = findHunkIdxAtScroll();
    tr = state.hunkRows[Math.max(0, at)];
  }
  if (!tr) return;
  doMerge(parseInt(tr.dataset.row, 10), direction, 'block');
}

function onCellInput(e) {
  const td = e.target.closest('td.code[contenteditable]');
  if (!td) return;
  const side = td.dataset.side;
  const lineNum = parseInt(td.dataset.line, 10);
  if (!side || !lineNum) return;
  // Strip any newlines that snuck in via paste — we treat each cell as one line.
  let text = td.textContent;
  if (text.indexOf('\n') >= 0 || text.indexOf('\r') >= 0) {
    text = text.replace(/[\r\n]+/g, ' ');
    // Re-set without disturbing caret if no change was needed.
    if (text !== td.textContent) td.textContent = text;
  }
  const disp = side === 'left' ? state.leftDisp : state.rightDisp;
  if (!disp || lineNum < 1 || lineNum > disp.length) return;
  disp[lineNum - 1] = text;
  td.classList.add('edited');

  const abs = side === 'left' ? state.leftAbs : state.rightAbs;
  if (!abs) return;
  const fullText = disp.join('\n');
  state.dirty.set(abs, fullText);
  scheduleTempWrite(abs, side, fullText);
  updateDirtyHeader();
  updateToolbar();
}

function scheduleTempWrite(absPath, side, text) {
  const prev = state.saveTimers[absPath];
  if (prev) clearTimeout(prev.id);
  const id = setTimeout(() => {
    delete state.saveTimers[absPath];
    window.api.tempWrite({ absPath, side, text }).catch(() => {});
  }, 250);
  state.saveTimers[absPath] = { id, side };
}

function updateDirtyHeader() {
  const d = state.currentDiff;
  if (!d) return;
  const lDirty = state.leftAbs && state.dirty.has(state.leftAbs);
  const rDirty = state.rightAbs && state.dirty.has(state.rightAbs);
  $('diff-title-left').textContent = (lDirty ? '● ' : '') + (d.leftTitle || 'Left');
  $('diff-title-right').textContent = (rDirty ? '● ' : '') + (d.rightTitle || 'Right');
}

// ---------- settings modal ----------

function openSettings() {
  $('ignore-list').value = state.ignores.join('\n');
  $('opt-ws').checked = !!state.compareOptions.ignoreWhitespace;
  $('opt-comments').checked = !!state.compareOptions.ignoreComments;
  $('opt-lb').checked = !!state.compareOptions.ignoreLineBreaks;
  syncFileScanUI();
  $('config-status').textContent = '';
  $('settings-modal').classList.remove('hidden');
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

$('settings-btn').onclick = openSettings;
$('settings-close').onclick = closeSettings;
document.querySelector('.modal-backdrop').onclick = closeSettings;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('settings-modal').classList.contains('hidden')) closeSettings();
});

// Tabs
document.querySelectorAll('.modal-tabs .tab').forEach(btn => {
  btn.onclick = () => {
    state.activeTab = btn.dataset.tab;
    document.querySelectorAll('.modal-tabs .tab').forEach(b =>
      b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab-panel').forEach(p =>
      p.classList.toggle('active', p.id === 'tab-' + state.activeTab));
  };
});

$('settings-save').onclick = async () => {
  const ignores = $('ignore-list').value.split('\n').map(s => s.trim()).filter(Boolean);
  state.ignores = ignores;
  state.compareOptions = {
    ignoreWhitespace: $('opt-ws').checked,
    ignoreComments: $('opt-comments').checked,
    ignoreLineBreaks: $('opt-lb').checked
  };
  if (!state.fileScan.groups.some(g => g.name === state.fileScan.activeGroup)) {
    state.fileScan.activeGroup = '';
  }
  await window.api.saveConfig({
    ignores,
    fileScan: state.fileScan,
    compareOptions: state.compareOptions
  });
  $('config-status').textContent = 'Saved.';
  // re-render current diff so the new options take effect immediately
  if (state.currentDiff) renderDiff(state.currentDiff);
  setTimeout(closeSettings, 600);
};

$('settings-reset').onclick = async () => {
  if (state.activeTab === 'ignore') {
    $('ignore-list').value = DEFAULT_IGNORES.join('\n');
  } else if (state.activeTab === 'general') {
    $('opt-ws').checked = false;
    $('opt-comments').checked = false;
    $('opt-lb').checked = false;
  } else {
    await window.api.saveConfig({ fileScan: null });
    const fresh = await window.api.loadConfig();
    state.fileScan = fresh.fileScan;
    state.selectedGroupIdx = state.fileScan.groups.length ? 0 : -1;
    syncFileScanUI();
  }
};

// ---------- file-scan UI ----------

function syncFileScanUI() {
  // active-group dropdown
  const sel = $('active-group');
  sel.innerHTML = '<option value="">(none — scan all files)</option>';
  for (const g of state.fileScan.groups) {
    const opt = document.createElement('option');
    opt.value = g.name; opt.textContent = g.name;
    if (g.name === state.fileScan.activeGroup) opt.selected = true;
    sel.appendChild(opt);
  }

  // groups list
  const list = $('groups-list');
  list.innerHTML = '';
  state.fileScan.groups.forEach((g, i) => {
    const item = document.createElement('div');
    item.className = 'group-item' + (i === state.selectedGroupIdx ? ' selected' : '');
    item.innerHTML = `<span class="gname"></span><span class="pcount"></span>`;
    item.querySelector('.gname').textContent = g.name;
    item.querySelector('.pcount').textContent = `${g.patterns.length}`;
    item.onclick = () => { state.selectedGroupIdx = i; syncFileScanUI(); };
    list.appendChild(item);
  });

  // editor
  const idx = state.selectedGroupIdx;
  const has = idx >= 0 && idx < state.fileScan.groups.length;
  $('group-name').disabled = !has;
  $('group-patterns').disabled = !has;
  $('group-delete').disabled = !has;
  if (has) {
    const g = state.fileScan.groups[idx];
    $('group-name').value = g.name;
    $('group-patterns').value = g.patterns.join('\n');
  } else {
    $('group-name').value = '';
    $('group-patterns').value = '';
  }
}

$('active-group').onchange = (e) => {
  state.fileScan.activeGroup = e.target.value;
};

$('group-name').addEventListener('input', (e) => {
  const idx = state.selectedGroupIdx;
  if (idx < 0) return;
  const oldName = state.fileScan.groups[idx].name;
  const newName = e.target.value;
  state.fileScan.groups[idx].name = newName;
  if (state.fileScan.activeGroup === oldName) state.fileScan.activeGroup = newName;
  // refresh dropdown only (avoid rebuilding the list while typing in the editor)
  const sel = $('active-group');
  const cur = sel.value;
  sel.innerHTML = '<option value="">(none — scan all files)</option>';
  for (const g of state.fileScan.groups) {
    const opt = document.createElement('option');
    opt.value = g.name; opt.textContent = g.name;
    sel.appendChild(opt);
  }
  sel.value = state.fileScan.activeGroup || cur;
  // also update the name in the list item without full rebuild
  const items = $('groups-list').children;
  if (items[idx]) items[idx].querySelector('.gname').textContent = newName;
});

$('group-patterns').addEventListener('input', (e) => {
  const idx = state.selectedGroupIdx;
  if (idx < 0) return;
  state.fileScan.groups[idx].patterns = e.target.value
    .split('\n').map(s => s.trim()).filter(Boolean);
  const items = $('groups-list').children;
  if (items[idx]) items[idx].querySelector('.pcount').textContent =
    state.fileScan.groups[idx].patterns.length;
});

$('group-new').onclick = () => {
  let n = 1, base = 'New group', name = base;
  const names = new Set(state.fileScan.groups.map(g => g.name));
  while (names.has(name)) name = `${base} ${++n}`;
  state.fileScan.groups.push({ name, patterns: [] });
  state.selectedGroupIdx = state.fileScan.groups.length - 1;
  syncFileScanUI();
  $('group-name').focus();
  $('group-name').select();
};

$('group-delete').onclick = () => {
  const idx = state.selectedGroupIdx;
  if (idx < 0) return;
  const removed = state.fileScan.groups[idx].name;
  state.fileScan.groups.splice(idx, 1);
  if (state.fileScan.activeGroup === removed) state.fileScan.activeGroup = '';
  state.selectedGroupIdx = Math.min(idx, state.fileScan.groups.length - 1);
  syncFileScanUI();
};

// ---------- resizer ----------

(function setupResizer() {
  const resizer = $('resizer');
  const main = $('main-folder');
  const MIN = 160, MAX_FRACTION = 0.7;
  let dragging = false;

  // restore persisted width
  const saved = parseInt(localStorage.getItem('treeWidth') || '', 10);
  if (saved && saved >= MIN) main.style.setProperty('--tree-width', saved + 'px');

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const maxW = Math.floor(window.innerWidth * MAX_FRACTION);
    const w = Math.max(MIN, Math.min(maxW, e.clientX));
    main.style.setProperty('--tree-width', w + 'px');
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
    const cur = getComputedStyle(main).getPropertyValue('--tree-width').trim();
    const px = parseInt(cur, 10);
    if (px) localStorage.setItem('treeWidth', String(px));
  });
})();

// ---------- init ----------

(async function init() {
  setCommitsCollapsed(localStorage.getItem('commitsCollapsed') === '1');

  const savedZoom = parseInt(localStorage.getItem('diffZoom') || '', 10);
  if (savedZoom >= 8 && savedZoom <= 40) state.zoom = savedZoom;
  applyZoom();

  const cfg = await window.api.loadConfig();
  state.ignores = cfg.ignores;
  state.fileScan = cfg.fileScan || { activeGroup: '', groups: [] };
  state.selectedGroupIdx = state.fileScan.groups.length ? 0 : -1;
  state.compareOptions = cfg.compareOptions || { ignoreWhitespace: false, ignoreComments: false, ignoreLineBreaks: false };
  state.recent = cfg.recent || [];
  if (cfg.lastMode && cfg.lastMode !== 'git') {
    state.mode = cfg.lastMode;
    $('mode-folder').classList.toggle('active', state.mode === 'folder');
    $('mode-file').classList.toggle('active', state.mode === 'file');
    $('main-folder').classList.toggle('file-mode', state.mode === 'file');
  }
  if (cfg.lastLeft) { state.left = cfg.lastLeft; $('left-path').value = cfg.lastLeft; }
  if (cfg.lastRight) { state.right = cfg.lastRight; $('right-path').value = cfg.lastRight; }

  // Hydrate in-memory dirty buffers from .temp/ so Save All / indicators work
  // immediately after a restart.
  try {
    const temps = await window.api.tempList();
    for (const t of temps) {
      const r = await window.api.tempRead({ absPath: t.absPath, side: t.side });
      if (r && typeof r.text === 'string') state.dirty.set(t.absPath, r.text);
    }
  } catch {}

  renderTree();
  updateToolbar();
})();
