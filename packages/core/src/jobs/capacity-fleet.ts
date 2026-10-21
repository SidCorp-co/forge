/**
 * Why no runner can take a step, read off the runner rows the fleet shows online (ISS-1228): an
 * empty dispatch pool is not "no runner online" while one is. Each online runner is named by the
 * first check it fails, in the order a person fixes them.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { claimCapableSql } from '../runners/device-cap.js';
import {
  deviceNotDisabled,
  livenessSeconds,
  runnerFresh,
  runnerUnlimited,
  runnerWorkspaceReady,
} from '../runners/liveness-sql.js';
import type { RequiredCapabilities } from '../runners/types.js';

/** What keeps an online runner from a step, first match wins. */
export const CAPACITY_BARS = [
  'silent',
  'disabled',
  'outside_pool',
  'lacking',
  'workspace',
  'too_old',
  'limited',
] as const;
export type CapacityBar = (typeof CAPACITY_BARS)[number];

/** The project's online runners, and how many of them each bar keeps from the step. */
export interface CapacityFleet {
  online: number;
  bars: Record<CapacityBar, number>;
}

/** One online runner's checks, as the query answers them. */
export interface RunnerChecks {
  /** The box is online while its runner for this project has not checked in. */
  silent: boolean;
  disabled: boolean;
  inPool: boolean;
  capable: boolean;
  workspaceReady: boolean;
  claimCapable: boolean;
  limited: boolean;
}

/** The first bar an online runner fails, or null where it could take the step. */
export function capacityBarOf(r: RunnerChecks): CapacityBar | null {
  if (r.silent) return 'silent';
  if (r.disabled) return 'disabled';
  if (!r.inPool) return 'outside_pool';
  if (!r.capable) return 'lacking';
  if (!r.workspaceReady) return 'workspace';
  if (!r.claimCapable) return 'too_old';
  if (r.limited) return 'limited';
  return null;
}

export function fleetOf(rows: readonly RunnerChecks[]): CapacityFleet {
  const bars = Object.fromEntries(CAPACITY_BARS.map((b) => [b, 0])) as Record<CapacityBar, number>;
  for (const r of rows) {
    const bar = capacityBarOf(r);
    if (bar) bars[bar] += 1;
  }
  return { online: rows.length, bars };
}

/** The project's runners whose runner or box is online, each with the checks the dispatch pool applies. */
export async function readCapacityFleet(
  projectId: string,
  required: RequiredCapabilities | undefined,
  pool: string[] | null,
): Promise<CapacityFleet> {
  const wanted = JSON.stringify(required ?? {});
  const inPool =
    pool && pool.length > 0
      ? sql`r.device_id IN (${sql.join(
          pool.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql`true`;
  const rows = await db.execute<{
    fresh: boolean;
    disabled: boolean;
    in_pool: boolean;
    capable: boolean;
    workspace_ready: boolean;
    claim_capable: boolean;
    limited: boolean;
  }>(sql`
    SELECT DISTINCT ON (r.device_id)
           ${runnerFresh('r', livenessSeconds())} AS fresh,
           NOT (${deviceNotDisabled('r')}) AS disabled,
           ${inPool} AS in_pool,
           r.capabilities @> ${wanted}::jsonb AS capable,
           ${runnerWorkspaceReady('r')} AS workspace_ready,
           EXISTS (SELECT 1 FROM devices d WHERE d.id = r.device_id AND ${claimCapableSql('d')})
             AS claim_capable,
           NOT (${runnerUnlimited('r')}) AS limited
      FROM runners r
      JOIN devices box ON box.id = r.device_id
     WHERE r.project_id = ${projectId}
       AND (${runnerFresh('r', livenessSeconds())}
            OR (box.status = 'online'
                AND box.last_seen_at > now() - (${livenessSeconds()} || ' seconds')::interval))
     ORDER BY r.device_id, r.last_seen_at DESC NULLS LAST
  `);
  return fleetOf(
    rows.map((r) => ({
      silent: r.fresh !== true,
      disabled: r.disabled === true,
      inPool: r.in_pool === true,
      capable: r.capable === true,
      workspaceReady: r.workspace_ready === true,
      claimCapable: r.claim_capable === true,
      limited: r.limited === true,
    })),
  );
}

/** What each bar says of the runners it keeps, in a person's words. */
const BAR_WORDS: Record<CapacityBar, string> = {
  silent: 'not yet checked in for this project',
  disabled: 'turned off',
  outside_pool: 'outside the runner pool this step may use',
  lacking: 'missing a capability this step needs',
  workspace: 'without a workspace ready for this project',
  too_old: 'running a build too old to take work',
  limited: 'held back by an account limit',
};

/** What a person does about each bar, said of the runners it keeps: one runner, or several. */
const BAR_FIXES: Record<CapacityBar, (several: boolean) => string> = {
  silent: (m) =>
    `restart the runner${m ? 's' : ''} that ${m ? 'have' : 'has'} not checked in for this project`,
  disabled: (m) => `turn the runner${m ? 's' : ''} that ${m ? 'are' : 'is'} off back on`,
  outside_pool: (m) =>
    `add the runner${m ? 's' : ''} outside the pool to the pool this step may use`,
  lacking: (m) => `give the runner${m ? 's' : ''} missing a capability what this step needs`,
  workspace: (m) => `finish the workspace of the runner${m ? 's' : ''} without one`,
  too_old: (m) => `update the runner${m ? 's' : ''} on an old build`,
  limited: (m) =>
    `wait for the account limit to lift, or sign the limited runner${m ? 's' : ''} in to an account with room`,
};

/** The next step, one fix for each bar the notice named and none for a bar it did not. */
function nextStepFor(named: readonly CapacityBar[], bars: Record<CapacityBar, number>): string {
  if (named.length === 0)
    return "Open this project's Runners tab and check what it shows for each runner.";
  const fixes = named.map((b) => BAR_FIXES[b](bars[b] > 1));
  const last = fixes.pop() as string;
  const said = fixes.length === 0 ? last : `${fixes.join(', ')}, and ${last}`;
  return `Open this project's Runners tab, then ${said}.`;
}

