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
