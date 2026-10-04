import type {
  CommentScope,
  DecisionFields,
  DecisionListResponse,
  EntityCommentListResponse,
  EntityCommentScope,
  EntityCommentView,
} from '@forge/contracts/comments';
import type { CommentIntent } from '@forge/contracts/record-events';
import { and, asc, desc, eq, isNotNull, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db, type Tx } from '../db/client.js';
import { comments, issues } from '../db/schema.js';
import { feedback } from '../db/schema-feedback.js';
import { requirements } from '../db/schema-requirements.js';
import { projectWorkflows } from '../db/schema-workflows.js';
import type { ReadDoor } from '../feedback/egress.js';
import { feedbackKey, rowIn as feedbackRowIn } from '../feedback/read.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { activeIssuePrefix } from '../issues/issue-prefix-read.js';
import { isUuid } from '../issues/issue-route-ref.js';
import { dataPolicyOf, type EgressSurface, egressReading } from '../lib/data-egress.js';
import { formatIssueRef } from '../lib/issue-ref.js';
import { peopleOf } from '../lib/people.js';
import { requirementKey, rowIn as requirementRowIn } from '../requirements/read.js';
import { type CommentArc, scopeOfArc } from './entity-rules.js';
import { requireCan } from '../permissions/index.js';

export interface EntityCommentActor {
  userId: string;
  agency: ActorAgency;
}

export interface CommentTarget {
  scope: CommentScope;
  id: string;
  key: string;
  title: string | null;
  projectId: string;
}

export const notFound = (message: string) =>
  new HTTPException(404, { message, cause: { code: 'NOT_FOUND' } });

