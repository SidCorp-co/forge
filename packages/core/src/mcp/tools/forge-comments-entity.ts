import {
  COMMENT_SCOPES,
  CREATE_ENTITY_COMMENT_SHAPE,
  createEntityCommentRequestSchema,
  decisionFieldsSchema,
  EDIT_ENTITY_COMMENT_SHAPE,
  type EntityCommentScope,
  editEntityCommentRequestSchema,
} from '@forge/contracts/comments';
import { z } from 'zod';
import { type PatPermission, patGrantCovers } from '../../auth/pat-permissions.js';
import {
  commentRowIn,
  type EntityCommentActor,
  listDecisionsAs,
  listEntityCommentsAs,
  placeOfComment,
} from '../../comments/entity-read.js';
import { recordKeptRefusal, scopeRefusal } from '../../comments/entity-rules.js';
import {
  type EntityCommentOutcome,
  editEntityComment,
  postEntityComment,
} from '../../comments/entity-service.js';
import { db } from '../../db/client.js';
import { COMMENT_INTENTS } from '@forge/contracts/record-events';
import {
  assertPrincipalIsMember,
  assertPrincipalIsWriter,
  type McpContext,
  principalAgency,
  principalAuthorDeviceId,
  refusedAnswer,
  resolveEffectiveProjectId,
} from './lib.js';

type Principal = Parameters<typeof assertPrincipalIsWriter>[0];

const ref = z.string().trim().min(1).max(200);

export const entityTargetFields = {
  requirement: ref.optional(),
  workflow: ref.optional(),
  feedback: ref.optional(),
};

export const entityDataFields = {
  ...entityTargetFields,
  decision: decisionFieldsSchema.optional(),
};

export const DECISIONS_FILTER = z.enum(COMMENT_SCOPES).optional();

interface Named {
  issue?: string | undefined;
  requirement?: string | undefined;
  workflow?: string | undefined;
  feedback?: string | undefined;
}

export type EntityPick =
  | { kind: 'issue' }
  | { kind: 'entity'; scope: EntityCommentScope; ref: string }
  | { kind: 'refused'; answer: ReturnType<typeof refusedAnswer> };

export function pickTarget(named: Named | undefined, path: string): EntityPick {
  const n = named ?? {};
  const refusal = scopeRefusal(
    {
      issueId: n.issue,
      requirementId: n.requirement,
      workflowId: n.workflow,
      feedbackId: n.feedback,
    },
    path,
  );
  if (refusal) return { kind: 'refused', answer: refusedAnswer([refusal], refusal.code) };
  if (n.issue) return { kind: 'issue' };
  const scope: EntityCommentScope = n.requirement
    ? 'requirement'
    : n.workflow
      ? 'workflow'
      : 'feedback';
  return { kind: 'entity', scope, ref: (n.requirement ?? n.workflow ?? n.feedback) as string };
}

// cm:guard a comment on a requirement, design or feedback item is project content, so this door asks
// the projects grant /api/projects asks, beside the issues grant the tool declares per action
function assertEntityGrant(ctx: McpContext, principal: Principal, wanted: PatPermission): void {
  const granted = ctx.grant !== undefined ? ctx.grant : principal.permissions;
  if (patGrantCovers(granted, wanted)) return;
  throw new Error(
    `FORBIDDEN: forge_comments on a requirement, workflow or feedback item needs '${wanted}' beside its issues grant, as /api/projects does, and this token was not granted it. Nothing was done.`,
  );
}

const actorOf = (principal: Principal): EntityCommentActor => ({
  userId: principal.userId,
  agency: principalAgency(principal),
});

function answered(outcome: EntityCommentOutcome) {
  if (!outcome.ok) return refusedAnswer(outcome.refusals, 'COMMENT_REFUSED');
  return { comment: outcome.comment, created: outcome.created };
}

export async function listEntity(
  ctx: McpContext,
  principal: Principal,
  pick: { scope: EntityCommentScope; ref: string },
  input: { projectId?: string | undefined; intent?: string | undefined },
) {
  assertEntityGrant(ctx, principal, 'projects:read');
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  await assertPrincipalIsMember(principal, projectId);
  const intent = z.enum(COMMENT_INTENTS).optional().safeParse(input.intent);
  if (!intent.success) {
    throw new Error(`BAD_REQUEST: filters.intent is one of ${COMMENT_INTENTS.join(' | ')}`);
  }
  return listEntityCommentsAs(
    actorOf(principal),
    projectId,
    pick.scope,
    pick.ref,
    { intent: intent.data },
    { providerBound: true },
  );
}

export async function createEntity(
  ctx: McpContext,
  principal: Principal,
  pick: { scope: EntityCommentScope; ref: string },
  input: { projectId?: string | undefined; data: Record<string, unknown> },
) {
  assertEntityGrant(ctx, principal, 'projects:write');
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  await assertPrincipalIsWriter(principal, projectId);
  const { body, format, parentId, intent, decision } = input.data;
  const parsed = createEntityCommentRequestSchema.safeParse({
    body,
    format,
    parentId,
    intent,
    decision,
  });
  if (!parsed.success) throw new Error(`BAD_REQUEST: data is ${CREATE_ENTITY_COMMENT_SHAPE}`);
  return answered(
    await postEntityComment({
      projectId,
      scope: pick.scope,
      ref: pick.ref,
      author: { ...actorOf(principal), deviceId: principalAuthorDeviceId(principal) },
      request: parsed.data,
      door: { providerBound: true },
    }),
  );
}

export async function updateEntity(
  ctx: McpContext,
  principal: Principal,
  commentId: string,
  data: Record<string, unknown>,
) {
  const row = await commentRowIn(db, commentId);
  if (!row || row.issueId) return null;
  assertEntityGrant(ctx, principal, 'projects:write');
  const place = await placeOfComment(db, row);
  await assertPrincipalIsWriter(principal, place.projectId);
  const { body, format, decision } = data;
  const parsed = editEntityCommentRequestSchema.safeParse({ body, format, decision });
  if (!parsed.success) throw new Error(`BAD_REQUEST: data is ${EDIT_ENTITY_COMMENT_SHAPE}`);
  return answered(
    await editEntityComment({
      projectId: place.projectId,
      scope: place.scope,
      ref: place.targetId,
      commentId,
      actor: actorOf(principal),
      request: parsed.data,
      door: { providerBound: true },
    }),
  );
}

export async function entityDeleteRefusal(commentId: string) {
  const row = await commentRowIn(db, commentId);
  if (!row || row.issueId) return null;
  const place = await placeOfComment(db, row);
  const refusal = recordKeptRefusal(commentId, place.scope);
  return refusedAnswer([refusal], refusal.code);
}

export async function listDecisions(
  ctx: McpContext,
  principal: Principal,
  input: { projectId?: string | undefined; scope?: string | undefined; limit?: number | undefined },
) {
  const scope = DECISIONS_FILTER.safeParse(input.scope);
  if (!scope.success) {
    throw new Error(`BAD_REQUEST: filters.scope is one of ${COMMENT_SCOPES.join(' | ')}`);
  }
  if (scope.data !== 'issue') assertEntityGrant(ctx, principal, 'projects:read');
  const projectId = await resolveEffectiveProjectId(ctx, input.projectId);
  await assertPrincipalIsMember(principal, projectId);
  return listDecisionsAs(
    actorOf(principal),
    projectId,
    { scope: scope.data, limit: input.limit },
    { providerBound: true },
  );
}
