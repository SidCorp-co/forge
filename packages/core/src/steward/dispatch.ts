// The `steward-dispatch` process timer (REQ-48 BC-1): every 30 seconds it takes up the queued runs
// whose debounce has passed, a handoff event's run ahead of the standing's backlog and several at
// once, so a trigger is acted on within 2 minutes and 30 seconds however long the backlog, and it
// ends the runs nothing else will (a cancelled job sends no event; a gateway run whose process died).
// A run takes its acts in `STEWARD_ACTS` order: the gateway acts as turns, then its runner acts as
// one job. That job is a run on its project's box like any other (ISS-1255): it starts when the
// project has a free slot (`devices/run-slots.ts:slotsFor`, asked through `refuseRunWithoutSlot`)
// and waits for one, never for a day, and a slot a master's declaration is queued for is that
// declaration's (ISS-1260); a run that took its turns carries the job into the run its end queues. Nothing here counts a slot: the steward's demand is read by the box's slot read.

import { randomUUID } from 'node:crypto';
import {
  type ItemStanding,
  STEWARD_ACT_RUNTIME,
  STEWARD_CHECK_ACTS,
  type StewardAct,
  type StewardFailureKind,
} from '@forge/contracts/steward';
import { refuseRunWithoutSlot } from '../devices/index.js';
import { paneLossStopSentence } from '../jobs/index.js';
import { logger } from '../lib/logger.js';
import { RefusalError } from '../lib/refusal.js';
import { stewardAccountOf } from './account.js';
import {
  boxesOf,
  enqueueStewardJob,
  type JobPlacing,
  type JobStart,
  jobEndFailure,
  revokeJobCredential,
} from './job.js';
import { repeatedNote } from './note.js';
import { stewardJobPlacementOf } from './pane-loss.js';
import { admitRun, repeatedRefusal } from './policy.js';
import { openStandings } from './ports.js';
import {
  callToFront,
  carryActs,
  claimDueRuns,
  endRun,
  nextInJobLine,
  type RunRow,
  requeueRun,
  runsToSettle,
  stampRun,
} from './runs-store.js';
import { actsOwedAt, subjectOf, triageTaken } from './subjects.js';
import { runGatewayAct } from './turn.js';

/** How many runs this core takes up at once, across its projects. */
const CORE_SLOTS = 16;
/** How long a run whose project has no free slot for its job waits before it is tried again. */
const SLOT_RETRY_MS = 60_000;

/** The subject's row of the one standing read, or null where the read holds none. */
async function standingOf(run: RunRow): Promise<ItemStanding | null> {
  const rows = await openStandings(run.projectId);
  return rows.find((r) => r.subject.id === run.subjectId) ?? null;
}

/**
 * The acts still owed after what the standing says: a note on an unchanged basis owes nothing, but
 * one written under facts core has since reworded reads stale and is written again (ISS-1044).
 */