const titleOf = (document: unknown, flow: string) => {
  const title = (document as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim() ? title : flow;
};

async function workflowIn(tx: Tx, projectId: string, ref: string) {
  const [row] = await tx
    .select({
      id: projectWorkflows.id,
      flow: projectWorkflows.flow,
      document: projectWorkflows.document,
    })
    .from(projectWorkflows)
    .where(
      and(
        eq(projectWorkflows.projectId, projectId),
        isUuid(ref) ? eq(projectWorkflows.id, ref) : eq(projectWorkflows.flow, ref),
      ),
    );
  if (!row) throw notFound(`project ${projectId} draws no workflow ${ref}`);
  return row;
}

export async function targetIn(
  tx: Tx,
  projectId: string,
  scope: EntityCommentScope,
  ref: string,
): Promise<CommentTarget> {
  if (scope === 'requirement') {
    const row = await requirementRowIn(tx, projectId, ref);
    return { scope, id: row.id, key: requirementKey(row.reqSeq), title: row.title, projectId };
  }
  if (scope === 'feedback') {
    const row = await feedbackRowIn(tx, projectId, ref);
    return { scope, id: row.id, key: feedbackKey(row.fbSeq), title: row.title, projectId };
  }
  const row = await workflowIn(tx, projectId, ref);
  return { scope, id: row.id, key: row.flow, title: titleOf(row.document, row.flow), projectId };
}

export const entityCommentColumns = {
  id: comments.id,
  issueId: comments.issueId,
  requirementId: comments.requirementId,
  workflowId: comments.workflowId,
  feedbackId: comments.feedbackId,
  authorId: comments.authorId,
  authorDeviceId: comments.authorDeviceId,
  body: comments.body,
  format: comments.format,
  parentId: comments.parentId,
  intent: comments.intent,
  decision: comments.decision,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
} as const;

export interface EntityCommentRow extends CommentArc {
  id: string;
  authorId: string;
  authorDeviceId: string | null;
  body: string;
  format: 'markdown' | 'html';
  parentId: string | null;
  intent: CommentIntent;
  decision: DecisionFields | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function commentRowIn(tx: Tx, commentId: string): Promise<EntityCommentRow | null> {
  const [row] = await tx
    .select(entityCommentColumns)
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);
  return row ?? null;
}

type Authors = Awaited<ReturnType<typeof peopleOf>>;

export type CommentEgress = ReturnType<typeof egressReading>;

export function entityCommentView(
  row: EntityCommentRow,
  target: Omit<CommentTarget, 'projectId'>,
  authors: Authors,
  egress: CommentEgress,
): EntityCommentView {
  const { withhold } = egress;
  const person = authors.get(row.authorId);
  const agency = row.authorDeviceId ? 'agent' : (person?.kind ?? 'human');
  const view: EntityCommentView = {
    id: row.id,
    target: {
      scope: target.scope,
      id: target.id,
      key: target.key,
      title: withhold ? null : target.title,
    },
    intent: row.intent,
    body: withhold ? null : row.body,
    format: row.format,
    decision: withhold ? null : row.decision,
    parentId: row.parentId,
    author: { id: row.authorId, name: person?.name ?? null, agency },
    withheld: withhold,
    edited: row.updatedAt.getTime() !== row.createdAt.getTime(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return withhold ? view : egress.shown(view, `comment ${row.id}`);
}

const ARC_COLUMN = {
  requirement: comments.requirementId,
  workflow: comments.workflowId,
  feedback: comments.feedbackId,
  issue: comments.issueId,
} as const;

// cm:why a comment takes the class of what it sits on, declared once in the egress table: a
// requirement's and a design's are product, an issue's too, a feedback item's is operational
const COMMENT_SURFACE = {
  requirement: 'requirement',
  workflow: 'design',
  feedback: 'feedback.comments',
  issue: 'issue.comments',
} as const satisfies Record<CommentScope, EgressSurface>;

export async function commentEgress(
  projectId: string,
  scope: CommentScope,
  actor: EntityCommentActor,
  door: ReadDoor,
): Promise<CommentEgress> {
  return egressReading(
    await dataPolicyOf(projectId),
    { agency: actor.agency, providerBound: door.providerBound },
    COMMENT_SURFACE[scope],
  );
}

export async function listEntityCommentsAs(
  actor: EntityCommentActor,
  projectId: string,
  scope: EntityCommentScope,
  ref: string,
  query: { intent?: CommentIntent | undefined } = {},
  door: ReadDoor = {},
): Promise<EntityCommentListResponse> {
  await requireCan({ userId: actor.userId }, 'project.read', projectId);
  const target = await targetIn(db, projectId, scope, ref);
  const rows = await db
    .select(entityCommentColumns)
    .from(comments)
    .where(
      and(
        eq(ARC_COLUMN[scope], target.id),
        query.intent ? eq(comments.intent, query.intent) : undefined,
      ),
    )
    .orderBy(asc(comments.createdAt), asc(comments.id));
  const [authors, egress] = await Promise.all([
    peopleOf(rows.map((r) => r.authorId)),
    commentEgress(projectId, scope, actor, door),
  ]);
  const shown = rows.map((r) => entityCommentView(r, target, authors, egress));
  return { comments: shown, returned: shown.length };
}

async function egressOfScopes(projectId: string, actor: EntityCommentActor, door: ReadDoor) {
  const level = await dataPolicyOf(projectId);
  const reader = { agency: actor.agency, providerBound: door.providerBound };
  return {
    requirement: egressReading(level, reader, COMMENT_SURFACE.requirement),
    workflow: egressReading(level, reader, COMMENT_SURFACE.workflow),
    feedback: egressReading(level, reader, COMMENT_SURFACE.feedback),
    issue: egressReading(level, reader, COMMENT_SURFACE.issue),
  } satisfies Record<CommentScope, CommentEgress>;
}

export const DECISIONS_DEFAULT_LIMIT = 100;

export async function listDecisionsAs(
  actor: EntityCommentActor,
  projectId: string,
  query: { scope?: CommentScope | undefined; limit?: number | undefined } = {},
  door: ReadDoor = {},
): Promise<DecisionListResponse> {
  await requireCan({ userId: actor.userId }, 'project.read', projectId);
  const limit = query.limit ?? DECISIONS_DEFAULT_LIMIT;
  const inProject = or(
    eq(issues.projectId, projectId),
    eq(requirements.projectId, projectId),
    eq(projectWorkflows.projectId, projectId),
    eq(feedback.projectId, projectId),
  );
  const rows = await db
    .select({
      ...entityCommentColumns,
      issueSeq: issues.issSeq,
      issueTitle: issues.title,
      reqSeq: requirements.reqSeq,
      reqTitle: requirements.title,
      flow: projectWorkflows.flow,
      flowDocument: projectWorkflows.document,
      fbSeq: feedback.fbSeq,
      fbTitle: feedback.title,
    })
    .from(comments)
    .leftJoin(issues, eq(comments.issueId, issues.id))
    .leftJoin(requirements, eq(comments.requirementId, requirements.id))
    .leftJoin(projectWorkflows, eq(comments.workflowId, projectWorkflows.id))
    .leftJoin(feedback, eq(comments.feedbackId, feedback.id))
    .where(
      and(
        eq(comments.intent, 'decision'),
        inProject,
        query.scope ? isNotNull(ARC_COLUMN[query.scope]) : undefined,
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(limit);
  const [authors, prefix, egress] = await Promise.all([
    peopleOf(rows.map((r) => r.authorId)),
    activeIssuePrefix(projectId),
    egressOfScopes(projectId, actor, door),
  ]);
  const decisions = rows.map((r) => {
    const scope = scopeOfArc(r);
    if (!scope)
      throw new Error(`comment ${r.id} breaks comments_scope_chk: it names no single target`);
    const target = targetOfRow(scope, r, prefix);
    return entityCommentView(r, target, authors, egress[scope]);
  });
  return { decisions, returned: decisions.length, limit };
}

const joined = <T>(value: T | null, commentId: string): T => {
  if (value === null) throw new Error(`comment ${commentId}: its target row did not join`);
  return value;
};

function targetOfRow(
  scope: CommentScope,
  r: EntityCommentRow & {
    issueSeq: number | null;
    issueTitle: string | null;
    reqSeq: number | null;
    reqTitle: string | null;
    flow: string | null;
    flowDocument: unknown;
    fbSeq: number | null;
    fbTitle: string | null;
  },
  prefix: string | null,
): Omit<CommentTarget, 'projectId'> {
  if (scope === 'issue') {
    return {
      scope,
      id: joined(r.issueId ?? null, r.id),
      key: formatIssueRef(prefix, joined(r.issueSeq, r.id)),
      title: r.issueTitle,
    };
  }
  if (scope === 'requirement') {
    return {
      scope,
      id: joined(r.requirementId ?? null, r.id),
      key: requirementKey(joined(r.reqSeq, r.id)),
      title: r.reqTitle,
    };
  }
  if (scope === 'workflow') {
    const flow = joined(r.flow, r.id);
    const id = joined(r.workflowId ?? null, r.id);
    return { scope, id, key: flow, title: titleOf(r.flowDocument, flow) };
  }
  return {
    scope,
    id: joined(r.feedbackId ?? null, r.id),
    key: feedbackKey(joined(r.fbSeq, r.id)),
    title: r.fbTitle,
  };
}

export async function placeOfComment(
  tx: Tx,
  row: EntityCommentRow,
): Promise<{ scope: EntityCommentScope; targetId: string; projectId: string }> {
  const scope = scopeOfArc(row);
  if (!scope)
    throw new Error(`comment ${row.id} breaks comments_scope_chk: it names no single target`);
  if (scope === 'issue') throw new Error(`comment ${row.id} sits on an issue, not an entity`);
  const targetId = joined(row[`${scope}Id`] ?? null, row.id);
  const [target] =
    scope === 'requirement'
      ? await tx
          .select({ projectId: requirements.projectId })
          .from(requirements)
          .where(eq(requirements.id, targetId))
      : scope === 'workflow'
        ? await tx
            .select({ projectId: projectWorkflows.projectId })
            .from(projectWorkflows)
            .where(eq(projectWorkflows.id, targetId))
        : await tx
            .select({ projectId: feedback.projectId })
            .from(feedback)
            .where(eq(feedback.id, targetId));
  return { scope, targetId, projectId: joined(target?.projectId ?? null, row.id) };
}
