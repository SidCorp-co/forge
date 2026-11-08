// REQ-89 BC-2 (ISS-1156): recall answers one entry per subject. A write on a held subject lands on the
// entry holding it (write-service.ts landingOfCuratedWrite), but entries written before that rule, or
// under refs nothing joined, can still hold one subject twice. Two curated hits are one subject when
// they share a source and their text is near-identical: the write's own test (NEAR_DUPLICATE_THRESHOLD
// on their vectors), or the same words where either has no vector. The subject is answered once, by
// its newest entry, at the best rank any of them held, naming the others in `duplicates`; the slot
// the others took goes to the next subject.

import { MEMORY_AUTHORED_SOURCES } from '@forge/contracts/memory';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import type { MemoryHit } from './search.js';
import { NEAR_DUPLICATE_THRESHOLD } from './thresholds.js';

/** A hit standing for its subject, with the ids of the entries holding the same subject. */
export type SubjectHit<H extends MemoryHit = MemoryHit> = H & { duplicates?: string[] };

/** The pairs of these curated hits that hold one subject, read from their stored vectors and text. */
export async function sameSubjectPairs(hits: readonly MemoryHit[]): Promise<[string, string][]> {
  const authored = new Set<string>(MEMORY_AUTHORED_SOURCES);
  const ids = hits.filter((h) => authored.has(h.source) && !h.via).map((h) => h.id);
  if (ids.length < 2) return [];
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT a.id::text AS a, b.id::text AS b
      FROM memories a
      JOIN memories b ON a.id < b.id AND a.source = b.source
     WHERE a.id IN (${list}) AND b.id IN (${list})
       AND (
         (a.embedding IS NOT NULL AND b.embedding IS NOT NULL
           AND 1 - (a.embedding <=> b.embedding) >= ${NEAR_DUPLICATE_THRESHOLD})
         OR lower(regexp_replace(a.text_content, '\\s+', ' ', 'g')) = lower(regexp_replace(b.text_content, '\\s+', ' ', 'g'))
       )`)) as unknown as { a: string; b: string }[];
  return rows.map((r) => [r.a, r.b]);
}

/**
 * Fold the hits holding one subject into one: the newest entry (`asOf`) stands for them at the best
 * rank any held, carrying the others' ids in `duplicates`. Order is otherwise kept. Pure.
 */
export function foldBySubject<H extends MemoryHit>(
  hits: readonly H[],
  pairs: readonly (readonly [string, string])[],
): { hits: SubjectHit<H>[]; folded: number } {
  if (pairs.length === 0) return { hits: [...hits], folded: 0 };
  const parent = new Map<string, string>();
  const root = (id: string): string => {
    const p = parent.get(id) ?? id;
    if (p === id) return id;
    const r = root(p);
    parent.set(id, r);
    return r;
  };
  for (const [a, b] of pairs) {
    const [ra, rb] = [root(a), root(b)];
    if (ra !== rb) parent.set(rb, ra);
  }
  const groups = new Map<string, H[]>();
  for (const h of hits) {
    const r = root(h.id);
    groups.set(r, [...(groups.get(r) ?? []), h]);
  }
  const out: SubjectHit<H>[] = [];
  const placed = new Set<string>();
  for (const h of hits) {
    const r = root(h.id);
    if (placed.has(r)) continue;
    placed.add(r);
    const group = groups.get(r) ?? [h];
    if (group.length === 1) {
      out.push(h);
      continue;
    }
    const newest = group.reduce((best, x) => (x.asOf.getTime() > best.asOf.getTime() ? x : best));
    out.push({ ...newest, duplicates: group.filter((x) => x.id !== newest.id).map((x) => x.id) });
  }
  return { hits: out, folded: hits.length - out.length };
}
