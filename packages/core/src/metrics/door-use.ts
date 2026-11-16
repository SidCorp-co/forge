/**
 * What agents did with the doors Forge gives them, in one project over a window (ISS-1251): each
 * door's calls by agent kind, the doors nobody called listed beside the ones in use, what each agent
 * kind read and which lessons it said it applied. Every figure is a count over a log Forge already
 * keeps: `mcp_audit_log` (every MCP call, and every REST write a token makes, a refused one with its
 * refusal code), `run_context_reaches` (what a box session or a room's agent was given and read),
 * `lesson_applications`, and `support_reply_verdicts` (the capabilities a room agent's own audit of a
 * reply says it missed). Core infers no miss: a miss is only what an agent named. The catalog is the
 * denominator, so a door no agent ever reached for shows, with 0.
 */

import type { CardAudience } from '@forge/contracts/capability-cards';
import {
  DOOR_USE_TOP,
  type DoorLessonAppliedRow,
  type DoorReadRow,
  type DoorUseDay,
  type DoorUseQuery,
  type DoorUseRow,
  type DoorUseView,
} from '@forge/contracts/door-use';
import type { RunContextHow, RunContextSourceKind } from '@forge/contracts/run-context';
import { type SQL, sql } from 'drizzle-orm';
import { SESSION_TURN_TOKEN_PREFIX, TOKEN_HOLDER_PREFIXES } from '../credentials/pat-format.js';
import { db } from '../db/client.js';
import { cardFreshness } from '../lessons/index.js';
import { type DoorCatalog, doorNames, type Tier0Map, tier0Map } from '../lib/door-catalog.js';

const DAY_MS = 86_400_000;

/** What the logs cannot tell, said with every answer so a gap is not read as "nobody did it". */
export const DOOR_USE_LIMITS = [
  'A REST read is logged nowhere, so a door here is an MCP action or a REST write; what a read returned is under reads.',
  'reads holds what a box session read through knowledge, memory and agreement routes; an MCP read of knowledge is not recorded there.',
  'A box credential is shared by its master and the runs it starts, so their REST writes count under box; their reads are told apart under session:<kind>.',
  'A call counts for this project where it named the project, or its credential is fenced to this project alone.',
  'A refusal is counted by the code it answered with; one logged before refusal codes were kept (ISS-1251) reads by its outcome (forbidden, not_found, error), and one a door answered rather than threw was logged ok.',
  "Misses are the capabilities an agent's own audit named as ones it should have reached for; only a room agent's support.audit records them so far.",
  "An applied lesson a box records reads under its credential's holder (person or agent account), since one box credential serves its master and its runs.",
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
  /**
   * How the call ended: `ok`, or the code a refused call answered with, else the outcome the log keeps
   * (forbidden, not_found, error) where no code was kept.
   */
  code: string;
  calls: number;
  last_at: Date | string | null;
};

/** A capability a room agent's own audit says it missed, by the door id it was kept under. */
export type MissRow = { door: string; agent: string; n: number };

/** The logged calls of one project in the window: named it, or made on a credential fenced to it alone. */
const scopedCalls = (projectId: string, since: Date) => sql`
  FROM mcp_audit_log a
  LEFT JOIN personal_access_tokens t ON t.id = a.token_id
  LEFT JOIN users u ON u.id = a.user_id
  WHERE a.created_at >= ${since.toISOString()}::timestamptz AND a.tool <> 'rate_limit'
    AND COALESCE(a.project_id, t.bound_project_id,
      CASE WHEN cardinality(t.project_ids) = 1 THEN t.project_ids[1] END) = ${projectId}::uuid`;

async function callRows(projectId: string, since: Date): Promise<CallRow[]> {
  const rows = await db.execute(sql`
    SELECT a.tool, a.action, ${tokenAgent()} AS agent,
      CASE WHEN a.result_code = 'ok' THEN 'ok' ELSE COALESCE(a.refusal_code, a.result_code) END AS code,
      count(*)::int AS calls,
      max(a.created_at) AS last_at
    ${scopedCalls(projectId, since)}
    GROUP BY 1, 2, 3, 4`);
  return rows as unknown as CallRow[];
}

/**
 * The capabilities room agents' own audits named as missed (`support.audit`'s `missed`), by door and
 * room kind. The door is kept as the catalog names it, so each counts on its row as written.
 */
async function missRows(projectId: string, since: Date): Promise<MissRow[]> {
  return (await db.execute(sql`
    SELECT m ->> 'door' AS door, 'room:' || v.room_kind AS agent, count(*)::int AS n
    FROM support_reply_verdicts v, jsonb_array_elements(v.missed) m
    WHERE v.project_id = ${projectId}::uuid AND v.audited_at >= ${since.toISOString()}::timestamptz
      AND jsonb_typeof(v.missed) = 'array'
    GROUP BY 1, 2`)) as unknown as MissRow[];
}

/** Every UTC day of the window with its calls and refusals, a day with none included. */
async function dayRows(projectId: string, since: Date, now: Date): Promise<DoorUseDay[]> {
  return (await db.execute(sql`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS day, count(c.code)::int AS calls,
      (count(c.code) FILTER (WHERE c.code <> 'ok'))::int AS refused
    FROM generate_series(${since.toISOString().slice(0, 10)}::date, ${now.toISOString().slice(0, 10)}::date,
      interval '1 day') AS d(day)
    LEFT JOIN (SELECT (a.created_at AT TIME ZONE 'UTC')::date AS day, a.result_code AS code
      ${scopedCalls(projectId, since)}) c ON c.day = d.day::date
    GROUP BY d.day ORDER BY d.day`)) as unknown as DoorUseDay[];
}

