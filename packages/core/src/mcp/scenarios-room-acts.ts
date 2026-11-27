// The scenarios of the room acts a grant opens and of a room's reference acts (`support/ops-cards.ts`,
// `support/reference-cards.ts`), each read as a room agent reads it, under the room brief's map.
// Forge recorded one call of these in the 90 days to 2026-11-17 (GET
// /api/projects/forge/metrics/doors): Forge-Communicate's draft_feedback in thread 86aGq, refused
// OPS_ROLE_NOT_GRANTED. The rest are the situation the record that built the act names, with the good
// use its card teaches; a bad use is carried only where one was recorded.

import type { CardScenario } from '../lessons/index.js';

const NONE = 'forge door use, 2026-08-19..11-17: no call';
const REFS = 'ISS-1252 (reference sources a room learns from)';

export const ROOM_ACT_SCENARIOS: readonly CardScenario[] = [
  {
    name: 'the owner’s two ePOD wishes drafted by a role not granted draft (FB-699)',
    card: 'support.draft_feedback',
    source:
      'Forge-Communicate, thread 86aGq, 2026-11-17 05:55:19: draft_feedback refused OPS_ROLE_NOT_GRANTED; routed to forge as FB-699 at 05:58:23',
    situation: 'The owner asks the operations room to file two wishes for ePOD',
    bad: 'Babo, whose role grants read and deliver, called draft_feedback and was refused',
    good: 'draft only where the role is granted draft, naming one target',
    teaches: [/and your role is granted draft/i, /Name one target/i],
  },
  {
    name: 'an issue moved for a member only once the act answers it moved',
    card: 'support.move',
    source: `the room acts a grant opens (support/ops-cards.ts); ${NONE}`,
    situation: 'A member asks the room to move an issue to review',
    good: 'move it naming their message and reason, and say so once the act answered',
    teaches: [/Never say it moved until the act answered that it did/i],
  },
  {
    name: 'a build from chat pushed on a branch of its own after a confirmer’s go',
    card: 'support.build',
    source: `the room's build grant (support/ability-acts.ts); ${NONE}`,
    situation: 'A change made in the room’s working copy is to reach the team',
    good: 'build on a branch of its own, then cite the confirmer’s go with support.agree',
    teaches: [/with a branch of its own/i, /cite the confirmer.s go with support\.agree/i],
  },
  {
    name: 'a deploy said live only once the deployment reads it',
    card: 'support.deploy',
    source: `the room's deploy grant (support/ability-acts.ts); ${NONE}`,
    situation: 'A person who may confirm asks for a deploy of a granted target',
    good: 'propose it, cite their go, then read support.deployment before saying it is live',
    teaches: [/say it is live only once support\.deployment reads it/i],
  },
  {
    name: 'a room’s reference sources read before researching a defect',
    card: 'support.references',
    source: `${REFS}; ${NONE}`,
    situation: 'A member asks why a sync fails, and the project has no settled answer',
    good: 'read its reference sources first, then the source itself, and cite it',
    teaches: [/read its reference sources first with support\.references/i],
  },
  {
    name: 'a source the owner named added for him, never sent to a screen',
    card: 'support.reference_add',
    source: `${REFS}; ${NONE}`,
    situation: 'The owner says to follow a repo for its worktree handling',
    good: 'add it citing his message, with why in his words and the areas',
    teaches: [/never send him to a screen to add it himself/i],
  },
  {
    name: 'a reference used in an answer cited with its take and why',
    card: 'support.reference_cite',
    source: `${REFS}; ${NONE}`,
    situation: 'A room answer used a source’s retry pattern and rejected its queue',
    good: 'cite the file read with take or reject and why, one per decision',
    teaches: [/a reject teaches as much as a take/i],
  },
  {
    name: 'a source used across several answers proposed with what it helped',
    card: 'support.reference_propose',
    source: `${REFS}; ${NONE}`,
    situation: 'A room agent used the same outside doc on three answers it is not listed for',
    good: 'propose it with the work it helped; never a page read once',
    teaches: [/A source earns its place by repeated use/i],
  },
  {
    name: 'the owner asks what the box’s per-project run limit is called (“chia slot”), and no term holds the word',
    card: 'support.term',
    source:
      'the owner, 2026-11-16: asked what "run slots" are called and nothing held the word; the room guide then sent a person’s word through support.record (ISS-1256 c9)',
    situation: 'A person calls a thing of the product by a word of their own',
    bad: 'the word was passed on through support.record, which files a defect, feature or request, and no term was written',
    good: 'find it first, then write it with support.term, citing their message, under its module',
    teaches: [/write with support\.term/i, /never pass a word on through support\.record/i],
  },
  {
    name: 'a user cannot find the menu item the agent said appears',
    card: 'support.look',
    source:
      'AdminHub-Support, PGPrints thread, 2026-11-19 05:53 and 06:37-06:38: a menu item said to show after enabling Using API; the user did not see it, and the next post said it shows only after a sync (ISS-1356)',
    situation: 'A user asks where a menu item is, after the master said the feature is live',
    bad: 'the room agent confirmed the item from what a master said, then corrected itself in the next post',
    good: 'look at the screen on the environment first, and say only what the look showed, or, where it cannot look, say so once with what it needs from the person',
    teaches: [/look first with support\.look/i, /never the thing anyway/i],
  },
  {
    name: 'three posts in eleven minutes for one matter: checking, unclear, cause',
    card: 'support.react',
    source:
      'AdminHub-Support, PGPrints thread Q8mjjHjyrk3u2zs89: a checking line, an unclear line, then the cause, with more to come (ISS-1475)',
    situation:
      'A user reports a sync that fails; the cause takes the agent several minutes to find',
    bad: 'a post saying it is checking, another saying the cause is unclear, a third giving the cause',
    good: 'react to the message with support.react, stay silent while it works, and post one message when it is done: cause, what was done, what they must do',
    teaches: [/support\.react/, /stay silent/i, /ONE message when it is done/i],
  },
  {
    name: 'a master hands the room’s bot facts, never the words for a users’ room: FB-866',
    card: 'POST /api/projects/:id/support/master-tells',
    source:
      'FB-866 (SidPeak, 2026-11-25): a master’s own English report with shas, issue keys and tool words reached a users’ thread as the bot’s post (ISS-1468)',
    situation: 'A fix is live and the person who asked in a users’ room should hear it',
    bad: 'the master wrote the sentence for the room, shas and issue keys included, and it reached the users’ thread as written',
    good: 'name the asker’s thread and hand the bot the facts: what changed, where it runs, what to check again',
    teaches: [
      /name the asker.s thread and write the facts/i,
      /never write the sentence the room should read/i,
    ],
  },
];
