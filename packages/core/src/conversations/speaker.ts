import type { StoredConversationMessage } from './store.js';

export interface LinkedSpeaker {
  userId: string | null;
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
