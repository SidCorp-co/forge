/**
 * ISS-1126 criterion 14, at the runtime criteria 5, 6 and 7 name: the `forge_issues` handler's own
 * `get`, `list` and `mark_merged` answers. Why the handler and not the projections it calls:
 * docs/modules/issues/merge-mark.md.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const ISSUE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '55555555-5555-4555-8555-555555555555';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const AT = new Date('2026-09-20T14:59:37.646Z');
const OBSERVED_SHA = '9a78b0c93f1a2b3c4d5e6f708192a3b4c5d6e7f8';

function issueRow(id: string, sha: string | null, at: Date | null = AT) {
  return {
    id,
    projectId: PROJECT_ID,
    issSeq: id === ISSUE_ID ? 7 : 8,
    title: 'a merge Forge did not observe',
    description: null,
    descriptionFormat: 'markdown',
    plan: null,
    acceptanceCriteria: null,
    sessionContext: null,
    releaseNotes: null,
    status: 'developed',
    waitingKind: null,
    priority: 'critical',
    category: 'bug',
    complexity: 'm',
    assigneeId: null,
    reopenCount: 0,
    mergedAt: at,
    mergedCommitSha: sha,
    createdAt: AT,
    updatedAt: AT,
  };
}

/** The row `findIssueById` answers with, which is what `get` and the mark's re-read both read. */
let stored = issueRow(ISSUE_ID, null);
/** The rows `list` pages over. */
let listRows: unknown[] = [];
/** The merged pull request `observedMergeForIssue` finds, or none. */
let projectionRows: unknown[] = [];
let stampedRows: unknown[] = [{ mergedAt: AT, mergedCommitSha: null }];
/** Every column set the mark's UPDATE carried, which is what the description claims about. */
const setPayloads: Record<string, unknown>[] = [];

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [stored],
          orderBy: () => ({ limit: async () => projectionRows }),
        }),
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        setPayloads.push(payload);
        return {
          where: () => ({
            returning: async () => stampedRows,
            then: (r: (v: unknown) => unknown) => Promise.resolve(undefined).then(r),
          }),
        };
      },
    }),
    insert: () => ({
      values: (row: { body: string }) => ({
        returning: async () => [{ id: 'comment-1', body: row.body, parentId: null }],
      }),
    }),
  },
}));

vi.mock('./lib.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  assertPrincipalIsMember: async () => undefined,
  assertPrincipalIsWriter: async () => undefined,
  resolveEffectiveProjectId: async () => PROJECT_ID,
}));
vi.mock('../../issues/read-service.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  findIssueById: async () => stored,
  findIssueProjectId: async () => PROJECT_ID,
}));
vi.mock('../../issues/list-service.js', () => ({ listIssueRows: async () => listRows }));
vi.mock('../../issues/issue-prefix-read.js', () => ({
  activeIssuePrefix: async () => 'ISS',
  heldIssuePrefixes: async () => ['ISS'],
}));
vi.mock('../../issues/attachment-service.js', () => ({ listIssueAttachments: async () => [] }));
vi.mock('../../issues/label-service.js', () => ({
  listIssueLabels: async () => [],
  resolveLabelIdsForWrite: async () => [],
}));
vi.mock('../../issues/dependency-read.js', () => ({
  loadIssueRelations: async () => ({ blocks: [], blockedBy: [] }),
}));
vi.mock('../../issues/attributes/read.js', () => ({ loadIssueAttributes: async () => [] }));
vi.mock('../../pipeline/work-evidence.js', () => ({
  findMissingWorkEvidence: async () => null,
  collectWorkEvidence: async () => ({ handoffCommitSha: null }),
}));
vi.mock('../../pipeline/hooks.js', () => ({ hooks: { emit: async () => undefined } }));

const { forgeIssuesTool } = await import('./forge-issues.js');
const { forgeIssuesDescription } = await import('./forge-issues-description.js');

const tool = forgeIssuesTool({
  principal: {
    userId: USER_ID,
    agency: 'human',
    tokenId: 'token-1',
    deviceId: null,
    projectIds: null,
  },
  projectSlug: 'forge-dev',
  boundProjectId: PROJECT_ID,
  // biome-ignore lint/suspicious/noExplicitAny: the factory's context, narrowed to what runs here
} as any);

const call = (args: Record<string, unknown>) =>
  tool.handler(args) as Promise<Record<string, unknown>>;

function asAsserted(sha: string | null = null) {
  stored = issueRow(ISSUE_ID, sha);
  projectionRows = [];
  stampedRows = [{ mergedAt: AT, mergedCommitSha: sha }];
}

function asObserved(sha = OBSERVED_SHA) {
  stored = issueRow(ISSUE_ID, sha);
  projectionRows = [{ sha, at: AT }];
  stampedRows = [{ mergedAt: AT, mergedCommitSha: sha }];
}

beforeEach(() => {
  asAsserted();
  listRows = [];
  setPayloads.length = 0;
});

