import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newEntries, readJournal } from '../migration-order.mjs';
import { showAt } from './git.mjs';
import { allocate, rebaseSnapshot, snapshotFile } from './migrations.mjs';
import { unionInsertions } from './union.mjs';

/**
 * What one member's entry into the combination does to the files the repository orders across
 * branches: its migrations, re-derived against the combination so far, and the declared union
 * paths. Runs inside an uncommitted `git merge --no-commit`; `assemble.mjs` owns the merge itself.
 */

/** A journal or snapshot that is not one; the only error a caller here turns into a refusal. */
export class Unreadable extends Error {}

/** The journal at `rev`, `null` where it has none; throws `Unreadable` where it is not a journal. */
function journalOf(t, rev, dir) {
  const text = showAt(t, rev, `${dir}/meta/_journal.json`);
  if (text === null) return null;
  const read = readJournal(text, `${rev}:${dir}/meta/_journal.json`);
  if (read.problem) throw new Unreadable(read.problem);
  return read.doc;
}

/** A snapshot parsed from `text`, or `Unreadable` naming `where`. */
function snapshotOf(text, where) {
  let snap;
  try {
    snap = JSON.parse(text);
  } catch (err) {
    throw new Unreadable(`the snapshot at ${where} is not readable JSON: ${err.message}`);
  }
  if (typeof snap?.id !== 'string' || typeof snap?.prevId !== 'string') {
    throw new Unreadable(`the snapshot at ${where} carries no string \`id\` and \`prevId\``);
  }
  return snap;
}

/** Put `path` back to what HEAD holds, or take it out of the index and the tree where HEAD has none. */
function toHead(t, path) {
  if (showAt(t, 'HEAD', path) !== null) {
    t.must(['checkout', 'HEAD', '--', path]);
    return;
  }
  t.run(['rm', '-q', '-f', '--cached', '--ignore-unmatch', '--', path]);
  rmSync(join(t.cwd, path), { force: true });
}

function write(t, path, text) {
  writeFileSync(join(t.cwd, path), text);
  t.must(['add', '--', path]);
}

/** The snapshot in `rev`'s tree whose `id` is `id`, parsed, or `null`. */
function snapshotById(t, rev, dir, id) {
  const hit = t.run(['grep', '-l', '-F', `"id": "${id}"`, rev, '--', `${dir}/meta/`]);
  const path = hit
    ?.split('\n')
    .find(Boolean)
    ?.slice(rev.length + 1);
  return path ? snapshotOf(showAt(t, rev, path), `${rev}:${path}`) : null;
}

function headSnapshot(t, dir) {
  const names = (t.run(['ls-tree', '--name-only', 'HEAD', `${dir}/meta/`]) ?? '')
    .split('\n')
    .filter((n) => /\/\d+_snapshot\.json$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)_snapshot/)[1]) - Number(b.match(/(\d+)_snapshot/)[1]));
  const last = names.at(-1);
  return last ? snapshotOf(showAt(t, 'HEAD', last), `HEAD:${last}`) : null;
}

/**
 * A journal entry the member changed or removed rather than added, as its refusal: the journal is
 * rewritten as the combination's entries plus the member's new ones, so an edit to an existing
 * entry would otherwise be dropped without a word.
 */
function editedEntries(member, combined, before, theirs) {
  const inCombined = new Map(combined.entries.map((e) => [e.tag, e]));
  for (const e of theirs.entries) {
    const c = inCombined.get(e.tag);
    if (c && JSON.stringify(c) !== JSON.stringify(e)) {
      return `${member.issue} changes the journal entry ${e.tag}, which a window keeps as the combination holds it`;
    }
  }
  const kept = new Set(theirs.entries.map((e) => e.tag));
  const removed = (before?.entries ?? []).find((e) => !kept.has(e.tag));
  return removed
    ? `${member.issue} removes the journal entry ${removed.tag}, which a window keeps as the combination holds it`
    : null;
}

/**
 * Re-derive `member`'s migrations against HEAD and stage the result.
 * @returns {{ moves: object[], rewrites: string[] } | { refusal: string }}
 */
export function enterMigrations(input) {
  try {
    return rederive(input);
  } catch (err) {
    if (!(err instanceof Unreadable)) throw err;
    return { refusal: `${input.member.issue}'s migrations cannot be entered: ${err.message}` };
  }
}

