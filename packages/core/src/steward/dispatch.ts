// The `steward-dispatch` process timer (REQ-48 BC-1): every 30 seconds it takes up the queued runs
// whose debounce has passed, a handoff event's run ahead of the standing's backlog and several at
// once, so a trigger is acted on within 2 minutes and 30 seconds however long the backlog, and it
// ends the runs nothing else will (a cancelled job sends no event; a gateway run whose process died).
// A run takes its acts in `STEWARD_ACTS` order: the gateway acts as turns, then its runner acts as
// one job.

import { randomUUID } from 'node:crypto';
import {
  type ItemStanding,
  STEWARD_ACT_RUNTIME,
  type StewardAct,
  type StewardFailureKind,
} from '@forge/contracts/steward';
import { logger } from '../lib/logger.js';
import { stewardAccountOf } from './account.js';
import { enqueueStewardJob, revokeJobCredential, stewardJobLive } from './job.js';
import { budgetNote } from './note.js';
import { admitRun, slotsFor, stewardStanceOf } from './policy.js';
import { openStandings } from './ports.js';
import {
  claimDueRuns,
  endRun,
  type RunRow,
  requeueRun,
  runsToSettle,
  stampRun,
} from './runs-store.js';
import { actsOwedAt, subjectOf } from './subjects.js';
import { runGatewayAct } from './turn.js';

/** How many runs this core takes up at once, across its projects. */
const CORE_SLOTS = 16;
/** How long a run behind its project's live steward job waits before it is tried again. */
const JOB_LIVE_RETRY_MS = 60_000;

/** The subject's row of the one standing read, or null where the read holds none. */
async function standingOf(run: RunRow): Promise<ItemStanding | null> {
  const rows = await openStandings(run.projectId);
  return rows.find((r) => r.subject.id === run.subjectId) ?? null;
}

/** The acts still owed after what the standing says: a note on an unchanged basis owes nothing. */
function actsAfterStanding(
  acts: readonly StewardAct[],
  standing: ItemStanding | null,
): StewardAct[] {
  const noteCurrent = standing?.note != null && standing.note.basis === standing.basis;
  return noteCurrent ? acts.filter((a) => a !== 'note') : [...acts];
}

async function runGatewayActs(
  run: RunRow,
  acts: readonly StewardAct[],
  standing: ItemStanding | null,
) {
  const stewardId = await stewardAccountOf(run.projectId);
  await stampRun(run.id, { turnId: randomUUID() });
  const failures: string[] = [];
  let unfinished = false;
  for (const act of acts) {
    const result = await runGatewayAct({ run, act, standing, stewardId });
    await stampRun(run.id, { addTurns: 1 });
    if (result.error) {
      unfinished = true;
      failures.push(`${act}: the turn did not finish: ${result.error}`);
    }
    for (const r of result.refused) failures.push(`${act}: the door refused ${r}`);
    for (const r of result.broken) failures.push(`${act}: the door broke ${r}`);
    if (result.broken.length > 0) unfinished = true;
  }
  // only refusals: the same act on the same standing is refused again, so it waits for the standing
  const kind: StewardFailureKind = unfinished ? 'error' : 'refused';
  return { failures, kind };
}

/** Where a run stands after a tick: ended, waiting on the job it started, or behind its project's live steward job. */
type RunOutcome = 'ended' | 'job_started' | 'job_live';

