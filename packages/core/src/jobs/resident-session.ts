// What a job-axis reaper may read as proof of life once a session is RESIDENT.
//
// Both hops that can reap a claimed job carry the same guard: a `result` event
// means the job reported its outcome, so don't reap it — the finalize call is
// in flight (ISS-258 / ISS-280). That is exact while a process is one unit of
// work, because a `result` is then the LAST thing it ever emits.
//
// Under duplex a `result` ends a TURN. Turn 1 writes one, and from that moment
// the guard is permanently true for a job that may run for hours — both hops go
// blind to it for every cause they were written to catch, including causes that
// have nothing to do with duplex. ISS-873 invariant 5.
//
// The discriminator is the session's own declared state (ISS-873 phase 2):
// duplex reports one, print reports NULL. So print keeps the result guard
// unchanged, and a resident session is bounded by what it declares instead.

import { sql } from 'drizzle-orm';

// cm:guard binds the alias `s` for `agent_sessions` and `j` for `jobs` — a raw fragment cannot carry its own FROM, so a hop that pastes these without both aliases fails at the DB, not at the type checker. LEFT, never INNER: a job with no session row must keep the print reading rather than dropping out of the sweep entirely.
export const RESIDENT_SESSION_JOIN = sql`LEFT JOIN agent_sessions s ON s.id = j.agent_session_id`;

// cm:guard the result guard survives for print (runtime_state NULL) and is DROPPED for a resident session, which is the whole of invariant 5. Never relax it for NULL as well "to be consistent": a print job whose finalize is mid-flight would then be reaped and retried against a process that already succeeded, which is the ISS-258 false positive this guard was born from.
export const RESULT_GUARD = sql`(s.runtime_state IS NOT NULL OR NOT EXISTS (SELECT 1 FROM job_events WHERE job_id = j.id AND kind = 'result'))`;

// cm:edge lockstep -> packages/core/src/jobs/loop-monitor.ts — the same exemption the session heartbeat hop takes, and it must stay the same string: a park that is quiet to one clock and reapable by the other loses the job while the human is still typing. Written IS DISTINCT FROM so print (NULL) is never read as "maybe parked".
export const NOT_PARKED = sql`s.runtime_state IS DISTINCT FROM 'awaiting_input'`;
