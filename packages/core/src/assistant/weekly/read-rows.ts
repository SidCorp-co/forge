/**
 * ISS-1056 — the week's rows read in-process: `chat_logs` by project and window, the same
 * conditions `chat-logs/routes.ts` builds, oldest first; the benchmark's own rooms named by the
 * title `bench/run.ts` gives every room it opens (`bench <runId> <taskId>`) and, since the bench
 * deletes those rooms with a read-back so the title lookup finds nothing afterwards, the sessions
 * that spoke nothing but shipped task messages and whose room is gone (ISS-1065 D2); and UUID issue
 * links resolved against `issues.id`, read-only. No API client, no credential.
 */

import { and, asc, eq, gte, inArray, like, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { chatLogs, issues } from '../../db/schema.js';
import { conversations } from '../../db/schema-conversations.js';
import { extractIssueLinks, type LinkOutcome } from '../bench/grade.js';
import { benchSessions } from '../bench/history/bench-sessions.js';
import type { HistoryRow } from '../bench/history/row.js';
import { loadTasks } from '../bench/tasks/index.js';

export interface WeekQuery {
  projectSlug: string;
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  source?: string | undefined;
}

export interface WeekRows {
  rows: HistoryRow[];
  /** The `conversations.id` of every bench room among the rows' sessions. */
  benchRooms: string[];
  /** Sessions that spoke nothing but shipped task messages and whose room is gone (ISS-1065 D2), apart from `benchRooms`. */
  benchRoomsGone: string[];
}

/** The title prefix `bench/run.ts:runTrial` gives every room the benchmark opens. */
export const BENCH_ROOM_TITLE_PREFIX = 'bench ';

type Executor = Pick<typeof db, 'select'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The window's rows, oldest first, and the bench rooms among them. */
export async function readWeekRows(q: WeekQuery, dbi: Executor = db): Promise<WeekRows> {
  const conditions = [
    eq(chatLogs.projectSlug, q.projectSlug),
    gte(chatLogs.createdAt, q.from),
    lt(chatLogs.createdAt, q.to),
    ...(q.source ? [eq(chatLogs.source, q.source)] : []),
  ];
  const found = await dbi
    .select()
    .from(chatLogs)
    .where(and(...conditions))
    .orderBy(asc(chatLogs.createdAt), asc(chatLogs.id));
  const rows: HistoryRow[] = found.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    reply: r.reply,
    toolCalls: r.toolCalls,
    iterations: r.iterations,
    durationMs: r.durationMs,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    query: r.query,
    model: r.model,
    source: r.source,
    userKey: r.userKey,
  }));
  const sessions = [...new Set(rows.flatMap((r) => (r.sessionId ? [r.sessionId] : [])))];
  const benchRooms =
    sessions.length === 0
      ? []
      : (
          await dbi
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                inArray(conversations.id, sessions),
                like(conversations.title, `${BENCH_ROOM_TITLE_PREFIX}%`),
              ),
            )
        ).map((r) => r.id);
  const candidates = benchSessions(rows, loadTasks()).filter((id) => !benchRooms.includes(id));
  const present =
    candidates.length === 0
      ? new Set<string>()
      : new Set(
          (
            await dbi
              .select({ id: conversations.id })
              .from(conversations)
              .where(inArray(conversations.id, candidates))
          ).map((r) => r.id),
        );
  return {
    rows,
    benchRooms: benchRooms.sort(),
    benchRoomsGone: candidates.filter((id) => !present.has(id)),
  };
}

/** Every UUID issue link across the rows, resolved against `issues.id`. */
export async function lookupsFor(
  rows: readonly HistoryRow[],
  dbi: Executor = db,
): Promise<Record<string, LinkOutcome>> {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const link of extractIssueLinks(row.reply ?? '')) {
      if (UUID_RE.test(link.segment)) ids.add(link.segment.toLowerCase());
    }
  }
  const out: Record<string, LinkOutcome> = {};
  if (ids.size === 0) return out;
  const found = new Set(
    (
      await dbi
        .select({ id: issues.id })
        .from(issues)
        .where(inArray(issues.id, [...ids]))
    ).map((r) => r.id.toLowerCase()),
  );
  for (const id of ids) out[id] = found.has(id) ? 'resolves' : 'dead';
  return out;
}
