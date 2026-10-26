// ISS-1160: the shared `:id` resolver for issue-scoped REST reads — uuid or
// display key (`ISS-1097`), key scoped by `?projectId=` since `issSeq` is
// unique per project, not globally (ISS-992).

import type { IssueReadRefusalDetails } from '@forge/contracts';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { effectiveProjectRole, loadProjectAccess, type ProjectAccess } from '../lib/authz.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { heldIssuePrefixes } from './issue-prefix-read.js';
import {
  findIssueByDisplaySeq,
  findIssueById,
  findProjectName,
  type IssueRow,
} from './read-service.js';

const uuidSchema = z.uuid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string, details: IssueReadRefusalDetails) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN', details } });

/** A project's name where this caller may see it: a role on it, or a place in its organization. */
async function nameShownTo(access: ProjectAccess | null): Promise<string | null> {
  if (!access || (access.role === null && access.orgRole === null)) return null;
  return findProjectName(access.projectId);
}

/**
 * The read refused for want of a role on the issue's project: which project that is, as far as the
 * caller may see it, and that the project the address named is not it — said only where the caller
 * holds a role on that project, so the refusal reads the same whichever project a caller with no role
 * there names, and never tells them which one holds the issue (ISS-1229 r42).
 */
async function closedIssueRefusal(
  issueAccess: ProjectAccess,
  addressProjectId: string | undefined,
  userId: string,
): Promise<HTTPException> {
  const issueName = await nameShownTo(issueAccess);
  const addressAccess =
    addressProjectId === undefined ? null : await effectiveProjectRole(userId, addressProjectId);
  const named = addressAccess?.role ? addressAccess.projectId : null;
  const addressName = named ? await findProjectName(named) : null;
  const owner = issueName ? `${issueName}, a project` : 'a project';
  const address = !named
    ? ''
    : addressName
      ? ` It is not in ${addressName}, the project this address names.`
      : ' It is not in the project this address names.';
  return forbidden(`This issue belongs to ${owner} you are not a member of.${address}`, {
    issueProject: { name: issueName },
    addressProject: named ? { id: named, name: addressName } : null,
  });
}

/**
 * A display key read under a project the caller holds no role on, or under an id that is no project:
 * the two read alike, so the refusal never says whether an id is a project (ISS-1229 r43).
 */
async function closedProjectRefusal(access: ProjectAccess | null): Promise<HTTPException> {
  const name = await nameShownTo(access);
  const project = name
    ? `${name} is a project you are not a member of`
    : 'This address names no project you are a member of';
  return forbidden(`${project}, so none of its issues can be read.`, {
    issueProject: { name },
    addressProject: null,
  });
}

const needsProjectScopeMessage = (raw: string): string =>
  `\`${raw}\` is not a uuid — it reads as a display key, like \`ISS-1097\` or its bare sequence ` +
  'number. A display key names one row inside one project only, so this route has to be told ' +
  'which project before it can look one up: pass `?projectId=<project uuid>` alongside it, or ' +
  "use the row's uuid instead.";

// A REST caller already ruled out uuid via `isUuid`, so a `SHAPE` refusal from
// the shared parser (whose own contract stops at the display-key example) is
// carrying an identifier that is neither shape — name both here.
const UUID_EXAMPLE = '123e4567-e89b-12d3-a456-426614174000';
const malformedRefMessage = (parsed: { code: string; message: string }): string =>
  parsed.code === 'SHAPE'
    ? `${parsed.message} Or a uuid, like \`${UUID_EXAMPLE}\`.`
    : parsed.message;

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
    if (!access.role) throw await closedIssueRefusal(access, projectIdQuery, userId);
    return issue;
  }

  const shapeOnly = parseIssueRef(rawId, []);
  if (!shapeOnly.ok && shapeOnly.code !== 'FOREIGN_PREFIX') {
    throw badRequest({ formErrors: [malformedRefMessage(shapeOnly)], fieldErrors: {} });
  }

  if (!projectIdQuery) {
    throw badRequest({ formErrors: [needsProjectScopeMessage(rawId)], fieldErrors: {} });
  }
  if (!isUuid(projectIdQuery)) {
    throw badRequest({ formErrors: ['`projectId` must be a uuid'], fieldErrors: {} });
  }

  const access = await effectiveProjectRole(userId, projectIdQuery);
  if (!access?.role) throw await closedProjectRefusal(access);

  const parsed = parseIssueRef(
    rawId,
    issueRefNeedsHeldPrefixes(rawId) ? await heldIssuePrefixes(projectIdQuery) : [],
  );
  if (!parsed.ok) throw badRequest({ formErrors: [malformedRefMessage(parsed)], fieldErrors: {} });

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
  if (!parsed.ok) throw badRequest({ formErrors: [malformedRefMessage(parsed)], fieldErrors: {} });
  const issue = await findIssueByDisplaySeq(projectId, parsed.issSeq);
  if (!issue) throw notFound(`\`${rawId}\` names no issue in this project`);
  return issue.id;
}
