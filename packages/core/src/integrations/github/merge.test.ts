/**
 * ISS-1073 — what the merge path sends, what it refuses, and what it records.
 *
 * Driven against a recording client rather than grepped: the App credential, the
 * absence of a bypass parameter and the number of `PUT`s are read off the requests
 * the stub received. A grep for `enforce_admin` goes green on a file that sends one
 * through a variable; the recorder cannot. The same path over a real Postgres and a
 * loopback GitHub is `tests/integration/github-merge-kernel-e2e.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pipelineRuns } from '../../db/schema.js';

vi.mock('../../config/env.js', () => ({
  env: { JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef', NODE_ENV: 'test' },
}));

const HEAD = 'c0ffee1234567890c0ffee1234567890c0ffee12';
const LANDED = 'e45b4ecf596c58e10135c25af4f7279a0a804802';
/** GitHub's own merge time, deliberately not this box's clock. */
const GITHUB_MERGED_AT = '2026-09-18T06:30:01.449Z';
const PR_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ISSUE_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';

/** GitHub's answer for this pull request, with only what a case varies spelled out. */
const openPull = (over: Record<string, unknown> = {}) => ({
  number: 481,
  state: 'open',
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  head: { sha: HEAD },
  base: { ref: 'main' },
  ...over,
});
const mergedPull = () =>
  openPull({
    state: 'closed',
    merged: true,
    merge_commit_sha: LANDED,
    merged_at: GITHUB_MERGED_AT,
    mergeable: null,
    mergeable_state: 'unknown',
  });

let storedRow: Record<string, unknown> | undefined;
let runRow: { projectId: string } | undefined;
const selectLimit = vi.fn(async () => (storedRow ? [storedRow] : []));
const projectionUpdate = vi.fn();
let transactionThrows = false;

vi.mock('../../db/client.js', () => {
  const selectFrom = (table: unknown) => ({
    where: () => ({
      limit: async () => {
        if (table === pipelineRuns) return runRow ? [runRow] : [];
        return selectLimit();
      },
    }),
  });
  const tx = {
    update: () => ({ set: (v: unknown) => ({ where: () => projectionUpdate(v) }) }),
  };
  return {
    db: {
      select: () => ({ from: selectFrom }),
      transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        if (transactionThrows) throw new Error('deadlock detected');
        return fn(tx);
      },
    },
  };
});

const recordIssueMerge = vi.fn(
  async (): Promise<{ wrote: boolean; mergedAt: Date | null; commitSha: string | null }> => ({
    wrote: true,
    mergedAt: null,
    commitSha: null,
  }),
);
vi.mock('../../issues/merge-record.js', () => ({
  recordIssueMerge: (...a: unknown[]) => recordIssueMerge(...(a as [])),
}));

const recordDelivery = vi.fn(async () => 'delivery-1');
const updateDelivery = vi.fn(async () => undefined);
vi.mock('../deliveries.js', () => ({
  recordDelivery: (...a: unknown[]) => recordDelivery(...(a as [])),
  updateDelivery: (...a: unknown[]) => updateDelivery(...(a as [])),
}));

vi.mock('./binding-credential.js', () => ({
  githubBindingCredential: async () => ({
    config: { owner: 'SidCorp-co', repo: 'forge', installationId: '9' },
    secrets: { appId: '7', privateKey: 'k' },
  }),
}));

/** One request the stub received: the method, the path, the body and the credential it carried. */
interface Sent {
  op: string;
  method: string;
  path: string;
  body?: unknown;
}

let sent: Sent[] = [];
/** Whether the stub has taken a merge, so the read back after one answers as GitHub would. */
let merged = false;
/** What the stub answers, by the path fragment that identifies the call. */
let answers: Record<string, unknown> = {};
let throwsOnMerge: unknown = null;

