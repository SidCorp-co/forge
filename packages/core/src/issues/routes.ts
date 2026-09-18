import { zValidator } from '@hono/zod-validator';
import { and, count, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { BodyInvalidError } from '../body/errors.js';
import { BODY_FORMATS } from '../body/formats.js';
import { bodyInvalidHttp } from '../body/http-error.js';
import type { BodyNode } from '../body/parse.js';
import { bodyNodes } from '../body/prepare.js';
import { registerIssueCommentRoutes } from '../comments/routes.js';
import { db } from '../db/client.js';
import {
  issueComplexities,
  issuePriorities,
  issueStatuses,
  issues,
  jobTypes,
  projectMembers,
} from '../db/schema.js';
import { assertProjectRole, loadProjectAccess } from '../lib/authz.js';
import { formatIssueRef, issueRefNeedsHeldPrefixes, parseIssueRef } from '../lib/issue-ref.js';
import { listResponse, paginationSchema } from '../lib/pagination.js';
import { queryBadRequest } from '../lib/query-strict.js';
import { logger } from '../logger.js';
import { deleteMemory } from '../memory/indexer.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { hooks } from '../pipeline/hooks.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { AttachmentError } from './attachment-service.js';
import { createIssue, IssueCreateError } from './create-service.js';
import { hydrateCreatorsForIssues } from './creator.js';
import { activeIssuePrefix, heldIssuePrefixes } from './issue-prefix-read.js';
import {
  LabelResolutionError,
  listIssueLabels,
  PrimaryModuleError,
  type ResolvedLabelAttach,
  resolveLabelIdsForWrite,
} from './label-service.js';
import { issueListPageQuery, serializeRestListRow } from './list-projection.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from './patch-fields.js';
import { safeHydratePipelineHealthForIssues } from './pipeline-health.js';
import { findIssueByDisplaySeq, findIssueById, type IssueRow } from './read-service.js';
import { issueRelationInputSchema } from './relations-service.js';
import { jobHistoryForStep } from './search.js';
import { sessionContextExpectSchema, sessionContextSchema } from './session-context.js';
import { buildIssueOrderBy, issueSortValues } from './sort.js';
import {
  IssueUpdateNotFound,
  SessionContextExpectMismatch,
  updateIssueFields,
} from './update-service.js';

const attachmentInputSchema = z
  .object({
    name: z.string().min(1).max(200),
    mime: z.string().min(1).max(255),
    dataBase64: z.string().min(1),
  })
  .strict();

import { isSelfReferentialBranch, issueMetadataSchema } from './metadata.js';

export {
  branchConfigOverrideSchema,
  branchNameSchema,
  isSelfReferentialBranch,
  issueMetadataSchema,
} from './metadata.js';

import { withKernelMarker } from '../db/kernel-marker.js';
import { ReleaseNotesSchema } from './release-notes.js';

// cm:guard the object arm's `labelId` accepts a NAME or a uuid, exactly as the bare string does — both arms go through `resolveLabelIdsForWrite`, so a caller can never have one value mean an id here and a name there. `isPrimary` is legal only on a `kind='module'` label; the resolver refuses the rest with PRIMARY_NOT_MODULE / MULTIPLE_PRIMARY.
const labelAttachItemSchema = z.union([
  z.string().trim().min(1),
  z
    .object({
      labelId: z.string().trim().min(1),
      isPrimary: z.boolean().optional(),
    })
    .strict(),
]);

export const issueCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    description: z.string().max(100_000).nullable().optional(),
    descriptionFormat: z.enum(BODY_FORMATS).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    reportedBy: z.string().trim().min(1).max(200).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    labels: z.array(labelAttachItemSchema).max(100).optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    detectorKey: z.string().trim().min(1).max(120).optional(),
    relations: z.array(issueRelationInputSchema).max(20).optional(),
    // cm:why ISS-130 / ISS-236 — the F4 transition endpoint owns every post-creation status change; this allow-list exists only so a caller can park at `on_hold` atomically with the insert, or hold an AI-generated proposal (Dream / Doc-Sync) at `draft` until a human promotes or discards it
    status: z.enum(['open', 'on_hold', 'draft']).optional(),
  })
  .strict();

