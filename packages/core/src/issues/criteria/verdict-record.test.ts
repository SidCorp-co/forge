import { describe, expect, it } from 'vitest';
import { verdictRecordFields } from './verdict-record.js';

describe('the record core writes for one stored verdict', () => {
  it('names the row, the criterion, the verdict and the identity the row holds, in that order', () => {
    const fields = verdictRecordFields({
      id: 'v-1',
      draft: {
        criterion: 2,
        verdict: 'pass',
        reason: '  judged at the merge  ',
        identity: { kind: 'commit', sha: 'A'.repeat(40) },
        evidence: ['judge-log.txt', 'screen.png'],
      },
      identity: { identityKind: 'commit', commitSha: 'a'.repeat(40) },
    });
    expect(fields).toEqual([
      { key: 'verdict-id', value: 'v-1' },
      { key: 'criterion', value: '2' },
      { key: 'verdict', value: 'pass' },
      { key: 'identity', value: 'commit' },
      { key: 'commit', value: 'a'.repeat(40) },
      { key: 'why', value: 'judged at the merge' },
      { key: 'evidence', value: 'judge-log.txt' },
      { key: 'evidence', value: 'screen.png' },
    ]);
  });

  it('carries a design identity as the workflow row and revision it resolved to', () => {
    const fields = verdictRecordFields({
      id: 'v-2',
      draft: {
        criterion: 1,
        verdict: 'pass',
        reason: null,
        identity: { kind: 'design', workflow: 'issue-lifecycle', revision: 2 },
        evidence: [],
      },
      identity: { identityKind: 'design', designWorkflowId: 'wf-1', designRevision: 2 },
    });
    expect(fields.slice(3)).toEqual([
      { key: 'identity', value: 'design' },
      { key: 'design-workflow', value: 'wf-1' },
      { key: 'design-revision', value: '2' },
    ]);
  });

  it('names no identity for a skipped verdict, and carries its reason', () => {
    const fields = verdictRecordFields({
      id: 'v-3',
      draft: {
        criterion: 1,
        verdict: 'skipped',
        reason: 'no runtime yet',
        identity: null,
        evidence: [],
      },
      identity: {},
    });
    expect(fields).toEqual([
      { key: 'verdict-id', value: 'v-3' },
      { key: 'criterion', value: '1' },
      { key: 'verdict', value: 'skipped' },
      { key: 'why', value: 'no runtime yet' },
    ]);
  });
});
