// REQ-48 BC-11: what an agent proposes, as the one Needs you page reads it, from the suggestion's own
// payload and the record it is on. A feedback triage that builds something is recommended only where
// a recording reproduced it; a close is recommended as it stands; a near duplicate is a tag; a
// breakdown of a requirement already carried is "check first"; a design update is one answer whose
// body names every design that moves; a payload its kind's schema refuses throws, never guessed.

import { needsYouDecisionSchema } from '@forge/contracts/needs-you-decisions';
import { decisionProposalSchema, fitProposal } from '@forge/contracts/needs-you-proposal';
import { describe, expect, it } from 'vitest';
import type { AttentionRow } from './needs-you.js';
import { breakdownProposal, suggestionProposal, triageProposal } from './needs-you-proposals.js';
import { repinDecision } from './needs-you-repin.js';

const ITEM = {
  key: 'FB-135',
  kind: 'bug' as const,
  severity: 'medium' as const,
  body: 'Landed issues are sent back to open.',
  whereSeen: 'reconciler',
};
const RECORDING = '0b8f6c1e-2a4d-4f7e-9c3b-5d6e7f8a9b0c';
const parsed = <T>(p: T): T => decisionProposalSchema.parse(p) as T;

describe('a feedback triage proposal', () => {
  it('proposes the new issue, recommended only where a recording reproduced it, and shows why', () => {
    const payload = {
      route: 'issue',
      createIssue: { title: 'Do not reset merged issues', priority: 'medium', complexity: 's' },
      answers: { criterion: 'REQ-2 BC-10', severity: 'medium', reproduced: 'no; one agent report' },
      dedup: { ran: true, nearest: 'FB-163', similarity: 0.8 },
    };
    const not = parsed(triageProposal(payload, ITEM));
    expect(not).toMatchObject({
      verb: 'New issue',
      what: '“Do not reset merged issues”',
      recommends: false,
      yields: [{ kind: 'new_issue', n: 1 }],
    });
    expect(not.tags.map((t) => t.text)).toEqual([
      'Bug · medium',
      'Not reproduced',
      '≈ FB-163 80%',
      'REQ-2 BC-10',
    ]);
    expect(not.consequences[0]).toBe(
      'Issue “Do not reset merged issues” is created (medium, size s)',
    );
    expect(not.why).toContainEqual({ label: 'Reproduced', value: 'no; one agent report' });
    expect(not.why).toContainEqual({
      label: 'Closest item',
      value: 'FB-163 · 80% similar, judged different',
    });
    expect(not.said).toBe(ITEM.body);

    const yes = parsed(
      triageProposal(
        {
          ...payload,
          diagnosis: {
            recording: RECORDING,
            cause: 'No merged_at check',
            fix: 'Skip merged issues',
          },
        },
        ITEM,
      ),
    );
    expect(yes.recommends).toBe(true);
    expect(yes.tags).toContainEqual({ text: 'Reproduced', tone: 'ok' });
    expect(yes.why.slice(0, 2)).toEqual([
      { label: 'Cause', value: 'No merged_at check' },
      { label: 'Fix', value: 'Skip merged issues' },
    ]);
  });

  it('reads a duplicate as a recommended close, its nearest a warning past 88%', () => {
    const p = parsed(
      triageProposal(
        {
          route: 'duplicate',
          duplicateOf: 'FB-117',
          note: 'Same fixture',
          dedup: { ran: true, nearest: 'FB-117', similarity: 0.96 },
        },
        ITEM,
      ),
    );
    expect(p).toMatchObject({
      verb: 'Duplicate of FB-117',
      what: 'Same fixture',
      recommends: true,
      yields: [{ kind: 'closed', n: 1 }],
    });
    expect(p.tags).toContainEqual({ text: '≈ FB-117 96%', tone: 'warn' });
    expect(p.tags.map((t) => t.text)).not.toContain('Not reproduced');
    expect(p.why).toContainEqual({ label: 'Closest item', value: 'FB-117 · 96% similar' });
  });

  it('leaves a nearest under 80% out of the tags but names it under Why', () => {
    const p = triageProposal(
      {
        route: 'decline',
        note: 'Not work',
        dedup: { ran: true, nearest: 'FB-9', similarity: 0.5 },
      },
      ITEM,
    );
    expect(p.tags.map((t) => t.text)).toEqual(['Bug · medium']);
    expect(p.why).toContainEqual({
      label: 'Closest item',
      value: 'FB-9 · 50% similar, judged different',
    });
  });

  it('throws on a payload its schema refuses rather than guessing what it proposed', () => {
    expect(() => triageProposal({ route: 'teleport' }, ITEM)).toThrow();
  });
});

