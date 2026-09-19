import { sql } from 'drizzle-orm';

export const RESIDENT_SESSION_JOIN = sql`LEFT JOIN agent_sessions s ON s.id = j.agent_session_id`;

export const RESULT_EVENT_LATERAL = sql`LEFT JOIN LATERAL (SELECT e.job_id FROM job_events e WHERE e.job_id = j.id AND e.kind = 'result' LIMIT 1) lr ON true`;

export const RESULT_GUARD = sql`(s.runtime_state IS NOT NULL OR lr.job_id IS NULL)`;

export const NOT_PARKED = sql`s.runtime_state IS DISTINCT FROM 'awaiting_input'`;
