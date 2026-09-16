// The projects layer's half of ISS-992: a PATCH carrying `issuePrefix` becomes
// an assignment or a retirement, and a refusal becomes an HTTP refusal that
// says only what its caller is allowed to be told.

import { eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import {
  type AssignPrefixResult,
  assignIssuePrefix,
  type PrefixWriter,
  retireIssuePrefix,
} from '../issues/issue-prefix-service.js';
import { loadProjectAccess } from '../lib/authz.js';

async function readProjectName(projectId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return row?.name ?? null;
}

async function issuePrefixRefusal(
  refusal: Exclude<AssignPrefixResult, { ok: true }>,
  userId: string,
): Promise<HTTPException> {
  if (refusal.reason !== 'taken') {
    return new HTTPException(400, {
      message: refusal.message,
      cause: { code: 'BAD_REQUEST' },
    });
  }
  const holder = refusal.holderProjectId
    ? await loadProjectAccess(refusal.holderProjectId, userId)
    : null;
  const visible = holder?.role ? await readProjectName(refusal.holderProjectId as string) : null;
  return new HTTPException(409, {
    message: visible
      ? `that issue prefix is already held by the project \`${visible}\`. A prefix names one project for good, so it is never handed on.`
      : 'that issue prefix is already held by another project. A prefix names one project for good, so it is never handed on.',
    cause: { code: 'ISSUE_PREFIX_TAKEN' },
  });
}

export async function applyIssuePrefixPatch(
  projectId: string,
  value: string | null,
  userId: string,
  dbi: PrefixWriter,
): Promise<void> {
  if (value === null || value === '') {
    await retireIssuePrefix(projectId, dbi);
    return;
  }
  const assigned = await assignIssuePrefix(projectId, value, dbi);
  if (!assigned.ok) throw await issuePrefixRefusal(assigned, userId);
}