describe('a breakdown proposal', () => {
  const payload = {
    issues: [
      {
        title: 'Standing',
        complexity: 's',
        criteria: [
          { body: 'a', tracesTo: 'BC-1' },
          { body: 'b', tracesTo: 'BC-2' },
        ],
      },
      {
        title: 'Runtime',
        complexity: 'm',
        category: 'feature',
        criteria: [{ body: 'c', tracesTo: 'BC-2' }],
      },
    ],
  };

  it('is recommended where nothing carries the requirement yet, with the issues it makes in a table', () => {
    const p = parsed(breakdownProposal(payload, { key: 'REQ-48', criteria: 11, carriedBy: [] }));
    expect(p).toMatchObject({
      verb: 'Break into 2 issues',
      what: '2 draft issues covering 2 criteria',
      recommends: true,
      yields: [{ kind: 'draft_issue', n: 2 }],
    });
    expect(p.tags).toEqual([{ text: 'BC 2 of 11 traced', tone: 'plain' }]);
    expect(p.table?.rows).toEqual([
      ['Standing', 'BC-1 BC-2'],
      ['Runtime\nfeature', 'BC-2'],
    ]);
  });

  it('asks to be checked first where issues already carry the requirement it would trace again', () => {
    const p = breakdownProposal(payload, {
      key: 'REQ-48',
      criteria: 11,
      carriedBy: ['ISS-595', 'ISS-596'],
    });
    expect(p.recommends).toBe(false);
    expect(p.tags[0]).toEqual({ text: 'Already carried by ISS-595, ISS-596', tone: 'warn' });
    expect(p.consequences).toContain(
      'REQ-48 is already carried by ISS-595 and ISS-596; these trace the same criteria again',
    );
  });
});

describe('every other suggestion kind', () => {
  it('reads a revision as its verb and object and never recommends it on its own', () => {
    const p = parsed(
      suggestionProposal(
        'revision_diff',
        { reason: 'Says it twice', changeSummary: 'Merge BC-3 into BC-2', criteria: [] },
        'REQ-8',
      ),
    );
    expect(p).toMatchObject({
      verb: 'Revise REQ-8',
      what: 'Merge BC-3 into BC-2',
      recommends: false,
      yields: [{ kind: 'revision', n: 1 }],
    });
  });
});

describe('a design update', () => {
  const group = {
    baseId: 'wf-base',
    flow: 'system-context',
    title: 'Forge in context',
    revision: 17,
    ready: [
      {
        workflowId: 'wf-a',
        flow: 'design-steward',
        source: 'approved' as const,
        revision: 4,
        approves: 5,
        pins: [{ workflow: 'system-context', from: 16, to: 17 }],
      },
      {
        workflowId: 'wf-b',
        flow: 'design-runner',
        source: 'proposal' as const,
        revision: 9,
        approves: 10,
        pins: [{ workflow: 'system-context', from: 15, to: 17 }],
      },
    ],
    refused: 0,
    approvedAt: '2026-10-08T00:00:00.000Z',
  };

  it('is one answer that moves every design at the revision read, recommended by the rule', () => {
    const { decision } = repinDecision(
      { touchedAt: '2026-10-08T00:00:00.000Z' } as AttentionRow,
      'designs',
      'p1',
      group,
    );
    const d = needsYouDecisionSchema.parse({ ...decision, stuck: false, dueAt: null });
    expect(d).toMatchObject({
      id: 'repin:wf-base',
      topic: 'design_update',
      key: 'system-context',
      recommended: { answerId: 'approve', by: 'rule' },
    });
    expect(d.answers).toEqual([
      expect.objectContaining({
        id: 'approve',
        act: 'design.repin',
        path: '/api/projects/p1/workflows/wf-base/design/repins',
        body: {
          revision: 17,
          designs: [
            { workflowId: 'wf-a', revision: 4 },
            { workflowId: 'wf-b', revision: 9 },
          ],
        },
      }),
    ]);
    expect(d.proposal).toMatchObject({
      verb: 'Follow r17',
      recommends: true,
      yields: [{ kind: 'design_update', n: 2 }],
    });
    expect(d.proposal?.table?.columns).toEqual(['Design', 'Follows now', 'After']);
  });
});

describe('a proposal fitted to the page', () => {
  it('cuts a note past its bound at a word rather than refusing the whole decision', () => {
    const note = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    const raw = triageProposal({ route: 'decline', note }, ITEM);
    expect(decisionProposalSchema.safeParse(raw).success).toBe(false);
    const fitted = decisionProposalSchema.parse(fitProposal(raw));
    expect(fitted.what.length).toBeLessThanOrEqual(600);
    expect(fitted.what.endsWith('…')).toBe(true);
    expect(note.startsWith(fitted.what.slice(0, -1))).toBe(true);
    expect(note.charAt(fitted.what.length - 1)).toBe(' ');
  });
});
