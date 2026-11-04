import { saidDisagreements } from '@forge/contracts/said';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import { designRowOf, repinRowOf } from '../development/needs-you-design.js';
import { designWaitingOn } from './design-standing.js';

// A proposed design resting on a base not approved at the revision it names waits on its writer, and
// says why from the refusal's facts (revision, each base and its fault), never from its English detail.

describe('a proposed design on an unapproved base', () => {
  it('names each base by its fault, said by key so a reader reads it in their language', () => {
    const w = designWaitingOn({
      status: 'proposed',
      proposedRevision: 4,
      approvedRevision: 3,
      latest: { revision: 4, author: 'Lan' },
      canDecide: true,
      baseUnapproved: {
        revision: 4,
        bases: [
          {
            workflow: 'hop-auth',
            revision: 2,
            state: 'stale',
            approvedRevision: 3,
            designStatus: 'approved',
          },
          {
            workflow: 'hop-cart',
            revision: 1,
            state: 'unapproved',
            approvedRevision: null,
            designStatus: 'draft',
          },
          {
            workflow: 'hop-gone',
            revision: 1,
            state: 'missing',
            approvedRevision: null,
            designStatus: null,
          },
        ],
      },
    });
    expect(w.kind).toBe('agent');
    expect(w.says.rule).toMatchObject({ key: 'designs.rule.baseUnapprovedAt', vars: { r: 4 } });
    expect(w.rule).toBe(
      'r4 builds on hop-auth r2, which is approved at r3 now; hop-cart r1, which is not approved; hop-gone, which is no workflow of this project: its writer re-pins basedOn before approval',
    );
    expect(saidDisagreements(w)).toEqual([]);
  });
});

// FB-145: a base proposed at the revision pinned waits on the base's approver, not on the writer
describe('a proposed design on a base proposed at the revision it pins', () => {
  const input = (canDecide: boolean) => ({
    status: 'proposed' as const,
    proposedRevision: 1,
    approvedRevision: null,
    latest: { revision: 1, author: 'Lan' },
    canDecide,
    baseUnapproved: {
      revision: 1,
      bases: [
        {
          workflow: 'hop-auth',
          revision: 4,
          state: 'proposed' as const,
          approvedRevision: 3,
          designStatus: 'proposed' as const,
        },
      ],
    },
  });

  it('names approving the base as the act, yours where you may approve it', () => {
    const w = designWaitingOn(input(true));
    expect(w.kind).toBe('you');
    expect(w.says.act).toEqual({ key: 'designs.act.approveBase', vars: { bases: 'hop-auth r4' } });
    expect(w.rule).toBe(
      'r1 builds on hop-auth r4, which waits on its approver: the base is approved first',
    );
    expect(saidDisagreements(w)).toEqual([]);
  });

  it('waits on whoever holds approval where you may not', () => {
    const w = designWaitingOn(input(false));
    expect(w.kind).toBe('person');
    expect(w.says.act.key).toBe('designs.act.approveBase');
  });

  it('still asks the writer to re-pin where another base is stale', () => {
    const mixed = input(true);
    mixed.baseUnapproved.bases.push({
      workflow: 'hop-cart',
      revision: 1,
      state: 'stale' as never,
      approvedRevision: 2,
      designStatus: 'approved' as never,
    });
    const w = designWaitingOn(mixed);
    expect(w.kind).toBe('agent');
    expect(w.says.act.key).toBe('designs.act.repin');
  });
});

// ISS-687 round 4 (judge run d47d6de0 at dev.489, c2 short): Issue lifecycle's page read "Waits on:
// Nobody · nothing next" beside "Needs you 2" and "Approve 4 pin-only changes", while Needs you listed
// "Issue lifecycle · next: decide 2 places where the code and the design differ". An approved design's
// line says what it still owes a person, in the very words Needs you lists it by, and "Nobody" only
// where nothing is owed. Planted red by dropping `owed` from `designWaitingOn`: the line reads Nobody.
describe("an approved design's line agrees with what Needs you counts on it", () => {
  const approved = {
    status: 'approved' as const,
    proposedRevision: null,
    approvedRevision: 20,
    latest: { revision: 20, author: null },
    canDecide: true,
  };
  const health = {
    flow: 'issue-lifecycle',
    needsYou: 2,
    markers: [],
    proposal: null,
  } as unknown as WorkflowHealth;
  const group = {
    baseId: 'wf-issue-lifecycle',
    flow: 'issue-lifecycle',
    title: 'Issue lifecycle',
    revision: 20,
    ready: ['a', 'b', 'c', 'd'].map((flow, i) => ({
      workflowId: `wf-${flow}`,
      flow,
      source: 'approved' as const,
      revision: 1 + i,
      approves: 2 + i,
      pins: [{ workflow: 'issue-lifecycle', from: 19, to: 20 }],
    })),
    refused: 0,
    approvedAt: '2026-11-04T00:00:00.000Z',
  };

  it('names the places to decide, as the Needs you row on the design does', () => {
    const line = designWaitingOn({
      ...approved,
      owed: { flow: 'issue-lifecycle', repin: null, settle: 2 },
    });
    const row = designRowOf(health)?.standing.waitingOn;
    expect(line).toEqual(row);
    expect(`${line.who} · ${line.act}`).toBe(
      'A person · decide 2 places where the code and the design differ',
    );
    expect(saidDisagreements(line)).toEqual([]);
  });

  it('names the pin-only changes first, as the re-pin row on Needs you does', () => {
    const owed = {
      flow: 'issue-lifecycle',
      repin: { flow: 'issue-lifecycle', revision: 20, n: 4 },
      settle: 2,
    };
    const line = designWaitingOn({ ...approved, owed });
    expect(line).toEqual(repinRowOf(group, true).standing.waitingOn);
    expect(line.act).toBe('approve 4 pin-only changes → r20');
  });

  it('reads Nobody · nothing only where nothing is owed, and a step that owes somebody keeps its own wait', () => {
    const none = designWaitingOn({
      ...approved,
      owed: { flow: 'issue-lifecycle', repin: null, settle: 0 },
    });
    expect(none.kind).toBe('none');
    const proposed = designWaitingOn({
      ...approved,
      status: 'proposed',
      proposedRevision: 21,
      owed: { flow: 'issue-lifecycle', repin: null, settle: 2 },
    });
    expect(proposed.act).toBe('approve or return the design');
  });
});
