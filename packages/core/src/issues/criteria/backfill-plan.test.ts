import { describe, expect, it } from 'vitest';
import { parseForgeRecord } from '../../messaging/forge-record.js';
import { type BackfillRecord, planIssueBackfill } from './backfill-plan.js';

const WHOLE = '1810f843c4abd30d4d0bedc908cdb29d1db1f1a5';
const OTHER = '3641ba21fec5096e2d1a91a40f2d9e50e9239068';

function record(source: string, blocks: string[][]): BackfillRecord {
  const body = [
    '```forge-record',
    ...blocks.flat(),
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');
  const parsed = parseForgeRecord(body);
  if (!parsed) throw new Error('fixture fence did not parse');
  return {
    source,
    commentId: source,
    record: parsed,
    author: { userId: 'u1', deviceId: null, agency: 'agent' },
    createdAt: new Date('2026-10-01T00:00:00Z'),
  };
}

const issue = (status: string, knownShas: string[] = []) => ({
  id: 'iss-1',
  status,
  acceptanceCriteria: '1. one\n2. two\n3. three',
  knownShas,
});

describe('planIssueBackfill (ISS-55: the one-time read into the tables)', () => {
  it('writes each numbered criterion and each representable verdict', () => {
    const plan = planIssueBackfill(
      issue('in_progress'),
      [record('c1', [['criterion: 1', 'verdict: pass', `commit: ${WHOLE}`]])],
      new Map(),
    );
    expect(plan.criteria.map((c) => c.n)).toEqual([1, 2, 3]);
    expect(plan.verdicts).toMatchObject([
      { n: 1, verdict: 'pass', identityKind: 'commit', commitSha: WHOLE },
    ]);
    expect(plan.refusals).toEqual([]);
  });

  it('resolves an abbreviation to the one whole sha the issue names that extends it', () => {
    const plan = planIssueBackfill(
      issue('in_progress', [WHOLE, OTHER]),
      [record('c1', [['criterion: 2', 'verdict: pass', 'commit: 1810f843']])],
      new Map(),
    );
    expect(plan.verdicts[0]).toMatchObject({ identityKind: 'commit', commitSha: WHOLE });
  });

  it('marks an unresolvable abbreviation commit_unresolved on a closed issue only', () => {
    const blocks = [['criterion: 1', 'verdict: pass', 'commit: abcdef12']];
    const closed = planIssueBackfill(issue('closed', [WHOLE]), [record('c1', blocks)], new Map());
    expect(closed.verdicts[0]).toMatchObject({
      identityKind: 'commit_unresolved',
      commitSha: 'abcdef12',
    });
    const live = planIssueBackfill(
      issue('in_progress', [WHOLE]),
      [record('c1', blocks)],
      new Map(),
    );
    expect(live.verdicts).toEqual([]);
    expect(live.refusals).toEqual([
      'issue iss-1 record c1 criterion 1: commit `abcdef12` is abbreviated, no whole sha the issue names extends it, and the issue is `in_progress`, not closed',
    ]);
  });

  it('refuses by name a verdict on a criterion the issue does not carry, and a skip with no why', () => {
    const plan = planIssueBackfill(
      issue('closed'),
      [
        record('c9', [
          ['criterion: 7', 'verdict: pass', `commit: ${WHOLE}`],
          ['criterion: 3', 'verdict: skipped'],
        ]),
      ],
      new Map(),
    );
    expect(plan.verdicts).toEqual([]);
    expect(plan.refusals[0]).toBe(
      'issue iss-1 record c9 criterion 7: the issue carries no numbered criterion 7',
    );
    expect(plan.refusals[1]).toContain(
      'issue iss-1 record c9 criterion 3: VERDICT_SKIP_REASON_REQUIRED',
    );
  });

  it('resolves a design to the project workflow and refuses a revision the project does not hold', () => {
    const designs = new Map([['discharge-post-care', { id: 'wf-1', revisions: [4, 3] }]]);
    const ok = planIssueBackfill(
      issue('in_progress'),
      [record('c1', [['criterion: 1', 'verdict: pass', 'design: discharge-post-care rev 4']])],
      designs,
    );
    expect(ok.verdicts[0]).toMatchObject({
      identityKind: 'design',
      designWorkflowId: 'wf-1',
      designRevision: 4,
    });
    const gone = planIssueBackfill(
      issue('in_progress'),
      [record('c1', [['criterion: 1', 'verdict: pass', 'design: discharge-post-care rev 9']])],
      designs,
    );
    expect(gone.refusals[0]).toContain(
      'design `discharge-post-care` rev 9 is not a workflow revision',
    );
  });

  it('refuses unnumbered criteria text by name rather than writing nothing in silence', () => {
    const plan = planIssueBackfill(
      { ...issue('closed'), acceptanceCriteria: '- a\n- b' },
      [],
      new Map(),
    );
    expect(plan.criteria).toEqual([]);
    expect(plan.refusals).toEqual([
      'issue iss-1: acceptance_criteria holds text and no numbered line, so no criterion was written',
    ]);
  });
});
