// The `standing-sweep` cluster timer (REQ-48 BC-1): every 5 minutes it reads every open item's
// standing in each project whose steward is on, and starts the steward where nothing else would. An
// item stuck on a basis no run of its diagnosis holds is emitted `standing.stuck`, so an item turning
// stuck by time alone is seen within 5 minutes, and a lost wake is re-emitted. A requirement or
// feedback item whose basis moved off its note is emitted `standing.changed`, and so is an issue that
// holds a note: an issue is noted once its diagnosis writes one, never on every sweep for being open.
// A requirement or feedback item stuck through a carrier issue that is itself stuck is not diagnosed:
// the carrier is, and the item is noted, its note citing the carrier it waits on.
// A note written under facts core has since reworded reads stale though its basis never moved
// (ISS-1044): it is emitted `standing.changed` too, a stuck item's as well once its diagnosis ran on
// that basis, and only once, by a run queued after the note was written.
// An ask of the master stands until its item's basis moves, its item waits on a person, or a reasoned
// decision on the item, or on the item whose run asked, answers it; one answered since it was made
// leaves the master's nudge at once, and the sweep settles it. The sweep spends only its share of the
// day's budget (`policy.ts:sharesOf`): it raises no more runs than that share has room for, oldest
// stuck first, then the oldest note, and the rest wait for a later sweep, so a full backlog is paced
// across days and the handoff share stays whole. Before any of it, an agreed requirement whose check
// ended without finishing an hour ago, or never ran, has its check queued again (`owed-checks.ts`):
// its delivery waits on that check, and nothing else raises it.

import type { ItemStanding, StandingSubjectKind } from '@forge/contracts/steward';
import { isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { emitEvent } from '../outbox/index.js';
import {
  type AnsweredOn,
  answeredAsks,
  answeredOnOf,
  askItemOf,
  asksToSettle,
  openMasterAsks,
  settleAsks,
} from './asks.js';
import { raiseOwedChecks } from './owed-checks.js';
import { sharesOf, stewardStanceOf, utcDayStart } from './policy.js';
import { openStandings } from './ports.js';
import { ranOnBasis, spentSince, sweepQueued } from './runs-store.js';

export interface SweepTally {
  projects: number;
  stuck: number;
  changed: number;
  settledAsks: number;
  /** Requirements whose owed check it queued again: it ended without finishing, or never ran. */
  checks: number;
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

/**
 * Stuck items first, longest stuck first, then the rest by their note, oldest first, and those with
 * none as read: the order the sweep's room is spent in.
 */
function byAge(rows: readonly ItemStanding[]): ItemStanding[] {
  const since = (r: ItemStanding) =>
    r.stuck ? Date.parse(r.stuck.since) : Number.POSITIVE_INFINITY;
  const noted = (r: ItemStanding) =>
    r.note ? Date.parse(r.note.writtenAt) : Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => since(a) - since(b) || noted(a) - noted(b));
}

/**
 * The note on this basis written under facts core has since reworded (ISS-1044): its basis is the
 * standing's, and it reads stale all the same. Null where the note is current or on another basis.
 */
function rewordedNote(row: ItemStanding): ItemStanding['note'] {
  return row.note && row.note.basis === row.basis && row.note.stale ? row.note : null;
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
  const reworded = rewordedNote(row);
  if (stuck && !stuckCarrierOf(row, stuckIssues)) {
    const diagnosed = await ranOnBasis(subject, 'stuck_diagnosis', row.basis);
    // a diagnosed item's note under reworded facts is rewritten by a note run, below
    if (diagnosed && !reworded) return;
    if (!diagnosed) {
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
  }
  if (row.note?.basis === row.basis && !reworded) return;
  // an open issue takes its first note from its diagnosis, not from being open
  if (row.subject.kind === 'issue' && !row.note) return;
  // a note this basis already had a run for is not asked again: a refused write says so on that run;
  // a reworded note counts only the runs since it was written, so the run that wrote it is none
  const since = reworded ? { queuedAfter: new Date(reworded.writtenAt) } : {};
  if (await ranOnBasis(subject, 'note', row.basis, since)) return;
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
 * Settle each open ask of the master whose item's standing moved off it, or that a reasoned decision
 * recorded on that standing answered (ISS-607): an answered ask leaves what the master is owed, and
 * is not made again until the standing moves. The item is the one the ask is about, whichever run
 * asked (`asks.ts:aboutKeyOf`).
 */
async function settleProjectAsks(
  projectId: string,
  rows: readonly ItemStanding[],
  now: Date,
): Promise<number> {
  const open = await openMasterAsks(projectId);
  return settleAsks(await asksToSettle(projectId, open, rows, now), now);
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
  // a check owed holds a delivery, so it is raised before any note or diagnosis takes the room
  const checks = await raiseOwedChecks(projectId, now, room.turns);
  room.turns -= checks;
  tally.checks += checks;
  for (const row of byAge(rows)) await sweepRow(projectId, row, stuckIssues, tally, room);
  tally.settledAsks += await settleProjectAsks(projectId, rows, now);
}

export async function sweepStandings(now = new Date()): Promise<SweepTally> {
  const tally: SweepTally = {
    projects: 0,
    stuck: 0,
    changed: 0,
    settledAsks: 0,
    checks: 0,
    paced: 0,
  };
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

/** An ask of the master still standing, the item it is about, and every item whose decision answers it. */
interface StewardAsk {
  actId: string;
  ask: string;
  subject: { kind: StandingSubjectKind; key: string };
  answeredOn: AnsweredOn[];
}

/**
 * The asks of the master still standing on a project, oldest first (`masters/owed.ts` stewardAsks),
 * each with the items whose decision answers it, so the nudge names those items' own doors (ISS-654,
 * ISS-739). One a decision answered since it was made is left out now, before the sweep settles it.
 */
export async function openStewardAsks(projectId: string, now = new Date()): Promise<StewardAsk[]> {
  const open = await openMasterAsks(projectId);
  const answered = await answeredAsks(projectId, open, now);
  return open
    .filter((r) => !answered.has(r.id))
    .map((r) => ({
      actId: r.id,
      ask: r.masterAsk ?? '',
      subject: askItemOf(r),
      answeredOn: answeredOnOf(r),
    }));
}
