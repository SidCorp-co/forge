/**
 * Comment reads and writes both transports share.
 *
 * The queries live here rather than beside a route or a tool because each
 * side had grown its own: the step-start tool primes an agent with a comment
 * thread, the comments tool lists the same thread, and REST serves the UI.
 * The projections are one now; the authorisation stays with each caller,
 * which is where the credential is known.
 */

import { and, asc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { BodyFormat } from '../body/formats.js';
import { prepareBody } from '../body/prepare.js';
import {
  type BodyPolicyConfigSource,
  refuseMissingComponent,
  resolveStageBodyPolicy,
} from '../body/stage-policy.js';
import { db, type Tx } from '../db/client.js';
import { comments, issues, projects } from '../db/schema.js';
import type { ActorAgency } from '../issues/actor-agency.js';
import { type CommentCursor, encodeCommentCursor } from './cursor.js';

export type CommentThreadRow = {
  id: string;
  issueId: string;
  authorId: string;
  authorDeviceId: string | null;
  body: string;
  format: BodyFormat;
  template: string | null;
  stage: string | null;
  authorAgency: ActorAgency | null;
  parentId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** The columns every comment surface projects — REST tree, MCP list and both writes. */
// cm:guard REST and MCP answer comments off THIS ONE object. `comments/routes.ts` kept a byte-identical private copy until ISS-956; two projections that must agree and nothing making them is how one surface silently gains or loses a field.
export const commentThreadColumns = {
  id: comments.id,
  issueId: comments.issueId,
  authorId: comments.authorId,
  authorDeviceId: comments.authorDeviceId,
  body: comments.body,
  format: comments.format,
  template: comments.template,
  stage: comments.stage,
  authorAgency: comments.authorAgency,
  parentId: comments.parentId,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
} as const;

/** One issue's comments, oldest first, all of them. */
export async function listIssueComments(issueId: string) {
  return db
    .select(commentThreadColumns)
    .from(comments)
    .where(eq(comments.issueId, issueId))
    .orderBy(asc(comments.createdAt), asc(comments.id));
}

/**
 * Comment depth the DB trigger allows. A root plus this many rounds of
 * `parent_id IN (…)` reaches every descendant of the roots on a page.
 */
// cm:edge lockstep -> packages/core/drizzle/migrations — the depth-3 check trigger is what makes a fixed number of rounds complete rather than a guess. Raising the trigger's depth without raising this leaves the deepest replies off every page, silently, because `buildCommentTree` drops a reply whose parent it was not given.
const COMMENT_MAX_DEPTH = 3;

export type CommentPage = {
  /** Roots and every descendant of them, ascending by `(createdAt, id)`. */
  rows: CommentThreadRow[];
  /** The roots this page carries, in the order the cursor walks them. */
  roots: CommentThreadRow[];
  /** Where the next page resumes, or null when this page ended the thread. */
  nextCursor: string | null;
  /** Each root's exact `created_at` key, for a caller that mints its own token. */
  cursorKeyById: Map<string, string>;
};

/**
 * `created_at` as the DB's own microsecond text, which is what a cursor
 * carries. Selected only on the root query, never projected to a caller.
 */
// cm:edge contract -> packages/core/src/comments/cursor.ts — this rendering IS the token's timestamp half, so the format here and `decodeCommentCursor`'s acceptance must agree; `to_char` with `US` is exact for a timestamptz, and the token is compared back as `::timestamptz` rather than parsed in JS so no precision is lost on the way in either.
const cursorKeyExpr = sql<string>`to_char(${comments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One page of an issue's thread: the next `limit` ROOT comments after
 * `after`, each with its whole subtree.
 *
 * ISS-956. The cursor walks roots rather than comments because
 * `buildCommentTree` drops a reply whose parent is absent from the row set it
 * is given — a deliberate guard, so that a partial fetch cannot promote a
 * reply to a top-level comment. Paging over roots is the one row set for
 * which that builder is correct on a partial fetch, and it is also what makes
 * a page self-contained for a flat reader: every `parentId` on the page names
 * a row that is on it.
 */
// cm:guard the keyset is `(createdAt, id)` and the tie-breaking `id` comparison is the whole of the second half — dropping to `createdAt > x` alone loses every root sharing a timestamp with the previous page's last. Agent-written threads produce those ties routinely (ISS-956 measured two at 2026-09-06T18:58).
export async function listIssueCommentPage(
  issueId: string,
  opts: { after?: CommentCursor | undefined; limit: number },
): Promise<CommentPage> {
  const { after, limit } = opts;
  const rootFilters = [eq(comments.issueId, issueId), isNull(comments.parentId)];
  if (after) {
    const at = sql`${after.createdAtKey}::timestamptz`;
    rootFilters.push(
      or(
        sql`${comments.createdAt} > ${at}`,
        and(sql`${comments.createdAt} = ${at}`, gt(comments.id, after.id)),
      ) as NonNullable<ReturnType<typeof gt>>,
    );
  }

  const probed = await db
    .select({ ...commentThreadColumns, cursorKey: cursorKeyExpr })
    .from(comments)
    .where(and(...rootFilters))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(limit + 1);

  const keyed = probed.slice(0, limit);
  const last = keyed.at(-1);
  const nextCursor =
    probed.length > limit && last
      ? encodeCommentCursor({ createdAtKey: last.cursorKey, id: last.id })
      : null;

  // cm:guard `cursorKey` is stripped HERE and reaches no caller. `buildCommentTree` spreads each row into its node, so a key left on a root is an undeclared field on every REST comment; the MCP tool reads the keys it needs out of `cursorKeyById` instead.
  const cursorKeyById = new Map(keyed.map((r) => [r.id, r.cursorKey]));
  const roots = keyed.map(({ cursorKey: _key, ...row }) => row);

  const rows = [...roots];
  let frontier = roots.map((r) => r.id);
  for (let depth = 1; depth < COMMENT_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const replies = await db
      .select(commentThreadColumns)
      .from(comments)
      .where(inArray(comments.parentId, frontier))
      .orderBy(asc(comments.createdAt), asc(comments.id));
    rows.push(...replies);
    frontier = replies.map((r) => r.id);
  }

  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return { rows, roots, nextCursor, cursorKeyById };
}

/** The project an issue belongs to; throws when the issue is gone. */
export async function loadIssueProjectId(issueId: string): Promise<string> {
  const [row] = await db
    .select({ projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: issue not found');
  return row.projectId;
}

export type CommentAccessRow = {
  id: string;
  issueId: string;
  authorId: string;
  projectId: string;
};

/** Who owns a comment and which project it sits under, for an access check. */
export async function loadCommentForAccess(commentId: string): Promise<CommentAccessRow> {
  const [row] = await db
    .select({
      id: comments.id,
      issueId: comments.issueId,
      authorId: comments.authorId,
      projectId: issues.projectId,
    })
    .from(comments)
    .innerJoin(issues, eq(comments.issueId, issues.id))
    .where(eq(comments.id, commentId))
    .limit(1);
  if (!row) throw new Error('NOT_FOUND: comment not found');
  return row;
}

export type NewComment = {
  issueId: string;
  authorId: string;
  authorDeviceId: string | null;
  /**
   * Who was at the keyboard, from the principal the door authenticated.
   *
   * REQUIRED, and never defaulted — the same reasoning `actorAgency`'s own
   * guard states: a door that forgets it would silently write every agent's
   * comment as a person's, which both exempts it from the mandate and drops it
   * out of the number that decides the mandate.
   */
  authorAgency: ActorAgency;
  body: string;
  format?: BodyFormat | null | undefined;
  parentId: string | null;
};

/** A written comment plus whatever the sanitizer removed on the way in. */
export type WrittenComment = { row: CommentThreadRow; warnings: string[] };

/**
 * The stage a body write happens at, and the policy in force there.
 *
 * One read for both: `issues.status` IS the stage name (`STAGE_NAMES` in
 * `pipeline-config-schema.ts` — "a key here must be a status this lane actually
 * reaches"), and the project's stored `agentConfig` is where the policy lives.
 */
async function loadStageContext(
  issueId: string,
): Promise<{ stage: string; policySource: BodyPolicyConfigSource | null } | null> {
  const [row] = await db
    .select({ stage: issues.status, agentConfig: projects.agentConfig })
    .from(issues)
    .innerJoin(projects, eq(issues.projectId, projects.id))
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!row) return null;
  return {
    stage: row.stage,
    policySource: (row.agentConfig ?? null) as BodyPolicyConfigSource | null,
  };
}

// cm:guard the `tx` handle exists for ONE reason: a caller that must commit this comment together with another row passes its transaction, and `rocketchat/comment-inbound.ts` is that caller — a room reply whose comment committed without its idempotency row is written a second time on the next redelivery, which is two resume intents at `answer-resume.ts` and the agent run twice (ISS-981). It defaults to the pool, so every other door is unchanged.
// cm:guard ISS-898 — the caller-supplied body is validated HERE, not at each transport, because REST and MCP create both reach this one function and a gate on one of them is a gate on neither. ISS-969 collapsed REST's own `db.insert(comments)` copy into this call for that same reason, so there is now exactly one insert site for a body somebody sent us. The ~11 kernel-authored `db.insert(comments)` sites (apply-transition, budget-check, merge-marker, stage-stall-guard, pm/routes, release-batch) deliberately do NOT come through here: they take the `markdown` column default, which is right for text core formats itself, and they store no stage because no stage asked them for a record. `agent-sessions/steer-session.ts` is the one kernel caller that DOES come through here, and correctly: a steer is a person's typed body written at a stage, and it passes `authorDeviceId: null`, so the mandate exempts it while the stage is still recorded.
export async function insertComment(input: NewComment, tx: Tx = db): Promise<WrittenComment> {
  const prepared = prepareBody({ raw: input.body, format: input.format });
  const context = await loadStageContext(input.issueId);
  const refusal = refuseMissingComponent({
    policy: resolveStageBodyPolicy(context?.policySource, context?.stage ?? ''),
    agency: input.authorAgency,
    format: prepared.format,
    template: prepared.template,
  });
  if (refusal) throw refusal;

  const { format: _ignored, ...rest } = input;
  const [row] = await tx
    .insert(comments)
    .values({
      ...rest,
      body: prepared.body,
      format: prepared.format,
      template: prepared.template,
      stage: context?.stage ?? null,
    })
    .returning(commentThreadColumns);
  if (!row) throw new Error('comment insert returned no row');
  return { row, warnings: prepared.warnings };
}

/**
 * Replace one comment's body, re-validating it. Returns null when it is gone.
 *
 * `stage` is NOT rewritten. It records when the comment was WRITTEN, and an
 * edit does not move that; rewriting it would make a comment written at `open`
 * and corrected an hour later count towards whatever stage the issue reached
 * meanwhile, which is the exact misattribution the column exists to prevent.
 */
// cm:guard the mandate stands at the EDIT door too. Gating create alone leaves the obvious way past it — post a compliant body, then replace it with prose — and a rule with a way around it measures nothing, which is the whole reason the adoption number beside it would be worth reading.
export async function updateCommentBody(
  commentId: string,
  input: { body: string; format?: BodyFormat | null | undefined },
): Promise<WrittenComment | null> {
  const prepared = prepareBody({ raw: input.body, format: input.format });
  const [existing] = await db
    .select({ issueId: comments.issueId, authorAgency: comments.authorAgency })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);
  if (!existing) return null;

  // cm:why the STORED agency, not the editor's: the rule is about who wrote the record, and a person correcting an agent's comment does not turn it into a person's. A row written before this column exists reads NULL and is exempt, which is the same "no backfill" position `stage` takes.
  const context = await loadStageContext(existing.issueId);
  const refusal = refuseMissingComponent({
    policy: resolveStageBodyPolicy(context?.policySource, context?.stage ?? ''),
    agency: existing.authorAgency,
    format: prepared.format,
    template: prepared.template,
  });
  if (refusal) throw refusal;

  const [row] = await db
    .update(comments)
    .set({
      body: prepared.body,
      format: prepared.format,
      template: prepared.template,
      updatedAt: new Date(),
    })
    .where(eq(comments.id, commentId))
    .returning(commentThreadColumns);
  return row ? { row, warnings: prepared.warnings } : null;
}

/** Remove one comment. Emitting `commentDeleted` belongs to the caller. */
export async function deleteComment(commentId: string): Promise<void> {
  await db.delete(comments).where(eq(comments.id, commentId));
}
