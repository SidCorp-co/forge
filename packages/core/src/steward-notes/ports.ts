import type { ItemStanding, StewardCite, StewardNoteSubjectKind } from '@forge/contracts/steward';
import { portSlot } from '../lib/port-slot.js';

// What a steward note is vetted against, from the standing read model a domain may not import
// (ADR 0008), handed in by the process entry at boot. Read only inside a call.

interface StewardNotesPorts {
  /** The subject's standing as no viewer reads it; null where the project holds no such subject. */
  standingOf(
    projectId: string,
    kind: StewardNoteSubjectKind,
    key: string,
  ): Promise<ItemStanding | null>;
  /** The cites no record of the project answers. */
  unknownCites(projectId: string, cites: readonly StewardCite[]): Promise<StewardCite[]>;
}

const slot = portSlot<StewardNotesPorts>('steward-notes', 'provideStewardNotesPorts');
export const provideStewardNotesPorts = slot.provide;
export const standingOf = slot.port('standingOf');
export const unknownCites = slot.port('unknownCites');
