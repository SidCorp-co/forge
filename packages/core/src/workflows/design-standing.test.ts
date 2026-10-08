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
      'revision 4 builds on hop-auth r2, which is approved at r3 now; hop-cart r1, which is not approved; hop-gone, which is no workflow of this project; its approver cannot approve it until its writer writes it again with basedOn re-pinned',
    );
    expect(saidDisagreements(w)).toEqual([]);
  });
});
