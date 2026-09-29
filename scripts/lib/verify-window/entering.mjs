import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newEntries, readJournal } from '../migration-order.mjs';
import { showAt } from './git.mjs';
import { allocate, rebaseSnapshot, rewriteReferences, snapshotFile } from './migrations.mjs';
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

/** The snapshot in `rev`'s tree whose `id` is `id`, parsed, or `null`: the id is read, not its spacing. */
function snapshotById(t, rev, dir, id) {
  const hits = (t.run(['grep', '-l', '-F', id, rev, '--', `${dir}/meta/`]) ?? '')
    .split('\n')
    .filter(Boolean)
    .map((h) => h.slice(rev.length + 1));
  for (const path of hits) {
    const snap = snapshotOf(showAt(t, rev, path), `${rev}:${path}`);
    if (snap.id === id) return snap;
  }
  return null;
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
function editedEntries(member, combined, before, theirs, landed) {
  const inCombined = new Map(combined.entries.map((e) => [e.tag, e]));
  const inherited = new Set((before?.entries ?? []).map((e) => e.tag));
  for (const e of theirs.entries) {
    const c = inCombined.get(e.tag);
    if (c && !inherited.has(e.tag)) {
      const owner = landed.find((m) => m.addedTags?.includes(e.tag))?.issue ?? 'an earlier member';
      return `${member.issue} adds the journal entry ${e.tag}, which ${owner} already added in this window; one of them regenerates it under another name`;
    }
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
 * `retag` is the moves `rewriteTags` applies once the merge's conflicts are settled.
 * @returns {{ moves: object[], retag: object[] } | { refusal: string }}
 */
export function enterMigrations(input) {
  try {
    return rederive(input);
  } catch (err) {
    if (!(err instanceof Unreadable)) throw err;
    return { refusal: `${input.member.issue}'s migrations cannot be entered: ${err.message}` };
  }
}

function rederive({ t, dir, member, open, earlier = [], landed = [] }) {
  const journalPath = `${dir}/meta/_journal.json`;
  const combined = journalOf(t, 'HEAD', dir);
  const theirs = journalOf(t, member.head, dir);
  const fork = t.run(['merge-base', 'HEAD', member.head])?.trim();
  const before = fork ? journalOf(t, fork, dir) : null;
  if (!combined || !theirs) return { moves: [], retag: earlier };
  const edited = editedEntries(member, combined, before, theirs, landed);
  if (edited) return { refusal: edited };
  // New against where the member forked, not against the combination: a member stacked on an
  // earlier one carries that one's entries under the tags it had before the window renumbered them.
  const fresh = newEntries(theirs.entries, (before ?? combined).entries);
  if (fresh.length === 0) return { moves: [], retag: earlier };

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

  return {
    moves: renumbered ? moves : [],
    added: moves.map((m) => m.to.tag),
    retag: [...earlier, ...(renumbered ? moves : [])],
  };
}

/**
 * Every file this member's merge brings that names a renumbered tag — its own, or one an earlier
 * member was moved off — rewritten once. Files already in the combination were rewritten when the
 * member that moved the tag entered, so they are not read again.
 */
export function rewriteTags(t, moves, dir) {
  const journalPath = `${dir}/meta/_journal.json`;
  const moved = moves.filter((m) => m.from.tag !== m.to.tag);
  if (moved.length === 0) return [];
  const brought = new Set(
    (t.run(['diff', '--cached', '--name-only', '-z', 'HEAD']) ?? '').split('\0').filter(Boolean),
  );
  const patterns = moved.flatMap((m) => ['-e', m.from.tag]);
  const hits = (t.run(['grep', '-l', '-z', '-F', ...patterns]) ?? '').split('\0').filter(Boolean);
  const touched = [];
  for (const path of hits.filter((p) => brought.has(p))) {
    if (path === journalPath) continue;
    const abs = join(t.cwd, path);
    if (!existsSync(abs)) continue;
    writeFileSync(abs, rewriteReferences(readFileSync(abs, 'utf8'), moved));
    t.must(['add', '--', path]);
    touched.push(path);
  }
  return touched.sort();
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
