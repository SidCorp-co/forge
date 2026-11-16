// The capability cards of the onboarding doors (ISS-1251), beside their routes (`routes.ts`), keyed
// by the door as the published contract lists it and built into the door catalog by
// `mcp/rest-cards.ts`. The onboarding job writes its questionnaire, updates and close; a person
// starts and re-runs it. Written from the onboarding job's prompt (`prompt.ts`), its refusals
// (`rules.ts`) and the calls these doors took on forge between 2026-10-17 and 2026-11-16.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const WORKFLOW = '3d2b8c4e-1a5f-4e7d-9b6c-0f1e2d3c4b5a';

export const ONBOARDING_REST_CARDS = {
  'POST /api/projects/:id/onboarding/questionnaires': {
    purpose: 'Posts the onboarding round’s questions and the assumptions its designs rest on.',
    situations: [
      {
        when: 'your onboarding drafted its designs and some answers only a person has',
        do: 'post the assumptions and the questions the code cannot answer, each with its evidence',
      },
    ],
    practice: [
      'A question is a choice whose inferredDefault is the option you recommend, so one press answers it.',
      'A recommendation is a suggestion of its own (POST …/suggestions), never an item here.',
    ],
    example: {
      title: 'What the code could not tell',
      items: [
        {
          id: 'reorder-prices',
          group: 'question',
          control: 'choice',
          prompt: 'Does a reorder keep the original prices?',
          why: 'The cart reprices every line; the order keeps the prices it was placed at.',
          evidence: ['src/cart/price.ts:reprice'],
          options: [
            { id: 'today', label: 'Today’s prices' },
            { id: 'original', label: 'Original prices' },
          ],
          inferredDefault: 'today',
        },
      ],
    },
    // forge, 2026-10-17..11-16: 7 of 8 batches refused, questions with no recommended answer
    // (ONBOARDING_QUESTION_UNRECOMMENDED) and recommendations sent as items
    // (ONBOARDING_RECOMMENDATION_IS_A_SUGGESTION)
    redFlag:
      'Asking a question with no recommended answer, or posting a recommendation as an item.',
    family: 'onboarding',
    audience: ['run'],
  },
  'POST /api/projects/:id/onboarding/updates': {
    purpose: 'Posts what onboarding read and the designs it drafted, registering them with it.',
    situations: [
      {
        when: 'your onboarding read the code and drafted its designs',
        do: 'post a short summary with designs naming each workflow you drafted',
      },
      {
        when: 'answers came in and you revised designs from them',
        do: 'post what changed with cites naming each item and the revision it landed in',
      },
    ],
    practice: ['A cite on an item still open is refused ONBOARDING_CITE_UNANSWERED.'],
    example: {
      text: 'Read a Next.js shop: 14 routes, 9 models, Stripe and Algolia. Two designs drafted.',
      designs: { heading: 'Designs drafted', workflowIds: [WORKFLOW] },
    },
    // forge: 3 updates in the window, none refused; the prompt warns an unregistered design is
    // refused at the close
    redFlag: 'Drafting designs without naming them in an update, so the close cannot find them.',
    family: 'onboarding',
    audience: ['run'],
  },
  'POST /api/projects/:id/onboarding/done': {
    purpose: 'Marks onboarding done on its assumptions once every design is proposed.',
    situations: [
      {
        when: 'every design you drafted is proposed and the questionnaire is posted',
        do: 'mark it done as your last act; do not wait for the answers',
      },
    ],
    practice: [
      'A draft design is refused ONBOARDING_DESIGNS_UNPROPOSED; on a sensitive-data project a data flow is owed.',
    ],
    example: {
      text: 'Done on its assumptions; the open questions keep only their own items open.',
    },
    // the prompt says "Do not wait for answers": a job that held the close for a person stalled
    redFlag:
      'Holding the close until a person answers: an unanswered question keeps only its item open.',
    family: 'onboarding',
    audience: ['run'],
  },
  'POST /api/projects/:id/onboarding/start': {
    purpose: 'Starts a project’s onboarding, which reads its code and drafts its first designs.',
    situations: [
      {
        when: 'a person sets up a project and asks Forge to read it',
        do: 'start onboarding, with what they want from it in request',
      },
    ],
    practice: ['A project onboards once; ONBOARDING_ALREADY_STARTED names the one under way.'],
    example: { request: 'Read the shop and draft its checkout and reorder flows.' },
    // forge: all 6 starts refused, 3 forbidden to agent credentials and the rest already started
    redFlag:
      'An agent starting a project’s onboarding the person did not ask for, or a second one.',
    family: 'onboarding',
    audience: ['person'],
  },
  'POST /api/projects/:id/onboarding/reanalyze': {
    purpose: 'Runs a project’s onboarding read again over code that changed since.',
    situations: [
      {
        when: 'a person says the code moved on since onboarding and its designs are stale',
        do: 're-run it with the reason',
      },
    ],
    practice: ['One runs at a time: ONBOARDING_ALREADY_RUNNING names it.'],
    example: { reason: 'The checkout was rewritten in October; the drafted flow predates it.' },
    // forge: 3 of 4 re-runs forbidden to the agent credentials that sent them
    redFlag: 'An agent re-running onboarding to refresh designs it can revise itself.',
    family: 'onboarding',
    audience: ['person'],
  },
} satisfies Record<string, CapabilityCardBody>;
