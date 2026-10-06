import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { baseRef } from './base-branch.mjs';

const DIRECTIONS = ['down', 'shrink', 'tighten'];

const STRICTNESS = ['draft', 'locked'];

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

const COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NO_COMMIT = /^0+$/;

/**
 * The tip a push event moved its branch from, read from `$GITHUB_EVENT_PATH`. A push carrying
 * several commits is one change and is judged against that tip: `HEAD~1` sees only the last of
 * them, so an entry withdrawn earlier in the push passed and one reworded inside it read as
 * withdrawn. Null for any other event, and for a push that created its branch.
 */
export function pushedFrom(root, env, head) {
  if (env.GITHUB_EVENT_NAME !== 'push') return null;
  const path = String(env.GITHUB_EVENT_PATH ?? '').trim();
  let payload;
  try {
    if (!path) throw new Error('$GITHUB_EVENT_PATH is unset');
    payload = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `a push event's payload at ${path || '$GITHUB_EVENT_PATH'} could not be read (${err.message}), ` +
        'so the tip this push moved its branch from is unknown and no base can be taken from it',
    );
  }
  const before = payload?.before;
  if (typeof before !== 'string' || !COMMIT.test(before)) {
    throw new Error(
      `a push event's payload at ${path} names no commit as \`before\` ` +
        `(${JSON.stringify(before ?? null)}), so the tip this push moved its branch from is unknown`,
    );
  }
  if (NO_COMMIT.test(before) || before === head) return null;
  try {
    git(['merge-base', '--is-ancestor', before, 'HEAD'], root);
  } catch {
    throw new Error(
      `this push moved its branch from ${before}, which is not an ancestor of HEAD ${head} or is ` +
        'absent from this clone. A shallow clone is fixed by checking out with `fetch-depth: 0`. ' +
        'A force-push has no base to measure it against, and re-running will not give it one; the ' +
        'next ordinary push to this branch carries a `before` that is its ancestor',
    );
  }
  return before;
}

const NONE = Object.freeze({ rev: null, basis: null, refusal: null });

function refused(refusal) {
  return { rev: null, basis: null, refusal };
}

/** What each `basis` is, in the words a reader of a gate's log needs. */
export const BASIS = Object.freeze({
  'merge-base': 'the merge-base with the merge target',
  push: "the tip this push moved its branch from (the payload's `before`)",
  parent: 'HEAD~1, the commit before this one',
});

/**
 * The revision this baseline is judged against: the merge-base with the branch this work will land
 * on, or, where that is `HEAD` itself, the tip a push moved the branch from.
 *
 * Not that branch's tip directly: a commit pushed STRAIGHT to the base branch has the tip equal to
 * HEAD, and comparing a file to itself passes everything. `HEAD~1` is left only for a checkout
 * standing on its merge target's tip outside a push, whose last commit was judged when it landed,
 * and for the push that creates its branch, whose commits were judged where they were cut from.
 * A merge target that cannot be derived or names no ref here, and a push whose base cannot be
 * read, are a refusal: `HEAD~1` there would judge one commit of a branch of many and say nothing.
 *
 * No form returns the revision alone: a reader holding only that cannot tell a refused base from a
 * shallow clone, and says the wrong one.
 *
 * @returns {{ rev: string | null, basis: 'merge-base' | 'push' | 'parent' | null,
 *   refusal: string | null }} `basis` names the rung `rev` came from; `rev` null with no refusal
 *   only where HEAD or its parent does not exist
 */
