/**
 * Who reported an item: its own reporter, then the reporter of every duplicate marked as following it.
 * A duplicate's reporters are read off the duplicates themselves, never copied, so the duplicate's
 * record is whole and a redaction of it still takes its evidence with it.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import type { Row } from './read.js';

export interface Reporter {
  id: string;
  agency: 'human' | 'agent';
  /** The key of the duplicate this person filed, null for the item's own reporter. */
  from: string | null;
}

/** The item's reporter first, then each duplicate's, one entry per person. */
export async function reportersOf(tx: Tx, row: Row): Promise<Reporter[]> {
  const duplicates = await tx
    .select({ by: feedback.reportedBy, agency: feedback.reporterAgency, seq: feedback.fbSeq })
    .from(feedback)
    .where(eq(feedback.duplicateOf, row.id))
    .orderBy(asc(feedback.fbSeq));
  const all: Reporter[] = [
    { id: row.reportedBy, agency: row.reporterAgency, from: null },
    ...duplicates.map((d) => ({ id: d.by, agency: d.agency, from: feedbackKey(d.seq) })),
  ];
  const seen = new Set<string>();
  return all.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

/** Those a bell can tell: an agent reporter has none. */
export const withBell = (reporters: readonly Reporter[]) =>
  reporters.filter((r) => r.agency === 'human');
