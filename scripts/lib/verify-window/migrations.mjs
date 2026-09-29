/**
 * A member's migrations, as it enters a combination: the numbers it may keep or must take, and
 * its drizzle snapshots rebased onto the combination's head snapshot. Pure; the git side is
 * `assemble.mjs`. Why a renumber here is not the hand renumber the migrations README forbids:
 * `docs/modules/landing/verify-window.md`.
 */

import { checkSet, floorOf } from '../migration-order.mjs';

const DAY = 86_400_000;

/** The schema objects a snapshot holds, one map each: the unit a rebase composes or refuses. */
export const OBJECT_COLLECTIONS = [
  'schemas',
  'enums',
  'tables',
  'sequences',
  'roles',
  'policies',
  'views',
];

function pad(idx) {
  return String(idx).padStart(4, '0');
}

/** `tag` carrying `idx` as its numeric prefix; a tag with no such prefix keeps its name. */
export function retag(tag, idx) {
  return /^\d+_/.test(tag) ? tag.replace(/^\d+_/, `${pad(idx)}_`) : tag;
}

/** Every renumbered tag in `text` replaced in one pass, longest first, so none is moved twice. */
export function rewriteReferences(text, moves) {
  const to = new Map(
    moves.filter((m) => m.from.tag !== m.to.tag).map((m) => [m.from.tag, m.to.tag]),
  );
  if (to.size === 0) return text;
  const alternatives = [...to.keys()]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(alternatives.join('|'), 'g'), (t) => to.get(t));
}

export function snapshotFile(dir, idx) {
  return `${dir}/meta/${pad(idx)}_snapshot.json`;
}

/**
 * The numbers `member`'s new entries land at. They keep their own where the first clears every
 * number the base, the combination so far and the open branches outside the window hold — the
 * `next` the migration-order checker prints as `Next free:` — and take consecutive numbers from
 * that `next` otherwise.
 * @param {{ combined: object[], member: object[], open: { branch: string, entries: object[] }[] }} input
 */
export function allocate({ combined, member, open }) {
  const { next } = checkSet({
    base: combined,
    baseRef: 'the combination',
    self: { branch: 'the combination', entries: [] },
    siblings: open,
  });
  const sorted = [...member].sort((a, b) => a.idx - b.idx);
  const clears =
    sorted.length > 0 &&
    sorted[0].when >= next.when &&
    sorted[0].idx >= next.idx &&
    sorted.every((e, i) => i === 0 || (e.when > sorted[i - 1].when && e.idx > sorted[i - 1].idx));
  const moves = sorted.map((e, k) => {
    if (clears) return { from: e, to: e };
    const idx = next.idx + k;
    return { from: e, to: { ...e, idx, when: next.when + k * DAY, tag: retag(e.tag, idx) } };
  });
  return { next, renumbered: !clears && sorted.length > 0, moves, floor: floorOf(combined) };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Whether `after` only adds to `before`: every key `before` holds is still there, unchanged. */
function onlyAdds(before, after) {
  if (!isObj(before) || !isObj(after)) return same(before, after);
  return Object.keys(before).every((k) => k in after && onlyAdds(before[k], after[k]));
}

/** Every object `from` changed on the way to `to`, keyed `collection:name`. */
export function objectDelta(from, to) {
  const delta = new Map();
  for (const coll of OBJECT_COLLECTIONS) {
    const a = from?.[coll] ?? {};
    const b = to?.[coll] ?? {};
    for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const key = `${coll}:${name}`;
      if (!(name in b)) delta.set(key, { op: 'remove', additive: false });
      else if (!(name in a)) delta.set(key, { op: 'add', additive: true, value: b[name] });
      else if (!same(a[name], b[name])) {
        delta.set(key, { op: 'change', additive: onlyAdds(a[name], b[name]), value: b[name] });
      }
    }
  }
  return delta;
}

/** The objects `value` points at: a foreign key's target table, an enum-typed column's enum. */
export function referencesOf(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const v of value) referencesOf(v, into);
  } else if (isObj(value)) {
    if (typeof value.tableTo === 'string') {
      into.add(`tables:${value.schemaTo || 'public'}.${value.tableTo}`);
    }
    if (typeof value.typeSchema === 'string' && typeof value.type === 'string') {
      into.add(`enums:${value.typeSchema}.${value.type.replace(/\[\]$/, '')}`);
    }
    for (const v of Object.values(value)) referencesOf(v, into);
  }
  return into;
}