function rederive({ t, dir, member, open }) {
  const combined = journalOf(t, 'HEAD', dir);
  const theirs = journalOf(t, member.head, dir);
  const fork = t.run(['merge-base', 'HEAD', member.head])?.trim();
  const before = fork ? journalOf(t, fork, dir) : null;
  if (!combined || !theirs) return { moves: [], rewrites: [] };
  const edited = editedEntries(member, combined, before, theirs);
  if (edited) return { refusal: edited };
  // New against where the member forked, not against the combination: a member stacked on an
  // earlier one carries that one's entries under the tags it had before the window renumbered them.
  const fresh = newEntries(theirs.entries, (before ?? combined).entries);
  if (fresh.length === 0) return { moves: [], rewrites: [] };

  const { moves, renumbered } = allocate({ combined: combined.entries, member: fresh, open });
  const sources = moves.map((m) => ({
    move: m,
    sql: showAt(t, member.head, `${dir}/${m.from.tag}.sql`),
    snap: showAt(t, member.head, snapshotFile(dir, m.from.idx)),
  }));
  for (const s of sources) {
    if (s.sql === null)
      return {
        refusal: `${member.issue} names ${s.move.from.tag} in its journal and carries no ${dir}/${s.move.from.tag}.sql`,
      };
  }

  let newParent = headSnapshot(t, dir);
  let previous = null;
  const snaps = [];
  for (const s of sources.filter((x) => x.snap !== null)) {
    const snap = snapshotOf(s.snap, `${member.head}:${snapshotFile(dir, s.move.from.idx)}`);
    const oldParent = previous ?? snapshotById(t, member.head, dir, snap.prevId);
    if (!oldParent) {
      return {
        refusal: `${member.issue}'s ${snapshotFile(dir, s.move.from.idx)} chains off ${snap.prevId}, which no snapshot in its own tree carries`,
      };
    }
    let next = snap;
    if (newParent && JSON.stringify(oldParent) !== JSON.stringify(newParent)) {
      const r = rebaseSnapshot({ oldParent, newParent, snap });
      if (r.refusal)
        return {
          refusal: `${member.issue}'s snapshot ${snapshotFile(dir, s.move.from.idx)}: ${r.refusal}`,
        };
      next = r.snapshot;
    }
    snaps.push({ path: snapshotFile(dir, s.move.to.idx), body: next });
    previous = snap;
    newParent = next;
  }

  const journalPath = `${dir}/meta/_journal.json`;
  for (const p of [
    journalPath,
    ...sources.flatMap((s) => [
      `${dir}/${s.move.from.tag}.sql`,
      snapshotFile(dir, s.move.from.idx),
    ]),
  ]) {
    toHead(t, p);
  }
  const doc = { ...combined, entries: [...combined.entries, ...moves.map((m) => m.to)] };
  write(t, journalPath, `${JSON.stringify(doc, null, 2)}\n`);
  for (const s of sources) write(t, `${dir}/${s.move.to.tag}.sql`, s.sql);
  for (const s of snaps) write(t, s.path, `${JSON.stringify(s.body, null, 2)}\n`);

  const rewrites = renumbered ? rewriteTags(t, moves, journalPath) : [];
  return { moves: renumbered ? moves : [], rewrites };
}

/** Every other file in the tree naming a renumbered tag, rewritten to the new one. */
function rewriteTags(t, moves, journalPath) {
  const touched = new Set();
  for (const { from, to } of moves) {
    if (from.tag === to.tag) continue;
    const hits = (t.run(['grep', '-l', '-F', from.tag]) ?? '').split('\n').filter(Boolean);
    for (const path of hits) {
      if (path === journalPath) continue;
      const abs = join(t.cwd, path);
      if (!existsSync(abs)) continue;
      writeFileSync(abs, readFileSync(abs, 'utf8').split(from.tag).join(to.tag));
      t.must(['add', '--', path]);
      touched.add(path);
    }
  }
  return [...touched].sort();
}

/** Resolve each declared union path that is unmerged: the member's additions beside the combination's. */
export function resolveUnions({ t, unmerged, union }) {
  const resolved = [];
  for (const path of unmerged.filter((p) => union.includes(p))) {
    const [base, ours, theirs] = [1, 2, 3].map((n) => t.run(['show', `:${n}:${path}`]) ?? '');
    const merged = unionInsertions({ base, ours, theirs, path });
    if (merged.refusal) return { refusal: merged.refusal };
    write(t, path, merged.text);
    resolved.push(path);
  }
  return { resolved };
}
