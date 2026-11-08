/**
 * The facts a requirement's standing reads beside its rows (`standing-read.ts:standingsOf`), which
 * need only the requirements' ids: so they are asked with its first wave (ISS-1070 r17).
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client.js';
import { rowsPerId } from '../db/read-memo.js';
import { suggestions } from '../db/schema-suggestions.js';
import { followReadsAcross } from './follow-reads.js';
import { statusFactsOf } from './standing-facts.js';
import { askedOf } from './steward-asked.js';

const uncoveredList = z.object({
  uncovered: z.array(z.object({ code: z.string(), reason: z.string() })).optional(),
});

/**
 * Per requirement, per BC code, the reason the newest accepted breakdown naming the code gave for
 * leaving it without an issue. An accepted suggestion keeps its payload (`suggestions_payload_chk`),
 * so the accept is the record and no column copies it.
 */
async function uncoveredOf(ids: readonly string[]): Promise<Map<string, Map<string, string>>> {
  const rows = await rowsPerId(
    'uncovered',
    ids,
    (some) =>
      db
        .select({ requirementId: suggestions.requirementId, payload: suggestions.payload })
        .from(suggestions)
        .where(
          and(
            inArray(suggestions.requirementId, [...some]),
            eq(suggestions.kind, 'breakdown'),
            eq(suggestions.status, 'accepted'),
          ),
        )
        .orderBy(desc(suggestions.decidedAt)),
    (r) => r.requirementId as string,
  );
  const out = new Map<string, Map<string, string>>();
  for (const row of rows) {
    if (!row.requirementId) continue;
    const reasons = out.get(row.requirementId) ?? new Map<string, string>();
    for (const u of uncoveredList.safeParse(row.payload).data?.uncovered ?? []) {
      if (!reasons.has(u.code)) reasons.set(u.code, u.reason);
    }
    out.set(row.requirementId, reasons);
  }
  return out;
}

/**
 * The facts a requirement's turn reads beside its rows, per requirement: why an accepted breakdown
 * left a BC uncovered, the traced nodes a stale design pin's approval removed or renamed (REQ-41
 * BC-10, `follow-reads.ts`), and whether a steward decision on it stands open (REQ-48 BC-5).
 */
// every requirement read has a status-since row (filed time where no transition); a missing one is a
// broken read, refused by name rather than read as its last edit (the AGE every edit reset, dev.227)
const sinceOf = (since: ReadonlyMap<string, Date>, id: string): Date => {
  const at = since.get(id);
  if (!at)
    throw new Error(`requirement ${id} has no status-since time: statusFactsOf read no row for it`);
  return at;
};

export async function besideFactsOf(ids: readonly string[]) {
  const [uncovered, follows, asked, { since: statusSince, decisions, held }] = await Promise.all([
    uncoveredOf(ids),
    followReadsAcross(ids),
    askedOf(ids),
    statusFactsOf(ids),
  ]);
  return (id: string) => ({
    statusSince: sinceOf(statusSince, id),
    acceptedByDecision: decisions.get(id) ?? null,
    uncovered: uncovered.get(id) ?? new Map<string, string>(),
    tracedChanges: (follows.get(id) ?? []).flatMap((f) => f.changes),
    stewardAsked: asked.steward.has(id),
    questionAsked: asked.person.has(id),
    decision: held.get(id) ?? null,
  });
}
