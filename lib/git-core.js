// Git-facing logic. Shells out to the `git` binary with execFile (never a
// shell) so nothing user-supplied can be interpreted as a command. No Electron
// dependency so it can be unit-tested directly against throwaway repositories.
const { execFile } = require('child_process');
const path = require('path');
const { MAX_DIFF_BYTES, BINARY_SNIFF_BYTES } = require('./fs-core.js');

const MAX_GIT_BUFFER = 32 * 1024 * 1024;
const REC_SEP = '\x1e';
const LOG_FORMAT = '%H%x00%h%x00%s%x00%an%x00%aI%x00%P' + '%x1e';
const DEFAULT_LOG_LIMIT = 200;
// A grep that looks like an abbreviated sha also matches commits by sha prefix.
const HEX_PREFIX_RE = /^[0-9a-f]{4,40}$/i;

function gitError(args, err, stderr) {
  const detail = String(stderr || (err && err.message) || '').trim();
  const e = new Error(detail || `git ${args.join(' ')} failed`);
  e.gitArgs = args;
  if (err && err.code !== undefined) e.code = err.code;
  return e;
}

// Resolves { stdout, stderr } with stdout as Buffer; rejects with git's stderr.
function run(root, args, { allowFailure = false } = {}) {
  const full = ['-c', 'core.quotepath=false', ...args];
  return new Promise((resolve, reject) => {
    execFile('git', full, {
      cwd: root || undefined,
      maxBuffer: MAX_GIT_BUFFER,
      encoding: 'buffer',
      windowsHide: true
    }, (err, stdout, stderr) => {
      const out = stdout || Buffer.alloc(0);
      const errText = (stderr || Buffer.alloc(0)).toString('utf8');
      if (err && !allowFailure) return reject(gitError(full, err, errText));
      resolve({ stdout: out, stderr: errText, failed: !!err });
    });
  });
}

async function runText(root, args, opts) {
  const r = await run(root, args, opts);
  return { ...r, stdout: r.stdout.toString('utf8') };
}

let gitProbe = null;
async function hasGit() {
  if (gitProbe === null) {
    gitProbe = run(null, ['--version'], { allowFailure: true })
      .then((r) => !r.failed)
      .catch(() => false);
  }
  return gitProbe;
}

// Test seam: forget the cached probe result.
function resetGitProbe() { gitProbe = null; }

async function repoRoot(dir) {
  if (!dir) return null;
  try {
    const { stdout, failed } = await runText(dir, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (failed) return null;
    const root = stdout.trim();
    // git always prints forward slashes; hand back the platform's own
    // separator so this root compares equal to a dialog-picked path.
    return root ? path.normalize(root) : null;
  } catch {
    return null;
  }
}

async function currentBranch(root) {
  const { stdout, failed } = await runText(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFailure: true });
  if (failed) return null; // detached HEAD
  return stdout.trim() || null;
}

async function listBranches(root) {
  const { stdout } = await runText(root, ['branch', '--format=%(refname:short)%00%(HEAD)']);
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name, marker] = line.split('\0');
    if (!name) continue;
    out.push({ name, current: (marker || '').trim() === '*' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function mapStatus(letter) {
  switch (letter) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'M': return 'modified';
    case 'R': return 'renamed';
    default: return 'modified'; // C (copy), T (type change), U, X...
  }
}

// Parses `--name-status -z` output: STATUS NUL PATH NUL, with renames/copies
// emitting STATUS NUL OLDPATH NUL NEWPATH NUL.
function parseNameStatusZ(text) {
  const tokens = text.split('\0').filter((t) => t !== '');
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const field = tokens[i++].replace(/^[\r\n]+/, '');
    if (!field) continue;
    const letter = field[0].toUpperCase();
    const twoPaths = letter === 'R' || letter === 'C';
    const first = tokens[i++];
    if (first === undefined) break;
    if (twoPaths) {
      const second = tokens[i++];
      if (second === undefined) break;
      const entry = { path: second, status: mapStatus(letter) };
      if (letter === 'R') entry.oldPath = first;
      out.push(entry);
    } else {
      out.push({ path: first, status: mapStatus(letter) });
    }
  }
  return out;
}

async function diffNameStatus(root, base, compare) {
  const { stdout } = await runText(root, ['diff', '--name-status', '-z', '-M', base, compare]);
  return parseNameStatusZ(stdout);
}

async function commitFiles(root, sha) {
  const { stdout } = await runText(root, ['show', '--name-status', '-z', '-M', '--format=', sha]);
  return parseNameStatusZ(stdout);
}

