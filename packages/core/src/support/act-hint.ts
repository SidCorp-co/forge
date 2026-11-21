// Which group of a channel agent's an act is in (REQ-77): what the act names that places it there, a
// thread, a message or a check, and whether it reads the same from any group. Kept apart from
// `acts.ts` for its size.

import type { RoomHint } from './access.js';
import type { SupportAction } from './act-cards.js';
import { REFERENCE_ACTS } from './reference-acts.js';

/** The acts that read the same from any group of a channel agent: its grant and project are shared. */
const ANY_ROOM = new Set<SupportAction>([
  'search',
  'tools',
  'deployment',
  'project',
  'read',
  // the tracker reads the same from any group, over every project the agent follows (ISS-874)
  'projects',
  'issues',
  'releases',
  'requirements',
  'feedback',
  // the room agent's guide is the project's, or its organization's (ISS-1251)
  'guide',
  // a project's reference sources, the same from any group (ISS-1252)
  ...REFERENCE_ACTS,
]);

/** What an act names that places it in one group of a channel agent's (REQ-77). */
export function hintOf(input: { action: SupportAction }, rid: string | undefined): RoomHint {
  const named = input as {
    thread?: unknown;
    threads?: unknown;
    message?: unknown;
    check?: unknown;
  };
  const thread =
    typeof named.thread === 'string'
      ? named.thread
      : typeof named.check === 'string'
        ? named.check
        : Array.isArray(named.threads) && typeof named.threads[0] === 'string'
          ? named.threads[0]
          : undefined;
  return {
    rid,
    thread,
    message: typeof named.message === 'string' ? named.message : undefined,
    anyRoom: ANY_ROOM.has(input.action),
  };
}
