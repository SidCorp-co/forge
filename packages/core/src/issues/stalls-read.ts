// A release's stalls (REQ-67 BC-7), read through its roster at read time: a stall counts on a
// release when the issue it stalled is on the roster, or, for one asked on no issue, when a roster
// issue delivers the requirement or carries the feedback item it stood on; and it started before the
// release went out (any start, while it has not). The roster is the release's own record of what it
// shipped, so the count can never name an issue the release does not; nothing is written at the cut,
// and a stall still standing reads open, never dropped.

import {
  type ReleaseStall,
  type ReleaseStalls,
  STALL_CAUSES,
  type StallCause,
} from '@forge/contracts/stalls';
import { and, asc, eq, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, stalls } from '../db/schema.js';
import { feedback, feedbackRouteIssues } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { issueDisplayIds } from './display-ids.js';

export async function stallsOfRoster(
  projectId: string,
  issueIds: readonly string[],
  releasedAt: string | null,
): Promise<ReleaseStalls> {
  const counts = Object.fromEntries(STALL_CAUSES.map((c) => [c, 0])) as Record<StallCause, number>;
  if (issueIds.length === 0) return { counts, stalls: [] };
  const roster = [...issueIds];
  const delivered = db
    .select({ id: issues.requirementId })
    .from(issues)
    .where(inArray(issues.id, roster));
  const carried = db
    .select({ id: feedbackRouteIssues.feedbackId })
    .from(feedbackRouteIssues)
    .where(inArray(feedbackRouteIssues.issueId, roster));
  const onRoster = or(
    inArray(stalls.issueId, roster),
    and(
      isNull(stalls.issueId),
      or(inArray(stalls.requirementId, delivered), inArray(stalls.feedbackId, carried)),
    ),
  ) as SQL;
  const rows = await db
    .select({
      cause: stalls.cause,
      issueId: stalls.issueId,
      question: stalls.question,
      startedAt: stalls.startedAt,
      endedAt: stalls.endedAt,
      reqSeq: requirements.reqSeq,
      reqTitle: requirements.title,
      fbSeq: feedback.fbSeq,
      fbTitle: feedback.title,
      issueTitle: issues.title,
    })
    .from(stalls)
    .leftJoin(requirements, eq(requirements.id, stalls.requirementId))
    .leftJoin(feedback, eq(feedback.id, stalls.feedbackId))
    .leftJoin(issues, eq(issues.id, stalls.issueId))
    .where(
      and(
        eq(stalls.projectId, projectId),
        onRoster,
        releasedAt ? lte(stalls.startedAt, new Date(releasedAt)) : undefined,
      ),
    )
    .orderBy(asc(stalls.startedAt), asc(stalls.id));
  const keys = await issueDisplayIds([...new Set(rows.flatMap((r) => r.issueId ?? []))]);
  const listed: ReleaseStall[] = rows.map((r) => {
    const cause = r.cause as StallCause;
    counts[cause] += 1;
    const item =
      r.reqSeq !== null
        ? { kind: 'requirement' as const, key: `REQ-${r.reqSeq}`, title: r.reqTitle ?? '' }
        : r.fbSeq !== null
          ? { kind: 'feedback' as const, key: `FB-${r.fbSeq}`, title: r.fbTitle ?? '' }
          : null;
    const key = r.issueId ? keys.get(r.issueId) : undefined;
    return {
      cause,
      item,
      issue: key ? { key, title: r.issueTitle ?? '' } : null,
      question: r.question,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    };
  });
  return { counts, stalls: listed };
}
