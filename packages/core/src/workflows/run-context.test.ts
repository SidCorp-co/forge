import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { artifactContext, type TracedDesignRow } from './run-context.js';

const document: unknown = JSON.parse(
  readFileSync(
    new URL('../../tests/fixtures/workflows/post-discharge.design.json', import.meta.url),
    'utf8',
  ),
);

const approvedAt3 = (reason: string | null): TracedDesignRow => ({
  workflowId: '9b1f2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d',
  flow: 'post-discharge',
  designStatus: 'approved',
  workflowRevision: 3,
  approvedRevision: 3,
  revisionRow: { document, decision: 'approve', reason },
});

describe('the approved design a build job is given carries its approval note', () => {
  it('quotes the note, every line of it, in the design heading', () => {
    const [given] = artifactContext([
      approvedAt3('The SLA step is still owed in rev 4.\nThe manual triage deviation is accepted.'),
    ]);
    expect(given?.text).toContain(
      'Its approver approved revision 3 with this note, the conditions the approval was given under:\n> The SLA step is still owed in rev 4.\n> The manual triage deviation is accepted.',
    );
  });

  it('says nothing of a note when the approval carried none, or only whitespace', () => {
    for (const reason of [null, '   ']) {
      const [given] = artifactContext([approvedAt3(reason)]);
      expect(given?.text).toContain('`post-discharge` at approved revision 3');
      expect(given?.text).not.toContain('with this note');
    }
  });
});
