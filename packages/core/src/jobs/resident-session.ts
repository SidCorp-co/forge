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

// cm:guard ISS-1013 — the result test is a LATERAL and not the `NOT EXISTS` it reads like, and the reason is in the plan rather than in the semantics, which are identical. Say what this fragment does and does NOT buy, because the two were conflated once already and the conflation reads as a stronger claim than the measurement supports. WITH `job_events_result_idx` present both forms plan identically — an Index Only Scan keyed on the driving job, 97 shared buffers for the `NOT EXISTS` against 102 for this one on the fixture in `loop-monitor-bounded-candidates-e2e.test.ts`. So on the shipped schema the PARTIAL INDEX, not this fragment, is what makes the guard cheap, and a test asserting only that every `job_events` node is keyed on `job_id` stays green with this fragment reverted. What this fragment buys is that the bound is STRUCTURAL rather than a property of one index the planner currently likes: drop `job_events_result_idx` and the two diverge 50x on the same fixture — under the `OR` in `RESULT_GUARD` the planner cannot turn `NOT EXISTS` into an anti-join, so it falls back to a HASHED SubPlan, one `Parallel Seq Scan on job_events` built once per statement whatever the driving row is, at 13,739 buffers, while `LIMIT 1` inside a lateral has no hash form and stays a per-driving-row nested loop at 273. `loop-monitor-bounded-candidates-e2e.test.ts` asserts exactly that divergence, with the index dropped and restored around the measurement, because it is the only assertion in this repository that would go red if this fragment were reverted.
// cm:guard binds `lr` and needs `jobs j`, exactly as the join above needs `j`. A hop that takes `RESULT_GUARD` without this lateral fails at the DB and not at the type checker — which is the safe direction, and the only one available to a raw fragment.
export const RESULT_EVENT_LATERAL = sql`LEFT JOIN LATERAL (SELECT e.job_id FROM job_events e WHERE e.job_id = j.id AND e.kind = 'result' LIMIT 1) lr ON true`;

// cm:guard the result guard survives for print (runtime_state NULL) and is DROPPED for a resident session, which is the whole of invariant 5. Never relax it for NULL as well "to be consistent": a print job whose finalize is mid-flight would then be reaped and retried against a process that already succeeded, which is the ISS-258 false positive this guard was born from.
// cm:guard `lr.job_id IS NULL` is `NOT EXISTS (... kind = 'result')` and nothing else: the lateral selects a NOT NULL column, so a NULL there can only mean the lateral matched no row.
export const RESULT_GUARD = sql`(s.runtime_state IS NOT NULL OR lr.job_id IS NULL)`;

// cm:edge lockstep -> packages/core/src/jobs/loop-monitor.ts — the same exemption the session heartbeat hop takes, and it must stay the same string: a park that is quiet to one clock and reapable by the other loses the job while the human is still typing. Written IS DISTINCT FROM so print (NULL) is never read as "maybe parked".
export const NOT_PARKED = sql`s.runtime_state IS DISTINCT FROM 'awaiting_input'`;