vi.mock('./client.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    buildRepoClient: () => ({
      bindingId: 'b',
      appId: '7',
      owner: 'SidCorp-co',
      repo: 'forge',
      fullName: 'SidCorp-co/forge',
      get: async () => ({}),
      publish: async (args: { op: string; method: string; path: string; body?: unknown }) => {
        sent.push(args);
        if (args.method === 'PUT') {
          merged = true;
          if (throwsOnMerge) throw throwsOnMerge;
          return answers.merge ?? { merged: true, sha: LANDED };
        }
        if (args.path.includes('/protection')) {
          const held = answers.protection;
          if (held instanceof Error) throw held;
          return held ?? { required_status_checks: { contexts: ['ci-passed'] } };
        }
        if (args.path.includes('/check-runs')) {
          return (
            answers.checks ?? {
              check_runs: [{ name: 'ci-passed', status: 'completed', conclusion: 'success' }],
            }
          );
        }
        if (answers.pull) return answers.pull;
        if (merged) {
          if (answers.pullAfterMerge !== undefined) return answers.pullAfterMerge;
          return mergedPull();
        }
        return openPull();
      },
    }),
  };
});

const { MergeInputError, mergeStoredPullRequest } = await import('./merge.js');

const ask = (over: Record<string, unknown> = {}) =>
  mergeStoredPullRequest({
    pullRequestId: PR_ID,
    requestedBy: 'user:alice',
    ...over,
  } as Parameters<typeof mergeStoredPullRequest>[0]);

const puts = () => sent.filter((s) => s.method === 'PUT');

beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  merged = false;
  answers = {};
  throwsOnMerge = null;
  transactionThrows = false;
  runRow = { projectId: PROJECT_ID };
  storedRow = {
    id: PR_ID,
    projectId: PROJECT_ID,
    bindingId: 'b',
    issueId: ISSUE_ID,
    number: 481,
    state: 'open',
  };
  recordIssueMerge.mockResolvedValue({ wrote: true, mergedAt: null, commitSha: null });
});

describe('the merge itself', () => {
  it('sends exactly one PUT, to the merge endpoint', async () => {
    const outcome = await ask();
    expect(outcome?.kind).toBe('merged');
    expect(puts()).toHaveLength(1);
    expect(puts()[0]?.path).toBe('/repos/SidCorp-co/forge/pulls/481/merge');
  });

  it('sends the head sha and the merge method and nothing else', async () => {
    await ask();
    expect(puts()[0]?.body).toEqual({ sha: HEAD, merge_method: 'merge' });
  });

  it('writes the issue stamp and the projection row in one transaction', async () => {
    await ask();
    expect(recordIssueMerge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        issueId: ISSUE_ID,
        evidence: expect.objectContaining({ kind: 'observed', commitSha: LANDED, via: 'kernel' }),
      }),
    );
    expect(projectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'merged', mergeCommitSha: LANDED }),
    );
  });

  it('records who asked on the delivery row', async () => {
    await ask({ runId: RUN_ID });
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'pull_request.merge',
        payload: expect.objectContaining({ requestedBy: 'user:alice', runId: RUN_ID }),
      }),
    );
    expect(updateDelivery).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({
        status: 'ok',
        response: expect.objectContaining({ requestedBy: 'user:alice' }),
      }),
    );
  });

  it('takes the merge method the caller named', async () => {
    await ask({ method: 'squash' });
    expect(puts()[0]?.body).toEqual({ sha: HEAD, merge_method: 'squash' });
  });

  it("records GitHub's own merge time and not this box's clock", async () => {
    const outcome = await ask();
    expect(outcome?.kind === 'merged' && outcome.mergedAt.toISOString()).toBe(GITHUB_MERGED_AT);
    expect(recordIssueMerge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        evidence: expect.objectContaining({ mergedAt: new Date(GITHUB_MERGED_AT) }),
      }),
    );
  });

  it('raises naming the commit when the time cannot be read back', async () => {
    answers = { pullAfterMerge: { number: 481, state: 'closed', merged: true, merged_at: null } };
    await expect(ask()).rejects.toThrow(
      new RegExp(`MERGED at ${LANDED}, and reading back when GitHub merged it failed`),
    );
    expect(puts()).toHaveLength(1);
  });
});