export type IssueCreateInput = z.infer<typeof issueCreateSchema>;

export const issuePatchSchema = z
  .object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().max(100_000).nullable().optional(),
    descriptionFormat: z.enum(BODY_FORMATS).optional(),
    priority: z.enum(issuePriorities).optional(),
    category: z.string().trim().min(1).max(100).nullable().optional(),
    complexity: z.enum(issueComplexities).nullable().optional(),
    plan: z.string().max(200_000).nullable().optional(),
    acceptanceCriteria: z.string().max(100_000).nullable().optional(),
    assigneeId: z.uuid().nullable().optional(),
    labels: z.array(labelAttachItemSchema).max(100).optional(),
    metadata: issueMetadataSchema.optional(),
    releaseNotes: ReleaseNotesSchema.nullable().optional(),
    // cm:guard these two were MCP-only until the CLI needed them, and they are the reason `sessionContextSchema` is imported rather than re-declared: `sessionContext.branch` is what `pipeline/work-evidence.ts` reads as proof that work exists, so an agent that cannot write it here cannot satisfy the very evidence gate this surface now enforces. Widening it to REST also hands it to a browser session, which is deliberate — a person may edit it, and the ISS-820 verified-claim walk still applies to them.
    sessionContext: sessionContextSchema,
    detectorKey: z.string().trim().min(1).max(120).optional(),
    // cm:guard ISS-959 — `expect` is a PRECONDITION, not a field: it must never reach `SHARED_ISSUE_PATCH_FIELDS`, or the value a client read back would be written to a column. The refine below is what keeps it from standing alone — a compare-and-set with nothing to write is a read wearing a write's verb, and it would still bump `updated_at`.
    expect: sessionContextExpectSchema.optional(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'no fields to update' })
  .refine((o) => Object.keys(o).some((k) => k !== 'expect'), {
    message: '`expect` is a precondition on a write — send the field(s) to write alongside it',
  });

export type IssuePatchInput = z.infer<typeof issuePatchSchema>;

// cm:guard the STRING survives validation, not a number — which prefix is legal depends on the project the request is scoped to, and this schema has no project. `parseIssueRef` in the handler is what refuses a foreign prefix by name; widening the shape here to swallow one would answer a caller's cross-project reference with this project's issue of that number (ISS-992).
const issueKeyFilterSchema = z
  .string()
  .trim()
  .regex(
    /^(?:[A-Za-z][A-Za-z0-9]{1,5}-)?\d{1,10}$/,
    'expected a display id like `ISS-42`, or its bare sequence number',
  );

// cm:guard `.strict()` is the whole point of this schema, not a flourish: without it zod STRIPS an unregistered key, the handler builds its WHERE from the four it knows, and a filtered ask is answered with the project's unfiltered list at 200 (ISS-991). `list-query-strict.test.ts` is the case that goes red if it is removed.
export const issueFiltersSchema = paginationSchema
  .extend({
    status: z.enum(issueStatuses).optional(),
    priority: z.enum(issuePriorities).optional(),
    assigneeId: z.uuid().optional(),
    category: z.string().trim().min(1).max(100).optional(),
    // cm:why the filter ISS-991's caller reached for and did not have — it asked this route for `ISS-376` by hand. Scoping stays the project's: the `key` condition is ANDed onto `projectId`, so a sequence number another project holds matches nothing here.
    key: issueKeyFilterSchema.optional(),
    sort: z.enum(issueSortValues).optional().default('createdAt:desc'),
    // cm:why default false rather than true: hydration is a second query per page, and the callers that want sessions are the two screens that render them
    withAgentSessions: z.coerce.boolean().optional().default(false),
  })
  .strict();

export type IssueFilters = z.infer<typeof issueFiltersSchema>;

const projectIdParamSchema = z.object({ id: z.uuid() });
const issueIdParamSchema = z.object({ id: z.uuid() });

const badRequest = (details: unknown) =>
  new HTTPException(400, { message: 'Invalid input', cause: { code: 'BAD_REQUEST', details } });

const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const forbidden = (message: string) =>
  new HTTPException(403, { message, cause: { code: 'FORBIDDEN' } });

