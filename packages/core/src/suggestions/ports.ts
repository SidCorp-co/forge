import { portSlot } from '../lib/port-slot.js';

// What suggestions reads from the modules above it, handed in by the process entry at boot (ADR 0008:
// a domain imports only its own context or one before it). Read only inside a call.

interface SuggestionsPorts {
  /** The project's steward account (REQ-48), or null where none was minted yet; never mints one. */
  stewardOf(projectId: string): Promise<string | null>;
}

const slot = portSlot<SuggestionsPorts>('suggestions', 'provideSuggestionsPorts');
export const provideSuggestionsPorts = slot.provide;
export const suggestionsPorts = slot.get;