describe('a merge nobody is named for', () => {
  it('is refused before anything is read', async () => {
    await expect(ask({ requestedBy: '   ' })).rejects.toBeInstanceOf(MergeInputError);
    expect(sent).toHaveLength(0);
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it('is refused when its run belongs to another project', async () => {
    runRow = { projectId: '99999999-9999-4999-8999-999999999999' };
    await expect(ask({ runId: RUN_ID })).rejects.toThrow(/belongs to another project/);
    expect(sent).toHaveLength(0);
  });

  it('is refused when its run does not exist', async () => {
    runRow = undefined;
    await expect(ask({ runId: RUN_ID })).rejects.toThrow(/names no pipeline run/);
    expect(sent).toHaveLength(0);
  });
});

describe('a pre-flight refusal reaches GitHub with no merge request', () => {
  const refusals: Array<{ what: string; answers: Record<string, unknown>; reason: string }> = [
    {
      what: 'a conflict',
      answers: { pull: openPull({ mergeable: false, mergeable_state: 'dirty' }) },
      reason: 'conflicting',
    },
    {
      what: 'a head behind its base',
      answers: { pull: openPull({ mergeable_state: 'behind' }) },
      reason: 'behind',
    },
    {
      what: 'a required check still running',
      answers: {
        checks: { check_runs: [{ name: 'ci-passed', status: 'in_progress', conclusion: null }] },
      },
      reason: 'required-check',
    },
    {
      what: 'a required check that failed',
      answers: {
        checks: { check_runs: [{ name: 'ci-passed', status: 'completed', conclusion: 'failure' }] },
      },
      reason: 'required-check',
    },
    {
      what: 'a protection that is not satisfied',
      answers: { pull: openPull({ mergeable_state: 'blocked' }) },
      reason: 'protected-branch',
    },
    {
      what: 'a mergeability GitHub has not computed',
      answers: { pull: openPull({ mergeable: null, mergeable_state: 'unknown' }) },
      reason: 'mergeability-uncomputed',
    },
  ];

  it.each(refusals)('refuses $what without sending a merge', async (c) => {
    answers = c.answers;
    const outcome = await ask();
    expect(outcome?.kind).toBe('refused');
    if (outcome?.kind !== 'refused') return;
    expect(outcome.reason).toBe(c.reason);
    expect(puts()).toHaveLength(0);
    expect(recordIssueMerge).not.toHaveBeenCalled();
    expect(updateDelivery).toHaveBeenCalledWith(
      'delivery-1',
      expect.objectContaining({ status: 'failed', response: { reason: c.reason } }),
    );
  });

  it('records an already-merged pull request even when the checks cannot be read', async () => {
    const { GitHubPublishError } = await import('./client.js');
    answers = {
      pull: mergedPull(),
      protection: new GitHubPublishError({ op: 'lookup', status: 403, message: 'forbidden' }),
    };
    const outcome = await ask();
    expect(outcome?.kind).toBe('already-merged');
    expect(sent.filter((c) => c.path.includes('/check-runs'))).toHaveLength(0);
    expect(sent.filter((c) => c.path.includes('/protection'))).toHaveLength(0);
    expect(puts()).toHaveLength(0);
  });

  it('refuses when Forge cannot read what the base branch requires', async () => {
    const { GitHubPublishError } = await import('./client.js');
    answers = {
      protection: new GitHubPublishError({ op: 'lookup', status: 403, message: 'forbidden' }),
    };
    const outcome = await ask();
    expect(outcome?.kind === 'refused' && outcome.reason).toBe('protection-unreadable');
    expect(puts()).toHaveLength(0);
  });

  it('treats a 404 on protection as an unprotected branch, which requires nothing', async () => {
    const { GitHubPublishError } = await import('./client.js');
    answers = {
      protection: new GitHubPublishError({ op: 'lookup', status: 404, message: 'not found' }),
      checks: { check_runs: [] },
    };
    expect((await ask())?.kind).toBe('merged');
  });
});

describe('a merge GitHub itself refuses', () => {
  it.each([
    [405, /not mergeable at the moment/],
    [409, /head branch was modified/],
  ])('refuses on HTTP %i without a second attempt', async (status, says) => {
    const { GitHubPublishError } = await import('./client.js');
    throwsOnMerge = new GitHubPublishError({ op: 'merge', status, message: `HTTP ${status}` });
    const outcome = await ask();
    expect(outcome?.kind).toBe('refused');
    if (outcome?.kind === 'refused') expect(outcome.detail).toMatch(says);
    expect(puts()).toHaveLength(1);
    expect(recordIssueMerge).not.toHaveBeenCalled();
  });

  it('tells an operator not to re-send a merge that timed out', async () => {
    const { GitHubPublishError } = await import('./client.js');
    throwsOnMerge = new GitHubPublishError({ op: 'merge', timedOut: true, message: 'timeout' });
    const outcome = await ask();
    expect(outcome?.kind === 'refused' && outcome.detail).toMatch(/Do not send it again/);
    expect(puts()).toHaveLength(1);
  });

  it('refuses an answer that does not confirm the merge, rather than recording one', async () => {
    answers = { merge: { merged: false, message: 'Base branch was modified' } };
    const outcome = await ask();
    expect(outcome?.kind === 'refused' && outcome.reason).toBe('merge-not-confirmed');
    expect(recordIssueMerge).not.toHaveBeenCalled();
  });
});

describe('a merge that has already happened', () => {
  const merged = { pull: mergedPull() };

  it('records the evidence and sends no merge request', async () => {
    answers = merged;
    const outcome = await ask();
    expect(outcome?.kind).toBe('already-merged');
    expect(puts()).toHaveLength(0);
    expect(recordIssueMerge).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        evidence: expect.objectContaining({
          commitSha: LANDED,
          mergedAt: new Date(GITHUB_MERGED_AT),
        }),
      }),
    );
  });

  it('reports stamped=false where the row already carried this evidence', async () => {
    answers = merged;
    recordIssueMerge.mockResolvedValue({ wrote: false, mergedAt: null, commitSha: LANDED });
    const outcome = await ask();
    expect(outcome?.kind === 'already-merged' && outcome.stamped).toBe(false);
  });

  it('refuses a merge GitHub reports without a commit to record', async () => {
    answers = { pull: { ...merged.pull, merge_commit_sha: null } };
    const outcome = await ask();
    expect(outcome?.kind === 'refused' && outcome.reason).toBe('merged-without-evidence');
  });
});

describe('when the stamp fails after GitHub merged', () => {
  it('raises naming the commit that landed, and records nothing', async () => {
    transactionThrows = true;
    await expect(ask()).rejects.toThrow(new RegExp(`MERGED at ${LANDED}, and recording it failed`));
    expect(puts()).toHaveLength(1);
  });

  it('names the way back, which is not another merge', async () => {
    transactionThrows = true;
    await expect(ask()).rejects.toThrow(/without merging again/);
  });
});

describe('a pull request this project does not hold', () => {
  it('answers null rather than merging something else', async () => {
    storedRow = undefined;
    expect(await ask()).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('refuses a row belonging to a binding the caller was not authorised for', async () => {
    await expect(
      mergeStoredPullRequest(
        { pullRequestId: PR_ID, requestedBy: 'user:alice' },
        'another-binding',
      ),
    ).rejects.toThrow(/will not merge on a repository the caller did not name/);
    expect(sent).toHaveLength(0);
  });
});
