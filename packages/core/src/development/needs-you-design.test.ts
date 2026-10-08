import { saidDisagreements, say, verbatim } from '@forge/contracts/said';
import { waitingOn } from '@forge/contracts/standing';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import { designRowOf as designRowOf_ } from './needs-you-design.js';

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
      titleLang: null,
      says: {
        title: {
          key: 'needsYou.title.designProposed',
          vars: { title: verbatim('Staff shell'), revision: 3 },
        },
      },
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