async function parentOf(root, sha) {
  const { stdout } = await runText(root, ['log', '-1', '--format=%P', sha]);
  const parents = stdout.trim().split(/\s+/).filter(Boolean);
  return parents.length ? parents[0] : null;
}

async function showFile(root, ref, filePath) {
  const spec = `${ref}:${filePath}`;
  const sizeRes = await runText(root, ['cat-file', '-s', spec], { allowFailure: true });
  if (sizeRes.failed) {
    // Missing path at an existing ref is a normal "no such file" answer; a bad
    // ref is a real error the caller should see.
    const refOk = await run(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFailure: true });
    if (refOk.failed) throw gitError(['cat-file', '-s', spec], null, sizeRes.stderr);
    return null;
  }
  const size = Number(sizeRes.stdout.trim());
  if (!Number.isFinite(size)) return null;
  if (size > MAX_DIFF_BYTES) return { binary: false, tooLarge: true, size, text: '' };
  const { stdout } = await run(root, ['show', spec]);
  const sniff = stdout.subarray(0, Math.min(BINARY_SNIFF_BYTES, stdout.length));
  if (sniff.includes(0)) return { binary: true, tooLarge: false, size, text: '' };
  return { binary: false, tooLarge: false, size, text: stdout.toString('utf8') };
}

function parseLog(text) {
  const out = [];
  for (const raw of text.split(REC_SEP)) {
    const rec = raw.replace(/^[\r\n]+/, '');
    if (!rec.trim()) continue;
    const [sha, short, subject, author, date, parents] = rec.split('\0');
    if (!sha) continue;
    out.push({
      sha,
      short: short || sha.slice(0, 7),
      subject: subject || '',
      author: author || '',
      date: date || '',
      parents: (parents || '').trim().split(/\s+/).filter(Boolean)
    });
  }
  return out;
}

function buildLogArgs({ ref, grep, author, pickaxe, path: filePath, skip, limit }) {
  const args = ['log', `--format=${LOG_FORMAT}`, '-n', String(limit)];
  if (skip) args.push(`--skip=${skip}`);
  if (pickaxe) {
    // Pickaxe and message grep are mutually exclusive by contract.
    args.push(`-S${pickaxe}`);
  } else if (grep) {
    args.push('--fixed-strings', '--regexp-ignore-case', `--grep=${grep}`);
  }
  if (author) args.push(`--author=${author}`);
  args.push(ref);
  if (filePath) args.push('--follow', '--', filePath);
  return args;
}

async function log(root, opts = {}) {
  const ref = opts.ref || 'HEAD';
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_LOG_LIMIT;
  const skip = Number.isFinite(opts.skip) && opts.skip > 0 ? Math.floor(opts.skip) : 0;
  const grep = opts.grep ? String(opts.grep) : '';
  const base = { ref, grep, author: opts.author, pickaxe: opts.pickaxe, path: opts.path, skip, limit };

  const primary = parseLog((await runText(root, buildLogArgs(base))).stdout);

  // A hex-looking grep should also find the commit by sha prefix. Only merged
  // on the first page so pagination stays stable.
  const wantsShaMatch = !opts.pickaxe && grep && HEX_PREFIX_RE.test(grep) && skip === 0;
  if (!wantsShaMatch) return primary;

  // Scan the whole history of the ref (cheap: shas only), so an old commit
  // is found by prefix even when it is far past the first page.
  const revArgs = ['rev-list', ref];
  if (opts.path) revArgs.push('--', opts.path);
  const prefix = grep.toLowerCase();
  const matchShas = (await runText(root, revArgs)).stdout
    .split(/\s+/)
    .filter((sha) => sha && sha.toLowerCase().startsWith(prefix))
    .slice(0, limit);
  const shaHits = matchShas.length
    ? parseLog((await runText(root, ['log', `--format=${LOG_FORMAT}`, '--no-walk', ...matchShas])).stdout)
    : [];
  if (!shaHits.length) return primary;

  const seen = new Set();
  const merged = [];
  for (const c of [...primary, ...shaHits]) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    merged.push(c);
  }
  // Array#sort is stable, so equal timestamps keep git's own ordering.
  merged.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return merged.slice(0, limit);
}

module.exports = {
  MAX_GIT_BUFFER,
  DEFAULT_LOG_LIMIT,
  hasGit,
  resetGitProbe,
  repoRoot,
  currentBranch,
  listBranches,
  diffNameStatus,
  showFile,
  log,
  commitFiles,
  parentOf,
  parseNameStatusZ,
  parseLog
};
