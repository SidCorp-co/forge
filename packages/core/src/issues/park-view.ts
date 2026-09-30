// What a person owes an issue, read once for the banner, the status control and the decision panel:
// the status, the park record in the thread and the open question rows (ISS-1310).

import type { IssuePark, ParkOwes, ParkResume } from '@forge/contracts';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  like,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  comments,
  type IssueStatus,
  issueStatuses,
  issues,
  kernelTransitions,
  type WaitingKind,
} from '../db/schema.js';
import { activityLog } from '../db/schema-activity.js';
import { parseForgeRecord } from '../messaging/forge-record.js';
import { openHumanQuestionIdsOn } from '../questions/issue-coupling.js';
import {
  AWAITING_INPUT_STATUSES,
  HUMAN_PARK_STATUSES,
  ISSUE_TERMINAL_STATUSES,
} from './status-sets.js';

/** A park is set down from a working rung and returned to one; a side status never is one. */
const SIDE_STATUSES: readonly string[] = HUMAN_PARK_STATUSES;
const NOT_A_RUNG: readonly string[] = [...HUMAN_PARK_STATUSES, ...ISSUE_TERMINAL_STATUSES, 'draft'];

const HISTORY_SHORT =
  'the moves before this park were made before Forge recorded each move inside its own write, so nothing says which park record is this one — move it where it belongs with Move anyway';

/** The heading every park announcement opens with, as the plugin's `announces` reads it. */
const ANNOUNCED = /—\s*moved from `[a-z_]+`\**$/u;
const ANSWER_CHARS = 2000;

const NO_RECORD =
  'no park record was posted for this park, so nothing says where it resumes — move it where it belongs with Move anyway';

export interface ParkMove {
  to: string;
  at: Date;
  reason: string | null;
}

export interface ParkComment {
  id: string;
  body: string;
  createdAt: Date;
  /** Posted on a paired device's token: a run's write, never a person's reply. */
  byDevice?: boolean;
}

export interface ParkInput {
  status: IssueStatus;
  waitingKind: WaitingKind | null;
  /** Status moves, newest first. */
  moves: readonly ParkMove[];
  /**
   * Whether `moves` reach back to the move before this park, or to the issue's creation where it
   * made none. `false` where the park began before moves were recorded inside their own write.
   */
  historyReaches?: boolean;
  /** Record comments posted after `boundaryOf(moves)`, oldest first. */
  comments: readonly ParkComment[];
  /** Comments after the boundary that could be a person's reply, oldest first. */
  replies?: readonly ParkComment[];
  openHumanQuestionIds: readonly string[];
}

/**
 * The transition that preceded this park: the newest move into a working rung. A park record is
 * written just before a `needs_info` move and just after a `waiting` one, so both fall after it,
 * and a record from an earlier park falls before it. `null` where the history holds no such move.
 */
export function boundaryOf(moves: readonly ParkMove[]): Date | null {
  return moves.find((m) => !SIDE_STATUSES.includes(m.to))?.at ?? null;
}

/** The kind the park stored decides; a `needs_info` park that stored none asks for information. */
function owesOf(status: IssueStatus, waitingKind: WaitingKind | null): ParkOwes | null {
  if (waitingKind === 'needs_decision') return 'decision';
  if (waitingKind === 'needs_resource') return 'resource';
  return status === 'waiting' ? null : 'information';
}

function fieldsOf(body: string, kind: string) {
  const record = parseForgeRecord(body);
  if (record?.kind !== kind) return null;
  return record.fields;
}

function resumeFrom(park: { id: string; left: string | undefined } | null): ParkResume {
  if (!park) return { at: null, why: NO_RECORD };
  const left = park.left?.trim();
  if (!left) {
    return {
      at: null,
      why: 'the park record names no status it left, so nothing says where it resumes',
    };
  }
  if (!(issueStatuses as readonly string[]).includes(left)) {
    return { at: null, why: `the park record says it left \`${left}\`, which is no status` };
  }
  if (NOT_A_RUNG.includes(left)) {
    return {
      at: null,
      why: `the park record says it left \`${left}\`, which is not a rung work resumes at`,
    };
  }
  return { at: left as IssueStatus, recordId: park.id };
}

/** The park view for one issue, or `null` where nobody owes it anything. */
export function readPark(input: ParkInput): IssuePark | null {
  const parked = AWAITING_INPUT_STATUSES.includes(input.status);
  if (!parked && input.openHumanQuestionIds.length === 0) return null;
  const entry = input.moves[0]?.to === input.status ? input.moves[0] : undefined;
  if (parked && input.historyReaches === false) {
    return {
      shape: 'park',
      status: input.status,
      owes: owesOf(input.status, input.waitingKind),
      since: entry ? entry.at.toISOString() : null,
      reason: entry?.reason ?? null,
      resume: { at: null, why: HISTORY_SHORT },
      record: null,
      readings: [],
      answer: null,
      openQuestionIds: [...input.openHumanQuestionIds],
    };
  }
  let record: IssuePark['record'] = null;
  let left: string | undefined;
  let readings: string[] = [];
  for (const c of input.comments) {
    const park = fieldsOf(c.body, 'park');
    if (park) {
      const one = (key: string) => park.find((f) => f.key === key)?.value;
      record = {
        commentId: c.id,
        kind: one('kind') ?? null,
        why: one('why') ?? null,
        postedAt: c.createdAt.toISOString(),
      };
      left = one('left');
      continue;
    }
    const question = fieldsOf(c.body, 'question');
    if (question) readings = question.filter((f) => f.key === 'reading').map((f) => f.value);
  }
  return {
    shape: parked ? 'park' : 'question',
    status: input.status,
    owes: parked ? owesOf(input.status, input.waitingKind) : 'information',
    since: entry ? entry.at.toISOString() : null,
    reason: entry?.reason ?? null,
    resume: parked
      ? resumeFrom(record ? { id: record.commentId, left } : null)
      : {
          at: null,
          why: `the issue has not stopped: it stands at \`${input.status}\` and waits on the answer`,
        },
    record: parked ? record : null,
    readings: parked ? readings : [],
    answer: parked && record ? answerAfter(input.replies ?? [], record.postedAt) : null,
    openQuestionIds: [...input.openHumanQuestionIds],
  };
}

