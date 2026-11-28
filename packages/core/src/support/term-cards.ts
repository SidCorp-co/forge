// The capability card of a room agent's term act (ISS-1256 c9; owner 2026-11-16: "a person names a
// thing → write a term"). Its lead situation is the room brief's map line (`room-conduct.ts`), so it
// is taught where the agent reads as it answers. Written from the case that made it: on 2026-11-16
// the owner asked what "run slots" are called and nothing held the word; the room guide then sent a
// person's word on through support.record, which files a defect, feature or request after asking them.
// Its scenario is that case; more are added as real uses are seen.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';
import type { SupportAction } from './act-cards.js';

export const TERM_ACT_CARDS = {
  term: {
    purpose:
      "Writes a thing a person names into the project's glossary under its module: their word an alias, their message quoted as who named it.",
    situations: [
      {
        when: 'a person calls a thing of the product by a word of their own',
        do: 'find it first (support.search); a word no term holds, write with support.term { thread, message, slug, title, means, module, aliases, quote }, citing their message',
        watch:
          'never pass a word on through support.record, which files a defect, feature or request',
      },
      {
        when: 'support.term is refused because the person may not write the project',
        do: 'send the word with support.ask_master: the word, what it names and their quote',
      },
    ],
    practice: [
      'Their word goes in aliases (vi for Vietnamese); title is the name the project uses, or theirs where it has none.',
      'Name the module by its slug from the project’s map; an unknown one is refused naming the modules.',
    ],
    example: {
      thread: '86aGqsokzYezYNdvF',
      message: 'pX4cQe9TnB2wLs7Rk',
      project: 'forge',
      slug: 'run-slots',
      title: 'Run slots',
      means: 'How many subagent runs a project may hold at once on a box.',
      module: 'execution',
      aliases: { vi: ['chia slot'], industry: ['fair-share scheduling'] },
      quote: 'how many chia slot does epod get?',
    },
    redFlag:
      'Passing a person’s word on through support.record, which files a defect, feature or request: the room guide taught that route until ISS-1256, and no term was written.',
    family: 'room.record',
    audience: ['bot'],
    scenarios: [
      'the owner asks what the box’s per-project run limit is called (“chia slot”), and no term holds the word',
    ],
  },
} satisfies Partial<Record<SupportAction, CapabilityCardBody>>;
