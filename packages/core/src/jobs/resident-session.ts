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

export const RESIDENT_SESSION_JOIN = sql`LEFT JOIN agent_sessions s ON s.id = j.agent_session_id`;

export const RESULT_EVENT_LATERAL = sql`LEFT JOIN LATERAL (SELECT e.job_id FROM job_events e WHERE e.job_id = j.id AND e.kind = 'result' LIMIT 1) lr ON true`;

export const RESULT_GUARD = sql`(s.runtime_state IS NOT NULL OR lr.job_id IS NULL)`;

export const NOT_PARKED = sql`s.runtime_state IS DISTINCT FROM 'awaiting_input'`;
