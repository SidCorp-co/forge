import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newEntries } from '../migration-order.mjs';
import { showAt } from './git.mjs';
import { allocate, rebaseSnapshot, snapshotFile } from './migrations.mjs';
import { unionInsertions } from './union.mjs';

/**
 * What one member's entry into the combination does to the files the repository orders across
 * branches: its migrations, re-derived against the combination so far, and the declared union
 * paths. Runs inside an uncommitted `git merge --no-commit`; `assemble.mjs` owns the merge itself.
 */

function journalOf(t, rev, dir) {
  const text = showAt(t, rev, `${dir}/meta/_journal.json`);
  return text === null ? null : JSON.parse(text);
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

/** The snapshot in HEAD's tree whose `id` is `id`, parsed, or `null`. */
function snapshotById(t, dir, id) {
  const hit = t.run(['grep', '-l', '-F', `"id": "${id}"`, 'HEAD', '--', `${dir}/meta/`]);
  const path = hit
    ?.split('\n')
    .find(Boolean)
    ?.replace(/^HEAD:/, '');
  return path ? JSON.parse(showAt(t, 'HEAD', path)) : null;
}

function headSnapshot(t, dir) {
  const names = (t.run(['ls-tree', '--name-only', 'HEAD', `${dir}/meta/`]) ?? '')
    .split('\n')
    .filter((n) => /\/\d+_snapshot\.json$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)_snapshot/)[1]) - Number(b.match(/(\d+)_snapshot/)[1]));
  const last = names.at(-1);
  return last ? JSON.parse(showAt(t, 'HEAD', last)) : null;
}

/**
 * Re-derive `member`'s migrations against HEAD and stage the result.
 * @returns {{ moves: object[], rewrites: string[] } | { refusal: string }}
 */
export function enterMigrations({ t, dir, member, open }) {
  const combined = journalOf(t, 'HEAD', dir);
  const theirs = journalOf(t, member.head, dir);
  if (!combined || !theirs) return { moves: [], rewrites: [] };
  const fresh = newEntries(theirs.entries, combined.entries);
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
    const snap = JSON.parse(s.snap);
    const oldParent = previous ?? snapshotById(t, dir, snap.prevId);
    if (!oldParent) {
      return {
        refusal: `${member.issue}'s ${snapshotFile(dir, s.move.from.idx)} chains off ${snap.prevId}, which no snapshot in the combination carries`,
      };
    }
    let next = snap;
    if (newParent && oldParent.id !== newParent.id) {
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
