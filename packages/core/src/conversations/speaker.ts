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
// cm:guard the NEWEST person message and not the principal: in a group venue the turn runs as the room's execution principal (route-window.ts), and binding a person's preferences or a note's authorship to that would credit one colleague's words to another. Where the newest author is unlinked the answer is null, which every reader treats as "refuse by name", never as "fall back to the principal" (ISS-1034 criterion 62, codex F1).
export function linkedSpeakerOf(messages: readonly StoredConversationMessage[]): LinkedSpeaker {
  const newest = [...messages].reverse().find((m) => m.role === 'user');
  if (!newest) return { userId: null, label: null };
  return {
    userId: newest.authorUserId ?? null,
    label: newest.authorLabel ?? newest.authorKey ?? null,
  };
}
