/**
 * A requirement route's delivery as the feedback list reads it (ISS-1332): the issues linked to each
 * routed requirement, read in one statement for a page beside an issue route's carriers, and what a
 * planned item whose requirement stands delivered or accepted still waits on, down to the release
 * its issues wait at.
 */

import type { FeedbackCarrierView } from '@forge/contracts/feedback';
import { asc, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsPerId } from '../db/read-memo.js';
import { issues } from '../db/schema.js';
import { carrierRunOf } from './list-carriers.js';
import type { Linked } from './list-read.js';
import type { Row } from './read.js';
import type { StandingFacts } from './standing.js';
import { isPastDelivery, type RoutedRequirementFacts } from './standing-requirement.js';

/** The issues linked to each of `requirementIds`, by requirement id, oldest issue first. */
export async function requirementIssuesOf(
  requirementIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (requirementIds.length === 0) return out;
  // a requirement's issues are its own: every project's asks are one read (ISS-1070 r6)
  const links = await rowsPerId(
    'requirementIssues',
    requirementIds,
    (some) =>
      db
        .select({ requirementId: issues.requirementId, issueId: issues.id })
        .from(issues)
        .where(inArray(issues.requirementId, [...some]))
        .orderBy(asc(issues.issSeq)),
    (l) => l.requirementId as string,
  );
  for (const l of links) {
    const id = l.requirementId as string;
    out.set(id, [...(out.get(id) ?? []), l.issueId]);
  }
  return out;
}

const AT_RELEASE_GATE = 'awaiting_release';

/**
 * What a planned requirement-routed item waits on once its requirement stands delivered or accepted:
 * the issues linked to it not yet closed and released, and, where every one of them waits at the
 * release gate, how the release is made and the cut release carrying them, as an issue route's item
 * reads its carriers there. Nothing for any other item.
 */
export function requirementFactsIn(
  r: Row,
  l: Linked,
): Pick<StandingFacts, 'requirement' | 'carrierRelease' | 'carrierRun'> | null {
  if (r.route !== 'new_requirement' || !r.routedRequirementId) return null;
  const q = l.requirements.get(r.routedRequirementId);
  if (!q || !isPastDelivery(q.status)) return null;
  const ids = l.requirementIssues.get(r.routedRequirementId) ?? [];
  const owed: FeedbackCarrierView[] = ids.flatMap((id) => {
    const i = l.issues.get(id);
    if (!i || i.status === 'dropped' || (i.status === 'closed' && !i.unreleased)) return [];
    return [{ key: i.key, status: i.status }];
  });
  const atGate =
    owed.length > 0 &&
    owed.every((c) => c.status === AT_RELEASE_GATE || (c.status === 'closed' && c.key !== null));
  return {
    requirement: {
      key: q.key,
      status: q.status,
      byDecision: q.byDecision,
      owed: owed.flatMap((c) => (c.key ? [c.key] : [])),
    },
    carrierRelease: atGate ? l.release : null,
    carrierRun: atGate ? carrierRunOf(ids, owed, l.issues, l.carryingRuns) : null,
  };
}

/** The issues `issueIds` name, as a phase reads them; one the read did not load is left out. */
export function issueFactsOf(issueIds: readonly string[], l: Linked) {
  return issueIds.flatMap((id) => {
    const issue = l.issues.get(id);
    if (!issue) return [];
    const { key, status, unreleased, failing, owed } = issue;
    return [{ key, status, unreleased, failing, owed }];
  });
}

/** The requirement a `new_requirement` route names, with the issues linked to it (ISS-1332). */
export function routedRequirementOf(id: string | null, l: Linked): RoutedRequirementFacts | null {
  const q = id ? l.requirements.get(id) : undefined;
  if (!id || !q) return null;
  return { status: q.status, issues: issueFactsOf(l.requirementIssues.get(id) ?? [], l) };
}
