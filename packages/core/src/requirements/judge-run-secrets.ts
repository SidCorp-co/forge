// What a judge run declared at a requirement reads its testing secrets against, and the audit of that
// read on the requirement (ISS-975). The environment itself is project-config's to name
// (`project-config/requirement-run-secrets.ts`); this module answers which issues deliver the
// requirement and keeps the record.

import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { issues } from '../db/schema-issues.js';
import {
  type RequirementSecretReadBasis,
  requirementSecretReads,
} from '../db/schema-requirement-secret-reads.js';
import { requirements } from '../db/schema-requirements.js';

/** The requirement a run judges, by its key, and its project's issues that deliver it, oldest first. */
export async function requirementJudgedBy(
  projectId: string,
  key: string,
): Promise<{ requirementId: string; issueIds: string[] } | null> {
  const seq = /^REQ-([1-9][0-9]*)$/i.exec(key.trim())?.[1];
  if (!seq) return null;
  const [requirement] = await db
    .select({ id: requirements.id })
    .from(requirements)
    .where(and(eq(requirements.projectId, projectId), eq(requirements.reqSeq, Number(seq))))
    .limit(1);
  if (!requirement) return null;
  const delivering = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.projectId, projectId),
        eq(issues.requirementId, requirement.id),
        isNull(issues.archivedAt),
        ne(issues.status, 'dropped'),
      ),
    )
    .orderBy(asc(issues.issSeq));
  return { requirementId: requirement.id, issueIds: delivering.map((i) => i.id) };
}

export interface RequirementSecretRead {
  requirementId: string;
  sessionId: string;
  runId: string;
  boxRunId: string | null;
  deviceId: string;
  /** The person the declaring box's credential acts for. */
  declaredBy: string | null;
  issueId: string | null;
  basis: RequirementSecretReadBasis;
  environment: string;
  profile: string;
  refs: string[];
  tokenId: string;
}

/** Audit the read on the requirement, committed before any value leaves. */
export async function recordRequirementSecretRead(read: RequirementSecretRead): Promise<void> {
  await db.insert(requirementSecretReads).values(read);
}

/** The refs each requirement-judge session read, by the project they were read in. */
export async function requirementSecretRefsOfSession(
  sessionId: string,
): Promise<Array<{ projectId: string; refs: string[] }>> {
  const rows = (await db.execute(sql`
    SELECT r.project_id, s.refs
      FROM requirement_secret_reads s JOIN requirements r ON r.id = s.requirement_id
     WHERE s.session_id = ${sessionId}
  `)) as unknown as Array<{ project_id: string; refs: string[] | null }>;
  return rows.map((r) => ({ projectId: r.project_id, refs: r.refs ?? [] }));
}
