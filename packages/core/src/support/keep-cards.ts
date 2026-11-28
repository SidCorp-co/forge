// The capability card of a room agent's keep act (ISS-1485, REQ-107 BC-5; owner ruling 2026-11-28:
// the agent keeps case summaries and agreed precedents, retrieved when relevant each turn). It is
// taught here and in the turn's kept note, never in the always-on brief, whose size is held. Written
// from the case that made it: AdminHub's room agent asked its master for what it had already been
// told, its own reads falling from 8 a day to 0 or 1.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

export const KEEP_ACT_CARDS = {
  keep: {
    purpose:
      'Keeps what you learned of the project, a recurring problem or a user as one summary with its scope and source case, handed back when a later turn bears on it.',
    situations: [
      {
        when: 'a case settled, or you learned something about the project, a recurring problem or a user that a later case will need',
        do: 'support.keep { thread, topic, concerns, title, learned, scope, recheckWhen }: the problem, its cause, what settled it, who decided',
        watch:
          'a precedent is the owner’s alone, written with owner_forge_act; a summary you keep is your own fact and decides nothing the owner has not agreed',
      },
      {
        when: 'the kept note handed in a turn names a case like this one',
        do: 'read it against what the person says now, and answer from it where it covers the case under its scope; where it no longer holds, keep the corrected one under the same topic',
      },
    ],
    practice: [
      'One topic is one summary: the same topic rewrites it, so correct rather than add a twin.',
      'Never keep a secret, a person’s private data or a guess: a fact you checked, its scope and when to check it again.',
    ],
    example: {
      thread: '86aGqsokzYezYNdvF',
      topic: 'export-size-column',
      concerns: 'problem',
      title: 'CSV export drops the size column',
      learned:
        'The export drops size when the product has no variants. Cause: the variant join. The master fixed it for new exports; old files are re-exported.',
      scope: 'AdminHub CSV export, products without variants',
      recheckWhen: 'the export or the variant model changes',
    },
    redFlag:
      'Asking the master again for what an earlier case already settled and was kept, or keeping a guess as a fact.',
    family: 'room.record',
    audience: ['bot'],
    scenarios: ['the room agent asks its master for what an earlier case already settled'],
  },
} satisfies Partial<Record<SupportAction, CapabilityCardBody>>;