/** Where a three-way merge of two additions cannot stand: they disagree, or both make one key. */
class Conflict {
  constructor(twice, at) {
    this.twice = twice;
    this.at = at;
  }
}

/**
 * A three-way merge of two additive changes to one value, or a `Conflict`. A key both sides add,
 * even identically, is two migrations each creating it, which the second cannot.
 */
function mergeAdditive(base, ours, theirs, at = []) {
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  if (base === undefined || !isObj(base) || !isObj(ours) || !isObj(theirs)) {
    return new Conflict(same(ours, theirs), at);
  }
  const out = {};
  for (const k of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const merged = mergeAdditive(base[k], ours[k], theirs[k], [...at, k]);
    if (merged instanceof Conflict) return merged;
    if (merged !== undefined) out[k] = merged;
  }
  return out;
}

/** The first object `adder` points at that `other` removes or changes, as its refusal. */
function danglingReference(adder, other, adderName, otherName) {
  for (const [key, d] of adder) {
    if (d.op === 'remove') continue;
    for (const ref of referencesOf(d.value)) {
      const hit = other.get(ref);
      if (hit && !hit.additive) {
        const verb = hit.op === 'remove' ? 'removes' : 'changes';
        return `${key} in ${adderName} points at ${ref}, which ${otherName} ${verb}`;
      }
    }
  }
  return null;
}

/**
 * `snap` — diffed by its member from `oldParent` — re-expressed over `newParent`. Refused, naming
 * the object, where the member and the combination both touch one object and either side removes
 * or changes what was there, or where one side points at an object the other removed or changed:
 * the snapshot that came out would describe a schema no migration order produces.
 * @returns {{ snapshot: object } | { refusal: string }}
 */
export function rebaseSnapshot({ oldParent, newParent, snap }) {
  for (const k of ['version', 'dialect']) {
    if (snap[k] !== newParent[k]) {
      return {
        refusal: `the snapshot's \`${k}\` is ${snap[k]} and the combination's is ${newParent[k]}`,
      };
    }
  }
  const mine = objectDelta(oldParent, snap);
  const theirs = objectDelta(oldParent, newParent);
  const out = structuredClone(newParent);
  for (const [key, d] of mine) {
    const [coll, name] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const other = theirs.get(key);
    if (other && (!d.additive || !other.additive)) {
      const who = !d.additive ? 'this member' : 'an earlier member';
      const what = (!d.additive ? d : other).op === 'remove' ? 'removes' : 'changes what was in';
      return {
        refusal: `${key} is touched by this member and by an earlier member, and ${who} ${what} it`,
      };
    }
    out[coll] ??= {};
    if (d.op === 'remove') delete out[coll][name];
    else if (!other) out[coll][name] = structuredClone(d.value);
    else {
      const merged = mergeAdditive(oldParent?.[coll]?.[name], other.value, d.value);
      if (merged instanceof Conflict && merged.twice) {
        const at =
          merged.at.length > 0
            ? `added to by this member and by an earlier member alike, at ${merged.at.join('.')}`
            : 'added by this member and by an earlier member alike';
        return { refusal: `${key} is ${at}, and two migrations cannot both create it` };
      }
      if (merged instanceof Conflict) {
        return {
          refusal: `${key} is added to by this member and an earlier member, and the two additions disagree`,
        };
      }
      out[coll][name] = merged;
    }
  }
  const byRef =
    danglingReference(mine, theirs, 'this member', 'an earlier member') ??
    danglingReference(theirs, mine, 'an earlier member', 'this member');
  if (byRef) return { refusal: byRef };
  const meta = mergeAdditive(oldParent?._meta, newParent._meta, snap._meta);
  if (meta instanceof Conflict)
    return { refusal: 'the snapshot `_meta` rename maps disagree with the combination' };
  out._meta = meta;
  out.id = snap.id;
  out.prevId = newParent.id;
  return { snapshot: out };
}
