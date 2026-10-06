/**
 * Which species of session a query is asking about. `agent_sessions.kind` is
 * the column; these are the sets, and the SQL below is built from them.
 */
import type { AgentSessionKind } from '../db/schema.js';

export {
  CLIENT_SESSION_KINDS,
  heartbeatBeatSql,
  heartbeatReapedSql,
  heartbeatSilentSql,
  kindTuple,
  PIPELINE_SESSION_KINDS,
} from '../db/session-vocabulary.js';

export const NEVER_PARKED_SESSION_KINDS = ['master'] as const satisfies readonly AgentSessionKind[];
