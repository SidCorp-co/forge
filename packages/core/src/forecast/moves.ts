/**
 * How a scope's forecast moved, kept so the move is never silent: each anchor a read meets
 * (`facts.ts:readAnchor`) is written once with the range it gave (`forecast_moves`), and the row
 * before it is where the dates moved from. Jira Plans shows a schedule's current value beside the new
 * one before it is accepted; here the new one is always taken, and the old one and the event that
 * moved it stay readable beside it.
 */

import type { ForecastMove, ScopeForecast } from '@forge/contracts/forecast';
import type { Said } from '@forge/contracts/said';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { rowsOf } from '../db/raw-sql.js';
import { forecastMoves } from '../db/schema.js';

const MINUTE = 60_000;

/** One stored anchor of a scope: its moment, its range and its event. */
export interface AnchorRow {
  anchoredAt: string;
  p50At: string;
  p85At: string;
  event: Said;
}

const scopeKey = (s: Pick<ScopeForecast, 'scope' | 'key'>) => `${s.scope}:${s.key}`;

/** The move from one anchor to the next, or null where the dates did not move by a minute. */
export function moveBetween(from: AnchorRow, to: AnchorRow): ForecastMove | null {
  const by = Math.round((Date.parse(to.p50At) - Date.parse(from.p50At)) / MINUTE);
  const by85 = Math.round((Date.parse(to.p85At) - Date.parse(from.p85At)) / MINUTE);
  if (by === 0 && by85 === 0) return null;
  return {
    fromAt: from.anchoredAt,
    fromP50At: from.p50At,
    fromP85At: from.p85At,
    at: to.anchoredAt,
    toP50At: to.p50At,
    toP85At: to.p85At,
    byMinutes: by,
    because: to.event,
  };
}

const iso = (v: Date | string) => new Date(v).toISOString();

/** The anchors read back per scope, newest first: enough to find the last one that moved the dates. */
const MOVES_READ = 20;

/** The newest move at or before `anchoredAt` in a scope's anchors (newest first); null where none of them moved. */
export function lastMove(
  newestFirst: readonly AnchorRow[],
  anchoredAt: string,
): ForecastMove | null {
  const from = newestFirst.findIndex((r) => r.anchoredAt === anchoredAt);
  if (from < 0) return null;
  for (let i = from; i + 1 < newestFirst.length; i++) {
    const move = moveBetween(newestFirst[i + 1] as AnchorRow, newestFirst[i] as AnchorRow);
    if (move) return move;
  }
  return null;
}

/**
 * Each scope with how its dates last moved: a scope whose landing is a range meets its anchor, which
 * is written the first time any read meets it, and its move is read against the anchor before.
 */
export async function withMoves(
  projectId: string,
  scopes: readonly ScopeForecast[],
): Promise<ScopeForecast[]> {
  const ranged = scopes.filter((s) => s.forecast?.kind === 'forecast');
  if (ranged.length === 0) return [...scopes];
  const keys = ranged.map(scopeKey);
  const fresh = ranged.map((s) => {
    const f = s.forecast as Extract<ScopeForecast['forecast'], { kind: 'forecast' }>;
    return {
      projectId,
      scope: scopeKey(s),
      anchoredAt: new Date(s.anchor.at),
      p50At: new Date(f.p50At),
      p85At: new Date(f.p85At),
      event: s.anchor.event,
    };
  });
  await db.insert(forecastMoves).values(fresh).onConflictDoNothing();
  const rows = rowsOf<{
    scope: string;
    anchored_at: string;
    p50_at: string;
    p85_at: string;
    event: Said;
  }>(
    await db.execute(sql`
      SELECT scope, anchored_at, p50_at, p85_at, event FROM (
        SELECT m.*, row_number() OVER (PARTITION BY m.scope ORDER BY m.anchored_at DESC) AS rank
          FROM forecast_moves m
         WHERE m.project_id = ${projectId}
           AND m.scope IN (${sql.join(
             keys.map((k) => sql`${k}`),
             sql`, `,
           )})
      ) r
      WHERE r.rank <= ${MOVES_READ}
      ORDER BY r.scope, r.anchored_at DESC`),
  );
  const byScope = new Map<string, AnchorRow[]>();
  for (const r of rows) {
    const list = byScope.get(r.scope) ?? [];
    list.push({
      anchoredAt: iso(r.anchored_at),
      p50At: iso(r.p50_at),
      p85At: iso(r.p85_at),
      event: r.event,
    });
    byScope.set(r.scope, list);
  }
  return scopes.map((s) => {
    if (s.forecast?.kind !== 'forecast') return s;
    return { ...s, moved: lastMove(byScope.get(scopeKey(s)) ?? [], iso(s.anchor.at)) };
  });
}
