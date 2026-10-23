// REQ-48 r3 BC-14 and BC-17, judged red live on 0.4.0-dev.287: a decision asks one plain sentence and
// carries no answer, commit or release name in it (FB-114 and FB-127 quoted their whole answer), and a
// row left out of the decisions is named by its title with a next step a person reads.

import { needsYouDecisionSchema } from '@forge/contracts/needs-you-decisions';
import { verbatim } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import type { OpenPersonQuestion } from '../questions/index.js';
import type { AttentionRow } from './needs-you.js';
import { cutDecision, designDecision, releaseDecision } from './needs-you-approve-builders.js';
import { type Built, feedbackDecision, questionDecision } from './needs-you-decision-builders.js';
import { designRowOf } from './needs-you-design.js';
import { repinDecision } from './needs-you-repin.js';

const P = '6f0ee160-8432-4b84-98cf-956b6cd65a29';
const row = (entity: AttentionRow['entity'], key: string, title = key): AttentionRow =>
  ({ entity, key, title, touchedAt: '2026-10-22T09:00:00.000Z' }) as unknown as AttentionRow;

const FB_114 =
  'Fixed on dev in 0.4.0-dev.232 (poc-fix-231, merge a011aabfa), outside the dropped carrier ISS-508. Verified on live dev.236: the export now keeps every column.';
const FB_127 =
  'Shipped in 0.4.0-dev.240 at 3f9c2e1b7d. The list reloads after a save; a stale tab still shows the old count until it is opened again.';

/** The decision as the read serves it, parsed by the contract. */
const served = (b: Built | { decision: Built['decision'] }) =>
  needsYouDecisionSchema.parse({
    id: 'x',
    stuck: false,
    dueAt: null,
    topic: 'requirement',
    proposal: null,
    ...b.decision,
  });

const SHA = /\b[0-9a-f]{7,40}\b/;
const RELEASE = /\b\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?\b|\bdev\.\d+\b/;

/** One sentence: a single closing mark, at its end, and nothing quoted or named by commit or release. */
function plain(question: string): void {
  expect(question.match(/[.?!](\s|$)/g) ?? []).toHaveLength(1);
  expect(question).toMatch(/[?]$/);
  expect(question).not.toMatch(SHA);
  expect(question).not.toMatch(RELEASE);
}

describe('a feedback decision', () => {
  it.each([
    ['FB-114', FB_114],
    ['FB-127', FB_127],
  ])('asks %s in one sentence and says the answer given once, in its why', (key, given) => {
    const d = served(feedbackDecision(row('feedback', key), 'feedback', P, given));
    plain(d.question);
    expect(d.question).toBe(`Does the answer given on ${key} settle it?`);
    expect(d.recommended?.why).toContain(given);
    expect(JSON.stringify(d).split(given)).toHaveLength(2);
  });

  it('keeps a long answer within the why, cut where it ends', () => {
    const d = served(feedbackDecision(row('feedback', 'FB-9'), 'feedback', P, FB_114.repeat(8)));
    expect(d.recommended?.why.length).toBeLessThanOrEqual(600);
    expect(d.recommended?.why).toContain('…"');
  });

  it('asks a shipped fix, and an answer it does not hold, in one sentence too', () => {
    plain(served(feedbackDecision(row('feedback', 'FB-3'), 'feedback', P, null, 'fix')).question);
    const none = served(feedbackDecision(row('feedback', 'FB-4'), 'feedback', P, null));
    plain(none.question);
    expect(none.recommended?.why).toBe(
      'It was answered. Nobody has reopened it; reopen it with a reason if the answer misses the point.',
    );
  });
});

describe('a release decision', () => {
  it('asks without naming the release its title already names', () => {
    const approve = served(
      releaseDecision(
        row('release', '0.4.0-dev.270', 'Release 0.4.0-dev.270'),
        'releases',
        P,
        { runId: 'run-7', failing: 0, total: 4, changeRequests: [] },
        'ap-7',
      ),
    );
    plain(approve.question);
    const cut = served(
      cutDecision(row('release', '0.4.0-dev.288', 'Release 0.4.0-dev.288'), 'releases', P, {
        version: '0.4.0-dev.288',
        contents: [
          {
            issues: [
              { key: 'ISS-1', title: 'One', proof: 'proven' },
              { key: 'ISS-2', title: 'Two', proof: 'proven' },
            ],
          },
        ],
        criteria: { total: 2, proven: 2, failing: 0, open: 0, unproven: 0 },
      } as unknown as Parameters<typeof cutDecision>[3]),
    );
    plain(cut.question);
    expect(cut.question).toBe('Cut this release with the 2 issues waiting for it?');
  });
});