export function baseRevision(root, env = process.env) {
  let head;
  try {
    head = git(['rev-parse', 'HEAD'], root);
  } catch {
    return NONE;
  }
  const target = baseRef(root, env);
  if (target.refusal) return refused(target.refusal);
  let mb;
  try {
    mb = git(['merge-base', target.ref, 'HEAD'], root);
  } catch {
    return refused(
      `\`git merge-base ${target.ref} HEAD\` found no common ancestor, so this checkout holds no ` +
        `revision where the change began. Fetch the history: \`git fetch origin ${target.branch}\`, ` +
        'or check out with `fetch-depth: 0`',
    );
  }
  if (mb !== head) return { rev: mb, basis: 'merge-base', refusal: null };
  try {
    const pushed = pushedFrom(root, env, head);
    if (pushed) return { rev: pushed, basis: 'push', refusal: null };
  } catch (err) {
    return refused(err.message);
  }
  try {
    return { rev: git(['rev-parse', 'HEAD~1'], root), basis: 'parent', refusal: null };
  } catch {
    return NONE;
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

function compareDown(before, now, _root, firstFreeze = new Set()) {
  const b = counts(before);
  const n = counts(now);
  const covered = new Set([...b.keys()].map(area));
  const only = covered.size === 0 ? null : covered;
  const wasBy = areaTotals(b, only);
  const nowBy = areaTotals(n, only);
  const faults = [];
  for (const [a, tn] of nowBy) {
    // A scope the checker did not measure at the base revision freezes its debt for the first
    // time here: that is a new measurement, not debt that grew.
    if (firstFreeze.has(a)) continue;
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

/** `.arch.json` module id -> the directory roots its globs name (the part before the first wildcard). */
function moduleRoots(doc) {
  const out = new Map();
  for (const [id, globs] of Object.entries(doc?.modules ?? {})) {
    const list = Array.isArray(globs) ? globs : [];
    out.set(id, list.map((g) => String(g).split('*')[0].replace(/\/$/, '')).filter(Boolean));
  }
  return out;
}

/** A contract may leave only with the code it governed: its `from` module is gone from `.arch.json` and from the tree at HEAD. */
function governedCodeGone(root, contract, before, now) {
  if (!contract?.from || contract.from === '*') return false;
  if (moduleRoots(now).has(contract.from)) return false;
  const roots = moduleRoots(before).get(contract.from) ?? [];
  if (roots.length === 0) return false;
  return roots.every((r) => {
    try {
      return git(['ls-tree', '-r', '--name-only', 'HEAD', '--', r], root) === '';
    } catch {
      return false;
    }
  });
}

function compareTighten(before, now, root) {
  const b = statuses(before);
  const n = statuses(now);
  const byId = new Map((before?.contracts ?? []).map((c) => [c?.id, c]));
  const faults = [];
  for (const [id, was] of b) {
    const is = n.get(id);
    if (is === undefined) {
      if (!governedCodeGone(root, byId.get(id), before, now))
        faults.push(`${id}: ${was} -> removed`);
    } else if (STRICTNESS.indexOf(is) < STRICTNESS.indexOf(was)) {
      faults.push(`${id}: ${was} -> ${is}`);
    }
  }
  return faults;
}

const COMPARE = { down: compareDown, shrink: compareShrink, tighten: compareTighten };

/** The scopes `decl.scopesFrom`'s checker measures at HEAD and did not measure at `rev`. */
function firstFrozenScopes(root, rev, decl) {
  if (!decl.scopesFrom) return new Set();
  const cwds = (doc) =>
    new Set((doc?.checkers?.[decl.scopesFrom]?.scopes ?? []).map((sc) => String(sc?.cwd ?? '')));
  const was = cwds(readAt(root, rev, '.forge/conformance.json'));
  return new Set(
    [...cwds(readAt(root, 'HEAD', '.forge/conformance.json'))].filter((c) => !was.has(c)),
  );
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
  const faults = COMPARE[decl.improves](before, now, root, firstFrozenScopes(root, rev, decl));
  if (faults.length === 0) return null;
  const shown = faults.slice(0, 3).join(' · ');
  const more = faults.length > 3 ? ` (+${faults.length - 3} more)` : '';
  return `${decl.path} moved against improves=${decl.improves}: ${shown}${more}`;
}
