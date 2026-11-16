/**
 * What agents did with the doors Forge gives them, in one project over a window (ISS-1251): each
 * door's calls by agent kind, the doors nobody called listed beside the ones in use, what each agent
 * kind read and which lessons it said it applied. Every figure is a count over a log Forge already
 * keeps: `mcp_audit_log` (every MCP call, and every REST write a token makes), `run_context_reaches`
 * (what a box session's credential read) and `lesson_applications`. The catalog is the denominator,
 * so a door no agent ever reached for shows, with 0.
 */

import {
  DOOR_USE_TOP,
  type DoorLessonAppliedRow,
  type DoorReadRow,
  type DoorUseQuery,
  type DoorUseRow,
  type DoorUseView,
} from '@forge/contracts/door-use';
import type { RunContextHow, RunContextSourceKind } from '@forge/contracts/run-context';
import { type SQL, sql } from 'drizzle-orm';
import { SESSION_TURN_TOKEN_PREFIX, TOKEN_HOLDER_PREFIXES } from '../credentials/pat-format.js';
import { db } from '../db/client.js';
import type { DoorCatalog } from '../lib/door-catalog.js';

const DAY_MS = 86_400_000;

/** What the logs cannot tell, said with every answer so a gap is not read as "nobody did it". */
export const DOOR_USE_LIMITS = [
  'A REST read is logged nowhere, so a door here is an MCP action or a REST write; what a read returned is under reads.',
  'reads holds what a box session read through knowledge, memory and agreement routes; an MCP read of knowledge is not recorded there.',
  'A box credential is shared by its master and the runs it starts, so their REST writes count under box; their reads are told apart under session:<kind>.',
  'A call counts for this project where it named the project, or its credential is fenced to this project alone.',
];

/** The room's agent the session answers for, else the session's own kind. */
const sessionAgent = (session: SQL) =>
  sql`COALESCE(
    'room:' || (SELECT r.kind FROM support_rooms r WHERE r.session_id = ${session} LIMIT 1),
    'session:' || (SELECT s.kind FROM agent_sessions s WHERE s.id = ${session}),
    'session')`;

/** Who called, read off the token: its name's prefix, a turn token by its session, else its holder's kind. */
function tokenAgent(): SQL {
  const turn = sql`(CASE WHEN t.name LIKE ${`${SESSION_TURN_TOKEN_PREFIX}%`}
    THEN substr(t.name, ${SESSION_TURN_TOKEN_PREFIX.length + 1}) END)`;
  const room = sql`COALESCE(
    'room:' || (SELECT r.kind FROM support_rooms r WHERE r.session_id::text = ${turn} LIMIT 1),
    'session:' || (SELECT s.kind FROM agent_sessions s WHERE s.id::text = ${turn}))`;
  const named = TOKEN_HOLDER_PREFIXES.map(([prefix, holder]) =>
    prefix === SESSION_TURN_TOKEN_PREFIX
      ? sql`WHEN t.name LIKE ${`${prefix}%`} THEN COALESCE(${room}, ${holder})`
      : sql`WHEN t.name LIKE ${`${prefix}%`} THEN ${holder}`,
  );
  return sql`CASE ${sql.join(named, sql` `)}
    WHEN u.kind = 'agent' THEN 'agent-account' ELSE 'person' END`;
}

export type CallRow = {
  tool: string;
  action: string | null;
  agent: string;
  calls: number;
  refused: number;
  last_at: Date | string | null;
};

async function callRows(projectId: string, since: Date): Promise<CallRow[]> {
  const rows = await db.execute(sql`
    SELECT a.tool, a.action, ${tokenAgent()} AS agent, count(*)::int AS calls,
      (count(*) FILTER (WHERE a.result_code <> 'ok'))::int AS refused, max(a.created_at) AS last_at
    FROM mcp_audit_log a
    LEFT JOIN personal_access_tokens t ON t.id = a.token_id
    LEFT JOIN users u ON u.id = a.user_id
    WHERE a.created_at >= ${since.toISOString()}::timestamptz AND a.tool <> 'rate_limit'
      AND COALESCE(a.project_id, t.bound_project_id,
        CASE WHEN cardinality(t.project_ids) = 1 THEN t.project_ids[1] END) = ${projectId}::uuid
    GROUP BY 1, 2, 3`);
  return rows as unknown as CallRow[];
}

const iso = (at: Date | string | null) =>
  at === null ? null : (at instanceof Date ? at : new Date(at)).toISOString();

const EMPTY = () => ({
  calls: 0,
  refused: 0,
  byAgent: {} as Record<string, number>,
  lastAt: null as string | null,
});

