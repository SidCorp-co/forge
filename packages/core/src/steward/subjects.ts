// The items a steward run is about (REQ-48 BC-1): a requirement, a feedback item or an issue, read by
// id for the key every page and record names it by, and whether its life has ended, which skips a run
// `subject_ended` rather than acting on a closed thing.

import { feedbackKey } from '@forge/contracts/feedback';
import { requirementKey } from '@forge/contracts/requirements';
import type { StandingSubject, StandingSubjectKind, StewardAct } from '@forge/contracts/steward';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { feedback } from '../db/schema-feedback.js';
import { issues } from '../db/schema-issues.js';
import { requirements } from '../db/schema-requirements.js';
import { activeIssuePrefix } from '../issues/index.js';
import { formatIssueRef } from '../lib/issue-ref.js';

/** The statuses an item's life ends at: nothing more is owed of the steward there. */
const ENDED: Record<StandingSubjectKind, readonly string[]> = {
  requirement: ['accepted', 'dropped'],
  feedback: ['declined', 'verified'],
  issue: ['closed', 'dropped'],
};

/** An act that follows an item past its end: the follow-through of shipped work reads closed issues. */
const ACTS_PAST_END: readonly StewardAct[] = ['release_followthrough'];

export interface SubjectRow extends StandingSubject {
  projectId: string;
  status: string;
}

/** The subject by id within its project, or null where there is none. */
export async function subjectOf(
  projectId: string,
  kind: StandingSubjectKind,
  id: string,
): Promise<SubjectRow | null> {
  if (kind === 'requirement') {
    const [row] = await db
      .select({ seq: requirements.reqSeq, status: requirements.status })
      .from(requirements)
      .where(and(eq(requirements.id, id), eq(requirements.projectId, projectId)))
      .limit(1);
    return row ? { kind, id, key: requirementKey(row.seq), projectId, status: row.status } : null;
  }
  if (kind === 'feedback') {
    const [row] = await db
      .select({ seq: feedback.fbSeq, status: feedback.status })
      .from(feedback)
      .where(and(eq(feedback.id, id), eq(feedback.projectId, projectId)))
      .limit(1);
    return row ? { kind, id, key: feedbackKey(row.seq), projectId, status: row.status } : null;
  }
  const [row] = await db
    .select({ seq: issues.issSeq, status: issues.status })
    .from(issues)
    .where(and(eq(issues.id, id), eq(issues.projectId, projectId)))
    .limit(1);
  if (!row) return null;
  const key = row.seq == null ? id : formatIssueRef(await activeIssuePrefix(projectId), row.seq);
  return { kind, id, key, projectId, status: row.status };
}

/** Several issues of one project by id, keyed; an id with no row is left out. */
export async function issueSubjects(projectId: string, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const prefix = await activeIssuePrefix(projectId);
  const rows = await db
    .select({ id: issues.id, seq: issues.issSeq, status: issues.status })
    .from(issues)
    .where(and(eq(issues.projectId, projectId), inArray(issues.id, [...ids])));
  return rows.map(
    (r): SubjectRow => ({
      kind: 'issue',
      id: r.id,
      key: r.seq == null ? r.id : formatIssueRef(prefix, r.seq),
      projectId,
      status: r.status,
    }),
  );
}

/** The acts of `acts` an item at `status` is still owed: none of an ended item but its follow-through. */
export function actsOwedAt(
  kind: StandingSubjectKind,
  status: string,
  acts: readonly StewardAct[],
): StewardAct[] {
  if (!ENDED[kind].includes(status)) return [...acts];
  return acts.filter((a) => ACTS_PAST_END.includes(a));
}
