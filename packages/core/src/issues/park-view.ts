// What a person owes an issue, read once for the banner, the status control and the decision panel:
// the status, the park record in the thread and the open question rows (ISS-1310).

import type { IssuePark, ParkOwes, ParkResume } from '@forge/contracts';
import { and, desc, eq, gt, like, notInArray, or, type SQL, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  comments,
  type IssueStatus,
  issueStatuses,
  issues,
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
}

export interface ParkInput {
  status: IssueStatus;
  waitingKind: WaitingKind | null;
  /** Status moves, newest first. */
  moves: readonly ParkMove[];
  /** Comments posted after `boundaryOf(moves, status)`, oldest first. */
  comments: readonly ParkComment[];
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
    openQuestionIds: [...input.openHumanQuestionIds],
  };
}

const toOf = sql<string>`${activityLog.payload}->>'to'`;

/**
 * The two moves `readPark` reads — the newest, and the newest into a working rung — each found in
 * the whole history, so a park that has cycled through side statuses keeps its own boundary.
 */
async function movesOf(issueId: string): Promise<ParkMove[]> {
  const newestWhere = (scope: SQL | undefined) =>
    db
      .select({ payload: activityLog.payload, at: activityLog.createdAt })
      .from(activityLog)
      .where(and(eq(activityLog.issueId, issueId), eq(activityLog.action, 'issue.statusChanged'), scope))
      .orderBy(desc(activityLog.createdAt))
      .limit(1);
  const [newest] = await newestWhere(undefined);
  const [boundary] = await newestWhere(notInArray(toOf, [...SIDE_STATUSES]));
  const rows = [newest, boundary].filter((r) => r !== undefined);
  return rows.map((r) => {
    const p = (r.payload ?? {}) as { to?: unknown; reason?: unknown };
    return {
      to: typeof p.to === 'string' ? p.to : '',
      at: r.at,
      reason: typeof p.reason === 'string' ? p.reason : null,
    };
  });
}

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
  const boundary = boundaryOf(moves);
  const records = await db
    .select({ id: comments.id, body: comments.body, createdAt: comments.createdAt })
    .from(comments)
    .where(
      and(
        eq(comments.issueId, issueId),
        boundary ? gt(comments.createdAt, boundary) : sql`true`,
        or(
          like(comments.body, '%forge-record: park%'),
          like(comments.body, '%forge-record: question%'),
        ),
      ),
    )
    .orderBy(comments.createdAt);
  return readPark({
    status,
    waitingKind: (issue.waitingKind as WaitingKind | null) ?? null,
    moves,
    comments: records,
    openHumanQuestionIds,
  });
}