/** Each door of `catalog` with its calls, and the logged calls the catalog names no door for. */
export function tallyDoors(
  catalog: DoorCatalog,
  rows: readonly CallRow[],
): { doors: DoorUseRow[]; unmatched: { door: string; calls: number }[] } {
  const doors = new Map<string, DoorUseRow>(
    catalog.doors.map((d) => [
      d.id,
      {
        door: d.id,
        surface: d.surface,
        summary: d.summary,
        feature: d.feature,
        card: d.card ?? null,
        ...EMPTY(),
      },
    ]),
  );
  const unmatched = new Map<string, number>();
  for (const row of rows) {
    const found = catalog.doorOf({ tool: row.tool, action: row.action });
    const door = found ? doors.get(found.id) : undefined;
    if (!door) {
      const name = row.tool === 'rest' ? (row.action ?? 'rest') : `${row.tool}.${row.action ?? ''}`;
      unmatched.set(name, (unmatched.get(name) ?? 0) + row.calls);
      continue;
    }
    door.calls += row.calls;
    door.refused += row.refused;
    door.byAgent[row.agent] = (door.byAgent[row.agent] ?? 0) + row.calls;
    const last = iso(row.last_at);
    if (last && (!door.lastAt || last > door.lastAt)) door.lastAt = last;
  }
  return {
    doors: [...doors.values()].sort((a, b) => b.calls - a.calls || a.door.localeCompare(b.door)),
    unmatched: [...unmatched]
      .map(([door, calls]) => ({ door, calls }))
      .sort((a, b) => b.calls - a.calls || a.door.localeCompare(b.door)),
  };
}

type ReachRow = { agent: string; kind: string; how: string; ref: string; n: number };

async function readRows(projectId: string, since: Date): Promise<DoorReadRow[]> {
  const rows = (await db.execute(sql`
      SELECT ${sessionAgent(sql`c.agent_session_id`)} AS agent, c.kind, c.how, c.ref, count(*)::int AS n
      FROM run_context_reaches c
      WHERE c.project_id = ${projectId}::uuid AND c.created_at >= ${since.toISOString()}::timestamptz
      GROUP BY 1, 2, 3, 4`)) as unknown as ReachRow[];
  const groups = new Map<string, DoorReadRow>();
  for (const r of rows) {
    const key = `${r.agent}\u0000${r.kind}\u0000${r.how}`;
    const g = groups.get(key) ?? {
      agent: r.agent,
      kind: r.kind as RunContextSourceKind,
      how: r.how as RunContextHow,
      reaches: 0,
      entries: 0,
      top: [],
    };
    g.reaches += r.n;
    g.entries += 1;
    g.top.push({ ref: r.ref, reaches: r.n });
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      top: g.top
        .sort((a, b) => b.reaches - a.reaches || a.ref.localeCompare(b.ref))
        .slice(0, DOOR_USE_TOP),
    }))
    .sort((a, b) => b.reaches - a.reaches || a.agent.localeCompare(b.agent));
}

async function lessonRows(projectId: string, since: Date): Promise<DoorLessonAppliedRow[]> {
  const rows = (await db.execute(sql`
      SELECT 'L-' || l.number AS lesson,
        CASE WHEN u.kind = 'agent' THEN 'agent-account' ELSE 'person' END AS agent,
        count(*)::int AS applications
      FROM lesson_applications la
      JOIN lessons l ON l.id = la.lesson_id
      LEFT JOIN users u ON u.id = la.agent_user_id
      WHERE la.project_id = ${projectId}::uuid AND la.at >= ${since.toISOString()}::timestamptz
      GROUP BY 1, 2 ORDER BY 3 DESC, 1`)) as unknown as DoorLessonAppliedRow[];
  return rows;
}

/** The use of every door of `catalog` in one project over the query's window. */
export async function readDoorUse(
  projectId: string,
  query: DoorUseQuery,
  catalog: DoorCatalog,
  now: Date = new Date(),
): Promise<DoorUseView> {
  const since = new Date(now.getTime() - query.days * DAY_MS);
  const [calls, reads, lessonsApplied] = await Promise.all([
    callRows(projectId, since),
    readRows(projectId, since),
    lessonRows(projectId, since),
  ]);
  const { doors, unmatched } = tallyDoors(catalog, calls);
  const shown = doors.filter(
    (d) =>
      (!query.surface || d.surface === query.surface) &&
      (!query.used || (query.used === 'never' ? d.calls === 0 : d.calls > 0)),
  );
  return {
    projectId,
    window: { days: query.days, since: since.toISOString(), until: now.toISOString() },
    doors: shown,
    totals: {
      doors: doors.length,
      neverUsed: doors.filter((d) => d.calls === 0).length,
      calls: doors.reduce((n, d) => n + d.calls, 0),
      taught: doors.filter((d) => d.card !== null).length,
    },
    unmatched,
    reads,
    lessonsApplied,
    limits: DOOR_USE_LIMITS,
  };
}
