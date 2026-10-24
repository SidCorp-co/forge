import { saidDisagreements } from '@forge/contracts/said';
import { describe, expect, it } from 'vitest';
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
