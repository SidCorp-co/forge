/**
 * Which species of session a query is asking about. `agent_sessions.kind` is
 * the column; these are the sets, and the SQL below is built from them.
 */
import { type SQL, sql } from 'drizzle-orm';
import {
  type AgentSessionKind,
  agentSessionKinds,
  type SessionTranscript,
} from '../db/session-vocabulary.js';
import {
  MASTER_SESSION_METADATA_TYPE,
  RUN_SESSION_METADATA_TYPE,
} from '../devices/run-session-keys.js';

export const MASTER_SESSION_KIND: AgentSessionKind = MASTER_SESSION_METADATA_TYPE;

export const RUN_SESSION_KIND: AgentSessionKind = RUN_SESSION_METADATA_TYPE;

const CHAT_SESSION_KIND: AgentSessionKind = 'chat';

/**
 * Ended by a reaper of its own, never by the one-shot sweep: a master or a working run session ten
 * minutes after its last beat, and a chat waiting on its person's reply only by the idle-chat close,
 * so a person's slow reply never reads as a failure (ISS-1228).
 */
export function endsOnItsOwnClock(kind: string, status: string): boolean {
  return (
    kind === MASTER_SESSION_KIND ||
    (kind === RUN_SESSION_KIND && status === 'running') ||
    (kind === CHAT_SESSION_KIND && status === 'idle')
  );
}

export function endsOnItsOwnClockSql(s: string): SQL {
  const kind = sql.raw(`${s}.kind`);
  const status = sql.raw(`${s}.status`);
  return sql`(${kind} = ${MASTER_SESSION_KIND} OR (${kind} = ${RUN_SESSION_KIND} AND ${status} = 'running') OR (${kind} = ${CHAT_SESSION_KIND} AND ${status} = 'idle'))`;
}

export const PIPELINE_SESSION_KINDS = [
  'pipeline',
  'pm',
] as const satisfies readonly AgentSessionKind[];

/** Whether a row's own `kind` is one a pipeline step drives, so `/retry` may reach it. */
export function isPipelineSessionKind(kind: AgentSessionKind): boolean {
  return (PIPELINE_SESSION_KINDS as readonly AgentSessionKind[]).includes(kind);
}

export const NON_CLIENT_SESSION_KINDS = [
  'pipeline',
  'pm',
  'master',
  'run_session',
] as const satisfies readonly AgentSessionKind[];

/** master and run_session are a box's own process: only the job and chat carriers reach the turn writer. A Record, so a new kind must be classified. */
export const SESSION_TRANSCRIPT_BY_KIND: Record<AgentSessionKind, SessionTranscript> = {
  master: 'not-recorded',
  run_session: 'not-recorded',
  pipeline: 'recorded',
  pm: 'recorded',
  chat: 'recorded',
};

/** The kinds whose count is refused rather than read, in the order the vocabulary lists them. */
export const TRANSCRIPTLESS_SESSION_KINDS = agentSessionKinds.filter(
  (k) => SESSION_TRANSCRIPT_BY_KIND[k] === 'not-recorded',
);

export const NEVER_PARKED_SESSION_KINDS = ['master'] as const satisfies readonly AgentSessionKind[];

export const CLIENT_SESSION_KINDS = ['chat'] as const satisfies readonly AgentSessionKind[];

/** A SQL `IN (...)` list over a set of kinds, parameterised. */
export function kindTuple(kinds: readonly AgentSessionKind[]) {
  return sql`(${sql.join(
    kinds.map((k) => sql`${k}`),
    sql`, `,
  )})`;
}

export function isAgentSessionKind(value: unknown): value is AgentSessionKind {
  return typeof value === 'string' && (agentSessionKinds as readonly string[]).includes(value);
}

export const AGENT_SESSION_KIND_LIST = agentSessionKinds.join(', ');
