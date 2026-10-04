import type { CommentRefusalCode } from '@forge/contracts/comments';
import {
  COMMENT_INTENTS,
  type CommentIntent,
  isCommentIntent,
} from '@forge/contracts/record-events';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { BodyFormat } from '../body/formats.js';
import { prepareBody } from '../body/prepare.js';
import { db, type Tx } from '../db/client.js';
import { commentMentions, comments, issues, users } from '../db/schema.js';
import type { Actor } from '../issues/index.js';
import { dropCommentMirror, mirrorCommentRecord, remirrorCommentRecord } from '../issues/index.js';
import { lockXact } from '../lib/advisory-lock.js';
import { type RefusalError, refuser } from '../lib/refusal.js';
import { parseForgeRecord } from '../messaging/forge-record.js';
import { logger } from '../observability/logger.js';
import { emitEvent } from '../outbox/index.js';
import { type CommentCursor, encodeCommentCursor } from './cursor.js';
import { parseMentions, resolveMentions } from './mentions.js';
import { screenAgentComment, screenRecordFence } from './screen.js';

const refuse = refuser<CommentRefusalCode>('COMMENT_REFUSED');

export type CommentThreadRow = {
  id: string;
  issueId: string;
  authorId: string;
  authorDeviceId: string | null;
  body: string;
  format: BodyFormat;
  stage: string | null;
  parentId: string | null;
  intent: CommentIntent;
  createdAt: Date;
  updatedAt: Date;
};

/** The columns every comment surface projects — REST tree, MCP list and both writes. */
export const commentThreadColumns = {
  id: comments.id,
  issueId: comments.issueId,
  authorId: comments.authorId,
  authorDeviceId: comments.authorDeviceId,
  body: comments.body,
  format: comments.format,
  stage: comments.stage,
  parentId: comments.parentId,
  intent: comments.intent,
  createdAt: comments.createdAt,
  updatedAt: comments.updatedAt,
} as const;

// cm:guard the issue thread reads issue comments only: a row on another target reaching it is an
// invariant break named here, never a thread entry with no issue
export function onIssue<T extends { id: string; issueId: string | null }>(
  row: T,
): T & { issueId: string } {
  if (row.issueId === null) {
    throw new Error(`comment ${row.id} sits on no issue, so the issue thread cannot carry it`);
  }
  return row as T & { issueId: string };
}

/**
 * Comment depth the DB trigger allows. A root plus this many rounds of
 * `parent_id IN (…)` reaches every descendant of the roots on a page.
 */
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
const cursorKeyExpr = sql<string>`to_char(${comments.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function listIssueCommentPage(
  issueId: string,
  opts: { after?: CommentCursor | undefined; limit: number; intent?: CommentIntent | undefined },
): Promise<CommentPage> {
  const { after, limit } = opts;
  const rootFilters = [eq(comments.issueId, issueId), isNull(comments.parentId)];
  if (opts.intent) rootFilters.push(eq(comments.intent, opts.intent));
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

  const cursorKeyById = new Map(keyed.map((r) => [r.id, r.cursorKey]));
  const roots = keyed.map(({ cursorKey: _key, ...row }) => onIssue(row));

  const rows = [...roots];
  let frontier = roots.map((r) => r.id);
  for (let depth = 1; depth < COMMENT_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const replies = await db
      .select(commentThreadColumns)
      .from(comments)
      .where(inArray(comments.parentId, frontier))
      .orderBy(asc(comments.createdAt), asc(comments.id));
    rows.push(...replies.map(onIssue));
    frontier = replies.map((r) => r.id);
  }

  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  return { rows, roots, nextCursor, cursorKeyById };
}

export type NewComment = {
  issueId: string;
  authorId: string;
  authorDeviceId: string | null;
  body: string;
  format?: BodyFormat | null | undefined;
  parentId: string | null;
  /**
   * Whether the door's caller declared it can write a record to the store. Absent means no, which
   * is the dormancy: a door that cannot read the declaration warns rather than refuses.
   */
  declaresRecordRoute?: boolean | undefined;
  /**
   * What the comment means to do, as the caller sent it. Validated here, so every door refuses the
   * same way; absent is decided by `defaultIntent` and the caller is warned.
   */
  intent?: string | null | undefined;
  /**
   * Who the door says posted it: given, the comment's `comment.created` outbox event is written in
   * its transaction. A notice Forge posts on its own act passes none and emits no event.
   */
  announce?: { actor: Actor; authored: 'human' | 'agent' } | undefined;
};

/** A written comment, whatever the sanitizer removed on the way in, and who it mentioned. */
export type WrittenComment = { row: CommentThreadRow; warnings: string[]; mentioned: string[] };

/** A comment intent outside the closed set, refused by name with the valid set. */
export function intentRefusal(intent: unknown, path = '/intent'): RefusalError {
  return refuse(
    'COMMENT_INTENT_UNKNOWN',
    `\`${String(intent)}\` is not a comment intent — send one of: ${COMMENT_INTENTS.join(', ')} (question is owed a reply, decision is pinned, note is neither)`,
    path,
  );
}