describe('forge_issues action=get, the answer an agent reads one issue through', () => {
  it('answers a claim and a witnessed merge with different marks', async () => {
    asAsserted();
    const claimed = await call({ action: 'get', documentId: ISSUE_ID });
    asObserved();
    const witnessed = await call({ action: 'get', documentId: ISSUE_ID });

    expect(claimed.mergeMark).toBe('asserted');
    expect(witnessed.mergeMark).toBe('observed');
    expect(claimed.mergedAt).toEqual(witnessed.mergedAt);
  });

  it('carries the sha beside the word, so the word can be checked', async () => {
    asObserved();
    expect((await call({ action: 'get', documentId: ISSUE_ID })).mergedCommitSha).toBe(
      OBSERVED_SHA,
    );
  });

  it('answers an unmarked issue unmarked rather than asserted', async () => {
    stored = issueRow(ISSUE_ID, null, null);
    expect((await call({ action: 'get', documentId: ISSUE_ID })).mergeMark).toBe('unmarked');
  });

  it('keeps the mark when the caller narrows the answer to a heavy field', async () => {
    asAsserted();
    const claimed = await call({ action: 'get', documentId: ISSUE_ID, fields: ['plan'] });
    asObserved();
    const witnessed = await call({ action: 'get', documentId: ISSUE_ID, fields: ['plan'] });

    expect(claimed.mergeMark).toBe('asserted');
    expect(witnessed.mergeMark).toBe('observed');
  });

  it('reads a sha with no timestamp as unmarked, because the timestamp decides first', async () => {
    stored = issueRow(ISSUE_ID, OBSERVED_SHA, null);
    expect((await call({ action: 'get', documentId: ISSUE_ID })).mergeMark).toBe('unmarked');
  });

  it('calls a stamp of the empty string a claim, not a merge it witnessed', async () => {
    asAsserted('');
    expect((await call({ action: 'get', documentId: ISSUE_ID })).mergeMark).toBe('asserted');
  });
});

describe('forge_issues action=list, the answer an agent browses through', () => {
  it('gives each row its own mark rather than one reading for the page', async () => {
    listRows = [issueRow(ISSUE_ID, null), issueRow(OTHER_ID, OBSERVED_SHA)];
    const rows = (await call({ action: 'list' })).issues as Record<string, unknown>[];
    expect(rows.map((r) => r.mergeMark)).toEqual(['asserted', 'observed']);
  });

  it('marks every row it returns, leaving none for a reader to guess at', async () => {
    listRows = [issueRow(ISSUE_ID, null), issueRow(OTHER_ID, OBSERVED_SHA)];
    const rows = (await call({ action: 'list' })).issues as Record<string, unknown>[];
    for (const row of rows) expect(row.mergeMark).toBeTruthy();
  });

  it('reports an unmarked row as unmarked on the browse surface too', async () => {
    listRows = [issueRow(ISSUE_ID, null, null)];
    const rows = (await call({ action: 'list' })).issues as Record<string, unknown>[];
    expect(rows[0]?.mergeMark).toBe('unmarked');
  });
});

describe('forge_issues action=mark_merged, the answer to the call that writes one', () => {
  it('answers a claim and a witnessed merge with different marks', async () => {
    asAsserted();
    const claimed = await call({
      action: 'mark_merged',
      data: { issueId: ISSUE_ID, target: 'base', commit: 'abc1234' },
    });
    asObserved();
    const witnessed = await call({
      action: 'mark_merged',
      data: { issueId: ISSUE_ID, target: 'base' },
    });

    expect(claimed.mark).toBe('asserted');
    expect(witnessed.mark).toBe('observed');
    expect(claimed.detail).not.toBe(witnessed.detail);
    expect(claimed.action).toBe(witnessed.action);
  });

  it('tells a caller whose merge was not witnessed that what it wrote is a claim', async () => {
    const claimed = await call({
      action: 'mark_merged',
      data: { issueId: ISSUE_ID, target: 'base', commit: 'abc1234' },
    });
    expect(claimed.detail).toContain('CLAIM Forge did not observe');
    expect(claimed.detail).toContain('NOT in `merged_commit_sha`');
  });

  it('answers unmark with unmarked rather than the kind it cleared', async () => {
    asObserved();
    stored = issueRow(ISSUE_ID, null, null);
    const cleared = await call({ action: 'unmark', data: { issueId: ISSUE_ID } });
    expect(cleared.mark).toBe('unmarked');
  });
});

describe('what the tool description tells an agent about the column', () => {
  const text = forgeIssuesDescription('<ref clause>');

  it('does not promise the sha on every mark, and does not promise a dispatch either', () => {
    expect(text).not.toContain('stamps merged_at and merged_commit_sha together');
    expect(text).not.toContain('unblocks dependents');
  });

  it('states the condition it is true under rather than a blanket never', () => {
    expect(text).toContain('It writes merged_commit_sha ONLY where Forge already');
    expect(text).not.toContain('It does not write merged_commit_sha');
  });

  it('is true of the witnessed path: the mark writes the sha there', async () => {
    asObserved();
    await call({ action: 'mark_merged', data: { issueId: ISSUE_ID, target: 'base' } });
    expect(setPayloads.some((p) => p.mergedCommitSha === OBSERVED_SHA)).toBe(true);
  });

  it("is true of the claimed path: the mark writes no sha, and not the caller's", async () => {
    asAsserted();
    await call({
      action: 'mark_merged',
      data: { issueId: ISSUE_ID, target: 'base', commit: 'abc1234' },
    });
    for (const p of setPayloads) expect(p).not.toHaveProperty('mergedCommitSha');
  });
});
