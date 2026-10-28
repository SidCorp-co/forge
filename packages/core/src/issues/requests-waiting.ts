// The direct requests a person left at draft (REQ-76 BC-9): an issue a person filed and nobody has
// admitted. Under a profile that turns `master_admitted_only` off these are master work, so a master
// is placed for them and admits or drops each (`masters/owed.ts`); under any other they wait on a
// person, as they always have.

import { and, asc, eq } from 'drizzle-orm';
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