/**
 * The intent a comment that declared none is stored under. A person's comment is `question`, so
 * it stays owed a reply exactly as every person's comment was before intents existed; an agent's,
 * or any comment carrying a record, is `note`.
 *
 * cm:hack — the default exists because forge-plugin's `forge comment` and older web builds send
 * no intent. Ends when the pinned plugin sends `intent` on every comment
 * (forge-local-docs/plugin-followups.md); then an absent intent is refused COMMENT_INTENT_REQUIRED.
 */
export function defaultIntent(byAnAgent: boolean, body: string): CommentIntent {
  if (byAnAgent || parseForgeRecord(body)) return 'note';
  return 'question';
}

/** The intent sent, checked; or the default with the warning that says it was taken. */
export function resolveIntent(
  sent: unknown,
  byAnAgent: boolean,
  body: string,
): { intent: CommentIntent; warning: string | null } {
  if (sent !== undefined && sent !== null) {
    if (!isCommentIntent(sent)) throw intentRefusal(sent);
    return { intent: sent, warning: null };
  }
  const intent = defaultIntent(byAnAgent, body);
  return {
    intent,
    warning: `COMMENT_INTENT_DEFAULTED: no \`intent\` was sent, so this comment is stored as \`${intent}\` — send intent: ${COMMENT_INTENTS.join(' | ')}`,
  };
}

/** The record actor a comment's author is: the box where a device wrote it, else the account. */
function commentActor(
  input: { authorId: string; authorDeviceId: string | null },
  byAnAgent: boolean,
): Actor {
  if (input.authorDeviceId) return { type: 'device', id: input.authorDeviceId, agency: 'agent' };
  return { type: 'user', id: input.authorId, agency: byAnAgent ? 'agent' : 'human' };
}

/**
 * The stage a body write happens at: `issues.status` IS the stage name.
 */
