// What a person owes an issue, read once for the banner, the status control and the decision panel:
// the status, the park record in the thread and the open question rows (ISS-1310).

import type { IssuePark, ParkOwes, ParkResume } from '@forge/contracts';
import { and, desc, eq, gt, isNull, notInArray, notLike, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  comments,
  type IssueStatus,
  issues,
  kernelTransitions,
  type WaitingKind,
} from '../db/schema.js';
import { issueWorkState } from '../db/schema-issue-work-state.js';
import { type ForgeRecord, parseForgeRecord } from '../messaging/forge-record.js';
import { PARK_STATUSES } from '../pipeline/state-machine.js';
import { openHumanQuestionIdsOn } from '../questions/issue-coupling.js';
import { type RecordEntry, recordHistory } from './record-events/history.js';
import { AWAITING_INPUT_STATUSES } from './status-sets.js';
import { announcesAMove } from './transition-reason.js';

/** A park is set down from a working status and returned to one; a side status never is one. */
const SIDE_STATUSES: readonly string[] = PARK_STATUSES;

const LEFT_UNKNOWN =
  'this park began before Forge kept the status a park leaves (migration 0346 found no audited move into it), so nothing says where it resumes — a person names it with Move anyway';

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
  /** The record this entry carries, read from its typed event (ISS-56); else the body is parsed. */
  record?: ForgeRecord | null;
  /** The event the record is stored as, where it is one. */
  eventId?: string | null;
  /** The comment that carried it, where one did; `null` for a record written only as an event. */
  commentId?: string | null;
}

export interface ParkInput {
  status: IssueStatus;
  waitingKind: WaitingKind | null;
  /** `issue_work_state.left_status`: where the park returns, or null where nothing recorded it. */
  leftStatus?: IssueStatus | null;
  /** Status moves, newest first. */
  moves: readonly ParkMove[];
  /** Record comments posted after `boundaryOf(moves)`, oldest first. */
  comments: readonly ParkComment[];
  /** Comments after the boundary that could be a person's reply, oldest first. */
  replies?: readonly ParkComment[];
  openHumanQuestionIds: readonly string[];
}

/**
 * The transition that preceded this park: the newest move into a working rung. A park record is
 * written around the `needs_info` move it records, so it falls after this boundary,
 * and a record from an earlier park falls before it. `null` where the history holds no such move.
 */
export function boundaryOf(moves: readonly ParkMove[]): Date | null {
  return moves.find((m) => !SIDE_STATUSES.includes(m.to))?.at ?? null;
}

/** The kind the park stored decides what a person owes it. */
function owesOf(waitingKind: WaitingKind | null): ParkOwes {
  if (waitingKind === 'needs_decision') return 'decision';
  if (waitingKind === 'needs_resource') return 'resource';
  return 'information';
}

function recordIn(entry: ParkComment): ForgeRecord | null {
  return entry.record !== undefined ? entry.record : parseForgeRecord(entry.body);
}

function fieldsOf(entry: ParkComment, kind: string) {
  const record = recordIn(entry);
  if (record?.kind !== kind) return null;
  return record.fields;
}

/** The comment an entry stands for: its own id where it is a comment read whole. */
const commentOf = (entry: ParkComment): string | null =>
  entry.commentId !== undefined ? entry.commentId : entry.id;

function resumeFrom(leftStatus: IssueStatus | null, recordId: string | null): ParkResume {
  if (leftStatus === null) return { at: null, why: LEFT_UNKNOWN };
  return { at: leftStatus, recordId };
}

/** The park view for one issue, or `null` where nobody owes it anything. */
export function readPark(input: ParkInput): IssuePark | null {
  const parked = AWAITING_INPUT_STATUSES.includes(input.status);
  if (!parked && input.openHumanQuestionIds.length === 0) return null;
  const entry = input.moves[0]?.to === input.status ? input.moves[0] : undefined;
  let record: IssuePark['record'] = null;
  let readings: string[] = [];
  for (const c of input.comments) {
    const park = fieldsOf(c, 'park');
    if (park) {
      const one = (key: string) => park.find((f) => f.key === key)?.value;
      record = {
        commentId: commentOf(c),
        eventId: c.eventId ?? null,
        kind: one('kind') ?? null,
        why: one('why') ?? null,
        postedAt: c.createdAt.toISOString(),
      };
      continue;
    }
    const question = fieldsOf(c, 'question');
    if (question) readings = question.filter((f) => f.key === 'reading').map((f) => f.value);
  }
  return {
    shape: parked ? 'park' : 'question',
    status: input.status,
    owes: parked ? owesOf(input.waitingKind) : 'information',
    since: entry ? entry.at.toISOString() : null,
    reason: entry?.reason ?? null,
    resume: parked
      ? resumeFrom(input.leftStatus ?? null, record?.eventId ?? record?.commentId ?? null)
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
    if (fieldsOf(c, 'answer')) return true;
    return !c.byDevice && !announcesAMove(c.body) && !recordIn(c);
  });
  if (!reply) return null;
  return {
    commentId: commentOf(reply) ?? reply.id,
    postedAt: reply.createdAt.toISOString(),
    text: reply.body,
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
 * The two moves `readPark` reads — the newest, and the newest into a working status — from
 * `kernel_transitions`, which the transition writes inside its own transaction. They bound which
 * park record and which reply belong to this park; where the park resumes is the work state's.
 */
async function movesOf(issueId: string): Promise<ParkMove[]> {
  const [newest] = await newestMove(issueId, undefined);
  const [boundary] = await newestMove(
    issueId,
    notInArray(kernelTransitions.toStatus, [...SIDE_STATUSES]),
  );
  return [newest, boundary]
    .filter((r) => r !== undefined)
    .map((r) => ({ to: r.to, at: r.at, reason: r.reason ?? null }));
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
  const moves = await movesOf(issueId);
  const [work] = await db
    .select({ leftStatus: issueWorkState.leftStatus })
    .from(issueWorkState)
    .where(eq(issueWorkState.issueId, issueId))
    .limit(1);
  const boundary = boundaryOf(moves);
  const asEntry = (r: RecordEntry): ParkComment => ({
    id: r.id,
    body: '',
    createdAt: r.createdAt,
    byDevice: r.byDevice,
    record: r.record,
    eventId: r.eventId,
    commentId: r.commentId,
  });
  const records = await recordHistory(issueId, { kinds: ['park', 'question'], after: boundary });
  const answers = await recordHistory(issueId, { kinds: ['answer'], after: boundary });
  const prose = await db
    .select({ id: comments.id, body: comments.body, createdAt: comments.createdAt })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueId),
        after(boundary),
        isNull(comments.authorDeviceId),
        notLike(comments.body, '%forge-record%'),
      ),
    )
    .orderBy(comments.createdAt);
  const replies = [
    ...prose.map((r): ParkComment => ({ ...r, byDevice: false, record: null, commentId: r.id })),
    ...answers.map(asEntry),
  ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return readPark({
    status,
    waitingKind: (issue.waitingKind as WaitingKind | null) ?? null,
    moves,
    leftStatus: (work?.leftStatus ?? null) as IssueStatus | null,
    comments: records.map(asEntry),
    replies,
    openHumanQuestionIds,
  });
}
