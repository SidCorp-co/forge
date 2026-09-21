import type { AgentSessionKind } from '../db/schema.js';
import { AGENT_SESSION_KIND_LIST, isAgentSessionKind } from '../jobs/session-kinds.js';

export function kindFromQuery(value: string, refuse: (message: string) => Error): AgentSessionKind {
  if (isAgentSessionKind(value)) return value;
  throw refuse(
    `metadataType=${value} names no session kind. A session's kind is one of: ${AGENT_SESSION_KIND_LIST}.`,
  );
}

export function assertCallerDeclaresNoKind(
  metadata: Record<string, unknown> | null | undefined,
  refuse: (message: string) => Error,
): void {
  if (!metadata || !('type' in metadata)) return;
  throw refuse(
    "metadata.type is not a caller's to set. A session's species is the `kind` column, " +
      `written by core when it opens the row, and it is one of: ${AGENT_SESSION_KIND_LIST}. ` +
      'Send the rest of your metadata without `type`; a session opened here is a chat.',
  );
}
