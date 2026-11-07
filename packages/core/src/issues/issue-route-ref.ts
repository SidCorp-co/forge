// ISS-1160: the shared `:id` resolver for issue-scoped REST reads — uuid or
// display key (`ISS-1097`), key scoped by `?projectId=` since `issSeq` is
// unique per project, not globally (ISS-992), or by the one project a token
// is fenced to where it names none.

import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { fencedProjectIds } from '../credentials/pat-scope.js';
import { loadProjectAccess } from '../lib/authz.js';
import { issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { badRequest, notFound } from '../middleware/route-errors.js';
import { zValidator } from '../middleware/zod-validator.js';
import { requireDeclaredOr, requireHeld } from '../permissions/index.js';
import { heldIssuePrefixes } from './issue-prefix-read.js';
import {
  findIssueByDisplaySeq,
  findIssueById,
  type IssueRow,
  issueScopeOf,
} from './read-service.js';

const uuidSchema = z.uuid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
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

/** Where a route on an issue finds the project its declared permission is held on. */
export const ISSUE_PROJECT =
  'the project of the issue `:id` names (a display key with `?projectId=`)';

export const projectScopeQuerySchema = z.object({ projectId: z.uuid().optional() });

/**
 * The query of an issue read that takes no filter: only the project a display key in its path is
 * resolved in. Any other key is refused by name.
 */
export const projectScopeQuery = zValidator('query', projectScopeQuerySchema);

/**
 * The issue an id names, once the caller is shown to hold, on its project, what its route declares
 * (`permission` for a caller that declares none yet).
 */
export async function heldIssue(
  issueId: string,
  userId: string,
  permission: Parameters<typeof requireHeld>[1],
  act?: string,
) {
  const issue = await issueScopeOf(issueId);
  if (!issue) throw notFound('issue not found');
  requireDeclaredOr(await loadProjectAccess(issue.projectId, userId), permission, act);
  return issue;
}

export async function resolveIssueRouteRef(
  rawId: string,
  projectIdQuery: string | undefined,
  userId: string,
): Promise<IssueRow> {
  if (isUuid(rawId)) {
    const issue = await findIssueById(rawId);
    if (!issue) throw notFound('issue not found');
    // the issue's project, at what the route declares on it (read where it declares none yet)
    requireDeclaredOr(await loadProjectAccess(issue.projectId, userId), 'project.read');
    return issue;
  }

  const shapeOnly = parseIssueRef(rawId, []);
  if (!shapeOnly.ok && shapeOnly.code !== 'FOREIGN_PREFIX') {
    throw badRequest(malformedRefMessage(shapeOnly));
  }

  const projectId = projectIdQuery ?? onlyFencedProject();
  if (!projectId) {
    throw badRequest(needsProjectScopeMessage(rawId));
  }
  if (!isUuid(projectId)) {
    throw badRequest('`projectId` must be a uuid');
  }

  requireDeclaredOr(await loadProjectAccess(projectId, userId), 'project.read');

  const parsed = parseIssueRef(
    rawId,
    issueRefNeedsHeldPrefixes(rawId) ? await heldIssuePrefixes(projectId) : [],
  );
  if (!parsed.ok) throw badRequest(malformedRefMessage(parsed));

  const issue = await findIssueByDisplaySeq(projectId, parsed.issSeq);
  if (!issue) throw notFound(`\`${rawId}\` names no issue in this project`);
  return issue;
}

/**
 * The one project a token fenced to exactly one reaches: a display key it names without
 * `?projectId=` can only mean an issue there. A session, an unfenced token or a token fenced to
 * several projects has none, and is told to name the project.
 */
function onlyFencedProject(): string | undefined {
  const fence = fencedProjectIds();
  return fence?.length === 1 ? fence[0] : undefined;
}

// Layer A: caller already asserted its own `projectId` (e.g. `issue-step-contexts`).
export async function resolveIssueKeyInProject(rawId: string, projectId: string): Promise<string> {
  if (isUuid(rawId)) return rawId;
  const parsed = parseIssueRef(
    rawId,
    issueRefNeedsHeldPrefixes(rawId) ? await heldIssuePrefixes(projectId) : [],
  );
  if (!parsed.ok) throw badRequest(malformedRefMessage(parsed));
  const issue = await findIssueByDisplaySeq(projectId, parsed.issSeq);
  if (!issue) throw notFound(`\`${rawId}\` names no issue in this project`);
  return issue.id;
}

/** The uuid a display key names in a project, or `null` where it names none or is not a key it answers to. */
export async function issueIdOfKey(rawId: string, projectId: string): Promise<string | null> {
  try {
    return await resolveIssueKeyInProject(rawId, projectId);
  } catch (err) {
    if (err instanceof HTTPException) return null;
    throw err;
  }
}

/** Why a display key named no issue, said only to a caller shown to read the project. */
export async function refuseUnresolvedIssueKey(
  rawId: string,
  projectId: string,
  userId: string | undefined,
): Promise<void> {
  requireHeld(await loadProjectAccess(projectId, userId), 'project.read');
  await resolveIssueKeyInProject(rawId, projectId);
}
