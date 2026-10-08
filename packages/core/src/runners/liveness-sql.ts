/**
 * What "this box is live enough to be handed work" is, in SQL, once.
 *
 * Three readers ask it — the dispatch candidate query in `select.ts`, the
 * `fresh_capable_runners` barrier CTE in `jobs/queued-gates.ts`, and the
 * release preference probe in `devices/release-label.ts`. A fourth spelling is
 * how a job reads as dispatchable to one of them and invisible to another; the
 * barrier CTE already carried a comment saying its device gate MUST mirror
 * `select.ts`, which is the drift this file removes.
 *
 * The claim-capable agent-version floor is deliberately NOT here.
 * `onlineCapableDeviceIds` filters on it, the barrier carries it as its own
 * `claim_capable` column so `runner_too_old` stays a different answer from
 * `runner_stale`, and the preference probe applies it itself.
 *
 * Every fragment takes the `runners` alias in the caller's query.
 */

import { type SQL, sql } from 'drizzle-orm';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { MASTER_SESSION_KIND } from '../jobs/session-kinds.js';
import { dispatchLivenessMs } from '../lib/dispatch-liveness.js';
import { PROVISION_IN_FLIGHT, provisionStallMs } from './provision-stall.js';

const col = (alias: string, name: string): SQL => sql.raw(`${alias}.${name}`);

export function livenessSeconds(): number {
  return Math.floor(dispatchLivenessMs() / 1000);
}

/** Registered as online and heartbeating inside the dispatch liveness window. */
export function runnerFresh(alias: string, seconds = livenessSeconds()): SQL {
  return sql`${col(alias, 'status')} = 'online'
    AND ${col(alias, 'last_seen_at')} IS NOT NULL
    AND ${col(alias, 'last_seen_at')} > now() - (${seconds} || ' seconds')::interval`;
}

/** Under none of the three limits a box can be held back by. */
export function runnerUnlimited(alias: string): SQL {
  return sql`(${col(alias, 'rate_limited_until')} IS NULL OR ${col(alias, 'rate_limited_until')} <= now())
    AND ${col(alias, 'limit_reason')} IS DISTINCT FROM 'auth'
    AND (${col(alias, 'quarantined_until')} IS NULL OR ${col(alias, 'quarantined_until')} <= now())`;
}

const sqlList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/**
 * Its provision has stood in flight with no write for the stall window: the box
 * stopped advancing it, and the row's own word for the workspace is no longer
 * evidence of anything (ISS-1359).
 */
export function provisionStalled(alias: string, stallMs = provisionStallMs()): SQL {
  return sql`(${col(alias, 'provision_status')} IN (${sqlList(PROVISION_IN_FLIGHT)})
    AND ${col(alias, 'provision_status_at')} <= now() - (${stallMs} || ' milliseconds')::interval)`;
}

/**
 * Its device holds a live resident master for the project. A REGISTRATION and
 * not a pane — core cannot see tmux — but the same one the Runners screen shows
 * as `residentMaster`, and what a box running the project's master out of this
 * checkout has registered (ISS-1118).
 */
export function workspaceServesProject(alias: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM agent_sessions serving_s
    WHERE serving_s.device_id = ${col(alias, 'device_id')}
      AND serving_s.project_id = ${col(alias, 'project_id')}
      AND serving_s.kind = ${MASTER_SESSION_KIND}
      AND serving_s.status NOT IN (${sqlList(terminalAgentSessionStatuses)})
  )`;
}

/**
 * Its workspace has finished provisioning, or never declared a status, or is
 * stalled on a box that is demonstrably serving the project from it. A stalled
 * row on a box that is NOT serving it stays refused: nothing says the checkout
 * is usable, and it is re-offered to the box instead.
 */
export function runnerWorkspaceReady(alias: string, stallMs = provisionStallMs()): SQL {
  return sql`(${col(alias, 'provision_status')} IS NULL OR ${col(alias, 'provision_status')} = 'ready'
    OR (${provisionStalled(alias, stallMs)} AND ${workspaceServesProject(alias)}))`;
}

/**
 * Its device is not turned off.
 *
 * Status alone does not cover this: a disabled device's runner keeps
 * heartbeating, so it stays `online` while the candidate query filters it out.
 */
export function deviceNotDisabled(alias: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM devices liveness_d
    WHERE liveness_d.id = ${col(alias, 'device_id')} AND liveness_d.disabled_at IS NOT NULL
  )`;
}

/** All four at once, for a reader that wants the whole question. */
export function runnerLive(alias: string, seconds = livenessSeconds()): SQL {
  return sql`${runnerFresh(alias, seconds)}
    AND ${runnerUnlimited(alias)}
    AND ${runnerWorkspaceReady(alias)}
    AND ${deviceNotDisabled(alias)}`;
}