/** Its online runners, counted as a person counts them: never "all 1" or "all 2". */
function onlineCount(n: number): string {
  if (n === 1) return 'Its one runner is online';
  return n === 2 ? 'Both of its runners are online' : `All ${n} of its runners are online`;
}

function barClause(bar: CapacityBar, n: number, online: number): string {
  if (online === 1) return `it is ${BAR_WORDS[bar]}`;
  if (n === online) return `${n === 2 ? 'both are' : `all ${n} are`} ${BAR_WORDS[bar]}`;
  return `${n === 1 ? 'one is' : `${n} are`} ${BAR_WORDS[bar]}`;
}

/**
 * Why a project's online runners cannot take its steps, and what a person does about it: the
 * notice's words and the issue page's, so the two never disagree. Null where none is online.
 */
export function fleetSentence(
  fleet: CapacityFleet,
): { named: CapacityBar[]; summary: string; nextStep: string } | null {
  const { online, bars } = fleet;
  if (online === 0) return null;
  const named = CAPACITY_BARS.filter((b) => bars[b] > 0);
  const why =
    named.length === 0
      ? 'none of them could take it when core last looked'
      : named.map((b) => barClause(b, bars[b], online)).join(', and ');
  return {
    named,
    summary: `${onlineCount(online)}, but ${why}. Steps keep waiting and resume by themselves once one can take them.`,
    nextStep: nextStepFor(named, bars),
  };
}

/**
 * The notice for a pool emptied by something other than every runner being offline, limited or out
 * of date — those keep `wedgeCopy`'s words. Null where that copy already tells the truth.
 */
export function fleetCopy(
  fleet: CapacityFleet,
  args: { scope: string },
): { reason: string; action: string; title: string; summary: string; nextStep: string } | null {
  const { online, bars } = fleet;
  if (bars.limited === online || bars.too_old === online) return null;
  const said = fleetSentence(fleet);
  if (!said) return null;
  return {
    reason: `${online} capable device(s) online, none able to take the step: ${said.named.join(', ') || 'none barred'}`,
    action: 'fix what keeps the online runners from this step',
    title: `No runner can take this work for ${args.scope}`,
    summary: said.summary,
    nextStep: said.nextStep,
  };
}

/**
 * What to tell an operator about an empty pool, given which of the three ways
 * it is empty.
 */
export function wedgeCopy(
  allLimited: boolean,
  limitedCount: number,
  tooOldCount: number,
  args: { scope: string },
): { reason: string; action: string; title: string; summary: string; nextStep: string } {
  const { scope } = args;
  /** Its runners, as a person counts them: never "all 1" or "all 2". */
  const its = (n: number, one: string, many: string) =>
    n === 1 ? `its one runner ${one}` : `${n === 2 ? 'both' : `all ${n}`} of its runners ${many}`;
  if (allLimited) {
    return {
      reason: `all ${limitedCount} capable device(s) are rate-limited or quarantined`,
      action: 'raise the account limit or wait for the provider reset',
      title: `No capacity: every runner for ${scope} is limited`,
      summary: `Work for ${scope} is paused because ${its(limitedCount, 'has', 'have')} hit an account limit. Steps keep waiting and resume by themselves once one frees up.`,
      nextStep:
        'Raise the account spend/usage limit, or wait for the provider reset — no other action needed.',
    };
  }
  if (tooOldCount > 0) {
    return {
      reason: `all ${tooOldCount} capable device(s) run a build too old to claim work`,
      action:
        tooOldCount === 1 ? 'update the runner on that host' : 'update the runner on those hosts',
      title: `No capacity: every runner for ${scope} is out of date`,
      summary: `Work for ${scope} is paused because ${its(tooOldCount, 'is', 'are')} online but running a build older than this server requires, so every claim is refused. This does NOT clear by itself.`,
      nextStep:
        tooOldCount === 1
          ? 'Update forge-runner on that host; work resumes on the next tick once it reports the new version.'
          : 'Update forge-runner on those hosts; work resumes on the next tick once one reports the new version.',
    };
  }
  return {
    reason: 'no capable device is online',
    action: 'bring a runner online for this project',
    title: `No capacity: no runner online for ${scope}`,
    summary: `Work for ${scope} is paused because none of its runners are online. Steps keep waiting and resume by themselves once one connects.`,
    nextStep: 'Start a runner for this project (forge-runner on a paired device).',
  };
}

/** Whose runners a capacity notice speaks of: the project's, or the pool one step type may use. */
export function capacityScope(stageKey: string): string {
  return stageKey === 'all' ? 'this project' : `the ${stageKey} runner pool`;
}

/** The capacity notice's words for a fleet as it stands: the raise and every later read use these. */
export function capacityCopy(
  fleet: CapacityFleet,
  args: { scope: string },
): { reason: string; action: string; title: string; summary: string; nextStep: string } {
  const all = (n: number) => fleet.online > 0 && n === fleet.online;
  return (
    fleetCopy(fleet, args) ??
    wedgeCopy(all(fleet.bars.limited), fleet.online, all(fleet.bars.too_old) ? fleet.online : 0, args)
  );
}