// cm:guard the CURRENT value must travel with the refusal. A bare 409 tells the loser its write failed and nothing about what to do next, so the only move left is to read again and write unconditionally — which is the overwrite this refusal exists to prevent.
const sessionContextMoved = (err: SessionContextExpectMismatch) =>
  new HTTPException(409, {
    message:
      '`sessionContext` no longer holds the value this write expected — another writer moved it. ' +
      'Re-read it from `details.current`, decide whether your claim still stands, and send the write again with the new `expect`.',
    cause: { code: 'SESSION_CONTEXT_MISMATCH', details: { current: err.current } },
  });

interface IssueBodyColumns {
  description?: string | null;
  descriptionFormat?: string | null;
}

// cm:guard the tree ships from HERE, the one projection both issue-detail surfaces already share, and never from a call site. web-v2 has no `@forge/core` dependency and cannot parse a component body, so a surface that forgets the field renders literal `<forge-…>` markup with every unit test still green (ISS-967).
function serializeIssue<T extends { issSeq: number } & IssueBodyColumns>(
  row: T,
  prefix: string | null,
): T & { displayId: string; descriptionNodes: BodyNode[] | null } {
  return {
    ...row,
    displayId: formatIssueRef(prefix, row.issSeq),
    descriptionNodes: bodyNodes(row.description ?? '', row.descriptionFormat),
  };
}

async function assertAssigneeIsMember(projectId: string, assigneeId: string): Promise<void> {
  const [row] = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, assigneeId)))
    .limit(1);
  if (!row) {
    throw new HTTPException(400, {
      message: 'assignee must be a project member',
      cause: { code: 'ASSIGNEE_NOT_MEMBER' },
    });
  }
}

// cm:why the ISS-967 body routes are re-exported through here rather than imported straight into `index.ts`: `.arch.baseline.json` freezes that file's fan-out at 48 modules with `improves: down`, so a 49th — `core-body` — is refused outright and there is no widening available. This module is where the choice belongs anyway: it already owns issue bodies, already imports `core-body` (so this costs its own frozen 7 nothing), and already hosts the comment surface via `registerIssueCommentRoutes`. `index.ts` stays a mount list.
export { bodyRoutes } from '../body/routes.js';

export const issueProjectRoutes = new Hono<{ Variables: AuthVars }>();
issueProjectRoutes.use('*', requireAuth(), assertEmailVerified());

issueProjectRoutes.post(
  '/:id/issues',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', issueCreateSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const input = c.req.valid('json');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    assertProjectRole(access, 'member');

    if (input.assigneeId) await assertAssigneeIsMember(projectId, input.assigneeId);

    let result: Awaited<ReturnType<typeof createIssue>>;
    try {
      result = await createIssue(
        { ...input, projectId },
        { createdById: userId, createdVia: 'web', actor: restActor(c) },
      );
    } catch (err) {
      throw toHttpCreateError(err);
    }

    // cm:why a detectorKey that already tracks a live issue is a successful no-op, not a conflict — the caller asked for "one issue per detector" and got it; 200 says nothing was created without making it an error the client must special-case as a failure
    if (result.deduped) return c.json(result, 200);

    const response: Record<string, unknown> = serializeIssue(
      result.issue as IssueRow,
      await activeIssuePrefix(projectId),
    );
    response.attachments = result.attachments;
    if (result.attachmentErrors.length > 0) response.attachmentErrors = result.attachmentErrors;
    if (result.relations.length > 0) response.relations = result.relations;
    if (result.bodyWarnings.length > 0) response.warnings = result.bodyWarnings;
    return c.json(response, 201);
  },
);

// cm:edge lockstep -> packages/core/src/issues/create-service.ts — every error the create service can raise needs a case here, or it surfaces as an unmapped 500
function toHttpCreateError(err: unknown): unknown {
  if (err instanceof BodyInvalidError) return bodyInvalidHttp(err);
  if (err instanceof LabelResolutionError) {
    return new HTTPException(400, {
      message: 'one or more labels do not exist in this project',
      cause: { code: 'INVALID_LABELS', details: { missing: err.missing } },
    });
  }
  if (err instanceof PrimaryModuleError) {
    return new HTTPException(400, { message: err.message, cause: { code: err.code } });
  }
  if (err instanceof AttachmentError) {
    return new HTTPException(400, { message: err.message, cause: { code: err.code } });
  }
  if (err instanceof IssueCreateError) {
    const code = err.code;
    return new HTTPException(400, { message: `${code}: ${err.value}`, cause: { code } });
  }
  return err;
}

