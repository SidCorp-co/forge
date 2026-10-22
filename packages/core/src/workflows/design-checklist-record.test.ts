// The workflow approval checklist as a design's record answers it (REQ-34 r2 BC-1, BC-7;
// Requirement lifecycle r15 design_check): criteria per step, roles, exception paths for a flow, and
// the change from the last approved revision computed, never typed.

import { WORKFLOW_APPROVAL_CHECKLIST } from '@forge/contracts/checklist-registry';
import { checklistRefusals, evaluateChecklist } from '@forge/contracts/checklists';
import { describe, expect, it } from 'vitest';
import { approvalAnswersOf, type DesignFacts } from './design-checklist-record.js';
import { readStoredWorkflow, WORKFLOW_V2_SCHEMA_ID } from './schema.js';

const doc = (
  template: string,
  steps: { id: string; title?: string; node?: object }[],
  edges: object[] = [],
) => ({
  $schema: WORKFLOW_V2_SCHEMA_ID,
  version: 2,
  project: '3f1c5a52-6a39-4b2d-9d0e-0a1b2c3d4e5f',
  template: { id: template, version: 1 },
  flow: 'intake',
  kind: 'flow',
  title: 'Intake',
  summary: 's',
  steps: steps.map((s) => ({ does: 'd', after: [], ...s })),
  ...(edges.length ? { edges } : {}),
  writtenBy: {},
});

const facts = (raw: ReturnType<typeof doc>, over: Partial<DesignFacts> = {}): DesignFacts => ({
  flow: 'intake',
  proposed: { revision: 2, document: readStoredWorkflow(raw), raw },
  approved: null,
  linkedBy: ['REQ-3'],
  traced: ['REQ-3 BC-1'],
  awaitingAccept: [],
  ...over,
});

const judge = (f: DesignFacts) =>
  evaluateChecklist(WORKFLOW_APPROVAL_CHECKLIST, { given: {}, record: approvalAnswersOf(f) });

const drawn = doc('state-machine', [
  { id: 'a', title: 'Draft', node: { type: 'STATE', owner: 'The author' } },
  {
    id: 'b',
    title: 'Check',
    node: { type: 'CHOICE', conditions: [{ when: 'a gap', result: 'refused, naming it' }] },
  },
]);

describe('the workflow approval checklist, read from the design', () => {
  it('is complete for a traced flow that names owners and draws a refusal', () => {
    expect(readStoredWorkflow(drawn)).not.toBeNull();
    const e = judge(facts(drawn));
    expect(e.complete).toBe(true);
    expect(e.answers.find((a) => a.question === 'changes')?.value).toBe(
      'Its first revision: nothing was approved before.',
    );
  });

  it('names each gap: untraced criteria, no owner, no exception path', () => {
    const bare = doc('state-machine', [{ id: 'a', title: 'Draft', node: { type: 'STATE' } }]);
    const refusals = checklistRefusals(judge(facts(bare, { traced: [] })));
    expect(refusals.map((r) => r.question)).toEqual(['criteria', 'roles', 'exceptions']);
    expect(refusals[0]?.detail).toContain('REQ-3 links it, and none of their business criteria');
  });

  it('names a linking requirement with traces but no accepted revision, never calling it untraced', () => {
    const e = judge(
      facts(drawn, {
        linkedBy: ['REQ-46'],
        traced: [],
        awaitingAccept: [{ requirement: 'REQ-46', traced: 7 }],
      }),
    );
    const [gap] = checklistRefusals(e);
    expect(gap?.question).toBe('criteria');
    expect(gap?.detail).toContain(
      'REQ-46 has 7 business criteria traced to its steps, but no accepted revision, so none counts yet.',
    );
    expect(gap?.detail).toContain('Accept a revision of REQ-46');
    expect(gap?.detail, 'the old wording sends a reader to trace again').not.toContain(
      'none of their business criteria is traced',
    );
  });

  it('asks no exception path of a structure, and no trace of a design no requirement links', () => {
    const structure = doc('system-context', [
      { id: 'a', title: 'Core', node: { type: 'CONTAINER', band: 'core' } },
    ]);
    const e = judge(facts(structure, { linkedBy: [], traced: [] }));
    expect(e.complete).toBe(true);
    expect(e.notAsked).toEqual(['exceptions']);
  });

  it('computes the change from the last approved revision', () => {
    const before = doc('state-machine', [
      { id: 'a', title: 'Draft', node: { type: 'STATE', owner: 'The author' } },
    ]);
    const e = judge(facts(drawn, { approved: { revision: 1, raw: before } }));
    expect(e.answers.find((a) => a.question === 'changes')?.value).toBe(
      'Against revision 1: steps added Check; changed none; removed none. Edges: 0 added, 0 changed, 0 removed.',
    );
  });
});

// Dev, 2026-10-22: the Needs-you decision "Move 4 designs built on requirement-to-delivery to follow
// r18" answered approve and was refused CHECKLIST_INCOMPLETE, "REQ-18 links it, and none of their
// business criteria is traced to a step" (REQ-41 BC-23). A pin-only revision changes no step, so the
// questions about its steps are answered by the revision it carries them from, said so by name.
describe('a pin-only revision is judged by what it changes (REQ-41 BC-23)', () => {
  const based = (revision: number) => ({
    ...doc('state-machine', [{ id: 'a', title: 'Draft', node: { type: 'STATE' } }]),
    basedOn: [{ workflow: 'requirement-to-delivery', revision }],
  });

  it('carries the step questions from the approved revision, naming it and the pin that moved', () => {
    const e = judge(
      facts(based(18), { linkedBy: ['REQ-18'], traced: [], approved: { revision: 4, raw: based(17) } }),
    );
    expect(checklistRefusals(e)).toEqual([]);
    expect(e.answers.find((a) => a.question === 'criteria')?.value).toBe(
      'Unchanged from revision 4, which was approved: this revision changes only which revision it follows (requirement-to-delivery r17 → r18).',
    );
  });

  it('still asks every question of a revision that moves a pin and changes a step', () => {
    const changed = { ...based(18), steps: [...based(18).steps, { id: 'b', title: 'Check', does: 'd', after: [] }] };
    const e = judge(
      facts(changed, { linkedBy: ['REQ-18'], traced: [], approved: { revision: 4, raw: based(17) } }),
    );
    expect(checklistRefusals(e).map((r) => r.question)).toEqual(['criteria', 'roles', 'exceptions']);
  });

  it('asks every question of a first revision, which carries nothing', () => {
    const e = judge(facts(based(18), { linkedBy: ['REQ-18'], traced: [] }));
    expect(checklistRefusals(e).map((r) => r.question)).toContain('criteria');
  });
});
