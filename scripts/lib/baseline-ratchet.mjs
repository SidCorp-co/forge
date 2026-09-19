import { execFileSync } from 'node:child_process';

const DIRECTIONS = ['down', 'shrink', 'tighten'];

const STRICTNESS = ['draft', 'locked'];

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * The revision this baseline is judged against.
 *
 * Not `origin/main` directly: on a branch that is what the diff is measured from, but a
 * commit pushed STRAIGHT to main has `origin/main` equal to HEAD, and comparing a file to
 * itself passes everything.
 */
export function baseRev(root) {
  let head;
  try {
    head = git(['rev-parse', 'HEAD'], root);
  } catch {
    return null;
  }
  try {
    const mb = git(['merge-base', 'origin/main', 'HEAD'], root);
    if (mb && mb !== head) return mb;
  } catch {}
  try {
    return git(['rev-parse', 'HEAD~1'], root);
  } catch {
    return null;
  }
}

function readAt(root, rev, path) {
  try {
    return JSON.parse(git(['show', `${rev}:${path}`], root));
  } catch {
    return null;
  }
}

/** `{files: {path: {rule: n}}}`, `{files: {path: n}}` and a bare `{path: n}` all flatten the same. */
function counts(doc) {
  const files = doc?.files ?? doc;
  const out = new Map();
  if (!files || typeof files !== 'object') return out;
  for (const [path, v] of Object.entries(files)) {
    if (typeof v === 'number') out.set(path, v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [rule, n] of Object.entries(v)) {
        if (typeof n === 'number') out.set(`${path}::${rule}`, n);
      }
    }
  }
  return out;
}

/** A set of frozen members: `{path: [hash]}` and `{uncovered: [step]}` both reduce to one. */
function members(doc) {
  const out = new Set();
  if (!doc || typeof doc !== 'object') return out;
  if (Array.isArray(doc.uncovered)) {
    for (const s of doc.uncovered) out.add(String(s));
    return out;
  }
  for (const [path, v] of Object.entries(doc)) {
    if (Array.isArray(v)) for (const m of v) out.add(`${path}::${m}`);
  }
  return out;
}

/** `.arch.json`'s contracts, as id -> status. */
function statuses(doc) {
  const out = new Map();
  for (const c of doc?.contracts ?? []) {
    if (c?.id) out.set(c.id, String(c.status ?? 'draft'));
  }
  return out;
}

function area(key) {
  const seg = key.split('::')[0].split('/');
  return seg.length >= 2 ? `${seg[0]}/${seg[1]}` : '';
}

/** Per-area totals over a flattened baseline, restricted to the areas in `only` when given. */
function areaTotals(m, only) {
  const out = new Map();
  for (const [k, v] of m) {
    const a = area(k);
    if (only && !only.has(a)) continue;
    out.set(a, (out.get(a) ?? 0) + v);
  }
  return out;
}

function compareDown(before, now) {
  const b = counts(before);
  const n = counts(now);
  const covered = new Set([...b.keys()].map(area));
  const only = covered.size === 0 ? null : covered;
  const wasBy = areaTotals(b, only);
  const nowBy = areaTotals(n, only);
  const faults = [];
  for (const [a, tn] of nowBy) {
    const tb = wasBy.get(a) ?? 0;
    if (tn > tb) faults.push(`frozen total for ${a || '.'} rose ${tb} -> ${tn}`);
  }
  for (const [k, v] of n) {
    const was = b.get(k);
    if (was !== undefined && v > was) faults.push(`${k}: ${was} -> ${v}`);
  }
  return faults;
}

function compareShrink(before, now) {
  const b = members(before);
  const n = members(now);
  return n.size > b.size ? [`frozen entries grew ${b.size} -> ${n.size}`] : [];
}

function compareTighten(before, now) {
  const b = statuses(before);
  const n = statuses(now);
  const faults = [];
  for (const [id, was] of b) {
    const is = n.get(id);
    if (is === undefined) {
      faults.push(`${id}: ${was} -> removed`);
    } else if (STRICTNESS.indexOf(is) < STRICTNESS.indexOf(was)) {
      faults.push(`${id}: ${was} -> ${is}`);
    }
  }
  return faults;
}

const COMPARE = { down: compareDown, shrink: compareShrink, tighten: compareTighten };

/** The direction check over two parsed baselines. Exported so it is testable without a git tree. */
export function compareBaseline(improves, before, now) {
  const cmp = COMPARE[improves];
  if (!cmp) return [`unknown direction ${improves}`];
  return cmp(before, now);
}

/**
 * Judge one declared baseline against the same file at `rev`.
 *
 * Returns `null` when the direction holds, a reason string when it does not, and
 * `null` when there is nothing to compare against — a baseline the base revision
 * never had is a new baseline, which is progress rather than regression.
 */
export function ratchetFault(root, rev, decl) {
  if (!rev || !decl?.path || !DIRECTIONS.includes(decl.improves)) return null;
  const before = readAt(root, rev, decl.path);
  if (before === null) return null;
  const now = readAt(root, 'HEAD', decl.path);
  if (now === null) return `${decl.path} is declared but unreadable at HEAD`;
  const faults = COMPARE[decl.improves](before, now);
  if (faults.length === 0) return null;
  const shown = faults.slice(0, 3).join(' · ');
  const more = faults.length > 3 ? ` (+${faults.length - 3} more)` : '';
  return `${decl.path} moved against improves=${decl.improves}: ${shown}${more}`;
}
