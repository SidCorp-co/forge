/**
 * A master's wait for a subagent slot (ISS-1266). Since ISS-1245 a runner asks core's preflight before
 * it writes a declaration, and a preflight refused for want of a slot leaves no queued row, so the
 * steward (`refuseRunWithoutSlot({ yieldToQueued })`, ISS-1260) had nothing to yield to. The wait is
 * kept on the master's own live session row: it is one per (box, project), which is exactly whose
 * wait this is, and a master that ends takes its wait with it.
 *
 * - kept: by a preflight refused only for want of a slot; a hold that is not a slot refuses first and
 *   never reaches here;
 * - renewed: by each re-declare refused the same way;
 * - ended: by the master's own open taking a slot (`run-session.ts:openRunSession`), or by lapsing
 *   `SLOT_WAIT_WINDOW_S` after its last declare, after which it holds the slot for nobody.
 */

import { MASTER_SESSION_KIND } from '@forge/contracts/agent-sessions';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { terminalAgentSessionStatuses } from '../db/schema.js';
import { logger } from '../lib/logger.js';
import { SESSION_SILENCE_TIMEOUT_S } from './session-silence.js';

/** Where on the master session's metadata the wait is kept: `{ issueKeys, requirement?, at }`. */
export const SLOT_WAIT_METADATA_KEY = 'slotWait';

/**
 * How long a wait holds the next free slot after the declare that left it: the silence clock a queued
 * declaration is held by (`SESSION_SILENCE_REAP_MS`, 10 minutes), so the two waits are honoured alike.
 * A master is woken every few minutes, so a master still trying renews it well inside the window,
 * and one that stopped trying (its work done, its pane gone) frees the steward within ten minutes.
 */
export const SLOT_WAIT_WINDOW_S = SESSION_SILENCE_TIMEOUT_S;

export interface SlotWait {
  masterSessionId: string;
  issueKeys: string[];
  requirement: string | null;
  at: string;
}

const LIVE_MASTER = sql`kind = ${MASTER_SESSION_KIND} AND status NOT IN (${sql.join(
  terminalAgentSessionStatuses.map((s) => sql`${s}`),
  sql`, `,
)})`;

/**
 * Keep (or renew) the master's wait. Answers false where the box holds no live master for the
 * project: the declare is refused by name all the same, and no wait is kept for a master that is not.
 */
export async function recordSlotWait(args: {
  deviceId: string;
  projectId: string;
  issueKeys: readonly string[];
  requirement?: string;
}): Promise<boolean> {
  const wait = {
    issueKeys: [...args.issueKeys],
    ...(args.requirement ? { requirement: args.requirement } : {}),
    at: new Date().toISOString(),
  };
  const rows = (await db.execute(sql`
    UPDATE agent_sessions
       SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), ARRAY[${SLOT_WAIT_METADATA_KEY}::text],
                                ${JSON.stringify(wait)}::jsonb, true)
     WHERE device_id = ${args.deviceId} AND project_id = ${args.projectId} AND ${LIVE_MASTER}
     RETURNING id`)) as unknown as Array<{ id: string }>;
  if (rows.length === 0) {
    logger.warn(
      { deviceId: args.deviceId, projectId: args.projectId, issueKeys: args.issueKeys },
      'run-slot-wait: a declare was refused for a slot on a box holding no live master for the project, so no wait is kept',
    );
  }
  return rows.length > 0;
}

/** The project's master wait on this box while it is fresh; null where none waits or it lapsed. */
export async function freshSlotWait(deviceId: string, projectId: string): Promise<SlotWait | null> {
  const [row] = (await db.execute(sql`
    SELECT id::text AS id, metadata -> ${SLOT_WAIT_METADATA_KEY}::text AS wait
      FROM agent_sessions
     WHERE device_id = ${deviceId} AND project_id = ${projectId} AND ${LIVE_MASTER}
       AND jsonb_typeof(metadata -> ${SLOT_WAIT_METADATA_KEY}::text) = 'object'
       AND (metadata -> ${SLOT_WAIT_METADATA_KEY}::text ->> 'at')::timestamptz
           >= now() - make_interval(secs => ${SLOT_WAIT_WINDOW_S})
     LIMIT 1`)) as unknown as Array<{
    id: string;
    wait: { issueKeys?: string[]; requirement?: string; at: string };
  }>;
  if (!row) return null;
  return {
    masterSessionId: row.id,
    issueKeys: row.wait.issueKeys ?? [],
    requirement: row.wait.requirement ?? null,
    at: row.wait.at,
  };
}

/** The master's own open took a slot: its wait is over. Inside the open, so a rolled-back open keeps it. */
export async function endSlotWait(tx: Tx, masterSessionId: string): Promise<void> {
  await tx.execute(sql`
    UPDATE agent_sessions SET metadata = metadata - ${SLOT_WAIT_METADATA_KEY}::text
     WHERE id = ${masterSessionId} AND metadata ? ${SLOT_WAIT_METADATA_KEY}::text`);
}
