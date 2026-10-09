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