async function loadStageContext(
  issueId: string,
  tx: Tx = db,
): Promise<{ stage: string; projectId: string } | null> {
  const [row] = await tx
    .select({ stage: issues.status, projectId: issues.projectId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  return row ? { stage: row.stage, projectId: row.projectId } : null;
}

/**
 * Was this comment written by an agent? (ISS-1137.)
 *
 * The same rule `issues/actor-resolution.ts:resolveActors` answers the thread's
 * marker with, asked here so the screening and the marker cannot disagree: a
 * comment carrying an `author_device_id` is a box's, and otherwise the author's
 * `users.kind` decides. Nothing is stored — the author's account IS the answer.
 */
async function writtenByAnAgent(
  input: { authorId: string; authorDeviceId: string | null },
  tx: Tx,
): Promise<boolean> {
  if (input.authorDeviceId != null) return true;
  const [row] = await tx
    .select({ kind: users.kind })
    .from(users)
    .where(eq(users.id, input.authorId))
    .limit(1);
  return row?.kind === 'agent';
}

export async function insertComment(input: NewComment, tx: Tx = db): Promise<WrittenComment> {
  const prepared = prepareBody({ raw: input.body, format: input.format });
  const fence = screenRecordFence(input.body, input.declaresRecordRoute === true);
  const context = await loadStageContext(input.issueId, tx);
  const byAnAgent = await writtenByAnAgent(input, tx);
  const { intent, warning } = resolveIntent(input.intent, byAnAgent, input.body);
  if (context && byAnAgent) {
    await screenAgentComment(context.projectId, input.body, tx);
  }

  const {
    format: _ignored,
    declaresRecordRoute: _declared,
    intent: _intent,
    announce,
    ...rest
  } = input;
  const actor = commentActor(input, byAnAgent);
  const result = await tx.transaction(async (t) => {
    const [row] = await t
      .insert(comments)
      .values({
        ...rest,
        body: prepared.body,
        format: prepared.format,
        stage: context?.stage ?? null,
        intent,
      })
      .returning(commentThreadColumns);
    if (!row) throw new Error('comment insert returned no row');
    const written = onIssue(row);
    const untyped = await mirrorCommentRecord(written, actor, t);
    const mentioned = context ? await recordMentions(written, context.projectId, t) : [];
    if (context && announce) {
      await emitEvent(t, 'comment.created', {
        issueId: written.issueId,
        projectId: context.projectId,
        actor: announce.actor,
        authored: announce.authored,
        commentId: written.id,
        body: written.body,
        parentId: written.parentId,
      });
    }
    if (context && mentioned.length > 0) {
      await emitEvent(t, 'comment.mentioned', {
        issueId: written.issueId,
        projectId: context.projectId,
        commentId: written.id,
        actor,
        mentionedUserIds: mentioned,
      });
    }
    const warnings = [...prepared.warnings, ...fence, ...untyped, ...(warning ? [warning] : [])];
    return { row: written, warnings, mentioned };
  });
  return result;
}

/** The project members a comment's body names by handle, its author excepted, recorded on it. */
async function recordMentions(row: CommentThreadRow, projectId: string, t: Tx): Promise<string[]> {
  const handles = parseMentions(row.body);
  if (handles.length === 0) return [];
  try {
    const resolved = await resolveMentions(handles, projectId);
    const targets = resolved.filter((r) => r.userId !== row.authorId).map((r) => r.userId);
    if (targets.length === 0) return [];
    await t
      .insert(commentMentions)
      .values(targets.map((userId) => ({ commentId: row.id, userId })))
      .onConflictDoNothing();
    return targets;
  } catch (err) {
    logger.error({ err, commentId: row.id }, 'comment mentions could not be recorded');
    return [];
  }
}

/** A comment Forge itself posts on an issue: a note unless it says otherwise. */
export type IssueNotice = {
  issueId: string;
  authorId: string;
  authorDeviceId?: string | null | undefined;
  body: string;
  intent?: CommentIntent | undefined;
  parentId?: string | null | undefined;
  announce?: NewComment['announce'];
};

/**
 * Post a notice through the one writer, so it is screened, mirrored and its mentions recorded the
 * way a comment through either door is.
 */
export async function postIssueNotice(notice: IssueNotice, tx: Tx = db): Promise<CommentThreadRow> {
  const { row } = await insertComment(
    {
      issueId: notice.issueId,
      authorId: notice.authorId,
      authorDeviceId: notice.authorDeviceId ?? null,
      body: notice.body,
      parentId: notice.parentId ?? null,
      intent: notice.intent ?? 'note',
      announce: notice.announce,
    },
    tx,
  );
  return row;
}

/**
 * Post a notice unless the issue's thread already carries `marker`, under a lock on the pair, so
 * any number of racing callers post it once. Null when it was already there.
 */
export async function postIssueNoticeOnce(
  notice: IssueNotice & { marker: string },
  tx: Tx = db,
): Promise<CommentThreadRow | null> {
  const { marker, ...rest } = notice;
  return tx.transaction(async (t) => {
    await lockXact(t, 'commentOnce', `${notice.issueId}:${marker}`);
    const [existing] = await t
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(eq(comments.issueId, notice.issueId), sql`strpos(${comments.body}, ${marker}) > 0`),
      )
      .limit(1);
    if (existing) return null;
    return postIssueNotice(rest, t);
  });
}

/** The body of the latest comment on an issue carrying any of `markers`, or null. */
export async function latestIssueCommentWith(
  issueId: string,
  markers: readonly string[],
  tx: Tx = db,
): Promise<string | null> {
  if (markers.length === 0) return null;
  const [latest] = await tx
    .select({ body: comments.body })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueId),
        or(...markers.map((m) => sql`strpos(${comments.body}, ${m}) > 0`)),
      ),
    )
    .orderBy(desc(comments.createdAt), desc(comments.id))
    .limit(1);
  return latest?.body ?? null;
}

