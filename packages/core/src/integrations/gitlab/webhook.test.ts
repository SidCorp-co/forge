/**
 * ISS-50 — what each GitLab webhook event does: a Push Hook takes the same push effects every host's
 * push takes, a merged Merge Request Hook stamps the issue through the one merge writer, a Pipeline
 * Hook writes the gate's state for that head, and any other event is refused by name.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const applyPushedBranch = vi.fn(async (_input: unknown) => 1);
vi.mock('../source-host/push.js', () => ({
  applyPushedBranch: (i: unknown) => applyPushedBranch(i),
}));

const recordIssueMerge = vi.fn(async (_tx: unknown, _input: unknown) => ({ wrote: true }));
vi.mock('../../issues/merge-record.js', () => ({
  recordIssueMerge: (tx: unknown, input: unknown) => recordIssueMerge(tx, input),
}));

let linkedIssue: string | null = 'issue-50';
vi.mock('../github/issue-link.js', () => ({ resolveIssueForHeadRef: async () => linkedIssue }));

const applyPullRequestEvent = vi.fn(async (_ctx: unknown, _payload: unknown) => 1);
const applyCheckRunEvent = vi.fn(async (_ctx: unknown, _payload: unknown) => 1);
vi.mock('../github/projection.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    applyPullRequestEvent: (c: unknown, p: unknown) => applyPullRequestEvent(c, p),
    applyCheckRunEvent: (c: unknown, p: unknown) => applyCheckRunEvent(c, p),
  };
});

const { handleGitLabEvent, gitlabTime } = await import('./webhook.js');
const { gitlabStub } = await import('./gitlab-stub.fixture.js');

const HEAD = 'c0ffee1234567890c0ffee1234567890c0ffee12';
const BASE = 'b'.repeat(40);
const LANDED = 'e45b4ecf596c58e10135c25af4f7279a0a804802';
const ctx = {
  projectId: 'proj-1',
  bindingId: 'bind-gl',
  config: { projectPath: 'autoflow/core' },
  secrets: { token: 'glpat-recorded-token-0001' },
};
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  linkedIssue = 'issue-50';
  globalThis.fetch = gitlabStub({
    'GET /projects/autoflow%2Fcore/merge_requests/12': { body: { diff_refs: { base_sha: BASE } } },
  }).fetchStub;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const mergeHook = (over: Record<string, unknown> = {}) => ({
  project: { path_with_namespace: 'autoflow/core' },
  object_attributes: {
    iid: 12,
    title: 'feat: x (ISS-50)',
    url: 'https://gitlab.com/autoflow/core/-/merge_requests/12',
    state: 'merged',
    action: 'merge',
    source_branch: 'ISS-50-gitlab',
    target_branch: 'main',
    last_commit: { id: HEAD },
    merge_commit_sha: LANDED,
    updated_at: '2026-10-02 06:30:01 UTC',
    ...over,
  },
});

describe('events Forge does not read', () => {
  it('refuses an unknown event by name and records nothing from it', async () => {
    const got = await handleGitLabEvent(ctx, 'Note Hook', {});
    expect(got.actions).toBe(0);
    expect(got.refusal).toMatch(/^GITLAB_EVENT_UNKNOWN: `Note Hook`/);
    expect(applyPushedBranch).not.toHaveBeenCalled();
    expect(applyPullRequestEvent).not.toHaveBeenCalled();
  });
});

describe('a Push Hook', () => {
  it('takes the shared push effects with the branch, the commit and GitLab’s default branch', async () => {
    await handleGitLabEvent(ctx, 'Push Hook', {
      ref: 'refs/heads/main',
      after: HEAD,
      project: { default_branch: 'main' },
    });
    expect(applyPushedBranch).toHaveBeenCalledWith({
      projectId: 'proj-1',
      bindingId: 'bind-gl',
      branch: 'main',
      commit: HEAD,
      defaultBranch: 'main',
    });
  });

  it('does nothing for a tag push', async () => {
    expect(await handleGitLabEvent(ctx, 'Push Hook', { ref: 'refs/tags/v1', after: HEAD })).toEqual(
      { actions: 0 },
    );
    expect(applyPushedBranch).not.toHaveBeenCalled();
  });
});

describe('a Merge Request Hook', () => {
  it('stamps a merged request through the merge writer, at GitLab’s landing and the merge action’s time', async () => {
    await handleGitLabEvent(ctx, 'Merge Request Hook', mergeHook());
    expect(recordIssueMerge).toHaveBeenCalledWith(expect.anything(), {
      issueId: 'issue-50',
      evidence: {
        kind: 'observed',
        commitSha: LANDED,
        mergedAt: new Date('2026-10-02T06:30:01Z'),
        via: 'event',
      },
    });
  });

  it('writes the projection row as a GitLab row, with the base sha read from GitLab', async () => {
    await handleGitLabEvent(
      ctx,
      'Merge Request Hook',
      mergeHook({ state: 'opened', action: 'open' }),
    );
    expect(recordIssueMerge).not.toHaveBeenCalled();
    expect(applyPullRequestEvent).toHaveBeenCalledWith(
      { projectId: 'proj-1', bindingId: 'bind-gl', host: 'gitlab' },
      expect.objectContaining({
        pull_request: expect.objectContaining({
          number: 12,
          state: 'open',
          merged: false,
          head: { ref: 'ISS-50-gitlab', sha: HEAD },
          base: { ref: 'main', sha: BASE },
        }),
      }),
    );
  });

  it('does not stamp a merged state an update carries without the merge time', async () => {
    await handleGitLabEvent(ctx, 'Merge Request Hook', mergeHook({ action: 'update' }));
    expect(recordIssueMerge).not.toHaveBeenCalled();
  });

  it('says so when the base sha cannot be read, and still stamps the merge', async () => {
    globalThis.fetch = gitlabStub({}).fetchStub;
    const got = await handleGitLabEvent(ctx, 'Merge Request Hook', mergeHook());
    expect(got.refusal).toMatch(/^GITLAB_PROJECTION_UNREAD/);
    expect(recordIssueMerge).toHaveBeenCalled();
    expect(applyPullRequestEvent).not.toHaveBeenCalled();
  });
});

describe('a Pipeline Hook', () => {
  it('writes the pipeline onto its merge request as the gate’s state for that head', async () => {
    await handleGitLabEvent(ctx, 'Pipeline Hook', {
      project: { web_url: 'https://gitlab.com/autoflow/core' },
      merge_request: { iid: 12 },
      object_attributes: {
        id: 88,
        name: 'ci',
        sha: HEAD,
        status: 'failed',
        created_at: '2026-10-02 06:00:00 UTC',
        finished_at: '2026-10-02 06:10:00 UTC',
      },
    });
    expect(applyCheckRunEvent).toHaveBeenCalledWith(
      { projectId: 'proj-1', bindingId: 'bind-gl', host: 'gitlab' },
      {
        check_run: {
          id: 88,
          name: 'ci',
          head_sha: HEAD,
          status: 'completed',
          conclusion: 'failure',
          details_url: 'https://gitlab.com/autoflow/core/-/pipelines/88',
          started_at: '2026-10-02T06:00:00.000Z',
          completed_at: '2026-10-02T06:10:00.000Z',
          app: { slug: 'gitlab-ci' },
          pull_requests: [{ number: 12 }],
        },
      },
    );
  });

  it('refuses a pipeline payload with no status rather than writing a guess', async () => {
    const got = await handleGitLabEvent(ctx, 'Pipeline Hook', {
      object_attributes: { id: 1, sha: HEAD },
    });
    expect(got.refusal).toMatch(/^GITLAB_PAYLOAD_INCOMPLETE/);
    expect(applyCheckRunEvent).not.toHaveBeenCalled();
  });
});

describe('GitLab hook times', () => {
  it('reads the legacy UTC spelling and an ISO one, and nothing else', () => {
    expect(gitlabTime('2026-10-02 06:30:01 UTC')).toBe('2026-10-02T06:30:01.000Z');
    expect(gitlabTime('2026-10-02T06:30:01Z')).toBe('2026-10-02T06:30:01.000Z');
    expect(gitlabTime('yesterday')).toBeNull();
  });
});