const displayIdParamSchema = z.object({
  id: z.uuid(),
  displayId: z.string().regex(/^[A-Za-z][A-Za-z0-9]{1,5}-\d+$/),
});

issueProjectRoutes.get(
  '/:id/issues/by-display/:displayId',
  zValidator('param', displayIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id: projectId, displayId } = c.req.valid('param');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const parsed = parseIssueRef(
      displayId,
      issueRefNeedsHeldPrefixes(displayId) ? await heldIssuePrefixes(projectId) : [],
    );
    if (!parsed.ok) throw badRequest({ formErrors: [parsed.message], fieldErrors: {} });
    const issue = await findIssueByDisplaySeq(projectId, parsed.issSeq);
    if (!issue) throw notFound('issue not found');

    const labelRows = await listIssueLabels(issue.id);

    const serialized = serializeIssue(issue, await activeIssuePrefix(projectId));
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, [issue.id]);
    const creatorMap = await hydrateCreatorsForIssues([
      { id: issue.id, createdById: issue.createdById, createdVia: issue.createdVia, creatorAgency: issue.creatorAgency },
    ]);
    return c.json({
      ...serialized,
      ...creatorMap.get(issue.id),
      pipelineHealth: healthMap.get(issue.id) ?? { stage: serialized.status },
      labels: labelRows,
      comments: [],
      activity: [],
    });
  },
);

issueProjectRoutes.get(
  '/:id/issues',
  zValidator('param', projectIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', issueFiltersSchema, (r) => {
    if (!r.success) throw queryBadRequest(issueFiltersSchema, r.error);
  }),
  async (c) => {
    const { id: projectId } = c.req.valid('param');
    const q = c.req.valid('query');
    const userId = c.get('userId');

    const access = await loadProjectAccess(projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const conditions = [eq(issues.projectId, projectId)];
    if (q.status) conditions.push(eq(issues.status, q.status));
    if (q.priority) conditions.push(eq(issues.priority, q.priority));
    if (q.assigneeId) conditions.push(eq(issues.assigneeId, q.assigneeId));
    if (q.category) conditions.push(eq(issues.category, q.category));
    if (q.key !== undefined) {
      const parsed = parseIssueRef(
        q.key,
        issueRefNeedsHeldPrefixes(q.key) ? await heldIssuePrefixes(projectId) : [],
      );
      if (!parsed.ok) throw badRequest({ formErrors: [parsed.message], fieldErrors: {} });
      conditions.push(eq(issues.issSeq, parsed.issSeq));
    }
    const where = conditions.length === 1 ? conditions[0] : and(...conditions);

    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(issues).where(where);

    // cm:why ISS-1016 — the page comes from `issueListPageQuery` and not from a `db.select()` here, so the plan the index tests EXPLAIN is the plan this handler runs. `sort=createdAt:desc` and `updatedAt:desc` are served by `issues_project_created_at_idx` / `issues_project_updated_at_idx`; the two `priority` sorts order by a CASE expression, which no btree serves, and still sort.
    const rows = await issueListPageQuery({
      where,
      orderBy: buildIssueOrderBy(q.sort),
      limit: q.limit,
      offset: q.offset,
    });

    const total = Number(n);

    const listPrefix = await activeIssuePrefix(projectId);
    // cm:guard `serializeRestListRow` and NOT `serializeIssue`: the latter also grafts `descriptionNodes`, parsed from a column this projection no longer reads, and its body columns are OPTIONAL — so a projected row type-checks through it and answers `descriptionNodes: null` on every row of every page. A list that says nothing about a body beats one that says the body is empty (ISS-1016).
    const serialized = rows.map((r) => serializeRestListRow(r, listPrefix));
    if (serialized.length === 0) {
      return c.json(listResponse(c, serialized, total, q));
    }

    // cm:why pipelineHealth is hydrated unconditionally here while `agentSessions` is opt-in above, and the asymmetry is measured: this is 6 queries flat regardless of page size, and every row on the list renders a gate-aware badge from it (ISS-164).
    const ids = serialized.map((r) => r.id);
    const healthMap = await safeHydratePipelineHealthForIssues(projectId, ids);
    // cm:why no opt-in flag here — every list/detail surface needs the creator fields, unlike withCost/withAgentSessions
    const creatorMap = await hydrateCreatorsForIssues(
      serialized.map((r) => ({ id: r.id, createdById: r.createdById, createdVia: r.createdVia, creatorAgency: r.creatorAgency })),
    );

    if (!q.withAgentSessions) {
      return c.json(
        listResponse(
          c,
          serialized.map((r) => ({
            ...r,
            ...creatorMap.get(r.id),
            pipelineHealth: healthMap.get(r.id) ?? { stage: r.status },
          })),
          total,
          q,
        ),
      );
    }

    const map = await hydrateAgentSessionsForIssues(projectId, ids);
    return c.json(
      listResponse(
        c,
        serialized.map((r) => {
          const bucket = map.get(r.id);
          return {
            ...r,
            ...creatorMap.get(r.id),
            agentSessions: bucket?.agentSessions ?? [],
            agentStatus: bucket?.agentStatus ?? null,
            pipelineHealth: healthMap.get(r.id) ?? { stage: r.status },
          };
        }),
        total,
        q,
      ),
    );
  },
);

