// The `standing-sweep` cluster timer (REQ-48 BC-1): every 5 minutes it reads every open item's
// standing in each project whose steward is on, and starts the steward where nothing else would. An
// item stuck on a basis no run of its diagnosis holds is emitted `standing.stuck`, so an item turning
// stuck by time alone is seen within 5 minutes, and a lost wake is re-emitted. A requirement or
// feedback item whose basis moved off its note is emitted `standing.changed`, and so is an issue that
// holds a note: an issue is noted once its diagnosis writes one, never on every sweep for being open.
// A requirement or feedback item stuck through a carrier issue that is itself stuck is not diagnosed:
// the carrier is, and the item is noted, its note citing the carrier it waits on.
// An ask of the master stands until its item's basis moves, or a reasoned decision on the item answers it. The sweep spends only its share of the
// day's budget (`policy.ts:sharesOf`): it raises no more runs than that share has room for, oldest
// stuck first, and the rest wait for a later sweep, so a full backlog is paced across days and the
// handoff share stays whole.

import type { ItemStanding } from '@forge/contracts/steward';
import { isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { emitEvent } from '../outbox/index.js';
import { answersOf, openMasterAsks, settleAsks } from './asks.js';
import { sharesOf, stewardStanceOf, utcDayStart } from './policy.js';
import { openStandings } from './ports.js';
import { ranOnBasis, spentSince, sweepQueued } from './runs-store.js';

export interface SweepTally {
  projects: number;
  stuck: number;
  changed: number;
  settledAsks: number;
  /** Items the sweep would have raised and left for a later sweep, its share of the day spent. */
  paced: number;
}

/** How many gateway turns the sweep may still commit today: its share, less what it spent and queued. */
async function sweepRoom(projectId: string, now: Date): Promise<number> {
  const { sweep } = sharesOf((await stewardStanceOf(projectId)).budget);
  const spent = await spentSince(projectId, utcDayStart(now), { sweepOnly: true });
  const queued = await sweepQueued(projectId, now);
  return sweep.gatewayTurns - spent.gatewayTurns - queued.gatewayTurns;
}

/** Stuck items first, longest stuck first, then the rest as read: the order the sweep's room is spent in. */
function byAge(rows: readonly ItemStanding[]): ItemStanding[] {
  const since = (r: ItemStanding) =>
    r.stuck ? Date.parse(r.stuck.since) : Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => since(a) - since(b));
}

/**
 * The issue whose stuck reading a requirement or feedback item reads stuck through, where that issue
 * is itself stuck: the issue is diagnosed, and the item only takes a note citing it, so one cause
 * is never diagnosed twice (REQ-45 and its carrier ISS-498 on dev.270).
 */
function stuckCarrierOf(row: ItemStanding, stuckIssues: ReadonlySet<string>): string | null {
  if (row.subject.kind === 'issue') return null;
  const carrier = row.stuck?.via ?? row.carriedBy;
  return carrier && stuckIssues.has(carrier) ? carrier : null;
}

async function sweepRow(
  projectId: string,
  row: ItemStanding,
  stuckIssues: ReadonlySet<string>,
  tally: SweepTally,
  room: { turns: number },
) {
  const subject = { kind: row.subject.kind, id: row.subject.id, key: row.subject.key };
  const stuck = row.stuck;
  if (stuck && !stuckCarrierOf(row, stuckIssues)) {
    if (await ranOnBasis(subject, 'stuck_diagnosis', row.basis)) return;
    if (room.turns <= 0) {
      tally.paced += 1;
      return;
    }
    room.turns -= 1;
    await db.transaction((tx) =>
      emitEvent(tx, 'standing.stuck', {
        projectId,
        subject,
        code: stuck.code,
        basis: row.basis,
      }),
    );
    tally.stuck += 1;
    return;
  }
  if (row.note?.basis === row.basis) return;
  // an open issue takes its first note from its diagnosis, not from being open
  if (row.subject.kind === 'issue' && !row.note) return;
  // a note this basis already had a run for is not asked again: a refused write says so on that run
  if (await ranOnBasis(subject, 'note', row.basis)) return;
  if (room.turns <= 0) {
    tally.paced += 1;
    return;
  }
  room.turns -= 1;
  await db.transaction((tx) =>
    emitEvent(tx, 'standing.changed', { projectId, subject, basis: row.basis }),
  );
  tally.changed += 1;
}

/**
 * Settle each open ask of the master whose item's standing moved off the basis its run read, or that
 * a reasoned decision on the item answered since it was made (ISS-607): an answered ask leaves what
 * the master is owed, and is not made again until the standing moves.
 */
async function settleProjectAsks(
  projectId: string,
  rows: readonly ItemStanding[],
  now: Date,
): Promise<number> {
  const open = await openMasterAsks(projectId);
  const basisOf = new Map(rows.map((r) => [r.subject.id, r.basis]));
  const moved = open.filter((ask) => basisOf.get(ask.subjectId) !== ask.basis);
  const standing = open.filter((ask) => !moved.includes(ask));
  const answered = await answersOf(projectId, standing, now);
  return settleAsks([...moved.map((a) => a.id), ...answered.keys()], now);
}

export async function sweepProjectStandings(
  projectId: string,
  now: Date,
  tally: SweepTally,
): Promise<void> {
  const rows = await openStandings(projectId);
  const stuckIssues = new Set(
    rows.filter((r) => r.subject.kind === 'issue' && r.stuck).map((r) => r.subject.key),
  );
  const room = { turns: await sweepRoom(projectId, now) };
  for (const row of byAge(rows)) await sweepRow(projectId, row, stuckIssues, tally, room);
  tally.settledAsks += await settleProjectAsks(projectId, rows, now);
}

export async function sweepStandings(now = new Date()): Promise<SweepTally> {
  const tally: SweepTally = { projects: 0, stuck: 0, changed: 0, settledAsks: 0, paced: 0 };
  const live = await db
    .select({ id: projects.id })
    .from(projects)
    .where(isNull(projects.archivedAt));
  for (const { id } of live) {
    if (!(await stewardStanceOf(id)).enabled) continue;
    tally.projects += 1;
    try {
      await sweepProjectStandings(id, now, tally);
    } catch (err) {
      logger.error(
        { err, projectId: id },
        'steward: the standing sweep could not read this project',
      );
    }
  }
  return tally;
}

/** The asks of the master still standing on a project, oldest first (`masters/owed.ts` stewardAsks). */
export async function openStewardAsks(
  projectId: string,
): Promise<{ actId: string; ask: string }[]> {
  return (await openMasterAsks(projectId)).map((r) => ({ actId: r.id, ask: r.masterAsk ?? '' }));
}
