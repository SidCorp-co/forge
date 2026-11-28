// The capability card of a room agent's look at a screen (ISS-1356; owner 2026-11-19: "Babo does not
// check the UI and reports nonsense: the feature plainly isn't on the UI, and it confirms it"). Written
// from the case that made it: in AdminHub-Support's PGPrints thread a user was told a menu item
// appears, did not see it, and the next post said it appears only after a sync.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

export const LOOK_ACT_CARDS = {
  look: {
    purpose:
      "Opens a Forge Box on your project's environment and answers what its screen shows: the snapshot, a screenshot and where a person watches it.",
    situations: [
      {
        when: 'you would tell someone a button, menu item, field or page exists, appears or behaves a certain way',
        do: 'look first with support.look { thread, environment, path }, and say only what the look showed',
        watch:
          'only your own project’s environments; where you cannot look, say so once with what you need from the person, never a progress line, never the thing anyway',
      },
      {
        when: 'you walk a person through a screen',
        do: 'walk each step yourself with support.look { thread, box, step } (a ref from the snapshot), so its shots come from that walk',
        watch:
          'a step that needs a workaround (an address edit, a hidden tab, a field the screen hides) is a UI defect recorded with support.record, never a step you send',
      },
    ],
    practice: [
      'A first look signs in as a testing-profile actor, the least privileged unless you name as: <actor>, the one closest to who asked; where its signIn says it could not, say the screen is behind a sign-in, never what it holds.',
      'Show what you saw: support.reply { thread, text, shots: [<the look’s picture>] } in the thread the look was taken for, and no other.',
      'Close the box with close: true once you have looked; one left open closes itself only after an hour idle.',
    ],
    example: { thread: '86aGqsokzYezYNdvF', environment: 'staging', path: '/settings/suppliers' },
    // ISS-1356, AdminHub-Support 19/11 05:53 and 06:38: "the Product Type Mapping item now shows in the
    // menu once Using API is on and PGPrints chosen"; the user did not see it, and the next post said
    // it shows only after Sync now, which the guide's step 3 reached by typing ?tab=2 into the address
    redFlag:
      'Saying what a screen shows from a post or a release note: on 19/11 a PGPrints user was told a menu item appears, did not see it, and the next post said it appears only after a sync.',
    family: 'room.facts',
    audience: ['bot'],
    scenarios: ['a user cannot find the menu item the agent said appears'],
  },
} satisfies Partial<Record<SupportAction, CapabilityCardBody>>;
