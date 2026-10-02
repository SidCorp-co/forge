/**
 * ISS-50 — `forge_source`, the agent face of the project's source host, and `forge_github`, its
 * priced former name. What the face refuses by name, which host it reaches, and that the former name
 * reaches the same verbs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('./lib.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  resolveEffectiveProjectId: async () => 'proj-1',
  assertPrincipalIsMember: async () => undefined,
  assertPrincipalIsWriter: async () => undefined,
}));

const openChangeRequest = vi.fn(async () => ({
  number: 12,
  url: 'https://gitlab.com/autoflow/core/-/merge_requests/12',
  title: 'x',
  state: 'open',
  draft: false,
  headRef: 'ISS-50-x',
  headSha: 'a'.repeat(40),
  baseRef: 'main',
  baseSha: 'b'.repeat(40),
  updatedAt: '2026-10-02T00:00:00Z',
}));
const requestReview = vi.fn();
const fakeHost = {
  provider: 'gitlab',
  bindingId: 'bind-gl',
  fullName: 'autoflow/core',
  host: 'gitlab.com',
  words: { changeRequest: 'merge request', sigil: '!', mergeMethods: ['merge', 'squash'] },
  openChangeRequest,
  requestReview,
};
let resolved: unknown = fakeHost;
const resolveSourceHost = vi.fn(async () => {
  if (resolved instanceof Error) throw resolved;
  return resolved;
});
vi.mock('../../integrations/source-host/resolve.js', () => ({
  resolveSourceHost: (...a: unknown[]) => resolveSourceHost(...(a as [])),
}));
const projectOpenedPullRequest = vi.fn(async () => ({
  outcome: 'recorded',
  issueId: 'issue-50',
  reason: null,
}));
vi.mock('../../integrations/github/opened-pull-request.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  projectOpenedPullRequest: (...a: unknown[]) => projectOpenedPullRequest(...(a as [])),
}));

const { forgeSourceTool, forgeGithubAliasTool, KERNEL_VERBS, kernelVerbRefusal } = await import(
  './forge-source.js'
);
const { REGISTERED_TOOLS } = await import('../registered-tools.js');
const { SourceHostInputRefusal, SourceHostUnavailable } = await import(
  '../../integrations/source-host/errors.js'
);

const ctx = { principal: { userId: 'u1' } } as never;
const source = forgeSourceTool(ctx);
const alias = forgeGithubAliasTool(ctx);

beforeEach(() => {
  vi.clearAllMocks();
  resolved = fakeHost;
});

describe('the door', () => {
  it('is registered under its own name and its former one', () => {
    expect(REGISTERED_TOOLS).toContain('forge_source');
    expect(REGISTERED_TOOLS).toContain('forge_github');
    expect(source.name).toBe('forge_source');
    expect(alias.name).toBe('forge_github');
  });

  it('offers open-change-request, and the former name also takes open-pull-request', () => {
    const actions = (t: typeof source) =>
      (t.inputSchema as { properties: { action: { enum: string[] } } }).properties.action.enum;
    expect(actions(source)).toContain('open-change-request');
    expect(actions(source)).not.toContain('open-pull-request');
    expect(actions(alias)).toEqual([...actions(source), 'open-pull-request']);
  });
});

describe('nothing on this face merges', () => {
  it('recognises the kernel verbs in order to answer them by name', () => {
    for (const verb of ['merge', 'close', 'delete-branch', 'squash', 'rebase'])
      expect(KERNEL_VERBS.has(verb)).toBe(true);
    expect(KERNEL_VERBS.has('review')).toBe(false);
  });

  it('says where the merge lives rather than that the verb is unknown', async () => {
    const said = kernelVerbRefusal('merge');
    expect(said).toContain('pull_request.merge');
    expect(said).toContain('merged_at');
    expect(said).toContain("Forge's projection of the repository");
    await expect(source.handler({ action: 'merge' })).rejects.toThrow(
      /^BAD_REQUEST: `merge` is not one of this tool's actions/,
    );
    expect(resolveSourceHost).not.toHaveBeenCalled();
  });
});

describe('reaching the host', () => {
  it('opens a merge request on the project’s host, as an agent verb, and records it on the projection as that host’s', async () => {
    const got = (await source.handler({
      action: 'open-change-request',
      head: 'ISS-50-x',
      base: 'main',
      title: 'x',
    })) as Record<string, unknown>;
    expect(resolveSourceHost).toHaveBeenCalledWith('proj-1', 'agent');
    expect(openChangeRequest).toHaveBeenCalledWith({ head: 'ISS-50-x', base: 'main', title: 'x' });
    expect(projectOpenedPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'gitlab',
        bindingId: 'bind-gl',
        repository: 'autoflow/core',
      }),
    );
    expect(got.projection).toMatchObject({ outcome: 'recorded' });
  });

  it('takes the former action name on the former tool name, and the same verb runs', async () => {
    await alias.handler({
      action: 'open-pull-request',
      head: 'ISS-50-x',
      base: 'main',
      title: 'x',
    });
    expect(openChangeRequest).toHaveBeenCalledTimes(1);
  });

  it('turns a host refusal into a BAD_REQUEST carrying its own words', async () => {
    resolved = new SourceHostUnavailable(
      'host_mismatch',
      'the project document declares a repository on gitlab.com',
    );
    await expect(source.handler({ action: 'diff', pullRequest: 1 })).rejects.toThrow(
      'BAD_REQUEST: the project document declares a repository on gitlab.com',
    );
    resolved = fakeHost;
    requestReview.mockRejectedValueOnce(new SourceHostInputRefusal('GitLab has no team reviewers'));
    await expect(
      source.handler({ action: 'request-review', pullRequest: 1, teamReviewers: ['core'] }),
    ).rejects.toThrow('BAD_REQUEST: GitLab has no team reviewers');
  });
});
