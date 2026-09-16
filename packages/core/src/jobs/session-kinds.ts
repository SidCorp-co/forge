/**
 * Which `agent_sessions.metadata.type` values are backed by a Claude CLI
 * client, and which are not.
 *
 * One list, read by every hop that would otherwise reason about a missing
 * `claude_session_id` — the reaper in `loop-monitor.ts` and its alarm mirror in
 * `sweeper.ts` are the same predicate in two places, and this is what stops
 * them drifting.
 */

import { sql } from 'drizzle-orm';

/** Sessions the pipeline hops scope themselves TO. */
export const PIPELINE_METADATA_TYPES = sql`('pipeline','pm')`;

/**
 * Sessions that never report a `claude_session_id`, and are reaped elsewhere.
 */
export const NON_CLIENT_METADATA_TYPES = sql`('pipeline','pm','master','run_session')`;

/**
 * Sessions that can never be a PROCESSLESS park, so no park clock may close them.
 */
export const NEVER_PARKED_METADATA_TYPES = sql`('master')`;
