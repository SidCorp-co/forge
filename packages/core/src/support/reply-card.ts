// support.reply's card (ISS-1251), the act every answer goes out by: kept apart from the other room
// cards (`room-cards.ts`) for size, and rendered with them into the room brief's map and the room
// agent's guide (`guides/served.ts`). What it teaches is where the agent reads as it writes.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const THREAD = '86aGqsokzYezYNdvF';

export const REPLY_CARD = {
  purpose:
    'Posts your answer in a thread, screened before posting; nothing you write reaches the room any other way.',
  situations: [
    {
      when: 'a message asks you something or reports a problem',
      do: "post one result in the asker's thread with support.reply { thread, text, why }, in the language they wrote in, short, mentioning at most one person, by username",
      watch:
        'In a group the product’s users read, a Forge issue key, MR number, variable name, sha or credential word is refused SUPPORT_INTERNAL_CODE.',
    },
    {
      when: 'an owner keeps each matter in the thread it was first raised in, and a question on one is asked elsewhere',
      do: 'answer it in the matter’s thread, naming it with request: { thread, message }; its own thread gets no post',
    },
  ],
  practice: [
    'Results only: no acknowledgement, plan or progress, save the one reply that an ask went to the team.',
    // ISS-1354 (FB-763): three failed audits after ISS-1329 taught reading first, at a line the agent did not read as it wrote
    'A live setting or account is stated from a read made in this turn, or said to be from an earlier read and when; each step names who does it, by role or name, never “em” for another person’s act, and the asker is addressed as who they are.',
  ],
  example: {
    thread: THREAD,
    text: 'The order export has the size column again since 15:20 today; export it once more.',
    why: 'she asked when the export is fixed',
  },
  // ISS-1243, AdminHub-Support 03/11-15/11: 21 of 76 bot posts were relays ("passed to the team,
  // I will report back") instead of an answer, and a master post landed beside 14 of them
  redFlag:
    'Relaying “passed to the team, will report back” when the answer can be had now: ask the master in the turn and answer yourself.',
  family: 'room.answer',
  audience: ['bot'],
  scenarios: ['a relay posted instead of the answer: “passed to the team, will report back”'],
} satisfies CapabilityCardBody;