/** Take one claimed run as far as it goes now; a `job_live` run is put back by the caller to retry. */
export async function runOne(run: RunRow, now: Date): Promise<RunOutcome> {
  const subject = await subjectOf(run.projectId, run.subjectKind, run.subjectId);
  const owed = subject ? actsOwedAt(subject.kind, subject.status, run.actsToRun) : [];
  if (owed.length === 0) {
    await endRun(run.id, { state: 'skipped', reason: 'subject_ended' });
    return 'ended';
  }
  const standing = await standingOf(run);
  const acts = actsAfterStanding(owed, standing);
  if (acts.length === 0) {
    await endRun(run.id, { state: 'skipped', reason: 'basis_unchanged' });
    return 'ended';
  }
  const gateway = acts.filter((a) => STEWARD_ACT_RUNTIME[a] === 'gateway_turn');
  const runner = acts.filter((a) => STEWARD_ACT_RUNTIME[a] === 'runner_job');
  // one steward job live per project: a run owing one waits, before it spends a turn
  if (runner.length > 0 && (await stewardJobLive(run.projectId))) return 'job_live';
  const refused = await admitRun(run, acts, now);
  if (refused) {
    await endRun(run.id, { state: 'skipped', reason: refused });
    if (refused === 'budget_spent') await budgetNote(run, standing);
    return 'ended';
  }
  await stampRun(run.id, { actsToRun: acts, basis: standing?.basis ?? run.basis });
  const ran = gateway.length > 0 ? await runGatewayActs(run, gateway, standing) : null;
  if (ran && ran.failures.length > 0) {
    await endRun(run.id, { state: 'failed', failure: ran.failures.join('\n'), kind: ran.kind });
    return 'ended';
  }
  if (runner.length === 0) {
    await endRun(run.id, { state: 'done' });
    return 'ended';
  }
  const started = await enqueueStewardJob(run, runner);
  if (!started.ok) {
    await endRun(run.id, { state: 'failed', failure: started.failure, kind: 'error' });
    return 'ended';
  }
  await stampRun(run.id, { jobId: started.jobId });
  return 'job_started';
}

/** End a run whose job is over, by how the job ended, and revoke the job's token. */
export async function settleJobRun(run: RunRow, jobStatus: string | null): Promise<void> {
  if (run.jobId) await revokeJobCredential(run.projectId, run.jobId);
  if (jobStatus === 'done') {
    await endRun(run.id, { state: 'done' });
    return;
  }
  const failure = run.jobId
    ? `the steward job ${run.jobId} ended ${jobStatus ?? 'unread'} before its acts were done`
    : 'the process running this run ended before the run did';
  await endRun(run.id, { state: 'failed', failure, kind: 'error' });
}

/** The runs this core has taken up and not yet finished, by run id, with the project each is of. */
const inFlight = new Map<string, string>();

/** One claimed run taken as far as it goes, its failure ended on the run rather than thrown. */
async function takeUp(run: RunRow, now: Date): Promise<void> {
  try {
    if ((await runOne(run, now)) === 'job_live') await requeueRun(run.id, JOB_LIVE_RETRY_MS);
  } catch (err) {
    logger.error({ err, runId: run.id, subject: run.subjectKey }, 'steward: a run failed');
    await endRun(run.id, {
      state: 'failed',
      failure: err instanceof Error ? err.message : String(err),
      kind: 'error',
    });
  } finally {
    inFlight.delete(run.id);
  }
}

/**
 * Settle the runs nothing else ends, then take up the due runs this core has slots for: up to
 * `CORE_SLOTS` at once, and per project the slots its daily budget sizes (`policy.ts:slotsFor`).
 * A run beyond its project's slots goes back to the queue, due now. The timer does not wait for the
 * runs it took up (`wait: false`), so a long turn never holds the next tick's claim; a caller that
 * reads what the runs did waits for them.
 */
export async function dispatchStewardRuns(
  now = new Date(),
  opts: { wait?: boolean } = {},
): Promise<{ started: number; settled: number }> {
  const stranded = await runsToSettle(now);
  for (const { run, jobStatus } of stranded) {
    if (!inFlight.has(run.id)) await settleJobRun(run, jobStatus);
  }
  const claimed = await claimDueRuns(now, CORE_SLOTS - inFlight.size);
  const launched: Promise<void>[] = [];
  const slots = new Map<string, number>();
  for (const run of claimed) {
    let free = slots.get(run.projectId);
    if (free === undefined) {
      const busy = [...inFlight.values()].filter((p) => p === run.projectId).length;
      free = slotsFor((await stewardStanceOf(run.projectId)).budget) - busy;
    }
    if (free <= 0) {
      await requeueRun(run.id, 0);
      continue;
    }
    slots.set(run.projectId, free - 1);
    inFlight.set(run.id, run.projectId);
    launched.push(takeUp(run, now));
  }
  if (opts.wait !== false) await Promise.all(launched);
  return { started: launched.length, settled: stranded.length };
}
