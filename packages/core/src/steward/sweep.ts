// The `standing-sweep` cluster timer (REQ-48 BC-1): every 5 minutes it reads every open item's
// standing in each project whose steward is on, and starts the steward where nothing else would. An
// item stuck on a basis no run of its diagnosis holds is emitted `standing.stuck`, so an item turning
// stuck by time alone is seen within 5 minutes, and a lost wake is re-emitted. A requirement or
// feedback item whose basis moved off its note is emitted `standing.changed`, and so is an issue that
// holds a note: an issue is noted once its diagnosis writes one, never on every sweep for being open.
// An ask of the master stands until its item's basis moves.

import type { ItemStanding } from '@forge/contracts/steward';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db/client.js';
import { projects } from '../db/schema.js';
import { stewardActs, stewardRuns } from '../db/schema-steward-runs.js';
import { logger } from '../lib/logger.js';
import { emitEvent } from '../outbox/index.js';
import { stewardStanceOf } from './policy.js';
import { openStandings } from './ports.js';
import { ranOnBasis } from './runs-store.js';

export interface SweepTally {
  projects: number;
  stuck: number;
  changed: number;
  settledAsks: number;
}

/** The issues another item was rolled up from: their stuck reading is diagnosed through that item. */
function carriedIssues(rows: readonly ItemStanding[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.subject.kind === 'issue') continue;
    if (r.carriedBy) out.add(r.carriedBy);
    if (r.stuck?.via) out.add(r.stuck.via);
  }
  return out;
}

async function sweepRow(
  projectId: string,
  row: ItemStanding,
  carried: Set<string>,
  tally: SweepTally,
) {
  const subject = { kind: row.subject.kind, id: row.subject.id, key: row.subject.key };
  const stuck = row.stuck;
  if (stuck) {
    if (row.subject.kind === 'issue' && carried.has(row.subject.key)) return;
    if (await ranOnBasis(subject, 'stuck_diagnosis', row.basis)) return;
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
  await db.transaction((tx) =>
    emitEvent(tx, 'standing.changed', { projectId, subject, basis: row.basis }),
  );
  tally.changed += 1;
}

/** Settle each open ask of the master whose item's standing moved off the basis its run read. */
async function settleAsks(
  projectId: string,
  rows: readonly ItemStanding[],
  now: Date,
): Promise<number> {
  const open = await db
    .select({ id: stewardActs.id, subjectId: stewardRuns.subjectId, basis: stewardRuns.basis })
    .from(stewardActs)
    .innerJoin(stewardRuns, eq(stewardRuns.id, stewardActs.runId))
    .where(
      and(
        eq(stewardActs.projectId, projectId),
        isNotNull(stewardActs.masterAsk),
        isNull(stewardActs.askSettledAt),
        isNull(stewardActs.undoneAt),
      ),
    );
  const basisOf = new Map(rows.map((r) => [r.subject.id, r.basis]));
  let settled = 0;
  for (const ask of open) {
    if (basisOf.get(ask.subjectId) === ask.basis) continue;
    await db.update(stewardActs).set({ askSettledAt: now }).where(eq(stewardActs.id, ask.id));
    settled += 1;
  }
  return settled;
}

export async function sweepProjectStandings(
  projectId: string,
  now: Date,
  tally: SweepTally,
): Promise<void> {
  const rows = await openStandings(projectId);
  const carried = carriedIssues(rows);
  for (const row of rows) await sweepRow(projectId, row, carried, tally);
  tally.settledAsks += await settleAsks(projectId, rows, now);
}

export async function sweepStandings(now = new Date()): Promise<SweepTally> {
  const tally: SweepTally = { projects: 0, stuck: 0, changed: 0, settledAsks: 0 };
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
  const rows = await db
    .select({ id: stewardActs.id, ask: stewardActs.masterAsk })
    .from(stewardActs)
    .where(
      and(
        eq(stewardActs.projectId, projectId),
        isNotNull(stewardActs.masterAsk),
        isNull(stewardActs.askSettledAt),
        isNull(stewardActs.undoneAt),
      ),
    )
    .orderBy(stewardActs.at);
  return rows.map((r) => ({ actId: r.id, ask: r.ask ?? '' }));
}
