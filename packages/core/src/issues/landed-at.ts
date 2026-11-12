/**
 * When the commit a merge mark names landed, as its marker says (ISS-1226, FB-628).
 *
 * A mark recorded after the fact dated the landing at the mark, so a release cut between the two
 * read as cut before the landing, and a shipped-in record naming it was refused
 * (`release-batch/shipped-in.ts:refuseCutBeforeLanding`). Forge reads no commit (owner ruling
 * `release-is-the-agents-record`), so the marker says when it landed, and that time is the stamp
 * (`issues.merged_at`) the containment and a finish's `claimMarkedLate` read. Forge refuses it only
 * where its own rows contradict it: a time not yet come, or one before the issue existed.
 *
 * `mergedAt` is the spelling the plugin's `mark_merged` already sends for the same time, so it is held
 * to the same refusals; one call names at most one of the two. A closed issue's correction
 * (`merge-correction.ts`) names its landing the same way and is held to the same rule.
 */

import type { MergeRefusalCode } from '@forge/contracts/issues';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema.js';
import { refuser } from '../lib/refusal.js';

const refuse = refuser<MergeRefusalCode>('MERGE_MARK_REFUSED');

/** The two spellings of the landing a mark's body may carry, each an ISO datetime the schema read. */
export interface SentLanding {
  landedAt?: string | undefined;
  mergedAt?: string | undefined;
}

/**
 * The time the mark's commit landed, as its body names it, or null where it names none (the stamp is
 * then the time the mark is recorded, as before). Refused by name, before anything is written: both
 * spellings at once, a time after now, and a time before the issue was created.
 */
export async function landingOfMark(
  issueId: string,
  body: SentLanding,
  now: Date = new Date(),
): Promise<Date | null> {
  if (body.landedAt && body.mergedAt) {
    throw refuse(
      'MERGE_LANDED_AT_TWICE',
      'when the commit landed is named once: send `landedAt` alone (`mergedAt` is the older spelling of the same time)',
      '/mergedAt',
    );
  }
  const path = body.landedAt ? '/landedAt' : '/mergedAt';
  const sent = body.landedAt ?? body.mergedAt;
  if (!sent) return null;
  const at = new Date(sent);
  if (at.getTime() > now.getTime()) {
    throw refuse(
      'MERGE_LANDED_AT_FUTURE',
      `${path.slice(1)} is ${at.toISOString()}, after now (${now.toISOString()}): a commit that has not landed yet is not marked. Send the time the commit landed on its branch, or omit it to date the landing now`,
      path,
    );
  }
  const [issue] = await db
    .select({ issSeq: issues.issSeq, createdAt: issues.createdAt })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (issue && at.getTime() < issue.createdAt.getTime()) {
    throw refuse(
      'MERGE_LANDED_AT_BEFORE_ISSUE',
      `${path.slice(1)} is ${at.toISOString()}, before ISS-${issue.issSeq} was created at ${issue.createdAt.toISOString()}: this issue's commit cannot have landed before the issue existed. Send the time its own commit landed, no earlier than that`,
      path,
    );
  }
  return at;
}
