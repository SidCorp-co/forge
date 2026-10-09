import {
  contentLanguageScriptWarning,
  releaseNoteReferenceWarning,
} from '@forge/contracts/content-language';
import { diffFieldValue } from '@forge/contracts/field-changes';
import { Hono } from 'hono';
import { loadProjectAccess } from '../lib/authz.js';
import { egressForRequest } from '../lib/data-egress.js';
import { logger } from '../lib/logger.js';
import { refused } from '../lib/refusal.js';
import { writtenLangFor } from '../lib/written-lang.js';
import { type AuthVars, assertEmailVerified, requireAuth, restActor } from '../middleware/auth.js';
import { holdChatWrite } from '../middleware/chat-write-hold.js';
import { zValidator } from '../middleware/zod-validator.js';
import { hydrateAgentSessionsForIssues } from './agent-sessions-hydrator.js';
import { heldTakeRefusal } from './blocked-by.js';
import { serializeIssue } from './detail-projection.js';
import { activeIssuePrefix } from './issue-prefix-read.js';
import {
  issueRouteIdParamSchema,
  projectScopeQuerySchema,
  resolveIssueRouteRef,
} from './issue-route-ref.js';
import {
  assertAssigneeIsMember,
  patchBodyAnswer,
  refuseUpdate,
  toHttpCreateError,
} from './issue-write-refusals.js';
import { type ResolvedLabelAttach, resolveLabelIdsForWrite } from './label-service.js';
import { readLandingShape } from './landing-evidence.js';
import { isSelfReferentialBranch } from './metadata.js';
import { collectIssueFieldUpdates, SHARED_ISSUE_PATCH_FIELDS } from './patch-fields.js';
import { issueDetailOf } from './project-issue-routes.js';
import { findIssueById, type IssueRow } from './read-service.js';
import { issuePatchSchema } from './request-schemas.js';
import { deleteIssue } from './service.js';
import { updateIssueFields } from './update-service.js';

export {
  branchConfigOverrideSchema,
  branchNameSchema,
  isSelfReferentialBranch,
  issueMetadataSchema,
} from './metadata.js';

import { idParamSchema, notFound } from '../middleware/route-errors.js';
import { requireHeld } from '../permissions/index.js';
import { deleteMemory, issueDeleteRefusal, readProjectDocument } from './ports.js';

export { bodyRoutes } from '../body/routes.js';

export const issueRoutes = new Hono<{ Variables: AuthVars }>();
issueRoutes.use('*', requireAuth(), assertEmailVerified());

async function loadIssue(issueId: string): Promise<IssueRow> {
  const row = await findIssueById(issueId);
  if (!row) throw notFound('issue not found');
  return row;
}

issueRoutes.get(
  '/:id',
  zValidator('param', issueRouteIdParamSchema),
  zValidator('query', projectScopeQuerySchema),
  async (c) => {
    const { id: rawId } = c.req.valid('param');
    const { projectId: projectIdQuery } = c.req.valid('query');
    const userId = c.get('userId');

    const resolved = await resolveIssueRouteRef(rawId, projectIdQuery, userId);
    const issue = await egressForRequest(
      restActor(c).agency,
      resolved.projectId,
      'issue',
      resolved,
      rawId,
    );
    const agentBucket = (await hydrateAgentSessionsForIssues(issue.projectId, [issue.id])).get(
      issue.id,
    );
    return c.json({
      ...(await issueDetailOf(issue)),
      agentSessions: agentBucket?.agentSessions ?? [],
      agentStatus: agentBucket?.agentStatus ?? null,
    });
  },
);

issueRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema),
  zValidator('json', issuePatchSchema, patchBodyAnswer),
  holdChatWrite('issue_change'),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    const userId = c.get('userId');

    const issue = await loadIssue(id);
    const access = await loadProjectAccess(issue.projectId, userId);
    requireHeld(access, 'project.write');

    if (patch.assigneeId) await assertAssigneeIsMember(issue.projectId, patch.assigneeId);
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
      if (diffFieldValue(field, prev, next).length > 0) {
        changedFields.push(field);
        before[field] = prev;
        after[field] = next;
      }
    };
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
    // a rewritten title or body is stored with the language its writer wrote it in; a declared
    // language alone restates the language of the text as it stands
    if (
      updates.title !== undefined ||
      updates.description !== undefined ||
      patch.writtenLang !== undefined
    ) {
      updates.writtenLang = await writtenLangFor(
        { userId, agency: restActor(c).agency },
        issue.projectId,
        patch.writtenLang ?? null,
        undefined,
        [updates.title ?? issue.title, updates.description ?? issue.description].join('\n'),
      );
    }
    if (patch.metadata !== undefined) {
      const baseRaw = patch.metadata?.branchConfig?.baseBranch;
      if (typeof baseRaw === 'string' && isSelfReferentialBranch(baseRaw, issue.issSeq)) {
        throw refuseUpdate(
          'BRANCH_SELF_REFERENCE',
          "baseBranch must not reference this issue's own branch; name the branch this work is based on",
          '/metadata/branchConfig/baseBranch',
        );
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
        ...(patch.workState ? { workState: patch.workState } : {}),
        actor,
        changes: { fields: changedFields, before, after },
      });
    } catch (err) {
      throw heldTakeRefusal(err) ?? err;
    }

    const patched = serializeIssue(
      updated,
      await activeIssuePrefix(issue.projectId),
      await readLandingShape(issue.projectId),
    );
    const warnings = [...collected.warnings];
    const note = patch.releaseNotes;
    if (note && note.section !== 'Skip') {
      const held = await readProjectDocument(issue.projectId);
      const language = held?.document.contentLanguage ?? 'en';
      const mismatch = contentLanguageScriptWarning(
        language,
        note.userFacing,
        'releaseNotes.userFacing',
      );
      if (mismatch) warnings.push(mismatch);
      const references = releaseNoteReferenceWarning(note.userFacing, 'releaseNotes.userFacing');
      if (references) warnings.push(references);
    }
    return c.json(warnings.length > 0 ? { ...patched, warnings } : patched);
  },
);

issueRoutes.delete('/:id', zValidator('param', idParamSchema), async (c) => {
  const { id } = c.req.valid('param');
  const userId = c.get('userId');

  const issue = await loadIssue(id);
  const access = await loadProjectAccess(issue.projectId, userId);
  requireHeld(access, 'project.admin');

  const carried = await issueDeleteRefusal(issue);
  if (carried) return refused(c, [carried], carried.code);

  await deleteIssue(id);

  queueMicrotask(() => {
    deleteMemory(issue.projectId, 'issue', id).catch((err) => {
      logger.warn(
        { err: (err as Error).message, issueId: id, projectId: issue.projectId },
        'issues.delete: memory cleanup failed',
      );
    });
  });

  return c.body(null, 204);
});

export { issueActivityRoutes, projectActivityRoutes } from './activity-routes.js';
export { attachmentRoutes, issueAttachmentRoutes } from './attachment-routes.js';
export { issueCheckRunRoutes } from './check-run-routes.js';
export { issueCriteriaRoutes } from './criteria/routes.js';
export { issueDependencyRoutes } from './dependency-routes.js';
export { issueExtrasRoutes } from './extras-routes.js';
export { issueGraphRoutes } from './graph-routes.js';
export { issueMergeRoutes } from './merge-routes.js';
export { issuePatternRoutes } from './pattern-routes.js';
export { issueProjectRoutes } from './project-issue-routes.js';
export { searchRoutes } from './search.js';
export { issueStandingRoutes } from './standing-routes.js';
export { transitionRoutes } from './transition.js';