const iso = (at: Date | string | null) =>
  at === null ? null : (at instanceof Date ? at : new Date(at)).toISOString();

const EMPTY = () => ({
  misses: 0,
  missedBy: {} as Record<string, number>,
  calls: 0,
  refused: 0,
  refusedBy: {} as Record<string, number>,
  byAgent: {} as Record<string, number>,
  lastAt: null as string | null,
});

/**
 * Each door of `catalog` with its calls and the misses agents named on it, and the logged calls the
 * catalog names no door for. A REST call to a route the catalog folds into a door (`mcp/twins.ts`)
 * counts on that door and its card.
 */
export function tallyDoors(
  catalog: DoorCatalog,
  rows: readonly CallRow[],
  misses: readonly MissRow[] = [],
): { doors: DoorUseRow[]; unmatched: { door: string; calls: number }[] } {
  const names = doorNames(catalog.doors);
  const doors = new Map<string, DoorUseRow>(
    catalog.doors.map((d) => [
      d.id,
      {
        door: d.id,
        name: names.get(d.id) ?? d.id,
        surface: d.surface,
        summary: d.summary,
        feature: d.feature,
        card: d.card ?? null,
        tiers: {},
        twins: [...(d.twins ?? [])],
        viaTwins: 0,
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
    if (catalog.viaTwin({ tool: row.tool, action: row.action })) door.viaTwins += row.calls;
    if (row.code !== 'ok') refuse(door, row.code, row.calls);
    door.byAgent[row.agent] = (door.byAgent[row.agent] ?? 0) + row.calls;
    const last = iso(row.last_at);
    if (last && (!door.lastAt || last > door.lastAt)) door.lastAt = last;
  }
  for (const m of misses) {
    const found = doors.get(m.door) ?? missedDoor(catalog, m.door, doors);
    if (!found) continue;
    found.misses += m.n;
    found.missedBy[m.agent] = (found.missedBy[m.agent] ?? 0) + m.n;
  }
  return {
    doors: [...doors.values()].sort((a, b) => b.calls - a.calls || a.door.localeCompare(b.door)),
    unmatched: [...unmatched]
      .map(([door, calls]) => ({ door, calls }))
      .sort((a, b) => b.calls - a.calls || a.door.localeCompare(b.door)),
  };
}

/** A miss named by a REST twin's route: the door the catalog folds it into. */
function missedDoor(
  catalog: DoorCatalog,
  door: string,
  doors: ReadonlyMap<string, DoorUseRow>,
): DoorUseRow | undefined {
  const found = /^[A-Z]+ \//.test(door) ? catalog.doorOf({ tool: 'rest', action: door }) : null;
  return found ? doors.get(found.id) : undefined;
}

function refuse(door: DoorUseRow, code: string, n: number): void {
  door.refused += n;
  door.refusedBy[code] = (door.refusedBy[code] ?? 0) + n;
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
        COALESCE(
          'room:' || (SELECT r.kind FROM support_rooms r WHERE r.principal_user_id = la.agent_user_id
            ORDER BY r.created_at LIMIT 1),
          CASE WHEN la.output_kind = 'steward_run' THEN 'steward' END,
          CASE WHEN u.kind = 'agent' THEN 'agent-account' ELSE 'person' END) AS agent,
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
  const [calls, misses, days, reads, lessonsApplied] = await Promise.all([
    callRows(projectId, since),
    missRows(projectId, since),
    dayRows(projectId, since, now),
    readRows(projectId, since),
    lessonRows(projectId, since),
  ]);
  const { doors, unmatched } = tallyDoors(catalog, calls, misses);
  const maps = await tier0Maps(projectId, catalog, new Map(doors.map((d) => [d.door, d.calls])));
  for (const d of doors) {
    for (const audience of d.card?.audience ?? []) {
      d.tiers[audience] = maps.get(audience)?.carried.includes(d.card?.id ?? d.door) ? 0 : 1;
    }
  }
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
      misses: doors.reduce((n, d) => n + d.misses, 0),
    },
    days,
    unmatched,
    reads,
    lessonsApplied,
    limits: DOOR_USE_LIMITS,
  };
}

/** The audiences a Tier-0 map is carried for: a person's client finds every door by situation. */
export const MAP_AUDIENCES: readonly CardAudience[] = ['bot', 'master', 'run'];

/**
 * Each audience's Tier-0 map in this project: its cards ranked by this project's calls, with the
 * situations lessons folded into a card shown as proposed until the card's code carries them.
 */
export async function tier0Maps(
  projectId: string,
  catalog: DoorCatalog,
  calls: ReadonlyMap<string, number>,
): Promise<Map<CardAudience, Tier0Map>> {
  const proposed = new Map(
    (await cardFreshness()).map((f) => [
      f.cardId,
      f.proposedDeltas
        .filter(
          (d) => d.field === 'situation' && (d.projectId === null || d.projectId === projectId),
        )
        .map((d) => d.text),
    ]),
  );
  return new Map(MAP_AUDIENCES.map((a) => [a, tier0Map(catalog.doors, a, proposed, calls)]));
}

/** This project's calls per door over the last `days`, for ranking a Tier-0 map. */
export async function doorCalls(
  projectId: string,
  catalog: DoorCatalog,
  days: number,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const { doors } = tallyDoors(
    catalog,
    await callRows(projectId, new Date(now.getTime() - days * DAY_MS)),
  );
  return new Map(doors.map((d) => [d.door, d.calls]));
}
