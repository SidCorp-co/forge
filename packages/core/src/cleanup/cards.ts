// The capability cards of the fast-delivery and cleanup doors a run and the cleanup run call over REST
// (ISS-1251), beside their routes (`routes.ts`), keyed by the door as the published contract lists it
// and built into the door catalog by `mcp/rest-cards.ts`. Recording debt is the orientation's card
// (`prompt/facts/affordance-cards.ts`). Written from the guides fast-delivery and cleanup-audit and
// the reports and carries made on forge.

import type { CapabilityCardBody } from '@forge/contracts/capability-cards';

const DEBT = '3d9f0b7a-1c2e-4f5a-8b6c-7e9d0a1b2c3d';

export const CLEANUP_REST_CARDS = {
  'POST /api/issues/:id/impact': {
    purpose:
      'Rates a change’s system impact before its merge is marked, telling Audit where to look first.',
    situations: [
      {
        when: 'a change is built and checked and you are about to mark its merge',
        do: 'rate it: the surface it touches, low, medium or high, and why',
      },
    ],
    practice: [
      'A migration, a kernel or permission change, or anything that can take the app down is high.',
      'A red you rate below high passes as debt; one rated high is fixed inside the issue.',
    ],
    example: {
      type: 'data',
      rating: 'high',
      reason: 'Adds a migration that rewrites the issues table.',
    },
    // ISS-780 / forge-plugin report: the drive skill marked merges without rating the change
    redFlag: 'Marking the merge unrated, so Audit cannot tell which landing to read first.',
    family: 'issue-landing',
    audience: ['run', 'master'],
  },
  'POST /api/projects/:projectId/cleanup-reports': {
    purpose:
      'Reports a cleanup run once, last: the head it left and every open debt cleared or remaining.',
    situations: [
      {
        when: 'your cleanup run has landed what it cleaned and is about to end',
        do: 'report once, naming the fire your brief gives, the full sha of the head you left, and each debt cleared with how or remaining with why',
      },
    ],
    practice: [
      'Green exactly when every debt left is carried; any other result is refused.',
      'A second report from the same fire supersedes the first, which is kept.',
    ],
    example: {
      fire: '9a2b4c6d-8e0f-4a1b-9c3d-5e7f9a1b3c5d',
      base: { branch: 'dev', sha: 'c82e7d7c3a339c5035efea3bcbb8b6f45c9510ee' },
      result: 'red',
      cleared: [],
      remains: [{ debt: DEBT, why: 'Needs a migration the window had no time for.' }],
    },
    // FB-482: a report's base sha was mistyped and stored as given; a base the branch does not hold is
    // now refused CLEANUP_BASE_NOT_ON_BRANCH
    redFlag:
      'Typing the base sha by hand or shortening it: the next window reads its range from it.',
    family: 'debt',
    audience: ['run'],
  },
  'POST /api/projects/:projectId/debts/:debt/carry': {
    purpose:
      'Carries a debt no change can clear as a priced amnesty, so reports stop reading red on it.',
    situations: [
      {
        when: 'a debt only a person can clear (a secret to set, an account to open) keeps a cleanup report red',
        do: 'as a project admin, carry it once: what it trades, what it costs and what ends it',
      },
    ],
    practice: [
      'A carried debt stays on every report until cleared; withdraw the carry with DELETE.',
    ],
    example: {
      trades: 'The Sentry DSN on staging stays unset.',
      costs: 'Staging errors are not reported.',
      endsWhen: 'The owner sets SENTRY_DSN on staging.',
    },
    // forge: 2 of 3 carries refused, one forbidden to a caller without project admin
    redFlag: 'Carrying a debt a change could clear, to make a cleanup report read green.',
    family: 'debt',
    audience: ['master'],
  },
  'POST /api/projects/:projectId/debts/:debt/evidence': {
    purpose: 'Keeps what you learned about an open debt on the debt itself.',
    situations: [
      {
        when: 'you looked into an open debt and found its cause, scope or a reason it cannot clear yet',
        do: 'add it as evidence on that debt, so the next window starts from it',
      },
    ],
    practice: ['One finding per call, with where you saw it.'],
    example: {
      evidence: 'The red is the jsdom upgrade: 4 suites time out at 5 s since 0.4.0-dev.690.',
    },
    // forge: 9 of 73 additions refused
    redFlag:
      'Filing a new debt for what an open debt already holds, instead of adding evidence to it.',
    family: 'debt',
    audience: ['run'],
  },
  'DELETE /api/projects/:projectId/debts/:debt/carry': {
    purpose: 'Withdraws the carry on a debt, so reports read it red again until it is cleared.',
    situations: [
      {
        when: 'what a carried debt waited on happened, or the carry was a mistake',
        do: 'withdraw the carry as a project admin, then clear the debt or let it read red',
      },
    ],
    practice: ['The debt itself stays until a change clears it.'],
    example: {},
    // forge: its one call in the window landed
    redFlag: 'Withdrawing a carry to make the debt read cleared: it reads red again, not gone.',
    family: 'debt',
    audience: ['master'],
  },
} satisfies Record<string, CapabilityCardBody>;
