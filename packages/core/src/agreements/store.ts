// The project layer of working agreements (REQ-90): every change a project made, one insert-only row
// per revision (`db/schema-agreements.ts:projectAgreementRevisions`). The only writer of that table.

import type { AgreementCondition } from '@forge/contracts/agreements';
import { and, asc, desc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projectAgreementRevisions as t } from '../db/schema-agreements.js';
import { users } from '../db/schema-auth.js';
import type { ProjectRevisionRow } from './resolve.js';

const columns = {
  slug: t.slug,
  revision: t.revision,
  change: t.change,
  name: t.name,
  rule: t.rule,
  detail: t.detail,
  condition: t.condition,
  reason: t.reason,
  baseRevision: t.baseRevision,
  actorUserId: t.actorUserId,
  actorName: users.displayName,
  at: t.createdAt,
};

type Selected = Omit<ProjectRevisionRow, 'condition'> & { condition: unknown };
const rowOf = (r: Selected): ProjectRevisionRow => ({
  ...r,
  condition: (r.condition as AgreementCondition | null) ?? null,
});

/** Every revision the project wrote, oldest first. */
export async function projectRevisionsOf(projectId: string): Promise<ProjectRevisionRow[]> {
  const rows = await db
    .select(columns)
    .from(t)
    .leftJoin(users, eq(users.id, t.actorUserId))
    .where(eq(t.projectId, projectId))
    .orderBy(asc(t.slug), asc(t.revision));
  return rows.map(rowOf);
}

/** The project's latest revision of `slug`; null where it wrote none. */
export async function latestRevisionOf(
  projectId: string,
  slug: string,
): Promise<ProjectRevisionRow | null> {
  const [row] = await db
    .select(columns)
    .from(t)
    .leftJoin(users, eq(users.id, t.actorUserId))
    .where(and(eq(t.projectId, projectId), eq(t.slug, slug)))
    .orderBy(desc(t.revision))
    .limit(1);
  return row ? rowOf(row) : null;
}

export interface RevisionInsert {
  projectId: string;
  slug: string;
  /** The revision this write expects to follow; the insert lands only as `expected + 1`. */
  expected: number;
  change: ProjectRevisionRow['change'];
  name: string | null;
  rule: string | null;
  detail: string | null;
  condition: AgreementCondition | null;
  reason: string;
  baseRevision: number | null;
  actorUserId: string;
}

/**
 * Appends revision `expected + 1`, or returns false where another write took it first: the unique
 * (project, slug, revision) index decides a race, never a read before the write.
 */
export async function appendRevision(row: RevisionInsert): Promise<boolean> {
  const { expected, ...fields } = row;
  const inserted = await db
    .insert(t)
    .values({ ...fields, revision: expected + 1 })
    .onConflictDoNothing({ target: [t.projectId, t.slug, t.revision] })
    .returning({ id: t.id });
  return inserted.length > 0;
}
