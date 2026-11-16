// The capability cards of the knowledge doors a master and a run call over REST (ISS-1251), beside
// their routes (`routes.ts`, `org-knowledge-routes.ts`), keyed by the door as the published contract
// lists it and built into the door catalog by `mcp/rest-cards.ts`. Writing a project entry carries the
// orientation's card (`prompt/facts/affordance-cards.ts`). Written from the curation of 2026-11-07,
// the prompt-is-a-map rule and the recall checks recorded on forge's issues.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

export const KNOWLEDGE_REST_CARDS = {
  'POST /api/projects/:id/knowledge/search': {
    purpose: 'Finds the project’s knowledge, lessons and org rulings by topic, ranked.',
    situations: [
      {
        when: 'your task touches an area and you do not know which guide, rule or lesson covers it',
        do: 'search by the concrete nouns of the task, then open the hits you need by slug',
      },
      {
        when: 'you are about to write a knowledge entry or a rule',
        do: 'search for one already holding the subject first, and rewrite that one instead',
      },
      {
        when: 'you want memory and knowledge hits in one ranked answer',
        do: 'send `scope: "all"`; `scope: "memory"` reads memory alone',
      },
    ],
    practice: [
      'Ask as a short question or topic; `semantic` is the default and finds paraphrases.',
      '`keyword` matches every term at once, so a long question finds almost nothing with it.',
    ],
    example: { query: 'when must an agent ask the owner to approve', topK: 5 },
    audience: ['master', 'run'],
  },
  'DELETE /api/projects/:id/knowledge/:slug': {
    purpose: 'Removes a project knowledge entry that is wrong, stale or merged into another.',
    situations: [
      {
        when: 'an entry describes code or a direction that no longer holds and cannot be verified',
        do: 'delete it in the change that found it; a wrong entry is worse than none',
      },
      {
        when: 'you merged an entry into its twin (a rule into its `-full` guide, two entries on one subject)',
        do: 'delete the entry you merged away once the one you keep says it all',
      },
    ],
    practice: [
      'Answers `deleted: false` when the slug holds no entry: read it before you take it as removed.',
      'A delete reaches running checkouts only when their orientation is next rewritten.',
    ],
    example: {},
    audience: ['master', 'run'],
  },
  'PUT /api/orgs/:orgId/knowledge/:slug': {
    purpose: 'Writes one org-wide ruling or guide that every project of the organisation reads.',
    situations: [
      {
        when: 'a way of working the owner set applies to every project, not one project’s facts',
        do: 'write it as one org entry, never seeded as a rule on each project',
      },
      {
        when: 'the owner changes a direction an org entry already states',
        do: 'rewrite that entry whole under its slug, merging its twin, rather than adding one beside it',
      },
      {
        when: 'your token is fenced to projects (refused PAT_ACCOUNT_ROUTE) or holds no `org.admin`',
        do: 'post the whole entry on the issue for an org admin to save; never write it as a project rule instead',
      },
    ],
    practice: [
      'Needs `org.admin`; an entry missing `source`, `scope` or `recheckWhen` is refused by name.',
      'The write replaces the whole entry: send every field you mean to keep.',
      '`injection: always` puts it in every prompt; keep it to a few short lines, detail on demand.',
    ],
    example: {
      title: 'Settle a configuration’s place before building it',
      body: 'Before building a configuration change, settle where it lives: the project document, a binding or code.',
      injection: 'on_demand',
      source: 'owner ruling 2026-11-12',
      scope: 'every project of the organisation',
      recheckWhen: 'project-config document shape changes',
    },
    // prompt-is-a-map owner rulings 2026-11-01..07: ways of working had been seeded as per-project
    // rules; ISS-1222 c2 is the right path from a fenced master (entry handed to an org admin)
    redFlag:
      'Writing an org-wide way of working as a rule on each project: the copies drift apart and none is the source.',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
