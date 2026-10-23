// Only a design no revision of which was approved is withdrawn: an approved revision is history, a
// design a live one builds on is held by it, and a withdrawn one is not withdrawn twice. Each refusal
// carries the facts its detail names.

import { WORKFLOW_DESIGN_MACHINE } from '@forge/contracts/design-status';
import { edgeBetween } from '@forge/contracts/state-machine';
import { describe, expect, it } from 'vitest';
import { designNotApprovedDetail, proposeRefusal, withdrawRefusal } from './design.js';
import { designWaitingOn } from './design-standing.js';

const rule = (over: Partial<Parameters<typeof withdrawRefusal>[0]> = {}) =>
  withdrawRefusal({
    flow: 'qa-throwaway',
    status: 'proposed',
    approvedRevision: null,
    pinnedBy: [],
    ...over,
  });

describe('which designs may be withdrawn', () => {
  it.each(['draft', 'proposed', 'returned'] as const)('a %s design never approved is', (status) => {
    expect(rule({ status })).toBeNull();
    expect(edgeBetween(WORKFLOW_DESIGN_MACHINE, status, 'withdrawn')).toMatchObject({
      act: 'workflow_design.withdrawn',
      permission: 'workflow-designs.write',
    });
  });

  it('an approved design is history, named with its approved revision', () => {
    const refusal = rule({ status: 'approved', approvedRevision: 3 });
    expect(refusal).toMatchObject({ code: 'DESIGN_WITHDRAW_APPROVED', approvedRevision: 3 });
    expect(refusal?.detail).toContain('revision 3 was approved');
    expect(edgeBetween(WORKFLOW_DESIGN_MACHINE, 'approved', 'withdrawn')).toBeNull();
  });

  it('a design proposed again after an approval is history too', () => {
    expect(rule({ status: 'proposed', approvedRevision: 2 })?.code).toBe(
      'DESIGN_WITHDRAW_APPROVED',
    );
  });

  it('a base a live design pins is held, naming each design that pins it', () => {
    const refusal = rule({ pinnedBy: ['intake', 'consent'] });
    expect(refusal).toMatchObject({
      code: 'DESIGN_WITHDRAW_PINNED',
      pinnedBy: ['intake', 'consent'],
    });
    expect(refusal?.detail).toContain('"intake", "consent"');
  });

  it('a withdrawn design is not withdrawn twice, whatever else holds', () => {
    expect(rule({ status: 'withdrawn', pinnedBy: ['intake'] })?.code).toBe(
      'DESIGN_ALREADY_WITHDRAWN',
    );
    expect(WORKFLOW_DESIGN_MACHINE.terminal).toContain('withdrawn');
    expect(WORKFLOW_DESIGN_MACHINE.edges.filter((e) => e.from === 'withdrawn')).toEqual([]);
  });

  it('a workflow outside the design lifecycle has no design to withdraw', () => {
    expect(rule({ status: null })?.code).toBe('WORKFLOW_DESIGN_NOT_PROPOSED');
  });
});

describe('a withdrawn design', () => {
  it('is not proposed again', () => {
    expect(proposeRefusal('withdrawn', 'qa-throwaway')?.code).toBe('WORKFLOW_DESIGN_WITHDRAWN');
  });

  it('waits on nobody', () => {
    const waiting = designWaitingOn({
      status: 'withdrawn',
      proposedRevision: null,
      approvedRevision: null,
      latest: { revision: 1, author: null },
      canDecide: true,
    });
    expect(waiting.kind).toBe('none');
  });

  it('tells an issue that builds it that it will never start, not to propose it', () => {
    const detail = designNotApprovedDetail({
      issue: 'ISS-1',
      workflowId: 'w',
      flow: 'qa-throwaway',
      status: 'withdrawn',
    });
    expect(detail).toContain('withdrawn and will never be approved');
    expect(detail).not.toContain('/design/propose');
  });
});
