// A project's room-line verdicts as a reader reads them (ISS-1250): the newest first, by bot, verdict
// and room kind, with each bot's pass, fail and unjudged counts over the same window.

import {
  REPLY_VERDICTS_LIMIT,
  type ReplyFinding,
  type ReplyRubricLine,
  type ReplyVerdict,
  type ReplyVerdictsQuery,
  type ReplyVerdictsView,
} from '@forge/contracts/support-reply-audit';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { supportRooms } from '../../db/schema-support.js';
import { supportReplyVerdicts } from '../../db/schema-support-verdicts.js';

export async function replyVerdictsOf(
  projectId: string,
  q: ReplyVerdictsQuery,
): Promise<ReplyVerdictsView> {
  const v = supportReplyVerdicts;
  const window = [
    eq(v.projectId, projectId),
    ...(q.bot ? [eq(v.bot, q.bot)] : []),
    ...(q.roomKind ? [eq(v.roomKind, q.roomKind)] : []),
    ...(q.since ? [gte(v.judgedAt, new Date(q.since))] : []),
  ];
  const limit = q.limit ?? REPLY_VERDICTS_LIMIT;
  const [rows, counts] = await Promise.all([
    db
      .select({ verdict: v, rid: supportRooms.rid })
      .from(v)
      .innerJoin(supportRooms, eq(supportRooms.id, v.roomId))
      .where(and(...window, ...(q.verdict ? [eq(v.verdict, q.verdict)] : [])))
      .orderBy(desc(v.judgedAt), desc(v.id))
      .limit(limit + 1),
    db
      .select({ bot: v.bot, verdict: v.verdict, n: sql<number>`count(*)::int` })
      .from(v)
      .where(and(...window))
      .groupBy(v.bot, v.verdict),
  ]);
  const bots = new Map<string, { bot: string } & Record<ReplyVerdict, number>>();
  for (const c of counts) {
    const at = bots.get(c.bot) ?? { bot: c.bot, pass: 0, fail: 0, unjudged: 0 };
    at[c.verdict] = c.n;
    bots.set(c.bot, at);
  }
  return {
    verdicts: rows.slice(0, limit).map(({ verdict: r, rid }) => ({
      id: r.id,
      bot: r.bot,
      roomId: r.roomId,
      rid,
      roomKind: r.roomKind,
      conversationId: r.conversationId,
      messageId: r.messageId,
      subject: r.subject,
      verdict: r.verdict,
      failed: r.failed as ReplyRubricLine[],
      findings: r.findings as ReplyFinding[],
      model: r.model,
      miss: r.miss,
      correctionId: r.correctionId,
      judgedAt: r.judgedAt.toISOString(),
    })),
    truncated: rows.length > limit,
    bots: [...bots.values()],
  };
}
