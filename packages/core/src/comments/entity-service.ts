import type {
  CommentRefusal,
  CreateEntityCommentRequest,
  DecisionFields,
  EditEntityCommentRequest,
  EntityCommentScope,
  EntityCommentView,
} from '@forge/contracts/comments';
import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import { eq } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { comments } from '../db/schema.js';
import { commentEvents } from '../db/schema-comments.js';
import { lockXact } from '../lib/advisory-lock.js';
import { dataPolicyOf, storedText } from '../lib/data-egress.js';
import { peopleOf } from '../lib/people.js';
import { notFound } from '../middleware/route-errors.js';
import {
  actorFor,
  type PermissionFacts,
  projectResource,
  requireCan,
} from '../permissions/index.js';
import {
  type CommentTarget,
  commentEgress,
  commentRowIn,
  type EntityCommentActor,
  type EntityCommentRow,
  entityCommentColumns,
  entityCommentView,
  type ReadDoor,
  targetIn,
} from './entity-read.js';
import {
  arcOf,
  COMMENT_MAX_DEPTH,
  contentRefusals,
  decisionBody,
  depthRefusal,
  editorRefusal,
  editRefusals,
  nodeDeciderRefusal,
  nodeDecisionScopeRefusal,
  parentRefusal,
  posterRefusal,
  preparedBody,
  scopeRefusal,
  sitsOn,
} from './entity-rules.js';
import { designNodeRefusal } from './ports.js';

export type EntityCommentOutcome =
  | { ok: true; comment: EntityCommentView; created: boolean }
  | { ok: false; refusals: CommentRefusal[] };

interface EntityCommentAuthor extends EntityCommentActor {
  deviceId: string | null;
}

async function lockCommentTarget(tx: Tx, targetId: string): Promise<void> {
  await lockXact(tx, 'commentTarget', targetId);
}

const present = <T>(v: T | null): v is T => v !== null;

function scrubbedDecision(level: SensitiveDataLevel, d: DecisionFields): DecisionFields {
  const s = (t: string) => storedText(level, t).text;
  return {
    decision: s(d.decision),
    reason: s(d.reason),
    ...(d.options ? { options: d.options.map(s) } : {}),
    ...(d.authority ? { authority: s(d.authority) } : {}),
    ...(d.reversedWhen ? { reversedWhen: s(d.reversedWhen) } : {}),
    ...(d.node ? { node: d.node } : {}),
  };
}

// cm:guard a node decision sits on a workflow, is posted by a holder of workflow-designs.approve and
// names a node of its approved revision or its latest observation (REQ-17 BC-26, design-reconciliation decide)
async function nodeDecisionRefusals(
  tx: Tx,
  facts: PermissionFacts,
  target: CommentTarget,
  decision: DecisionFields | undefined,
): Promise<CommentRefusal[]> {
  const node = decision?.node;
  if (!node) return [];
  const scoped = nodeDecisionScopeRefusal(target.scope, target.key, decision);
  if (scoped) return [scoped];
  const decider = nodeDeciderRefusal(facts, decision, target.key);
  if (decider) return [decider];
  const wrong = await designNodeRefusal(tx, target.projectId, target.id, node, '/decision/node');
  return wrong ? [wrong as CommentRefusal] : [];
}

async function depthOf(tx: Tx, parentId: string): Promise<number> {
  let depth = 1;
  let cursor: string | null = parentId;
  while (cursor && depth <= COMMENT_MAX_DEPTH) {
    depth += 1;
    const parent: EntityCommentRow | null = await commentRowIn(tx, cursor);
    cursor = parent?.parentId ?? null;
  }
  return depth;
}

async function parentRefusals(
  tx: Tx,
  parentId: string | undefined,
  target: CommentTarget,
): Promise<CommentRefusal[]> {
  if (!parentId) return [];
  const parent = await commentRowIn(tx, parentId);
  const scope = target.scope as EntityCommentScope;
  const mismatch = parentRefusal(
    parent ? { arc: parent } : null,
    parentId,
    scope,
    target.id,
    target.key,
  );
  if (mismatch) return [mismatch];
  const deep = depthRefusal(await depthOf(tx, parentId), target.key);
  return deep ? [deep] : [];
}

async function viewIn(
  row: EntityCommentRow,
  target: CommentTarget,
  actor: EntityCommentActor,
  door: ReadDoor,
): Promise<EntityCommentView> {
  const [authors, egress] = await Promise.all([
    peopleOf([row.authorId]),
    commentEgress(target.projectId, target.scope, actor, door),
  ]);
  return entityCommentView(row, target, authors, egress);
}

