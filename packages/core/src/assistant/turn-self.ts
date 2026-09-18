/**
 * ISS-1034 — what a turn reads about WHO is answering and WHO is being answered:
 * the handle's self and the speaker's preferences, in one place for every door.
 */

import { readAssistantPreferences } from '../auth/preference-changes.js';
import { db as defaultDb } from '../db/client.js';
import { readSelvesFor } from '../orgs/agent-selves.js';
import { speakerSection } from './preference-line.js';
import type { SelfSummary } from './system-prompt.js';

export interface TurnSelfInput {
  /** The handle participant the turn speaks as, or null where the room names none. */
  handleUserId: string | null;
  /** The Forge user the newest person message is linked to, or null. */
  speakerUserId: string | null;
  /** The transport's own label for the speaker, quoted only in the unlinked sentence. */
  speakerLabel: string | null;
  db?: typeof defaultDb;
}

export interface TurnSelf {
  self: SelfSummary | null;
  speakerContext: string | null;
}

// cm:guard the self is read off the HANDLE the turn speaks as and the preferences off the SPEAKER, and neither off "the project's agent" or the principal: a project may hold more than one agent account and the room names which one is in it, while in a group room the principal is the org agent and the person being answered is somebody else (ISS-1034 criteria 3, 17, 19).
// cm:edge contract -> packages/core/src/assistant/external-chat.ts — every door takes its self and speaker section from HERE rather than reaching the org and auth modules on its own; the archmap fan-out limit on the SSE door is what put the two reads together, and the rule outlived that door (ISS-1030).
export async function loadTurnSelf(input: TurnSelfInput): Promise<TurnSelf> {
  const dbi = input.db ?? defaultDb;
  const selves = input.handleUserId ? await readSelvesFor([input.handleUserId], dbi) : new Map();
  const self = input.handleUserId ? (selves.get(input.handleUserId) ?? null) : null;
  const speakerContext = speakerSection({
    speakerUserId: input.speakerUserId,
    speakerLabel: input.speakerLabel,
    preferences: input.speakerUserId
      ? await readAssistantPreferences(input.speakerUserId, dbi)
      : null,
  });
  return { self, speakerContext };
}
