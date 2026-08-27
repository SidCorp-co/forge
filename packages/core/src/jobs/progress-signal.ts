// What counts as a job still making progress (agent-driven pipeline, phase 3).
//
// The result hop reaps a claimed job that has gone quiet. "Quiet" used to mean
// only "no job_event", which is right for a staged step: it runs minutes and
// emits as it goes. An autonomous session runs ONE job for hours, and the
// signal that it is alive is the phase it declares — so a declared phase has
// to count as progress too, or the watchdog kills a driver that is working.
//
// This adds a term to the hop's existing quiet computation. It is deliberately
// not a second reaper: the hop, the kill gate and RESULT_QUIET_MINUTES are
// untouched.

import { sql } from 'drizzle-orm';

// cm:edge contract -> packages/core/src/db/schema-journal.ts — reads phase_journal.started_at/ended_at by name inside raw SQL; renaming either column silently costs autonomous jobs their liveness signal instead of failing to compile
export const LAST_PHASE_CTE = sql`last_phase AS (SELECT run_id, MAX(GREATEST(started_at, COALESCE(ended_at, started_at))) AS max_ts FROM phase_journal GROUP BY run_id)`;

// cm:guard both terms, never one: job_events alone reaps a live autonomous driver, and phase rows alone stop covering every staged job, which declares no phases of its own
export const LAST_PROGRESS_AT = sql`GREATEST(COALESCE(le.max_ts, j.dispatched_at), COALESCE(lp.max_ts, j.dispatched_at), j.dispatched_at)`;