describe('a design decision', () => {
  it('names the design by its title, in the question and in what approving does', () => {
    const d = served(
      designDecision(row('workflow', 'judge-k47-test'), 'designs', P, {
        workflowId: 'wf-1',
        revision: 1,
        title: '[judge K47 test] throwaway design',
      }),
    );
    expect(d.question).toBe(
      'Approve revision 1 of "[judge K47 test] throwaway design", or return it to its writer?',
    );
    expect(JSON.stringify(d.question)).not.toContain('judge-k47-test');
    expect(d.answers[0]?.effect).toBe(
      'Revision 1 becomes the approved design of "[judge K47 test] throwaway design".',
    );
  });

  it('names the base a re-pin follows by its title', () => {
    const d = served(
      repinDecision(row('workflow', 'access'), 'designs', P, {
        baseId: 'b',
        flow: 'access',
        title: 'Who may see what',
        revision: 13,
        ready: [
          {
            workflowId: 'w',
            flow: 'staff',
            source: 'approved',
            revision: 2,
            approves: 3,
            pins: [{ workflow: 'access', from: 12, to: 13 }],
          },
        ],
        refused: 0,
        approvedAt: null,
      }),
    );
    expect(d.question).toContain('"Who may see what"');
    expect(d.question).not.toContain(' access ');
  });
});

describe('a design row left out of the decisions', () => {
  const health = (over: Partial<WorkflowHealth>): WorkflowHealth =>
    ({
      flow: 'system-context',
      title: 'Forge in context',
      needsYou: 20,
      markers: [],
      proposal: null,
      ...over,
    }) as WorkflowHealth;

  it('is named by its title, with its next step in plain words', () => {
    const r = designRowOf(health({}));
    expect(r?.title).toBe('Forge in context');
    expect(r?.standing.waitingOn.act).toBe('decide 20 places where the code and the design differ');
    expect(r?.standing.waitingOn.act).not.toMatch(/marker/);
  });

  it('says one place in the singular, and falls back to its key only where it has no title', () => {
    const r = designRowOf(health({ title: null, needsYou: 1 }));
    expect(r?.title).toBe('system-context');
    expect(r?.standing.waitingOn.act).toBe('decide 1 place where the code and the design differ');
  });

  it('is unchanged where a revision waits on the viewer: the proposal names it', () => {
    const r = designRowOf(
      health({
        proposal: {
          revision: 3,
          title: 'Forge in context',
          proposedAt: '2026-10-06T08:00:00.000Z',
          waitingOn: waitingOn('you', {
            who: verbatim('you'),
            act: verbatim('approve or return the design'),
            rule: verbatim('r'),
          }),
        },
      }),
    );
    expect(r?.title).toBe('Forge in context · revision 3 proposed');
  });
});

describe('a question a run asked on nothing', () => {
  const PROMPT =
    'Release 0.1.0 has no name yet, and naming it takes the project admin role the master does not hold. Name it, or grant the master the role?';
  const q = {
    id: '6d89a0ef-68ea-4dae-be03-878bb8657655',
    issueId: null,
    requirementId: null,
    at: '2026-10-22T09:00:00.000Z',
    current: {
      round: 1,
      answerShape: 'choice',
      askedAt: '2026-10-22T09:00:00.000Z',
      prompt: PROMPT,
      options: [
        {
          id: 'name',
          label: 'Name it',
          authority: 'writer',
          bindsTo: 'this_call',
          executedBy: 'core',
          fingerprint: 'f',
        },
        {
          id: 'grant',
          label: 'Grant the role',
          authority: 'writer',
          bindsTo: 'this_call',
          executedBy: 'core',
          fingerprint: 'f',
        },
      ],
      recommendedOptionId: 'name',
    },
  } as unknown as OpenPersonQuestion;

  it('says its prompt once, as the question, under a title of its own', () => {
    const d = served(
      questionDecision(row('question', q.id, PROMPT.slice(0, 120)), 'questions', q, null),
    );
    expect(d.title).toBe('A question a run asked');
    expect(d.question).toBe(PROMPT);
    expect(JSON.stringify(d).split('naming it takes')).toHaveLength(2);
  });

  it('keeps the title of the issue a question is asked on', () => {
    const d = served(
      questionDecision(row('issue', 'ISS-9', 'Export drops a column'), 'issues', q, null),
    );
    expect(d.title).toBe('Export drops a column');
  });
});
