/**
 * HOP ISS-1: an issue outside git has no commit and no runtime to name, and its work is a workflow
 * design. Its criteria are earned on the design revision they were judged at.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServingReading } from '../release-batch/serving-reading.js';

const listIssueCommentsMock = vi.fn(async (_issueId: string) => [] as Array<{ body: string }>);
// The record store reads each mocked comment body as the record it carries (ISS-56).
vi.mock('./record-events/history.js', async () => {
  const { parseForgeRecord } = await import('../messaging/forge-record.js');
  return {
    recordHistory: async (issueId: string) =>
      (await listIssueCommentsMock(issueId)).flatMap((row, at) => {
        const record = parseForgeRecord(row.body);
        return record?.kind === 'verdict' ? [{ id: String(at), record }] : [];
      }),
  };
});

const HOP = 'd180bdca-a927-4b11-b370-fa2ec923dba4';
const issueRows = [{ id: 'hop-1', projectId: HOP, acceptanceCriteria: '1. drawn\n2. typed' }];
const workflowRows = [{ id: 'wf-1', flow: 'discharge-post-care', projectId: HOP, revision: 4 }];

/** The workflow read selects `flow`, the issue read `id`, the two attachment reads `name`. */
const selectMock = vi.fn((arg: unknown) => {
  const columns = (arg ?? {}) as Record<string, unknown>;
  const rows = async () =>
    'flow' in columns ? workflowRows : 'id' in columns ? issueRows : [{ name: 'readback.json' }];
  const where = vi.fn(rows);
  return { from: vi.fn(() => ({ where, innerJoin: vi.fn(() => ({ where })) })) };
});
vi.mock('../db/client.js', () => ({ db: { select: (arg: unknown) => selectMock(arg) } }));

const { unearnedCriteriaReports, verdictPairsIn } = await import('./criteria-verdicts.js');

/** A design has nothing to serve: the reading is the one a project with no probe gives. */
const NOTHING_SERVED: ServingReading = {
  kind: 'undeclared',
  missing: 'no probe is declared',
  route: 'none',
};

const comment = (blocks: Array<[number, string]>) =>
  [
    '```forge-record',
    ...blocks.flatMap(([criterion, design]) => [
      `criterion: ${criterion}`,
      'verdict: pass',
      `design: ${design}`,
      'evidence: readback.json',
    ]),
    '```',
    '',
    '`forge-record: verdict · contract 1`',
  ].join('\n');

beforeEach(() => {
  listIssueCommentsMock.mockReset();
  listIssueCommentsMock.mockResolvedValue([]);
});

describe('a design verdict on the criteria report', () => {
  it('is read as a design identity where no runtime and no commit is named', () => {
    expect(verdictPairsIn(comment([[1, 'discharge-post-care rev 4']]))).toEqual([
      {
        criterion: 1,
        verdict: 'pass',
        at: { kind: 'design', value: 'discharge-post-care rev 4' },
        cited: ['readback.json'],
      },
    ]);
  });

  it('earns at the current revision, and names a superseded one with the revision now', async () => {
    listIssueCommentsMock.mockResolvedValueOnce([
      {
        body: comment([
          [1, 'discharge-post-care rev 4'],
          [2, 'discharge-post-care rev 3'],
        ]),
      },
    ]);
    const [report] = await unearnedCriteriaReports(['hop-1'], NOTHING_SERVED);
    expect(report?.unearned).toEqual([
      {
        criterion: 2,
        verdict: 'pass',
        standing: 'superseded',
        why: 'judged against design discharge-post-care rev 3, and that workflow is now at revision 4',
      },
    ]);
    expect(report?.uncorroborated).toEqual([]);
  });
});
