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
];
