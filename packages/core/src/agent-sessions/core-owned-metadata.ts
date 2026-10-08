// The metadata keys core writes on a session that say where it answers and what kind of fire it is:
// the room and escalation markers its reply is delivered by, and the schedule source a fire is told
// apart from a chat by (`chat-door.ts:isChatDoorSession`). They are core's, written when the row is
// opened, so no caller sets or changes them, whatever credential it holds: a chat session that could
// rewrite its own would decide for itself whether a person's agreement holds its writes (REQ-30
// BC-4, ISS-439) or whether it runs confined.

import { isDeepStrictEqual } from 'node:util';
import { refuseSession } from './refusals.js';
import { TERMINAL_SESSION_BRIDGE_MARKERS } from './terminal-effects.js';

export const CORE_OWNED_SESSION_KEYS = [
  ...TERMINAL_SESSION_BRIDGE_MARKERS,
  'source',
  'scheduleRunId',
] as const;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const refusal = (keys: readonly string[], what: string) =>
  refuseSession(
    'SESSION_METADATA_CORE_OWNED',
    `${what} ${keys.join(', ')}, which core writes when it opens a session to say where the session answers and what kind of fire it is; no caller sets or changes ${keys.length === 1 ? 'it' : 'them'}. Send the metadata with ${keys.length === 1 ? 'that key' : 'those keys'} exactly as the session holds ${keys.length === 1 ? 'it' : 'them'}, or leave metadata out; nothing was written`,
    '/metadata',
  );

/** A session opened by a caller names none of core's keys. */
export function assertCallerNamesNoCoreKey(metadata: unknown): void {
  const named = CORE_OWNED_SESSION_KEYS.filter((k) => asRecord(metadata)[k] !== undefined);
  if (named.length > 0) throw refusal(named, 'this new session names');
}

/** A PATCH of a session's metadata replaces it whole, so it must carry core's keys unchanged. */
export function assertCoreKeysKept(held: unknown, patched: unknown): void {
  const before = asRecord(held);
  const after = asRecord(patched);
  const changed = CORE_OWNED_SESSION_KEYS.filter(
    (k) => !isDeepStrictEqual(before[k] ?? null, after[k] ?? null),
  );
  if (changed.length > 0) throw refusal(changed, 'this metadata would change');
}
