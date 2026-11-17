// The capability cards of the lesson doors every orientation's lessons map names in its tail
// (`block.ts`), beside their routes (`routes.ts`), keyed by the door as the published contract lists it
// and built into the door catalog by `mcp/rest-cards.ts`. Written from the lessons map's own teaching,
// the `Lessons applied:` lines runs leave on forge's issues and the refusals each door was given.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const LESSON_REST_CARDS = {
  'POST /api/projects/:id/lessons/applied': {
    purpose: 'Records which approved lessons shaped one output, so a lesson in use is kept.',
    situations: [
      {
        when: 'a lesson you opened from the lessons map changed what you built, wrote or decided',
        do: 'end the issue comment that reports it with `Lessons applied: L-n`, which is kept against the issue; for any other output (`job`, `chat_message`, `steward_run`) record it here with its ref',
      },
    ],
    practice: [
      'A lesson goes as its key (`L-3`), its slug as the map lists it (`lesson-3`) or its number (3).',
      'Only an approved lesson of this project is applied; any other is refused LESSON_NOT_APPLICABLE.',
      'Record only lessons that shaped the output, not every one you read.',
    ],
    example: { lessons: ['L-29', 'lesson-30'], output: { kind: 'job', ref: 'a3c1e2f4' } },
    // forge to 2026-11-17: 4 calls, all refused (3 as a generic error to 10-22, 1 BAD_REQUEST on 11-17),
    // while runs ended their issue comments with `Lessons applied:` lines nothing read; since ISS-1251
    // round 4 that line on an agent's issue comment is kept, and the door takes the map's slug
    redFlag:
      'Naming in `Lessons applied:` every lesson the map listed: a lesson applied three times and never corrected is folded into its card and retired, so a lesson you only read must not count.',
    scenarios: [
      'a run’s `Lessons applied:` line read by nothing while the door refused every call',
    ],
    family: 'knowledge',
    audience: ['master', 'run'],
  },
  'POST /api/projects/:id/lessons/:n/confusions': {
    purpose: 'Reports a lesson that conflicts, contradicts a requirement or cannot be applied.',
    situations: [
      {
        when: 'two lessons tell you opposite things about the work in front of you',
        do: 'raise `conflict` on one, naming the other in `other.lesson`, quote both in `sides`, and go on without either',
      },
      {
        when: 'a lesson contradicts an approved requirement or design',
        do: 'raise `contradicts`, naming the requirement (`REQ-n`) or design in `other.ref` and quoting both in `sides`; the requirement leads',
      },
      {
        when: 'you cannot tell how a lesson applies, or it was applied to an output where it did not fit',
        do: 'raise `unclear`, or `wrongly_applied` naming in `other.ref` the output its application was recorded under',
      },
    ],
    practice: [
      'Raising holds the lesson off every prompt until the steward settles it; no person is asked.',
      'Give `recommended` the resolution you would choose (keep, edit or retire); an edit needs its sentence.',
      'Only an approved lesson can confuse; a held, retired or proposed one is refused LESSON_DECIDED.',
    ],
    example: {
      kind: 'conflict',
      other: { lesson: 30 },
      sides: {
        lesson: 'Show the stuck reason inline on the issue page.',
        other: 'Reasons and evidence open on demand, never inline.',
      },
      recommended: {
        resolution: 'edit',
        sentence: 'Show the stuck reason on hover, keeping the inline label to one word.',
      },
    },
    // forge, 2026-10-17..11-16: 14 of 21 confusions refused, among them ones already decided
    // (LESSON_CONFUSION_DECIDED) and ones quoting no sides (LESSON_CONFUSION_INVALID)
    redFlag:
      'Asking a person which lesson wins, where raising the confusion and going on is the act.',
    family: 'knowledge',
    audience: ['master', 'run'],
    scenarios: ['a confusion raised on a decided lesson: LESSON_CONFUSION_DECIDED'],
  },
} satisfies Record<string, CapabilityCardBody>;
