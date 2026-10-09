// What settling a POC room needs of the requirement and issue modules (REQ-44 BC-7, BC-8), which sit
// in a later context than previews and so cannot be imported from it: the composition root hands the
// writer in at boot (`requirements/room-settle.ts:writeSettledRoom`), as it hands the keep writer.

import type { ActorAgency } from '@forge/contracts/permissions';
import type { KeptPreviewContent } from '@forge/contracts/preview';
import { portSlot } from '../lib/port-slot.js';
import type { KeptAbout } from './keep-port.js';

export interface RoomSettleWriter {
  /**
   * Why the room cannot be settled into its item's requirement, by name, before anything is written
   * or merged: the requirement draws no preview picture (it is not a screen), or a draft is open.
   */
  refusal(input: {
    projectId: string;
    about: KeptAbout;
  }): Promise<{ code: string; detail: string } | null>;
  /**
   * After the merge landed: a new revision of the item's requirement (a new requirement started from
   * a feedback item) with the settled items as criteria and the kept page as its picture, and the
   * follow-up issue that verifies, reviews and cleans the merge, linked to it. A step that is refused
   * is answered by its own code; the merge already stands.
   */
  write(input: {
    projectId: string;
    actor: { userId: string; agency: ActorAgency };
    about: KeptAbout;
    items: { text: string; commit: string }[];
    alt: string;
    content: KeptPreviewContent;
    merge: { into: string; sha: string; branch: string; roomId: string };
  }): Promise<{
    requirement: string | null;
    revision: number | null;
    issue: { id: string; displayId: string | null } | null;
    refusals: { code: string; detail: string }[];
  }>;
}

const slot = portSlot<RoomSettleWriter>('previews', 'provideRoomSettleWriter');
export const provideRoomSettleWriter = slot.provide;
export const roomSettleWriter = slot.get;
