// The chat or direct requests waiting on agreement (REQ-76 BC-9): a draft requirement whose revision
// is proposed — what a person or the assistant recorded from a chat. Under a profile that turns
// `master_admitted_only` off these are master work (`masters/owed.ts`), and the agree gate that
// profile also turns off lets the master agree and break each down itself.

import { requirementKey } from '@forge/contracts/requirements';
import { and, asc, eq, exists } from 'drizzle-orm';
import { db } from '../db/client.js';
import { requirementRevisions, requirements } from '../db/schema-requirements.js';

export async function proposedDraftRequirements(projectId: string): Promise<{ key: string }[]> {
  const rows = await db
    .select({ reqSeq: requirements.reqSeq })
    .from(requirements)
    .where(
      and(
        eq(requirements.projectId, projectId),
        eq(requirements.status, 'draft'),
        exists(
          db
            .select({ revision: requirementRevisions.revision })
            .from(requirementRevisions)
            .where(
              and(
                eq(requirementRevisions.requirementId, requirements.id),
                eq(requirementRevisions.state, 'proposed'),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(requirements.reqSeq));
  return rows.map((r) => ({ key: requirementKey(r.reqSeq) }));
}