const factsOf = (actor: EntityCommentActor, projectId: string) =>
  requireCan(actorFor(actor.userId), 'project.read', projectResource(projectId));

export async function postEntityComment(input: {
  projectId: string;
  scope: EntityCommentScope;
  ref: string;
  author: EntityCommentAuthor;
  request: CreateEntityCommentRequest;
  door?: ReadDoor | undefined;
}): Promise<EntityCommentOutcome> {
  const { projectId, scope, ref, author, request } = input;
  const facts = await factsOf(author, projectId);
  return db.transaction(async (tx) => {
    const target = await targetIn(tx, projectId, scope, ref);
    await lockCommentTarget(tx, target.id);
    const arc = arcOf(scope, target.id);
    const refusals = [
      posterRefusal(facts, target.key),
      scopeRefusal(arc),
      ...contentRefusals(request),
      ...(await parentRefusals(tx, request.parentId, target)),
      ...(await nodeDecisionRefusals(tx, facts, target, request.decision)),
    ].filter(present);
    if (refusals.length > 0) return { ok: false, refusals };

    const level = await dataPolicyOf(projectId);
    const decision = request.decision ? scrubbedDecision(level, request.decision) : null;
    const said = request.body?.trim() ? request.body : null;
    const raw = said ? storedText(level, said).text : decisionBody(decision as DecisionFields);
    const body = preparedBody(raw, said ? request.format : 'markdown');
    if (!body.ok) return { ok: false, refusals: [body.refusal] };

    const [row] = await tx
      .insert(comments)
      .values({
        ...arc,
        authorId: author.userId,
        authorDeviceId: author.deviceId,
        body: body.prepared.body,
        format: body.prepared.format,
        parentId: request.parentId ?? null,
        intent: request.intent,
        decision,
      })
      .returning(entityCommentColumns);
    if (!row) throw new Error('comments: insert returned no row');
    await tx.insert(commentEvents).values({
      projectId,
      commentId: row.id,
      kind: 'posted',
      body: row.body,
      decision: row.decision,
      actorId: author.userId,
      actorAgency: author.agency,
    });
    return {
      ok: true,
      comment: await viewIn(row, target, author, input.door ?? {}),
      created: true,
    };
  });
}

export async function editEntityComment(input: {
  projectId: string;
  scope: EntityCommentScope;
  ref: string;
  commentId: string;
  actor: EntityCommentActor;
  request: EditEntityCommentRequest;
  door?: ReadDoor | undefined;
}): Promise<EntityCommentOutcome> {
  const { projectId, scope, ref, commentId, actor, request } = input;
  const facts = await factsOf(actor, projectId);
  return db.transaction(async (tx) => {
    const target = await targetIn(tx, projectId, scope, ref);
    await lockCommentTarget(tx, target.id);
    const row = await commentRowIn(tx, commentId);
    if (!row || !sitsOn(row, scope, target.id)) {
      throw notFound(`${target.key} holds no comment ${commentId}`);
    }
    const refusals = [
      editorRefusal(facts, row.authorId === actor.userId, target.key),
      ...editRefusals(row.intent, request),
      ...(await nodeDecisionRefusals(tx, facts, target, request.decision)),
    ].filter(present);
    if (refusals.length > 0) return { ok: false, refusals };

    const level = await dataPolicyOf(projectId);
    const decision = request.decision ? scrubbedDecision(level, request.decision) : row.decision;
    const derived = row.decision !== null && row.body === decisionBody(row.decision);
    const raw =
      request.body !== undefined
        ? storedText(level, request.body).text
        : request.decision && derived
          ? decisionBody(decision as DecisionFields)
          : row.body;
    const format =
      request.body !== undefined
        ? request.format
        : request.decision && derived
          ? 'markdown'
          : row.format;
    const body = preparedBody(raw, format);
    if (!body.ok) return { ok: false, refusals: [body.refusal] };

    const [edited] = await tx
      .update(comments)
      .set({
        body: body.prepared.body,
        format: body.prepared.format,
        decision,
        updatedAt: new Date(),
      })
      .where(eq(comments.id, row.id))
      .returning(entityCommentColumns);
    if (!edited) throw new Error(`comments: ${row.id} vanished under the target lock`);
    await tx.insert(commentEvents).values({
      projectId,
      commentId: row.id,
      kind: 'edited',
      body: edited.body,
      decision: edited.decision,
      actorId: actor.userId,
      actorAgency: actor.agency,
    });
    return {
      ok: true,
      comment: await viewIn(edited, target, actor, input.door ?? {}),
      created: false,
    };
  });
}
