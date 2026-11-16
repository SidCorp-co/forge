// A project's reply audits as a reader reads them (ISS-1250): the newest first, by bot, verdict and
// room kind, with each bot's replies, how many its agent audited, and how those passed and failed, so
// a person sees whether the teaching works.

import {
  REPLY_VERDICTS_LIMIT,
  type ReplyFinding,
  type ReplyMiss,
  type ReplyRubricLine,
  type ReplyVerdictsQuery,
  type ReplyVerdictsView,
} from '@forge/contracts/support-reply-audit';
import { and, desc, eq, gte, type SQL, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { supportActions, supportRooms } from '../../db/schema-support.js';
import { supportReplyVerdicts } from '../../db/schema-support-verdicts.js';

type Bots = ReplyVerdictsView['bots'];

/** Each bot's replies in the window, and of them the audited, passed and failed. */
async function botCounts(projectId: string, q: ReplyVerdictsQuery): Promise<Bots> {
  const a = supportActions;
  const v = supportReplyVerdicts;
  const where: SQL[] = [
    eq(a.projectId, projectId),
    eq(a.kind, 'reply'),
    sql`${a.externalId} IS NOT NULL`,
    ...(q.bot ? [eq(supportRooms.connectionId, q.bot)] : []),
    ...(q.roomKind ? [eq(supportRooms.kind, q.roomKind)] : []),
    ...(q.since ? [gte(a.createdAt, new Date(q.since))] : []),
  ];
  const rows = await db
    .select({
      bot: supportRooms.connectionId,
      replies: sql<number>`count(*)::int`,
      audited: sql<number>`count(${v.id})::int`,
      pass: sql<number>`count(*) FILTER (WHERE ${v.verdict} = 'pass')::int`,
      fail: sql<number>`count(*) FILTER (WHERE ${v.verdict} = 'fail')::int`,
    })
    .from(a)
    .innerJoin(supportRooms, eq(supportRooms.id, a.roomId))
    .leftJoin(v, and(eq(v.roomId, a.roomId), eq(v.message, a.externalId)))
    .where(and(...where))
    .groupBy(supportRooms.connectionId);
  return rows;
}

export async function replyVerdictsOf(
  projectId: string,
  q: ReplyVerdictsQuery,
): Promise<ReplyVerdictsView> {
  const v = supportReplyVerdicts;
  const limit = q.limit ?? REPLY_VERDICTS_LIMIT;
  const [rows, bots] = await Promise.all([
    db
      .select({ verdict: v, rid: supportRooms.rid })
      .from(v)
      .innerJoin(supportRooms, eq(supportRooms.id, v.roomId))
      .where(
        and(
          eq(v.projectId, projectId),
          ...(q.bot ? [eq(v.bot, q.bot)] : []),
          ...(q.roomKind ? [eq(v.roomKind, q.roomKind)] : []),
          ...(q.since ? [gte(v.auditedAt, new Date(q.since))] : []),
          ...(q.verdict ? [eq(v.verdict, q.verdict)] : []),
        ),
      )
      .orderBy(desc(v.auditedAt), desc(v.id))
      .limit(limit + 1),
    botCounts(projectId, q),
  ]);
  return {
    verdicts: rows.slice(0, limit).map(({ verdict: r, rid }) => ({
      id: r.id,
      bot: r.bot,
      roomId: r.roomId,
      rid,
      roomKind: r.roomKind,
      thread: r.thread,
      message: r.message,
      verdict: r.verdict,
      failed: r.failed as ReplyRubricLine[],
      findings: r.findings as ReplyFinding[],
      missed: r.missed as ReplyMiss[],
      correctionId: r.correctionId,
      auditedAt: r.auditedAt.toISOString(),
    })),
    truncated: rows.length > limit,
    bots,
  };
}
