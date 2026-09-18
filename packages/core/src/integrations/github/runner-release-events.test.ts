/**
 * Steps 7 and 8: which delivery settles which release, and on what evidence.
 *
 * Two rules carry this file. The first is that a delivery is attributed by its
 * TAG and by nothing else — a commit does not name a tag, and the cases below
 * are the ones where guessing would settle the wrong release. The second is
 * that what GitHub holds for the tag is READ on every completed build, whatever
 * that build concluded: a failed build over a release that exists anyway, and a
 * successful build over a draft, are both states this path meets.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));
vi.mock('../../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

class FakeClientError extends Error {}
const buildRepoClient = vi.fn(() => ({ bindingId: 'binding-1', fullName: 'SidCorp-co/forge' }));
vi.mock('./client.js', () => ({
  buildRepoClient: (...a: unknown[]) => buildRepoClient(...(a as [])),
  GitHubClientError: FakeClientError,
}));

class FakeRepoError extends Error {
  constructor(readonly refusal: { cause: string; message: string }) {
    super(refusal.message);
  }
}
const WHOLE = {
  htmlUrl: 'https://github.com/SidCorp-co/forge/releases/tag/runner-v0.13.3',
  draft: false,
  prerelease: false,
  assetNames: [
    'forge-runner-x86_64-unknown-linux-gnu',
    'forge-runner-aarch64-apple-darwin',
    'VERSION',
  ],
};
const readReleaseForTag = vi.fn<(...a: unknown[]) => Promise<typeof WHOLE | null>>(
  async () => WHOLE,
);
vi.mock('./runner-release-repo.js', () => ({
  readReleaseForTag: (...a: unknown[]) => readReleaseForTag(...a),
  RunnerReleaseRepoError: FakeRepoError,
}));

type Row = Record<string, unknown> & { id: string; settledAt: Date | null };
let row: Row;
let inFlight: Row[];
const settlePublished = vi.fn(async (id: string, patch: Record<string, unknown>) => {
  if (row.id !== id || row.settledAt) return false;
  Object.assign(row, patch, { status: 'published', settledAt: new Date() });
  return true;
});
const settleFailed = vi.fn(async (id: string, patch: Record<string, unknown>) => {
  if (row.id !== id || row.settledAt) return false;
  Object.assign(row, patch, { status: 'failed', settledAt: new Date() });
  return true;
});
const appendReading = vi.fn(async (id: string, line: string) => {
  const target = row.id === id ? row : inFlight.find((r) => r.id === id);
  if (target) (target.readings as string[]).push(line);
});
vi.mock('./runner-release-store.js', () => ({
  findByBindingAndTag: async (bindingId: string, tag: string) =>
    bindingId === row.bindingId && tag === row.tag ? row : null,
  inFlightAtCommit: async () => inFlight,
  appendReading: (...a: unknown[]) => appendReading(...(a as [string, string])),
  settleFailed: (...a: unknown[]) => settleFailed(...(a as [string, Record<string, unknown>])),
  settlePublished: (...a: unknown[]) =>
    settlePublished(...(a as [string, Record<string, unknown>])),
}));

const { applyWorkflowRunEvent } = await import('./runner-release-events.js');

const ctx = {
  bindingId: 'binding-1',
  projectId: 'p1',
  config: { owner: 'SidCorp-co', repo: 'forge', installationId: 42 },
  secrets: { appId: '7', privateKey: 'pk' },
} as never;

const delivery = (over: Record<string, unknown> = {}, run: Record<string, unknown> = {}) => ({
  action: 'completed',
  repository: { full_name: 'SidCorp-co/forge' },
  workflow_run: {
    id: 111,
    name: 'runner-release',
    path: '.github/workflows/runner-release.yml',
    head_branch: 'runner-v0.13.3',
    head_sha: 'abc1234',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/SidCorp-co/forge/actions/runs/111',
    event: 'push',
    ...run,
  },
  ...over,
});

// cm:guard the implementations are restored by hand: `vi.clearAllMocks` clears CALLS and leaves `mockImplementation` in place, so the case that makes `buildRepoClient` throw would otherwise leave every later case reading no release at all — and the arm under test would look as though it never asks.
beforeEach(() => {
  vi.clearAllMocks();
  readReleaseForTag.mockImplementation(async () => WHOLE);
  buildRepoClient.mockImplementation(() => ({
    bindingId: 'binding-1',
    fullName: 'SidCorp-co/forge',
  }));
  row = {
    id: 'rel-1',
    projectId: 'p1',
    bindingId: 'binding-1',
    repository: 'SidCorp-co/forge',
    tag: 'runner-v0.13.3',
    version: '0.13.3',
    commitSha: 'abc1234',
    status: 'building',
    step: 'await_build',
    tagState: 'present',
    publication: 'unread',
    publicationDetail: null,
    readings: [],
    settledAt: null,
  };
  inFlight = [];
});

describe('a build that produced a whole release', () => {
  it('publishes the release, naming the build it was reported from', async () => {
    expect(await applyWorkflowRunEvent(ctx, delivery())).toBe(1);
    expect(row.status).toBe('published');
    expect(row.workflowRunId).toBe('111');
    expect(row.releaseUrl).toBe(WHOLE.htmlUrl);
    expect(row.buildConclusion).toBe('success');
    expect(String(row.publicationDetail)).toContain('forge-runner-aarch64-apple-darwin');
  });

  // cm:guard criterion 14. The row is settled once and the second delivery answers 0 — the conditional write in the store is the guarantee, and this is the arm that reports it.
  it('settles once when the same delivery arrives twice', async () => {
    expect(await applyWorkflowRunEvent(ctx, delivery())).toBe(1);
    expect(await applyWorkflowRunEvent(ctx, delivery())).toBe(0);
    expect(settlePublished).toHaveBeenCalledTimes(1);
    expect(row.workflowRunId).toBe('111');
  });

  it('writes nothing when a re-run of an older build reports over a settled release', async () => {
    await applyWorkflowRunEvent(ctx, delivery());
    expect(await applyWorkflowRunEvent(ctx, delivery({}, { id: 222, conclusion: 'failure' }))).toBe(
      0,
    );
    expect(row.status).toBe('published');
    expect(row.buildConclusion).toBe('success');
  });
});

describe('a build that succeeded over a release that is not whole', () => {
  // cm:guard criterion 16 and 17. `install/fetch-release.ts` ingests only a release that is neither draft nor prerelease and picks its assets by prefix, so a green build over a half-published release is a failed RELEASE however green the build was.
  it('fails at confirm_release when an asset is missing, naming what is there', async () => {
    readReleaseForTag.mockResolvedValue({
      ...WHOLE,
      assetNames: ['forge-runner-aarch64-apple-darwin'],
    });
    expect(await applyWorkflowRunEvent(ctx, delivery())).toBe(1);
    expect(row.status).toBe('failed');
    expect(row.step).toBe('confirm_release');
    expect(row.publication).toBe('incomplete');
    expect(String(row.failure)).toContain('missing forge-runner-x86_64-unknown-linux-gnu');
    expect(String(row.failure)).toContain('Present: forge-runner-aarch64-apple-darwin');
    expect(settlePublished).not.toHaveBeenCalled();
  });

  it('fails when the release is a draft the channel would never ingest', async () => {
    readReleaseForTag.mockResolvedValue({ ...WHOLE, draft: true });
    await applyWorkflowRunEvent(ctx, delivery());
    expect(row.status).toBe('failed');
    expect(String(row.failure)).toContain('it is a draft, which the install channel skips');
  });

  it('fails when GitHub holds no release at all for the tag', async () => {
    readReleaseForTag.mockResolvedValue(null);
    await applyWorkflowRunEvent(ctx, delivery());
    expect(row.publication).toBe('absent');
    expect(String(row.failure)).toContain('nothing is published');
  });
});

describe('a build that did not succeed', () => {
  it('fails at await_build, naming the conclusion, the url and what the repository holds', async () => {
    readReleaseForTag.mockResolvedValue(null);
    expect(await applyWorkflowRunEvent(ctx, delivery({}, { conclusion: 'failure' }))).toBe(1);
    expect(row.status).toBe('failed');
    expect(row.step).toBe('await_build');
    expect(row.buildConclusion).toBe('failure');
    expect(String(row.failure)).toContain('concluded `failure`');
    expect(String(row.failure)).toContain('/actions/runs/111');
    expect(String(row.failure)).toContain('`runner-v0.13.3` exists at abc1234');
    expect(String(row.failure)).toContain('nothing is published');
  });

  // cm:guard this is the reading that may not be inferred. A cancelled or failed workflow can have published a release before it died, and telling an operator "nothing is published" without looking is a claim nothing here supports.
  it('reads what GitHub holds even when the build failed, and reports it', async () => {
    readReleaseForTag.mockResolvedValue({
      ...WHOLE,
      assetNames: ['forge-runner-aarch64-apple-darwin'],
    });
    await applyWorkflowRunEvent(ctx, delivery({}, { conclusion: 'cancelled' }));
    expect(readReleaseForTag).toHaveBeenCalledTimes(1);
    expect(row.publication).toBe('incomplete');
    expect(String(row.failure)).toContain('concluded `cancelled`');
    expect(String(row.failure)).not.toContain('nothing is published');
    expect(String(row.failure)).toContain('Present: forge-runner-aarch64-apple-darwin');
  });

  it('records a reading it could not take as unknown rather than as absent', async () => {
    readReleaseForTag.mockRejectedValue(
      new FakeRepoError({ cause: 'rate-limited', message: 'GitHub rate-limited Forge' }),
    );
    await applyWorkflowRunEvent(ctx, delivery({}, { conclusion: 'failure' }));
    expect(row.publication).toBe('unknown');
    expect(String(row.failure)).toContain('could not read what GitHub holds');
    expect(String(row.failure)).not.toContain('nothing is published');
  });

  it('records the same unknown when the binding carries no App credential', async () => {
    buildRepoClient.mockImplementation(() => {
      throw new FakeClientError(
        'the connection behind this binding holds no GitHub App credential',
      );
    });
    await applyWorkflowRunEvent(ctx, delivery({}, { conclusion: 'failure' }));
    expect(row.publication).toBe('unknown');
    expect(readReleaseForTag).not.toHaveBeenCalled();
  });
});

describe('the deliveries that settle nothing', () => {
  it('ignores a run of any other workflow, without reading a release', async () => {
    expect(
      await applyWorkflowRunEvent(ctx, delivery({}, { path: '.github/workflows/ci.yml' })),
    ).toBe(0);
    expect(readReleaseForTag).not.toHaveBeenCalled();
    expect(settleFailed).not.toHaveBeenCalled();
    expect(row.settledAt).toBeNull();
  });

  it('ignores a run that has not completed', async () => {
    expect(
      await applyWorkflowRunEvent(
        ctx,
        delivery({ action: 'requested' }, { status: 'in_progress', conclusion: null }),
      ),
    ).toBe(0);
    expect(await applyWorkflowRunEvent(ctx, delivery({}, { status: 'in_progress' }))).toBe(0);
    expect(row.settledAt).toBeNull();
  });

  // cm:guard criterion 10 and 11, and the whole reason there is no `head_sha` fallback: the release IS in flight at this commit, so a matcher that fell back would settle it from a build that named no tag.
  it('settles nothing for a delivery naming no runner-v tag, and writes the fact onto the release', async () => {
    inFlight = [row];
    expect(await applyWorkflowRunEvent(ctx, delivery({}, { head_branch: null }))).toBe(0);
    expect(row.settledAt).toBeNull();
    expect((row.readings as string[])[0]).toContain('naming no runner-v* tag');
    expect((row.readings as string[])[0]).toContain('not attributed to this release');
    expect((row.readings as string[])[0]).toContain('abc1234');
  });

  it('settles nothing for a tag Forge did not cut', async () => {
    expect(await applyWorkflowRunEvent(ctx, delivery({}, { head_branch: 'runner-v9.9.9' }))).toBe(
      0,
    );
    expect(row.settledAt).toBeNull();
    expect(readReleaseForTag).not.toHaveBeenCalled();
  });

  it('settles nothing when the delivery names a different repository', async () => {
    expect(
      await applyWorkflowRunEvent(ctx, delivery({ repository: { full_name: 'someone/else' } })),
    ).toBe(0);
    expect(row.settledAt).toBeNull();
  });

  it('settles nothing for a delivery carrying no workflow run at all', async () => {
    expect(await applyWorkflowRunEvent(ctx, { action: 'completed' })).toBe(0);
  });
});

describe('what this arm asks GitHub', () => {
  // cm:guard criterion 12. The ONE outbound call on this path is the release read, and it happens after the build reported rather than while it runs. A poll would be a second source of truth with its own staleness, which is the rule ISS-1062 set for the whole projection.
  it('asks nothing about the build itself, and reads the release exactly once', async () => {
    await applyWorkflowRunEvent(ctx, delivery());
    expect(readReleaseForTag).toHaveBeenCalledTimes(1);
    expect(readReleaseForTag).toHaveBeenCalledWith(expect.anything(), 'runner-v0.13.3');
    expect(buildRepoClient).toHaveBeenCalledTimes(1);
  });
});