function actsAfterStanding(
  acts: readonly StewardAct[],
  standing: ItemStanding | null,
): StewardAct[] {
  const noteCurrent =
    standing?.note != null && standing.note.basis === standing.basis && !standing.note.stale;
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

/** The acts that check a requirement before its delivery (REQ-67): `delivery-check.ts` reads their end. */
const CHECK_ACTS: readonly StewardAct[] = STEWARD_CHECK_ACTS;

/**
 * A check finishes or fails on its own (ISS-1084): a run carrying one beside other acts takes the
 * check now and carries the rest into the run its end queues, so the run's end is the check's. One
 * run folding a stuck diagnosis into REQ-45's intake check (forge, 2026-11-07) ended failed on the
 * diagnosis's refused note, and the check it had finished read as never done.
 */
function checkAlone(acts: readonly StewardAct[]): {
  acts: StewardAct[];
  apart: StewardAct[];
} {
  const checks = acts.filter((a) => CHECK_ACTS.includes(a));
  if (checks.length === 0 || checks.length === acts.length) return { acts: [...acts], apart: [] };
  return { acts: checks, apart: acts.filter((a) => !CHECK_ACTS.includes(a)) };
}

/** Whether the run's subject has ended since it was taken up, so none of `acts` is owed it now. */
async function endedSince(run: RunRow, acts: readonly StewardAct[]): Promise<boolean> {
  const subject = await subjectOf(run.projectId, run.subjectKind, run.subjectId);
  return !subject || actsOwedAt(subject.kind, subject.status, acts).length === 0;
}

/** Where a run stands after a tick: ended, waiting on the job it started, or waiting for a slot. */
type RunOutcome = 'ended' | 'job_started' | 'slot_wait';

/** What one tick knows: the projects already found with no free slot, read once a tick. */
export interface Tick {
  noSlot: Set<string>;
}

const isSlotRefusal = (err: unknown): boolean =>
  err instanceof RefusalError && err.refusals.some((r) => r.code === 'RUN_SLOT_UNAVAILABLE');

/**
 * Whether the project has a free slot for one more run on a box it is bound to: the run-declare
 * door's own answer. A project bound to no box is let through, and the job's enqueue names that.
 */
async function slotFree(projectId: string, tick: Tick): Promise<boolean> {
  if (tick.noSlot.has(projectId)) return false;
  const boxes = await boxesOf(projectId);
  if (boxes.length === 0) return true;
  for (const deviceId of boxes) {
    try {
      await refuseRunWithoutSlot({ deviceId, projectId, yieldToQueued: true });
      return true;
    } catch (err) {
      if (!isSlotRefusal(err)) throw err;
    }
  }
  tick.noSlot.add(projectId);
  return false;
}

/**
 * Slot reads and job enqueues taken one at a time in this process, so two runs of a project never
 * both read the one free slot before either job is there to hold it.
 */
let slotGate: Promise<unknown> = Promise.resolve();
function throughSlotGate<T>(fn: () => Promise<T>): Promise<T> {
  const next = slotGate.then(fn, fn);
  slotGate = next.catch(() => undefined);
  return next;
}

/**
 * How the item's next job is placed (ISS-1415, `pane-loss.ts`): at once, after the wait its last
 * jobs' lost panes earned, or, past the cap, held for a person's resume, naming the item, the failure
 * and the count. Read at the one place every steward job starts, whatever queued its run.
 */
async function placingOf(run: RunRow, acts: readonly StewardAct[]): Promise<JobPlacing> {
  const { streak, placement } = await stewardJobPlacementOf({
    kind: run.subjectKind,
    id: run.subjectId,
  });
  if (placement.kind === 'place') return { kind: 'now' };
  if (placement.kind === 'wait') {
    return { kind: 'after', at: placement.at, paneLosses: placement.losses };
  }
  const said = paneLossStopSentence({
    what: `The steward's ${acts.join(' and ')}`,
    item: run.subjectKey,
    losses: placement.losses,
    failure: streak.lastFailure,
  });
  return { kind: 'held', paneLosses: placement.losses, said };
}

/**
 * Start the run's job where its project has a free slot and the run is the head of its project's job
 * line (`runs-store.ts:nextInJobLine`); null otherwise. `slotsFor` alone says whether the project may
 * start a run; the line says which of its runs takes it, whatever order the tick took them up in or
 * whichever happened to be due when the slot freed (ISS-596 c6). A run behind the head leaves the
 * slot to it and makes it due now, so the slot waits at most a tick for its head.
 */
const startJobInSlot = (run: RunRow, runner: readonly StewardAct[], tick: Tick) =>
  throughSlotGate<JobStart | null>(async () => {
    if (!(await slotFree(run.projectId, tick))) return null;
    const head = await nextInJobLine(run.projectId);
    if (head && head.id !== run.id) {
      if (head.state === 'queued') await callToFront(head.id);
      return null;
    }
    return enqueueStewardJob(run, runner, await placingOf(run, runner));
  });

/** Take one claimed run as far as it goes now; a `slot_wait` run is put back by the caller to retry. */
export async function runOne(run: RunRow, tick: Tick = { noSlot: new Set() }): Promise<RunOutcome> {
  const subject = await subjectOf(run.projectId, run.subjectKind, run.subjectId);
  const owedAll = subject ? actsOwedAt(subject.kind, subject.status, run.actsToRun) : [];
  if (owedAll.length === 0) {
    await endRun(run.id, { state: 'skipped', reason: 'subject_ended' });
    return 'ended';
  }
  // a filed item routed before its triage draft ran owes no draft: the run says so, never spending a
  // job to write nothing; a run owing other acts takes them and carries the draft to a run of its own,
  // skipped the same way when taken up
  const taken = subject && owedAll.includes('triage_draft') && triageTaken(subject);
  if (taken && owedAll.length === 1) {
    await endRun(run.id, { state: 'skipped', reason: 'triage_taken' });
    return 'ended';
  }
  if (taken) await carryActs(run.id, ['triage_draft']);
  const owed = taken ? owedAll.filter((a) => a !== 'triage_draft') : owedAll;
  // a run owing only a job waits for its slot before anything else is read
  const jobOnly = owed.every((a) => STEWARD_ACT_RUNTIME[a] === 'runner_job');
  if (jobOnly && !(await slotFree(run.projectId, tick))) return 'slot_wait';
  const standing = await standingOf(run);
  const after = actsAfterStanding(owed, standing);
  if (after.length === 0) {
    await endRun(run.id, { state: 'skipped', reason: 'basis_unchanged' });
    return 'ended';
  }
  const { acts, apart } = checkAlone(after);
  const gateway = acts.filter((a) => STEWARD_ACT_RUNTIME[a] === 'gateway_turn');
  const runner = acts.filter((a) => STEWARD_ACT_RUNTIME[a] === 'runner_job');
  // left owing only a job, it waits for its slot before it is taken up; one owing turns too starts
  // with them, so a filed item's note is never held behind its project's busy box (ISS-618 c1)
  if (!jobOnly && gateway.length === 0 && !(await slotFree(run.projectId, tick))) {
    return 'slot_wait';
  }
  const basis = standing?.basis ?? run.basis;
  const refused = await admitRun(run, acts, basis);
  if (refused && 'skip' in refused) {
    await endRun(run.id, { state: 'skipped', reason: refused.skip });
    return 'ended';
  }
  if (refused) {
    await repeatedNote(run, standing, refused.repeated);
    await endRun(run.id, {
      state: 'failed',
      failure: repeatedRefusal(run, refused.repeated),
      kind: 'refused',
    });
    return 'ended';
  }
  await stampRun(run.id, { actsToRun: acts, basis });
  if (apart.length > 0) await carryActs(run.id, apart);
  const ran = gateway.length > 0 ? await runGatewayActs(run, gateway, standing) : null;
  if (ran && ran.failures.length > 0) {
    // the item ended while its turns ran: nothing is owed an ended item, so the run is skipped as one
    // taken up after the end is, never failed (dev.682, dev.683: ISS-1240 and ISS-1241 were closed
    // half a minute into their output check, the note door refused an item no longer open, and the
    // run read failed, REQ-48 BC-6)
    if (await endedSince(run, gateway)) {
      await endRun(run.id, { state: 'skipped', reason: 'subject_ended' });
      return 'ended';
    }
    await endRun(run.id, { state: 'failed', failure: ran.failures.join('\n'), kind: ran.kind });
    return 'ended';
  }
  if (runner.length === 0) {
    await endRun(run.id, { state: 'done' });
    return 'ended';
  }
  const started = await startJobInSlot(run, runner, tick);
  if (started === null) {
    if (gateway.length === 0) return 'slot_wait';
    // its turns are taken and its project's slots are not free: the job waits for one in the run its
    // end queues, tried again after the retry
    await carryActs(run.id, runner);
    await endRun(run.id, { state: 'done' }, new Date(), {
      followUpNotBefore: new Date(Date.now() + SLOT_RETRY_MS),
    });
    return 'ended';
  }
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
    ? await jobEndFailure(run.jobId, jobStatus)
    : 'the process running this run ended before the run did';
  await endRun(run.id, { state: 'failed', failure, kind: 'error' });
}

/** The runs this core has taken up and not yet finished, by run id. */
const inFlight = new Set<string>();

/** One claimed run taken as far as it goes, its failure ended on the run rather than thrown. */
async function takeUp(run: RunRow, tick: Tick): Promise<void> {
  try {
    if ((await runOne(run, tick)) === 'slot_wait') await requeueRun(run.id, SLOT_RETRY_MS);
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
 * Settle the runs nothing else ends, then take up the due runs this core has room for, up to
 * `CORE_SLOTS` at once, handoffs first (`claimDueRuns`). The timer does not wait for the runs it took
 * up (`wait: false`), so a long turn never holds the next tick's claim; a caller that reads what the
 * runs did waits for them.
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
  const tick: Tick = { noSlot: new Set() };
  const launched: Promise<void>[] = [];
  for (const run of claimed) {
    inFlight.add(run.id);
    launched.push(takeUp(run, tick));
  }
  if (opts.wait !== false) await Promise.all(launched);
  return { started: launched.length, settled: stranded.length };
}
