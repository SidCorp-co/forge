// ISS-1160: the shared `:id` resolver for issue-scoped REST reads — uuid or
// display key (`ISS-1097`), key scoped by `?projectId=` since `issSeq` is
// unique per project, not globally (ISS-992).

import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { loadProjectAccess } from '../lib/authz.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { heldIssuePrefixes } from './issue-prefix-read.js';
import { findIssueByDisplaySeq, findIssueById, type IssueRow } from './read-service.js';

const uuidSchema = z.uuid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

const needsProjectScopeMessage = (raw: string): string =>
  `\`${raw}\` is not a uuid — it reads as a display key, like \`ISS-1097\` or its bare sequence ` +
  'number. A display key names one row inside one project only, so this route has to be told ' +
  'which project before it can look one up: pass `?projectId=<project uuid>` alongside it, or ' +
  "use the row's uuid instead.";

export const issueRouteIdParamSchema = z.object({ id: z.string().trim().min(1).max(200) });

export const projectScopeQuerySchema = z.object({ projectId: z.uuid().optional() });

export async function resolveIssueRouteRef(
  rawId: string,
  projectIdQuery: string | undefined,
  userId: string,
): Promise<IssueRow> {
  if (isUuid(rawId)) {
    const issue = await findIssueById(rawId);
    if (!issue) throw notFound('issue not found');
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');
    return issue;
  }

  const shapeOnly = parseIssueRef(rawId, []);
  if (!shapeOnly.ok && shapeOnly.code !== 'FOREIGN_PREFIX') {
    throw badRequest({ formErrors: [shapeOnly.message], fieldErrors: {} });
  }

  if (!projectIdQuery) {
    throw badRequest({ formErrors: [needsProjectScopeMessage(rawId)], fieldErrors: {} });
  }
  if (!isUuid(projectIdQuery)) {
    throw badRequest({ formErrors: ['`projectId` must be a uuid'], fieldErrors: {} });
  }

  const access = await loadProjectAccess(projectIdQuery, userId);
  if (!access.role) throw forbidden('not a project member');

  const parsed = parseIssueRef(
    rawId,
    issueRefNeedsHeldPrefixes(rawId) ? await heldIssuePrefixes(projectIdQuery) : [],
  );
  if (!parsed.ok) throw badRequest({ formErrors: [parsed.message], fieldErrors: {} });

  const issue = await findIssueByDisplaySeq(projectIdQuery, parsed.issSeq);
  if (!issue) throw notFound(`\`${rawId}\` names no issue in this project`);
  return issue;
}

// Layer A: caller already asserted its own `projectId` (e.g. `issue-step-contexts`).
export async function resolveIssueKeyInProject(rawId: string, projectId: string): Promise<string> {
  if (isUuid(rawId)) return rawId;
  const parsed = parseIssueRef(
    rawId,
    issueRefNeedsHeldPrefixes(rawId) ? await heldIssuePrefixes(projectId) : [],
  );
  if (!parsed.ok) throw badRequest({ formErrors: [parsed.message], fieldErrors: {} });
  const issue = await findIssueByDisplaySeq(projectId, parsed.issSeq);
  if (!issue) throw notFound(`\`${rawId}\` names no issue in this project`);
  return issue.id;
}
