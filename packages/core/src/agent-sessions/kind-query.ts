/**
 * The two places a caller may name a session's species, and what each is told.
 *
 * Both used to be silences. `?metadataType=agent` filtered on a jsonb value no
 * writer in this repository has ever set, so it answered an empty page — which
 * reads exactly like "you have no sessions". And a caller could declare its own
 * species by putting a `type` in `metadata`, which core then ignored, leaving
 * the caller believing a filter that no longer reads the key (ISS-1136).
 */

import { AGENT_SESSION_KIND_LIST, isAgentSessionKind } from '../jobs/session-kinds.js';
import type { AgentSessionKind } from '../db/schema.js';

/** The kind a `metadataType` query names, or a refusal saying what is valid. */
export function kindFromQuery(value: string, refuse: (message: string) => Error): AgentSessionKind {
  if (isAgentSessionKind(value)) return value;
  throw refuse(
    `metadataType=${value} names no session kind. A session's kind is one of: ${AGENT_SESSION_KIND_LIST}.`,
  );
}

/** Refuse a caller that tries to declare the species of the row it is opening. */
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