/**
 * Replace one comment's body, re-validating it. Returns null when it is gone.
 *
 * `stage` is NOT rewritten. It records when the comment was WRITTEN, and an
 * edit does not move that; rewriting it would make a comment written at `open`
 * and corrected an hour later count towards whatever stage the issue reached
 * meanwhile, which is the exact misattribution the column exists to prevent.
 */
export async function updateCommentBody(
  commentId: string,
  input: {
    body: string;
    format?: BodyFormat | null | undefined;
    declaresRecordRoute?: boolean | undefined;
    /** Who edited it, through a door; given, the edit's `comment.updated` event is written with it. */
    announce?: { actor: Actor; projectId: string; before: string } | undefined;
  },
): Promise<WrittenComment | null> {
  const prepared = prepareBody({ raw: input.body, format: input.format });
  const fence = screenRecordFence(input.body, input.declaresRecordRoute === true);
  const [existing] = await db
    .select({
      issueId: comments.issueId,
      authorId: comments.authorId,
      authorDeviceId: comments.authorDeviceId,
    })
    .from(comments)
    .where(eq(comments.id, commentId))
    .limit(1);
  if (!existing) return null;
  const issueId = existing.issueId;
  if (issueId === null)
    throw new Error(`comment ${commentId} sits on no issue; edit it at its own target`);
  const byAnAgent = await writtenByAnAgent(existing, db);
  if (byAnAgent) {
    const context = await loadStageContext(issueId);
    if (context) await screenAgentComment(context.projectId, input.body, db);
  }

  return db.transaction(async (t) => {
    const [row] = await t
      .update(comments)
      .set({
        body: prepared.body,
        format: prepared.format,
        updatedAt: new Date(),
      })
      .where(eq(comments.id, commentId))
      .returning(commentThreadColumns);
    if (!row) return null;
    const edited = onIssue(row);
    const untyped = await remirrorCommentRecord(edited, commentActor(existing, byAnAgent), t);
    if (input.announce) {
      await emitEvent(t, 'comment.updated', {
        issueId: edited.issueId,
        projectId: input.announce.projectId,
        actor: input.announce.actor,
        commentId: edited.id,
        before: input.announce.before,
        after: edited.body,
      });
    }
    return { row: edited, warnings: [...prepared.warnings, ...fence, ...untyped], mentioned: [] };
  });
}

/** Remove one comment, and the event its record was mirrored into; a door's delete passes who
 *  removed it, and its `comment.deleted` event is written with the delete. */
export async function deleteComment(
  commentId: string,
  announce?: { actor: Actor; issueId: string; projectId: string },
): Promise<void> {
  await db.transaction(async (t) => {
    await dropCommentMirror(commentId, t);
    await t.delete(comments).where(eq(comments.id, commentId));
    if (announce) await emitEvent(t, 'comment.deleted', { ...announce, commentId });
  });
}
