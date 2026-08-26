// Enforce the DIRECTION a baseline is allowed to move.
//
// `.forge/conformance.json` declares `improves` per axis — down / shrink /
// tighten — and until now nothing read it. `baselineFault` checked only that the
// word was one of the three legal ones, so `--update-baseline` could re-freeze any
// baseline larger than it was and every gate stayed green. The manifest's own
// comment says a rule a re-freeze can silently drop is not a rule; this is the
// reader that makes it one.
//
// Measured on this repo: the codemap baseline went 13304 -> 13413 frozen comments
// on a re-freeze over 29 rebased files, which `improves: shrink` forbids, and
// nothing anywhere went red.

import { execFileSync } from 'node:child_process';

const DIRECTIONS = ['down', 'shrink', 'tighten'];

// cm:guard STRICTNESS ORDER, not alphabetical — `tighten` compares against this, so a status
// missing here reads as index -1 and every transition into it looks like loosening.
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
// cm:guard the HEAD~1 fallback is the whole point. The prose gate carried exactly this bug — `--since $(git merge-base origin/main HEAD)` scoped to an empty diff on every push to main, printed its success line over zero files, and let 15 violations through. A ratchet whose base can equal its subject is that same fail-open shape.
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
  } catch {
    // cm:why swallowed on purpose — a shallow or detached checkout has no origin/main, and the HEAD~1 fallback below is the answer for it rather than an error
  }
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

// cm:guard the AREA a key belongs to, and the `::` split is load-bearing — a key is `<path>::<rule>` once `counts` flattens a nested baseline, so splitting the whole key would make every rule its own area and the total check would compare one number against itself. Fewer than two segments collapses to the root area on purpose: `.arch.baseline.json`'s keys all reduce to `frozen`, so they stay one area and its ratchet is unchanged.
function area(key) {
  const seg = key.split('::')[0].split('/');
  return seg.length >= 2 ? `${seg[0]}/${seg[1]}` : '';
}

// cm:guard TOTAL first, per-key second — and renames are why. A path-keyed baseline re-freezes a moved file under its new key, so "no new keys" fails every rename and a rule that fires on renames is a rule someone turns off. A total that may not rise cannot be gamed: debt has to leave for debt to arrive.
// cm:guard the total is per AREA, and only over areas the base revision already had, because a total over EVERY key made widening a baseline's scope impossible: registering `packages/core` on check-lint-budget takes .forge/lint-baseline.json from 216 frozen to ~496 and `improves: down` rejected it, so the manifest's promise that declaring a new rule is never punished was false for any checker sharing an existing baseline file. New debt on a new FILE inside a covered area still raises that area's total and still fails, which is the anti-gaming property the guard above is about.
function compareDown(before, now) {
  const b = counts(before);
  const n = counts(now);
  const covered = new Set([...b.keys()].map(area));
  // cm:guard an EMPTY previous baseline covers everything, never nothing. `covered` is derived from the base revision's keys, so an empty one would exempt every area and turn a first fill of `{files:{}}` into an accept-anything pass — the fail-open shape this file exists to close, arrived at by making it stricter elsewhere.
  const scoped = (k) => covered.size === 0 || covered.has(area(k));
  const sum = (m) => [...m].reduce((a, [k, v]) => (scoped(k) ? a + v : a), 0);
  const faults = [];
  const [tb, tn] = [sum(b), sum(n)];
  if (tn > tb) faults.push(`frozen total rose ${tb} -> ${tn}`);
  for (const [k, v] of n) {
    const was = b.get(k);
    if (was !== undefined && v > was) faults.push(`${k}: ${was} -> ${v}`);
  }
  return faults;
}

function compareShrink(before, now) {
  const b = members(before);
  const n = members(now);
  // cm:guard counts EVERY entry, including codemap's `b:`-prefixed block hashes, so this number is deliberately larger than `cm doctor`'s comment count — it is a relative measure and dropping the duplicates would hide growth that lands only in them
  return n.size > b.size ? [`frozen entries grew ${b.size} -> ${n.size}`] : [];
}

// cm:guard a contract that DISAPPEARS is loosening, not tidying: the graph it constrained is now unconstrained, which is the same outcome as flipping it to draft and reads as progress in a diff.
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
  // cm:guard read HEAD, never the working tree. An uncommitted --update-baseline is a local edit nobody else can see; judging it would make this fail on a diff a contributor is still writing, and CI would then disagree with the machine it ran on.
  if (now === null) return `${decl.path} is declared but unreadable at HEAD`;
  const faults = COMPARE[decl.improves](before, now);
  if (faults.length === 0) return null;
  const shown = faults.slice(0, 3).join(' · ');
  const more = faults.length > 3 ? ` (+${faults.length - 3} more)` : '';
  return `${decl.path} moved against improves=${decl.improves}: ${shown}${more}`;
}
