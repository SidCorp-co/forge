// Whether a project's steward is on, and what it may spend in a UTC day (REQ-48 cost guard): 200
// gateway turns and 10 runner jobs (`STEWARD_DAILY_BUDGET`), lowered, never raised, through the
// project document's `steward` key. A run the budget cannot pay for is skipped `budget_spent` whole.

import {
  STEWARD_ACT_RUNTIME,
  STEWARD_DAILY_BUDGET,
  type StewardAct,
  type StewardSkipReason,
} from '@forge/contracts/steward';
import { db, type Tx } from '../db/client.js';
import { lockXact } from '../lib/advisory-lock.js';
import { readProjectDocument } from '../project-config/index.js';
import { markStarted, spentSince } from './runs-store.js';

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

/** Why a run of `acts` on `projectId` may not run now, or null where it may. */
export async function refusalOf(
  projectId: string,
  acts: readonly StewardAct[],
  now: Date,
  opts: { exceptRunId?: string; tx?: Tx } = {},
): Promise<StewardSkipReason | null> {
  const stance = await stewardStanceOf(projectId);
  if (!stance.enabled) return 'steward_off';
  const spent = await spentSince(projectId, utcDayStart(now), opts);
  return fits(stance.budget, spent, costOf(acts)) ? null : 'budget_spent';
}

/**
 * Take the claimed run up, or say why it may not run: the budget read and the start stamped under
 * the project's lock, so runs of one project taken up at once each see the others' cost.
 */
export async function admitRun(
  run: { id: string; projectId: string },
  acts: readonly StewardAct[],
  now: Date,
): Promise<StewardSkipReason | null> {
  return db.transaction(async (tx) => {
    await lockXact(tx, 'stewardBudget', run.projectId);
    const refused = await refusalOf(run.projectId, acts, now, { exceptRunId: run.id, tx });
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
