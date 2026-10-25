/**
 * Who reported an item: its own reporter, then everyone whose repeat joined it as an occurrence
 * (REQ-66 BC-3, `occurrences.ts`), then the reporter of every duplicate marked as following it and of
 * every repeat that had joined that duplicate. A duplicate's reporters are read off the duplicates
 * themselves, never copied, so the duplicate's record is whole and a redaction of it still takes its evidence with it.
 */

import { feedbackKey } from '@forge/contracts/feedback';
import { asc, eq } from 'drizzle-orm';
import type { Tx } from '../db/client.js';
import { feedback, feedbackOccurrences } from '../db/schema-feedback.js';
import { occurrenceReportersIn } from './occurrences.js';
import type { Row } from './read.js';
import { tellReporters } from './reporter-language.js';
import { stepNotice } from './reporter-notices.js';

export interface Reporter {
  id: string;
  agency: 'human' | 'agent';
  /** The key of the duplicate this person reported; null for the item's own reporter and repeats. */
  from: string | null;
}

/** The item's reporter, then each occurrence's, then each duplicate's and its repeats', once each. */
export async function reportersOf(tx: Tx, row: Row): Promise<Reporter[]> {
  const repeated = await occurrenceReportersIn(tx, row.id, row.reportedBy);
  const duplicates = await tx
    .select({ by: feedback.reportedBy, agency: feedback.reporterAgency, seq: feedback.fbSeq })
    .from(feedback)
    .where(eq(feedback.duplicateOf, row.id))
    .orderBy(asc(feedback.fbSeq));
  // a duplicate that had joined repeats before a triage found it carries their reporters with it
  const repeatedOfDuplicates = await tx
    .select({
      by: feedbackOccurrences.reportedBy,
      agency: feedbackOccurrences.reporterAgency,
      seq: feedback.fbSeq,
    })
    .from(feedbackOccurrences)
    .innerJoin(feedback, eq(feedback.id, feedbackOccurrences.feedbackId))
    .where(eq(feedback.duplicateOf, row.id))
    .orderBy(asc(feedback.fbSeq), asc(feedbackOccurrences.createdAt));
  const all: Reporter[] = [
    { id: row.reportedBy, agency: row.reporterAgency, from: null },
    ...repeated.map((r) => ({ id: r.id, agency: r.agency, from: null })),
    ...duplicates.map((d) => ({ id: d.by, agency: d.agency, from: feedbackKey(d.seq) })),
    ...repeatedOfDuplicates.map((d) => ({ id: d.by, agency: d.agency, from: feedbackKey(d.seq) })),
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

/**
 * Tells every reporter with a bell, but the one who made the move, of a step their item took
 * (REQ-34 BC-21): a reporter's own verify or reopen tells nobody, a triager's tells them.
 */
export async function tellStepToReporters(
  tx: Tx,
  row: Row,
  step: 'triaged' | 'verified' | 'reopened',
  moverId: string | null,
  carrier: string | null = null,
): Promise<void> {
  const told = withBell(await reportersOf(tx, row))
    .map((r) => r.id)
    .filter((id) => id !== moverId);
  await tellReporters(
    tx,
    { projectId: row.projectId, feedbackId: row.id, kind: 'step' },
    told,
    (language) => stepNotice(language, step, feedbackKey(row.fbSeq), row.title, carrier),
  );
}
