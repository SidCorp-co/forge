// The direct requests a person left at draft (REQ-76 BC-9): an issue a person filed and nobody has
// admitted. Under a profile that turns `master_admitted_only` off these are master work, so a master
// is placed for them and admits or drops each (`masters/owed.ts`); under any other they wait on a
// person, as they always have.

import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues, users } from '../db/schema.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { activeIssuePrefix } from './issue-prefix-read.js';

export async function draftIssuesPeopleFiled(projectId: string): Promise<{ key: string }[]> {
  const rows = await db
    .select({ issSeq: issues.issSeq })
    .from(issues)
    .innerJoin(users, eq(users.id, issues.createdById))
    .where(
      and(eq(issues.projectId, projectId), eq(issues.status, 'draft'), eq(users.kind, 'human')),
    )
    .orderBy(asc(issues.issSeq));
  if (rows.length === 0) return [];
  const prefix = await activeIssuePrefix(projectId);
  return rows.map((r) => ({ key: formatIssueRef(prefix, r.issSeq) }));
}

/**
 * The drafts a feedback triage routed an item to, whoever filed them (ISS-840). The item's standing
 * names taking each on as the master's act (`feedback/standing-carrier.ts:draftCarrierWait`), and no
 * product page asks a person to act on an issue (REQ-68 BC-6), so these are master work under every
 * profile: a person's triage already decided they are work. epod's FB-6 waited 13 h stuck
 * `nobody_serves` on a draft no master was placed for.
 */
export async function draftFeedbackCarriers(projectId: string): Promise<{ key: string }[]> {
  const rows = await db
    .select({ issSeq: issues.issSeq })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.status, 'draft'),
        sql`EXISTS (SELECT 1 FROM feedback_route_issues fr WHERE fr.issue_id = ${issues.id})`,
      ),
    )
    .orderBy(asc(issues.issSeq));
  if (rows.length === 0) return [];
  const prefix = await activeIssuePrefix(projectId);
  return rows.map((r) => ({ key: formatIssueRef(prefix, r.issSeq) }));
}