export const issueRoutes = new Hono<{ Variables: AuthVars }>();
issueRoutes.use('*', requireAuth(), assertEmailVerified());

registerIssueCommentRoutes(issueRoutes);
// cm:why the issue attachment endpoints are a SEPARATE router (`issueAttachmentRoutes`, mounted at /api/issues in index.ts) rather than registered here: this router applies `requireAuth()` to everything, and those two endpoints must also accept a PAT and a device credential — mounting them here would silently narrow that to browser sessions.

async function loadIssue(issueId: string): Promise<IssueRow> {
  const row = await findIssueById(issueId);
  if (!row) throw notFound('issue not found');
  return row;
}

issueRoutes.get(
  '/:id',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    const labelRows = await listIssueLabels(id);

    const healthMap = await safeHydratePipelineHealthForIssues(issue.projectId, [issue.id]);
    const serialized = serializeIssue(issue, await activeIssuePrefix(issue.projectId));
    // cm:guard the detail payload hydrates `agentStatus` like the list and search payloads do — without it PipelineTracker falls back to a status-only bead and an issue whose agent FAILED still draws green (ISS-308).
    const agentMap = await hydrateAgentSessionsForIssues(issue.projectId, [issue.id]);
    const agentBucket = agentMap.get(issue.id);
    const creatorMap = await hydrateCreatorsForIssues([
      { id: issue.id, createdById: issue.createdById, createdVia: issue.createdVia, creatorAgency: issue.creatorAgency },
    ]);
    return c.json({
      ...serialized,
      ...creatorMap.get(issue.id),
      agentSessions: agentBucket?.agentSessions ?? [],
      agentStatus: agentBucket?.agentStatus ?? null,
      pipelineHealth: healthMap.get(issue.id) ?? { stage: serialized.status },
      labels: labelRows,
      comments: [],
      activity: [],
    });
  },
);

// cm:edge contract -> packages/core/src/jobs/routes.ts — the rollup joins `usage_records` on `session_id = jobs.agent_session_id::text`, the same link `loadActualUsage` uses; let the two spellings drift and one surface prices a job the other reports at zero (ISS-202). Until ISS-1015 both spelled it `session_id::uuid = jobs.id`, which is a JOB id where the column holds an `agent_sessions.id`: measured on beta 2026-09-17, 0 of 24,085 usage rows matched any job id and 24,085 matched an agent session, so both surfaces priced every job at zero. The edge held the two in step and the step was wrong; it is the column this names, not merely that the two agree.
// cm:guard the LEFT JOIN is what keeps queued and running jobs in the history at tokens=0/cost=0 — an inner join drops every job that has not produced a usage row yet, and a step in flight vanishes from its own history
const jobHistoryQuerySchema = z.object({
  step: z.enum(jobTypes),
});

issueRoutes.get(
  '/:id/job-history',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('query', jobHistoryQuerySchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { step } = c.req.valid('query');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    if (!access.role) throw forbidden('not a project member');

    return c.json(await jobHistoryForStep(id, step));
  },
);

