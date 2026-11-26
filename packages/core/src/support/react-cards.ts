// The capability card of a room agent's reaction (ISS-1475; owner 2026-11-26: "no 'I am checking, I
// will report' message: acknowledge by a reaction on the asker's message"). Written from the case that
// made it: in AdminHub-Support's PGPrints thread 3 messages in 11 minutes answered one matter
// (checking, unclear, cause), and Suport-HRM's thread of 25/11 held 67 bot messages for 48 user ones.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

export const REACT_ACT_CARDS = {
  react: {
    purpose:
      'Sets one reaction on a message of your own thread: the acknowledgement, in place of a message saying you are checking.',
    situations: [
      {
        when: 'a message needs work before you can answer, and the asker owes nothing meanwhile',
        do: 'react with support.react { thread, message, emoji: eyes }, stay silent while you work, and post ONE message when it is done: the cause, what was done, what they must do',
        watch:
          'a message of another thread is refused SUPPORT_REACT_MESSAGE_UNKNOWN; only eyes, hourglass_flowing_sand, white_check_mark and thumbsup are taken; the same reaction twice sets nothing the second time',
      },
    ],
    practice: [
      'A reaction posts no text: never add a line saying you are checking or will report.',
    ],
    example: { thread: '86aGqsokzYezYNdvF', message: 'Hx3kQp9mZt2LrWv8d', emoji: 'eyes' },
    // ISS-1475, PGPrints thread Q8mjjHjyrk3u2zs89: "checking", "unclear", then the cause, 3 posts in 11 minutes
    redFlag:
      'A post saying you are checking or will report back, where a reaction acknowledges and one message at the end answers.',
    family: 'room.answer',
    audience: ['bot'],
    scenarios: ['three posts in eleven minutes for one matter: checking, unclear, cause'],
  },
} satisfies Partial<Record<SupportAction, CapabilityCardBody>>;