/**
 * The reply a run reads as the answer to its park, by the rule the plugin's `answered` reads: the
 * newest comment later than the park record that no device posted and no move announces, or an
 * `answer` record relaying one.
 */
function answerAfter(replies: readonly ParkComment[], recordAt: string): IssuePark['answer'] {
  const after = new Date(recordAt).getTime();
  const reply = [...replies].reverse().find((c) => {
    if (c.createdAt.getTime() <= after) return false;
    if (fieldsOf(c.body, 'answer')) return true;
    const heading = c.body.split('\n')[0]?.trim() ?? '';
    return !c.byDevice && !ANNOUNCED.test(heading) && !parseForgeRecord(c.body);
  });
  if (!reply) return null;
  return {
    commentId: reply.id,
    postedAt: reply.createdAt.toISOString(),
    text: reply.body.slice(0, ANSWER_CHARS),
  };
}

/** The newest audited move of this issue, found among rows matching `scope`. */
function newestMove(issueId: string, scope: SQL | undefined) {
  return db
    .select({
      to: kernelTransitions.toStatus,
      reason: kernelTransitions.reason,
      at: kernelTransitions.createdAt,
    })
    .from(kernelTransitions)
    .where(
      and(eq(kernelTransitions.entity, 'issue'), eq(kernelTransitions.entityId, issueId), scope),
    )
    .orderBy(desc(kernelTransitions.createdAt))
    .limit(1);
}

/**
 * The two moves `readPark` reads — the newest, and the newest into a working rung — from
 * `kernel_transitions`, which the transition writes inside its own transaction. The history row a
 * bus subscriber writes after the commit trails the move, so a record posted after the move could
 * read as older than it (ISS-1310, judge j1). `reaches` says whether that record goes back far
 * enough to bound this park.
 */
async function movesOf(
  issueId: string,
  status: IssueStatus,
): Promise<{ moves: ParkMove[]; reaches: boolean }> {
  const [newest] = await newestMove(issueId, undefined);
  const [boundary] = await newestMove(
    issueId,
    notInArray(kernelTransitions.toStatus, [...SIDE_STATUSES]),
  );
  const moves = [newest, boundary]
    .filter((r) => r !== undefined)
    .map((r) => ({ to: r.to, at: r.at, reason: r.reason ?? null }));
  if (!newest || newest.to !== status) return { moves, reaches: false };
  if (boundary) return { moves, reaches: true };
  return { moves, reaches: !(await movedBeforeTheAudit(issueId)) };
}

/**
 * Whether this issue moved before its oldest audited move: an `issue.statusChanged` history row
 * older than it. Read for existence only — that row's time is never a boundary.
 */
async function movedBeforeTheAudit(issueId: string): Promise<boolean> {
  const [oldest] = await db
    .select({ at: kernelTransitions.createdAt })
    .from(kernelTransitions)
    .where(and(eq(kernelTransitions.entity, 'issue'), eq(kernelTransitions.entityId, issueId)))
    .orderBy(asc(kernelTransitions.createdAt))
    .limit(1);
  if (!oldest) return true;
  const [earlier] = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.issueId, issueId),
        eq(activityLog.action, 'issue.statusChanged'),
        lt(activityLog.createdAt, oldest.at),
      ),
    )
    .limit(1);
  return earlier !== undefined;
}

const after = (boundary: Date | null) => (boundary ? gt(comments.createdAt, boundary) : sql`true`);

/** `readPark` over the rows: the issue, its moves, its record comments and its open questions. */
export async function loadIssuePark(issueId: string): Promise<IssuePark | null> {
  const [issue] = await db
    .select({ status: issues.status, waitingKind: issues.waitingKind })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);
  if (!issue) return null;
  const openHumanQuestionIds = await openHumanQuestionIdsOn(db, issueId);
  const status = issue.status as IssueStatus;
  if (!AWAITING_INPUT_STATUSES.includes(status)) {
    return readPark({ status, waitingKind: null, moves: [], comments: [], openHumanQuestionIds });
  }
  const { moves, reaches } = await movesOf(issueId, status);
  const boundary = boundaryOf(moves);
  const records = await db
    .select({ id: comments.id, body: comments.body, createdAt: comments.createdAt })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueId),
        after(boundary),
        or(
          like(comments.body, '%forge-record: park%'),
          like(comments.body, '%forge-record: question%'),
        ),
      ),
    )
    .orderBy(comments.createdAt);
  const replies = await db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      device: comments.authorDeviceId,
    })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueId),
        after(boundary),
        or(isNull(comments.authorDeviceId), like(comments.body, '%forge-record: answer%')),
      ),
    )
    .orderBy(desc(comments.createdAt))
    .limit(50);
  return readPark({
    status,
    waitingKind: (issue.waitingKind as WaitingKind | null) ?? null,
    moves,
    historyReaches: reaches,
    comments: records,
    replies: replies.reverse().map((r) => ({ ...r, byDevice: r.device !== null })),
    openHumanQuestionIds,
  });
}
