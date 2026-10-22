// Whether a project's steward is on, and what it may spend in a UTC day (REQ-48 cost guard): 200
// gateway turns and 10 runner jobs (`STEWARD_DAILY_BUDGET`), lowered, never raised, through the
// project document's `steward` key. A share of each day (`HANDOFF_SHARE`) is kept for handoff-event
// runs, which the sweep's standing backlog can never spend: the sweep spends only the rest, and a
// sweep run its share cannot pay for waits for the next day, oldest first (dev.271: the first sweep's
// backlog spent the whole day and every later handoff was skipped). A share of each day's runner
// jobs (`FOLLOWTHROUGH_SHARE`, 4 of the default 10, ceil(40%) of a lowered cap) is kept for release
// follow-throughs, the judge a shipped issue is owed: no other run may spend it (dev.287: four
// triages and two follow-throughs spent the day by 02:38, and that release's three judges were
// skipped). A handoff run the whole day, or the part of it not kept for follow-throughs, cannot pay
// for is skipped `budget_spent`, except a release follow-through: it waits for the next day's budget
// and says so on the issue (`dispatch.ts`).

import {
  STEWARD_ACT_RUNTIME,
  STEWARD_DAILY_BUDGET,
  type StewardAct,
  type StewardSkipReason,
} from '@forge/contracts/steward';
import type { StewardBudgetView } from '@forge/contracts/steward-runtime';
import { db, type Tx } from '../db/client.js';
import { lockXact } from '../lib/advisory-lock.js';
import { readProjectDocument } from '../project-config/index.js';
import { isSweepTrigger, markStarted, spentSince, sweepQueued } from './runs-store.js';

export interface StewardBudget {
  gatewayTurns: number;
  runnerJobs: number;
}

export interface StewardStance {
  enabled: boolean;
  budget: StewardBudget;
}

/** The project's steward policy: on unless its document says `enabled: false`, at the default budget unless lowered. */
export async function stewardStanceOf(projectId: string): Promise<StewardStance> {
  const policy = (await readProjectDocument(projectId))?.document.steward;
  return {
    enabled: policy?.enabled ?? true,
    budget: {
      gatewayTurns: policy?.budget?.gatewayTurns ?? STEWARD_DAILY_BUDGET.gatewayTurns,
      runnerJobs: policy?.budget?.runnerJobs ?? STEWARD_DAILY_BUDGET.runnerJobs,
    },
  };
}

/** The UTC midnight `now` falls after: the budget's day. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** What a run of `acts` costs: a gateway turn per gateway act, one runner job for all its runner acts. */
export function costOf(acts: readonly StewardAct[]): StewardBudget {
  const turns = acts.filter((a) => STEWARD_ACT_RUNTIME[a] === 'gateway_turn').length;
  const job = acts.some((a) => STEWARD_ACT_RUNTIME[a] === 'runner_job') ? 1 : 0;
  return { gatewayTurns: turns, runnerJobs: job };
}

/** Whether `cost` fits what is left of `budget` after `spent`. */
export function fits(budget: StewardBudget, spent: StewardBudget, cost: StewardBudget): boolean {
  return (
    spent.gatewayTurns + cost.gatewayTurns <= budget.gatewayTurns &&
    spent.runnerJobs + cost.runnerJobs <= budget.runnerJobs
  );
}

/** The part of each day's budget only a handoff-event run may spend. */
export const HANDOFF_SHARE = 0.4;

/** A day's budget split: `handoff` kept for handoff-event runs, `sweep` all the sweep's backlog may spend. */
export function sharesOf(budget: StewardBudget): { handoff: StewardBudget; sweep: StewardBudget } {
  const handoff = {
    gatewayTurns: Math.ceil(budget.gatewayTurns * HANDOFF_SHARE),
    runnerJobs: Math.ceil(budget.runnerJobs * HANDOFF_SHARE),
  };
  return {
    handoff,
    sweep: {
      gatewayTurns: budget.gatewayTurns - handoff.gatewayTurns,
      runnerJobs: budget.runnerJobs - handoff.runnerJobs,
    },
  };
}

/** The part of each day's runner jobs only a release follow-through may spend. */
export const FOLLOWTHROUGH_SHARE = 0.4;

/** The runner jobs kept for release follow-throughs: 4 of the default 10, ceil(40%) of a lowered cap. */
export function followthroughReserveOf(budget: StewardBudget): number {
  return Math.ceil(budget.runnerJobs * FOLLOWTHROUGH_SHARE);
}

/** Whether a run of `acts` is a release follow-through, which may spend the jobs kept for it. */
export const followsThrough = (acts: readonly StewardAct[]): boolean =>
  acts.includes('release_followthrough');

