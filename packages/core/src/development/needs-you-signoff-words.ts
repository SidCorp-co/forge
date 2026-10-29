// What a sign-off's one press records as the signer's why (REQ-4 BC-16, ISS-645 r2): the words of the
// revision it signs, what it changes and why its author proposed it, read off the revision itself.
// Never a sentence the rule says to every reader alike: that went on every accept under the signer's
// name (judge K144 on 0.4.0-dev.355). A revision that says neither leaves the press to ask.

import { hasVisibleText } from '@forge/contracts/reason-text';
import { and, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementRevisions } from '../db/schema-requirements.js';
import { clipAtWord } from './needs-you-decision-builders.js';

/** The bound on a decision's why (`@forge/contracts/needs-you-decisions` `LIMITS.why`). */
const WHY_MAX = 600;

/** A revision's own words, its change summary then its author's reason, each said once; null where it gives neither. */
export function revisionWords(r: {
  changeSummary: string | null;
  reason: string | null;
}): string | null {
  const parts = [r.changeSummary, r.reason]
    .map((t) => (t ?? '').trim())
    .filter((t, i, all) => hasVisibleText(t) && all.indexOf(t) === i);
  return parts.length > 0 ? clipAtWord(parts.join(' — '), WHY_MAX) : null;
}

/** What a revision with no words of its own says instead of a recommendation. */
export const wordlessRevision = (n: number) =>
  `Revision ${n} says neither what it changes nor why.`;

const keyOf = (requirementId: string, revision: number) => `${requirementId}:${revision}`;

/** Reads each wanted revision's own words once, and answers them by requirement and revision. */
export async function revisionWordsOf(
  wanted: readonly { requirementId: string; revision: number }[],
): Promise<(requirementId: string, revision: number | null) => string | null> {
  const ids = [...new Set(wanted.map((w) => w.requirementId))];
  const revisions = [...new Set(wanted.map((w) => w.revision))];
  const rows =
    ids.length === 0
      ? []
      : await db
          .select({
            requirementId: requirementRevisions.requirementId,
            revision: requirementRevisions.revision,
            changeSummary: requirementRevisions.changeSummary,
            reason: requirementRevisions.reason,
          })
          .from(requirementRevisions)
          .where(
            and(
              inArray(requirementRevisions.requirementId, ids),
              inArray(requirementRevisions.revision, revisions),
            ),
          );
  const words = new Map(rows.map((r) => [keyOf(r.requirementId, r.revision), revisionWords(r)]));
  return (requirementId, revision) =>
    revision === null ? null : (words.get(keyOf(requirementId, revision)) ?? null);
}
