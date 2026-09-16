// The linked speaker of a window — the one identity personal preferences and
// memory authorship bind to, kept apart from the principal the turn ACTS as
// (ISS-1034).

import type { StoredConversationMessage } from './store.js';

export interface LinkedSpeaker {
  /** The Forge user the newest person message is by, or null when nobody Forge knows wrote it. */
  userId: string | null;
  /** The transport's label for whoever wrote it, for the reader only. */
  label: string | null;
}

/**
 * Who spoke last: the newest `user` message's linked author.
 */
export function linkedSpeakerOf(messages: readonly StoredConversationMessage[]): LinkedSpeaker {
  const newest = [...messages].reverse().find((m) => m.role === 'user');
  if (!newest) return { userId: null, label: null };
  return {
    userId: newest.authorUserId ?? null,
    label: newest.authorLabel ?? newest.authorKey ?? null,
  };
}
