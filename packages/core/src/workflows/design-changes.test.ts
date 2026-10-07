import { uxFlow } from '@forge/contracts/workflow-template-behaviour';
import { describe, expect, it } from 'vitest';
import { revisionChangesOf } from './design-changes.js';
import { WORKFLOW_V2_SCHEMA_ID } from './schema.js';

const doc = (steps: { id: string; title?: string; does?: string; node?: object }[]) => ({
  $schema: WORKFLOW_V2_SCHEMA_ID,
  version: 2,
  project: '3f1c5a52-6a39-4b2d-9d0e-0a1b2c3d4e5f',
  template: { id: 'flow', version: 1 },
  flow: 'f',
  kind: 'flow',
  title: 'F',
  summary: 's',
  steps: steps.map((s) => ({ does: 'd', after: [], ...s })),
  writtenBy: {},
});

describe('revision changes', () => {
  it('names what a revision adds, removes and rewords, by step title', () => {
    const r1 = doc([
      { id: 'a', title: 'Sign in' },
      { id: 'b', title: 'Pick a shift' },
      { id: 'c', title: 'Old step' },
    ]);
    const r2 = doc([
      { id: 'a', title: 'Sign in', does: 'changed' },
      { id: 'b', title: 'Pick a shift' },
      { id: 'd' },
    ]);
    expect(revisionChangesOf(r1, r2)).toEqual({
      steps: { added: ['d'], removed: ['Old step'], changed: ['Sign in'] },
      edges: { added: 0, removed: 0, changed: 0 },
    });
  });

  it('names a step by the label its card shows, and an entry or exit by start and end, never by its id', () => {
    const r1 = doc([{ id: 'a', title: 'Sign in' }]);
    const r2 = doc([
      { id: 'a', title: 'Sign in' },
      { id: 's-signin-loading', title: 'Loading', node: { type: 'UI_STATE', label: 'Signing in' } },
      { id: 'n1', node: { type: 'ENTRY' } },
      { id: 'n2', node: { type: 'EXIT' } },
    ]);
    expect(revisionChangesOf(r1, r2)?.steps.added).toEqual(['Signing in', 'Start', 'End']);
  });

  it('is null on the first revision, and where a document no longer reads as a design', () => {
    expect(revisionChangesOf(undefined, doc([{ id: 'a' }]))).toBeNull();
    expect(revisionChangesOf({ junk: true }, doc([{ id: 'a' }]))).toBeNull();
  });

  it('is empty for an unchanged design', () => {
    const d = doc([{ id: 'a' }]);
    expect(revisionChangesOf(d, d)?.steps).toEqual({ added: [], removed: [], changed: [] });
  });
});

describe('the UI/UX template names where a flow starts and ends', () => {
  it('calls an entry node Start and an exit node End on the canvas chip', () => {
    const label = (id: string) => uxFlow.nodeTypes.find((t) => t.id === id)?.label;
    expect([label('ENTRY'), label('EXIT')]).toEqual(['Start', 'End']);
  });
});
