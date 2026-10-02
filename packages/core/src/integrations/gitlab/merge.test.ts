/**
 * ISS-50 — what merging a GitLab merge request sends, what it refuses, and on what evidence. Every
 * refusal case asserts that NO merge was sent: a refusal that still merged would be the worst lie
 * this path could tell.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const { buildGitLabClient } = await import('./client.js');
const { mergeGitLabMergeRequest } = await import('./merge.js');
const { gitlabStub } = await import('./gitlab-stub.fixture.js');

const P = '/projects/autoflow%2Fcore/merge_requests/12';
const HEAD = 'c0ffee1234567890c0ffee1234567890c0ffee12';
const LANDED = 'e45b4ecf596c58e10135c25af4f7279a0a804802';
const MERGED_AT = '2026-10-02T06:30:01.449Z';
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const openMr = (over: Record<string, unknown> = {}) => ({
  iid: 12,
  state: 'opened',
  draft: false,
  sha: HEAD,
  detailed_merge_status: 'mergeable',
  head_pipeline: { id: 3, status: 'success', sha: HEAD },
  ...over,
});

function merge(
  over: {
    mr?: Record<string, unknown>;
    approvals?: unknown;
    approvalsStatus?: number;
    mergeAnswer?: { status?: number; body?: unknown };
  } = {},
  args: { expectedHeadSha?: string; method?: string } = {},
) {
  const stub = gitlabStub({
    [`GET ${P}`]: { body: openMr(over.mr) },
    [`GET ${P}/approvals`]: {
      status: over.approvalsStatus ?? 200,
      body: over.approvals ?? { approved: true, approvals_required: 1, approvals_left: 0 },
    },
    [`PUT ${P}/merge`]: over.mergeAnswer ?? {
      body: { iid: 12, state: 'merged', sha: HEAD, merge_commit_sha: LANDED, merged_at: MERGED_AT },
    },
  });
  globalThis.fetch = stub.fetchStub;
  const client = buildGitLabClient({
    bindingId: 'bind-gl',
    config: { projectPath: 'autoflow/core' },
    secrets: { token: 'glpat-recorded-token-0001' },
  });
  return {
    result: mergeGitLabMergeRequest(client, { number: 12, ...args }),
    puts: () => stub.sent.filter((s) => s.method === 'PUT'),
  };
}

describe('merging a mergeable, approved merge request', () => {
  it('sends one PUT, conditional on the judged head, and records GitLab’s landing commit and time', async () => {
    const m = merge({}, { expectedHeadSha: HEAD.slice(0, 12), method: 'squash' });
    expect(await m.result).toEqual({
      kind: 'merged',
      commitSha: LANDED,
      mergedAt: new Date(MERGED_AT),
    });
    expect(m.puts()).toHaveLength(1);
    expect(m.puts()[0]?.body).toEqual({
      sha: HEAD,
      squash: true,
      should_remove_source_branch: false,
    });
  });

  it('takes the fast-forwarded head as the landing where GitLab made no merge commit', async () => {
    const m = merge({
      mergeAnswer: {
        body: { state: 'merged', sha: HEAD, merge_commit_sha: null, merged_at: MERGED_AT },
      },
    });
    expect(await m.result).toMatchObject({ kind: 'merged', commitSha: HEAD });
  });

  it('reads an already-merged request back as evidence and sends nothing', async () => {
    const m = merge({ mr: { state: 'merged', merge_commit_sha: LANDED, merged_at: MERGED_AT } });
    expect(await m.result).toEqual({
      kind: 'already-merged',
      commitSha: LANDED,
      mergedAt: new Date(MERGED_AT),
    });
    expect(m.puts()).toHaveLength(0);
  });
});

describe('what is refused, by name, before anything is merged', () => {
  const cases: Array<[string, Parameters<typeof merge>[0], Parameters<typeof merge>[1], string]> = [
    [
      'a request still owed an approval',
      { approvals: { approved: false, approvals_required: 1, approvals_left: 1 } },
      {},
      'not-approved',
    ],
    [
      'a request GitLab itself calls not approved',
      { mr: { detailed_merge_status: 'not_approved' } },
      {},
      'not-approved',
    ],
    ['approvals Forge cannot read', { approvalsStatus: 403 }, {}, 'approvals-unreadable'],
    [
      'a request with a conflict',
      { mr: { detailed_merge_status: 'conflict' } },
      {},
      'not-mergeable',
    ],
    [
      'a request GitLab is still checking',
      { mr: { detailed_merge_status: 'checking' } },
      {},
      'mergeability-unknown',
    ],
    [
      'a failed head pipeline',
      { mr: { head_pipeline: { id: 3, status: 'failed', sha: HEAD } } },
      {},
      'checks-not-green',
    ],
    ['a draft', { mr: { draft: true } }, {}, 'draft'],
    ['a closed request', { mr: { state: 'closed' } }, {}, 'not-open'],
    ['a head that moved since it was judged', {}, { expectedHeadSha: 'deadbeef' }, 'head-moved'],
  ];
  for (const [name, over, args, reason] of cases) {
    it(name, async () => {
      const m = merge(over, args);
      expect(await m.result).toMatchObject({ kind: 'refused', reason });
      expect(m.puts()).toHaveLength(0);
    });
  }
});

describe('what GitLab says back', () => {
  it('names a merge GitLab refused, with its own words', async () => {
    const m = merge({ mergeAnswer: { status: 405, body: { message: 'Method Not Allowed' } } });
    const got = await m.result;
    expect(got).toMatchObject({ kind: 'refused', reason: 'not-mergeable' });
    expect(got.kind === 'refused' && got.detail).toContain('Method Not Allowed');
  });

  it('records nothing on a merge GitLab did not confirm', async () => {
    const m = merge({ mergeAnswer: { body: { state: 'opened' } } });
    expect(await m.result).toMatchObject({ kind: 'refused', reason: 'merge-not-confirmed' });
  });

  it('refuses a merged answer that carries no merge time as evidence', async () => {
    const m = merge({
      mergeAnswer: { body: { state: 'merged', merge_commit_sha: LANDED, merged_at: null } },
    });
    expect(await m.result).toMatchObject({ kind: 'refused', reason: 'merged-without-evidence' });
  });
});
