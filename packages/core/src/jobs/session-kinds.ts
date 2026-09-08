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
// cm:guard `master` is the value that is easy to miss here: a master is a tmux pane, so it never reports a `claude_session_id` and matches the no-client hop's every predicate. It survives only because the daemon re-registers it each sweep — and a rate-limited box stretches that to `LIMITED_POLL_INTERVAL` (5 min) against a 3-minute heartbeat, at which point core fails a healthy master, mints it a second session row, and the pane goes on claiming under an id core calls dead (ISS-933 criterion 21).
// cm:edge lockstep -> packages/core/src/devices/master-session.ts — `MASTER_SESSION_TYPE` and `RUN_SESSION_TYPE` are the two values spelled out here; renaming either without editing this list re-opens the hop onto them.
export const NON_CLIENT_METADATA_TYPES = sql`('pipeline','pm','master','run_session')`;
