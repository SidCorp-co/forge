/**
 * Why no runner can take a step, read off the same runner rows the fleet shows online (ISS-1228).
 *
 * The empty-pool notice used to say "no runner online" whenever the dispatch pool came back empty,
 * which is false wherever a runner is online and a narrower test refused it: its device turned off,
 * the step's pool, a capability, its workspace, its build, an account limit. Each online runner is
 * read once here and named by the first of those it fails, in the order a person fixes them.
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
 * The notice for a pool emptied by something other than every runner being offline, limited or out
 * of date — those keep `wedgeCopy`'s words. Null where that copy already tells the truth.
 */
export function fleetCopy(
  fleet: CapacityFleet,
  args: { scope: string },
): { reason: string; action: string; title: string; summary: string; nextStep: string } | null {
  const { online, bars } = fleet;
  if (online === 0 || bars.limited === online || bars.too_old === online) return null;
  const named = CAPACITY_BARS.filter((b) => bars[b] > 0);
  const why =
    named.length === 0
      ? 'none of them could take it when core last looked'
      : named.map((b) => barClause(b, bars[b], online)).join(', and ');
  return {
    reason: `${online} capable device(s) online, none able to take the step: ${named.join(', ') || 'none barred'}`,
    action: 'fix what keeps the online runners from this step',
    title: `No runner can take this work for ${args.scope}`,
    summary: `${onlineCount(online)}, but ${why}. Steps keep waiting and resume by themselves once one can take them.`,
    nextStep:
      "Open this project's Runners tab and fix what it shows for each runner, such as finishing its workspace or turning it back on.",
  };
}
