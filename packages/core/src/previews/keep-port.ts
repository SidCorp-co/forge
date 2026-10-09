// What keeping an idea needs of the requirement and suggestion modules, which sit in a later
// context than previews and so cannot be imported from it: the composition root hands the writer in
// at boot (`suggestions/kept-preview.ts:writeKeptPreview`), as it hands the requirements their dependents.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { KeepPreviewResponse, KeptPreviewContent } from '@forge/contracts/preview';
import { portSlot } from '../lib/port-slot.js';

/** The item an idea was about: a requirement, or a feedback item a new requirement is started from. */
export type KeptAbout =
  | { kind: 'requirement'; key: string }
  | { kind: 'feedback'; key: string; title: string };

export interface KeptPreviewWriter {
  /**
   * Draws `content` as the picture of the item's requirement (the head, or a new screen draft started
   * from the feedback item) and offers the criteria drafted from what was asked as a suggestion.
   * A refusal of the picture comes out as a `RefusalError` naming it; the suggestion's own refusal is
   * returned in the answer, since the picture is already kept.
   */
  write(input: {
    projectId: string;
    actor: { userId: string; agency: ActorAgency };
    about: KeptAbout;
    alt: string;
    content: KeptPreviewContent;
  }): Promise<KeepPreviewResponse>;
}

const slot = portSlot<KeptPreviewWriter>('previews', 'provideKeptPreviewWriter');
export const provideKeptPreviewWriter = slot.provide;
export const keptPreviewWriter = slot.get;
