// Reads the git branch and status of a workspace (like Herdr's "master *").

const { execFile } = require('child_process');

const cache = new Map(); // folder -> { at, info, pending }
const TTL_MS = 8000;

function parse(out) {
  const lines = out.split('\n').filter(Boolean);
  const head = lines[0] || '';
  // "## main...origin/main [ahead 1, behind 2]", "## No commits yet on main" or "## HEAD (no branch)"
  const m = head.match(/^## (?:No commits yet on )?([^.\s]+)(?:\.\.\.\S+)?(?: \[(.*)\])?/);
  if (!m) return null;
  const branch = m[1] === 'HEAD' ? 'detached HEAD' : m[1];
  const ahead = Number((m[2] || '').match(/ahead (\d+)/)?.[1] || 0);
  const behind = Number((m[2] || '').match(/behind (\d+)/)?.[1] || 0);
  return { branch, dirty: lines.length > 1, ahead, behind };
}

function refresh(cwd) {
  const entry = cache.get(cwd) || { at: 0, info: null, pending: false };
  if (entry.pending) return;
  entry.pending = true;
  cache.set(cwd, entry);
  execFile('git', ['status', '--porcelain=v1', '-b'], { cwd, timeout: 3000, windowsHide: true }, (err, stdout) => {
    entry.pending = false;
    entry.at = Date.now();
    entry.info = err ? null : parse(stdout);
  });
}

/** Returns the cached info immediately and refreshes it in the background when stale. */
function gitInfo(cwd) {
  const entry = cache.get(cwd);
  if (!entry || Date.now() - entry.at > TTL_MS) refresh(cwd);
  return entry?.info || null;
}

module.exports = { gitInfo };
