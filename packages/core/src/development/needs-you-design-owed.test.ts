/**
 * The places a design's code and its design differ are reconciled by the master (ISS-1068): reconciling
 * code to an approved design is delivery, and changing the design is a person's only where the
 * project's designs gate asks one (`whoOwes('design.decide')`). On a project with that gate off, the
 * marker row names the master and leaves a person's Needs you, and the design's own page says the same.
 *
 * @direct-test-of packages/core/src/development/needs-you-design.ts
 * @direct-test-of packages/contracts/src/design-owed.ts
 */

import { owedWait } from '@forge/contracts/design-owed';
import { saidDisagreements } from '@forge/contracts/said';
import { needsViewer } from '@forge/contracts/standing';
import type { WorkflowHealth } from '@forge/contracts/workflow-health';
import { describe, expect, it } from 'vitest';
import { designRowOf } from './needs-you-design.js';

const health = (over: Partial<WorkflowHealth>): WorkflowHealth =>
  ({
    flow: 'issue-lifecycle',
    title: 'Issue lifecycle',
    needsYou: 12,
    markers: [],
    proposal: null,
    ...over,
  }) as WorkflowHealth;

describe('design-drift markers on a project whose designs gate is off', () => {
  it('name the master and leave the person’s Needs you', () => {
    const row = designRowOf(health({}), 'master');
    expect(saidDisagreements(row)).toEqual([]);
    expect(row?.standing.waitingOn.who).toBe('Master');
    expect(row?.standing.waitingOn.who).not.toBe('A person');
    expect(row?.standing.attentionGroup).not.toBe('needs_you');
    expect(row && needsViewer(row.standing)).toBe(false);
  });

  it('read the same on the design page', () => {
    const w = owedWait(
      { flow: 'issue-lifecycle', repin: null, settle: 12, settleBy: 'master' },
      true,
    );
    expect(w?.who).toBe('Master');
  });
});

describe('design-drift markers where the designs gate asks a person', () => {
  it('stay a person’s', () => {
    const row = designRowOf(health({}), 'person');
    expect(row?.standing.attentionGroup).toBe('needs_you');
    expect(row?.standing.waitingOn.who).toBe('A person');
  });
});
