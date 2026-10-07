import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import { designRowOf } from './needs-you-design.js';

const wait = (kind: 'you' | 'person') => ({
  kind,
  who: kind === 'you' ? 'You' : 'A holder of workflow-designs.approve',
  act: 'approve or return revision 3',
  rule: 'r',
  ref: null,
  dueAt: null,
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
