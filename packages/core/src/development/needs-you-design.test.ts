import { saidDisagreements, say, verbatim } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import { designRowOf as designRowOf_, repinRowOf } from './needs-you-design.js';

/** Every sentence the producer said agrees with the English beside it (`saidDisagreements`). */
const checked = <T>(v: T): T => {
  expect(saidDisagreements(v)).toEqual([]);
  return v;
};
const designRowOf = ((...a: Parameters<typeof designRowOf_>) =>
  checked(designRowOf_(...a))) as typeof designRowOf_;

const wait = (kind: 'you' | 'person') =>
  waitingOn(kind, {
    who:
      kind === 'you'
        ? say('standing.who.you')
        : say('standing.who.holderOf', { perm: 'workflow-designs.approve' }),
    act: say('designs.act.approveOrReturn', { r: 3 }),
    rule: verbatim('r'),
  });

const health = (over: Partial<WorkflowHealth>): WorkflowHealth =>
  ({
    flow: 'hop-staff-shell-ux',
    needsYou: 0,
    markers: [],
    proposal: null,
    ...over,
  }) as WorkflowHealth;

describe('the design row on Needs you', () => {
  it('is the workflow itself when a revision waits on the viewer to decide it', () => {
    const row = designRowOf(
      health({
        proposal: {
          revision: 3,
          title: 'Staff shell',
          proposedAt: '2026-10-06T08:00:00.000Z',
          waitingOn: wait('you'),
        },
      }),
    );
    expect(row).toMatchObject({
      entity: 'workflow',
      key: 'hop-staff-shell-ux',
      title: 'Staff shell · revision 3 proposed',
      touchedAt: '2026-10-06T08:00:00.000Z',
      standing: {
        attentionGroup: 'needs_you',
        waitingOn: { kind: 'you', act: 'approve or return revision 3' },
      },
    });
  });

  it('is no row for a revision waiting on someone else, with no marker owed', () => {
    expect(
      designRowOf(
        health({
          proposal: {
            revision: 3,
            title: 't',
            proposedAt: '2026-10-06T08:00:00.000Z',
            waitingOn: wait('person'),
          },
        }),
      ),
    ).toBeNull();
  });

  it('falls back to the markers a person owes, and is no row with none', () => {
    expect(designRowOf(health({ needsYou: 2 }))?.standing.waitingOn.act).toBe(
      'settle 2 health markers',
    );
    expect(designRowOf(health({}))).toBeNull();
  });
});

describe('the re-pin row on Needs you', () => {
  const group = {
    flow: 'access',
    revision: 13,
    ready: ['operational-case', 'complaint-intake', 'complaint-ux'].map((flow) => ({
      flow,
      source: 'approved' as const,
    })),
    approvedAt: '2026-10-08T08:00:00.000Z',
  };

  it('is one row for the base, counting its pin-only dependents, waiting on whoever may approve', () => {
    const row = checked(repinRowOf(group, true));
    expect(row).toMatchObject({
      entity: 'workflow',
      key: 'access',
      title: '3 designs only need their pin moved → r13',
      says: { title: { key: 'designs.title.repinBatch', vars: { n: 3, r: 13 } } },
      standing: {
        attentionGroup: 'needs_you',
        waitingOn: { kind: 'you', act: 'approve 3 pin-only changes → r13' },
      },
    });
    expect(checked(repinRowOf(group, false)).standing.waitingOn.kind).toBe('person');
  });

  it('agrees in number for a single design', () => {
    expect(checked(repinRowOf({ ...group, ready: group.ready.slice(0, 1) }, true)).title).toBe(
      '1 design only needs its pin moved → r13',
    );
  });
});
