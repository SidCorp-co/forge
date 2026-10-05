// Which species of session a row is: `agent_sessions.kind` is the column, these are its readings.

import { type AgentSessionKind, agentSessionKinds } from '../db/schema.js';
import { PIPELINE_SESSION_KINDS } from '../db/session-vocabulary.js';

/** Whether a row's own `kind` is one a pipeline step drives, so `/retry` may reach it. */
export function isPipelineSessionKind(kind: AgentSessionKind): boolean {
  return (PIPELINE_SESSION_KINDS as readonly AgentSessionKind[]).includes(kind);
}

export function isAgentSessionKind(value: unknown): value is AgentSessionKind {
  return typeof value === 'string' && (agentSessionKinds as readonly string[]).includes(value);
}

export const AGENT_SESSION_KIND_LIST = agentSessionKinds.join(', ');