issueRoutes.patch(
  '/:id',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  zValidator('json', issuePatchSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'member');

    if (patch.assigneeId) await assertAssigneeIsMember(issue.projectId, patch.assigneeId);
    // cm:guard `undefined` means "no change" and `[]` means "clear every label" — collapsing the two makes an unrelated PATCH silently wipe the issue's labels
    let resolvedLabelIds: ResolvedLabelAttach[] | undefined;
    if (patch.labels !== undefined) {
      try {
        resolvedLabelIds = await resolveLabelIdsForWrite(issue.projectId, patch.labels);
      } catch (err) {
        throw toHttpCreateError(err);
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const changedFields: string[] = [];
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const track = (field: keyof IssueRow, next: unknown) => {
      const prev = issue[field];
      if (prev !== next) {
        changedFields.push(field);
        before[field] = prev;
        after[field] = next;
      }
    };
    // cm:edge lockstep -> packages/core/src/mcp/tools/forge-issues.ts — `SHARED_ISSUE_PATCH_FIELDS` is the one column list both update surfaces write from; a field added at either call site instead of in that array is a column one surface can set and the other cannot.
    let collected: ReturnType<typeof collectIssueFieldUpdates>;
    try {
      collected = collectIssueFieldUpdates(
        patch,
        [...SHARED_ISSUE_PATCH_FIELDS, 'assigneeId'],
        (f, v) => track(f as keyof IssueRow, v),
      );
    } catch (err) {
      throw toHttpCreateError(err);
    }
    Object.assign(updates, collected.updates);
    if (patch.metadata !== undefined) {
      const baseRaw = patch.metadata?.branchConfig?.baseBranch;
      if (typeof baseRaw === 'string' && isSelfReferentialBranch(baseRaw, issue.issSeq)) {
        throw new HTTPException(400, {
          message: "baseBranch must not reference this issue's own branch",
          cause: { code: 'BRANCH_SELF_REFERENCE' },
        });
      }
      updates.metadata = patch.metadata;
      track('metadata', patch.metadata);
    }

    const actor = restActor(c);

    let updated: IssueRow;
    try {
      updated = await updateIssueFields({
        issueId: id,
        updates,
        labelIds: resolvedLabelIds,
        ...(patch.expect ? { expect: patch.expect } : {}),
        actor,
      });
    } catch (err) {
      if (err instanceof IssueUpdateNotFound) throw notFound('issue not found');
      if (err instanceof SessionContextExpectMismatch) throw sessionContextMoved(err);
      throw err;
    }

    if (changedFields.length > 0) {
      await hooks.emit('issueUpdated', {
        issueId: id,
        projectId: issue.projectId,
        actor,
        fields: changedFields,
        before,
        after,
      });
    }

    const patched = serializeIssue(updated, await activeIssuePrefix(issue.projectId));
    return c.json(
      collected.warnings.length > 0 ? { ...patched, warnings: collected.warnings } : patched,
    );
  },
);

issueRoutes.delete(
  '/:id',
  zValidator('param', issueIdParamSchema, (r) => {
    if (!r.success) throw badRequest(z.flattenError(r.error));
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    assertProjectRole(access, 'admin', 'not a project admin');

    // cm:edge contract -> packages/core/drizzle/migrations/0219_unaudited_transition_reach.sql — `pipeline_runs.issue_id` is `ON DELETE CASCADE`, so this statement deletes kernel rows and owes the `forge.kernel_txn` marker; without it every issue delete is charged to the interventions metric as a hand on the database.
    await withKernelMarker(db, async (tx) => tx.delete(issues).where(eq(issues.id, id)));

    // cm:guard delete the issue's memory row too, and do it DETACHED. The row references the issue by `sourceRef` with no FK, so skipping it leaves the title and description searchable forever; awaiting it lets a memory-store failure fail a delete that already succeeded.
    queueMicrotask(() => {
      deleteMemory(issue.projectId, 'issue', id).catch((err) => {
        logger.warn(
          { err: (err as Error).message, issueId: id, projectId: issue.projectId },
          'issues.delete: memory cleanup failed',
        );
      });
    });

    return c.body(null, 204);
  },
);