/** The UTC midnight after `now`: when a paced sweep run is due again. */
export function nextUtcDay(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + 86_400_000);
}

/**
 * Why a run of `acts` raised by `trigger` may not run now, or null where it may: `next_day` for a
 * sweep run its share of the day cannot pay for, which waits rather than ends.
 */
export async function refusalOf(
  projectId: string,
  acts: readonly StewardAct[],
  now: Date,
  opts: { exceptRunId?: string; tx?: Tx; trigger?: string } = {},
): Promise<StewardSkipReason | 'next_day' | null> {
  const stance = await stewardStanceOf(projectId);
  if (!stance.enabled) return 'steward_off';
  const day = utcDayStart(now);
  const cost = costOf(acts);
  const whole = fits(stance.budget, await spentSince(projectId, day, opts), cost);
  const kept = await outsideReserve(projectId, day, acts, cost, stance.budget, opts);
  if (!opts.trigger || !isSweepTrigger(opts.trigger)) return whole && kept ? null : 'budget_spent';
  const swept = await spentSince(projectId, day, { ...opts, sweepOnly: true });
  return whole && kept && fits(sharesOf(stance.budget).sweep, swept, cost) ? null : 'next_day';
}

/** Whether a run that is not a follow-through fits what is left once the follow-throughs' jobs are kept. */
async function outsideReserve(
  projectId: string,
  day: Date,
  acts: readonly StewardAct[],
  cost: StewardBudget,
  budget: StewardBudget,
  opts: { exceptRunId?: string; tx?: Tx },
): Promise<boolean> {
  if (cost.runnerJobs === 0 || followsThrough(acts)) return true;
  const others = await spentSince(projectId, day, { ...opts, followthrough: 'except' });
  const open = { ...budget, runnerJobs: budget.runnerJobs - followthroughReserveOf(budget) };
  return fits(open, others, cost);
}

/**
 * Take the claimed run up, or say why it may not run: the budget read and the start stamped under
 * the project's lock, so runs of one project taken up at once each see the others' cost.
 */
export async function admitRun(
  run: { id: string; projectId: string; trigger: string },
  acts: readonly StewardAct[],
  now: Date,
): Promise<StewardSkipReason | 'next_day' | null> {
  return db.transaction(async (tx) => {
    await lockXact(tx, 'stewardBudget', run.projectId);
    const refused = await refusalOf(run.projectId, acts, now, {
      exceptRunId: run.id,
      tx,
      trigger: run.trigger,
    });
    if (!refused) await markStarted(run.id, new Date(), tx);
    return refused;
  });
}

/** How many runs of one project are taken up at once: a slot per 25 gateway turns of its daily budget, 1 to 8. */
export function slotsFor(budget: StewardBudget): number {
  return Math.max(1, Math.min(STEWARD_MAX_SLOTS, Math.floor(budget.gatewayTurns / TURNS_PER_SLOT)));
}

const TURNS_PER_SLOT = 25;
export const STEWARD_MAX_SLOTS = 8;

/**
 * The steward's day as a person reads it: each share and what it spent, how many of the sweep's
 * items wait for a later day, and whether the steward is quiet for handoffs or only for the sweep.
 * Handoff runs spend their own share first and then whatever the sweep left (`refusalOf`).
 */
export async function budgetDayOf(projectId: string, now: Date): Promise<StewardBudgetView> {
  const day = utcDayStart(now);
  const { budget } = await stewardStanceOf(projectId);
  const shares = sharesOf(budget);
  const all = await spentSince(projectId, day);
  const swept = await spentSince(projectId, day, { sweepOnly: true });
  const handed = {
    gatewayTurns: all.gatewayTurns - swept.gatewayTurns,
    runnerJobs: all.runnerJobs - swept.runnerJobs,
  };
  const { paced } = await sweepQueued(projectId, now);
  const one = { gatewayTurns: 1, runnerJobs: 0 };
  const quiet = !fits(budget, all, one)
    ? 'handoffs'
    : !fits(shares.sweep, swept, one) || paced > 0
      ? 'sweep'
      : null;
  const view = (spent: StewardBudget, of: StewardBudget) => ({
    gatewayTurns: { spent: spent.gatewayTurns, of: of.gatewayTurns },
    runnerJobs: { spent: spent.runnerJobs, of: of.runnerJobs },
  });
  return {
    day: day.toISOString(),
    resumesAt: nextUtcDay(now).toISOString(),
    handoff: view(handed, shares.handoff),
    sweep: view(swept, shares.sweep),
    paced,
    quiet,
  };
}
