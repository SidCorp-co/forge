import { describe, expect, it } from 'vitest';
import { isRefusal } from '../../lib/refusal.js';
import type { GitHubAgentClient } from './agent-client.js';
import { githubChangeRequestVerbs } from './change-requests.js';
import type { GitHubRepoClient } from './client.js';

const HEAD = 'a'.repeat(40);
const MERGE = 'm'.repeat(40);

interface Write {
  method: string;
  path: string;
  body?: unknown;
}

function doubles(reads: Record<string, unknown>, written: (w: Write) => unknown = () => ({})) {
  const got: string[] = [];
  const writes: Write[] = [];
  const client = {
    bindingId: 'b1',
    owner: 'acme',
    repo: 'shop',
    fullName: 'acme/shop',
    get: async <T>(path: string): Promise<T> => {
      got.push(path);
      const hit = Object.entries(reads).find(([k]) => path.startsWith(k));
      if (!hit) throw new Error(`no read planted for ${path}`);
      return (
        typeof hit[1] === 'function' ? (hit[1] as (p: string) => unknown)(path) : hit[1]
      ) as T;
    },
  } as unknown as GitHubRepoClient;
  const agent = {
    owner: 'acme',
    repo: 'shop',
    fullName: 'acme/shop',
    json: async <T>(w: Write): Promise<T> => {
      writes.push(w);
      return written(w) as T;
    },
  } as unknown as GitHubAgentClient;
  return { verbs: githubChangeRequestVerbs(client, () => agent), got, writes };
}

const pull = (over: Record<string, unknown> = {}) => ({
  number: 7,
  html_url: 'https://github.com/acme/shop/pull/7',
  title: 'Fix',
  body: 'Delivers ISS-2',
  state: 'open',
  draft: false,
  merged: false,
  merged_at: null,
  // GitHub names a test merge on an open pull request; it is not a landing
  merge_commit_sha: 't'.repeat(40),
  updated_at: '2026-10-26T08:00:00Z',
  head: { ref: 'fix/x-iss-2', sha: HEAD },
  base: { ref: 'main', sha: 'b'.repeat(40) },
  ...over,
});

const RUNS = `/repos/acme/shop/commits/${HEAD}/check-runs`;
const STATUS = `/repos/acme/shop/commits/${HEAD}/status`;

describe('github readChecks: check runs and commit statuses in the projection’s shape', () => {
  it('reads every check run and every combined status on the commit', async () => {
    const { verbs } = doubles({
      [RUNS]: {
        total_count: 1,
        check_runs: [
          {
            id: 11,
            name: 'ci-passed',
            head_sha: HEAD,
            status: 'completed',
            conclusion: 'success',
            details_url: 'https://ci/11',
            started_at: '2026-10-26T08:00:00Z',
            completed_at: '2026-10-26T08:10:00Z',
            app: { slug: 'github-actions' },
          },
        ],
      },
      [STATUS]: {
        statuses: [
          {
            id: 99,
            context: 'jenkins/build',
            state: 'pending',
            target_url: 'https://jenkins/1',
            created_at: '2026-10-26T08:01:00Z',
            updated_at: '2026-10-26T08:01:00Z',
          },
          {
            id: 98,
            context: 'deploy/stg',
            state: 'failure',
            created_at: '2026-10-26T08:02:00Z',
            updated_at: '2026-10-26T08:03:00Z',
          },
        ],
      },
    });
    expect(await verbs.readChecks(HEAD)).toEqual([
      {
        id: '11',
        name: 'ci-passed',
        app: 'github-actions',
        headSha: HEAD,
        status: 'completed',
        conclusion: 'success',
        detailsUrl: 'https://ci/11',
        startedAt: '2026-10-26T08:00:00Z',
        completedAt: '2026-10-26T08:10:00Z',
      },
      {
        id: 'status-99',
        name: 'jenkins/build',
        app: 'commit-status',
        headSha: HEAD,
        status: 'in_progress',
        conclusion: null,
        detailsUrl: 'https://jenkins/1',
        startedAt: '2026-10-26T08:01:00Z',
        completedAt: null,
      },
      {
        id: 'status-98',
        name: 'deploy/stg',
        app: 'commit-status',
        headSha: HEAD,
        status: 'completed',
        conclusion: 'failure',
        detailsUrl: null,
        startedAt: '2026-10-26T08:02:00Z',
        completedAt: '2026-10-26T08:03:00Z',
      },
    ]);
  });

  it('pages check runs until GitHub’s total is read', async () => {
    const page = (n: number, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: n * 1000 + i,
        name: `c${n}-${i}`,
        status: 'queued',
      }));
    const { verbs, got } = doubles({
      [RUNS]: (path: string) =>
        path.endsWith('page=1')
          ? { total_count: 130, check_runs: page(1, 100) }
          : { total_count: 130, check_runs: page(2, 30) },
      [STATUS]: { statuses: [] },
    });
    expect(await verbs.readChecks(HEAD)).toHaveLength(130);
    expect(got.filter((p) => p.startsWith(RUNS))).toEqual([
      `${RUNS}?per_page=100&page=1`,
      `${RUNS}?per_page=100&page=2`,
    ]);
  });
});

// ISS-841 (FB-437, agenfold 2026-10-31): the gate `gate` is a GitHub Actions job, green as a check
// run, and the repository credential gets 403 on commit statuses. Reading both at once refused every
// release RELEASE_GATE_CHECK_UNREAD. A check asked by name that a check run carries is answered by
// the check runs alone; anything else still asks the statuses, and their 403 still fails the read.
describe('github readChecks for one check by name', () => {
  const forbidden = () => {
    throw new Error(`GET /repos/acme/shop/commits/${HEAD}/status on acme/shop returned HTTP 403`);
  };
  const gateRun = (conclusion: string) => ({
    total_count: 1,
    check_runs: [
      {
        id: 41,
        name: 'gate',
        head_sha: HEAD,
        status: 'completed',
        conclusion,
        app: { slug: 'github-actions' },
      },
    ],
  });

  it('answers a green Actions gate from its check run, never asking the forbidden statuses', async () => {
    const { verbs, got } = doubles({ [RUNS]: gateRun('success'), [STATUS]: forbidden });
    const checks = await verbs.readChecks(HEAD, { named: 'gate' });
    expect(checks.map((c) => [c.name, c.conclusion])).toEqual([['gate', 'success']]);
    expect(got.some((p) => p.startsWith(STATUS))).toBe(false);
  });

  it('answers a red Actions gate as red, so the gate still refuses it', async () => {
    const { verbs } = doubles({ [RUNS]: gateRun('failure'), [STATUS]: forbidden });
    const checks = await verbs.readChecks(HEAD, { named: 'gate' });
    expect(checks.map((c) => [c.name, c.conclusion])).toEqual([['gate', 'failure']]);
  });

  it('asks a pull request head the same way', async () => {
    const { verbs, got } = doubles({ [RUNS]: gateRun('success'), [STATUS]: forbidden });
    const checks = await verbs.readChangeRequestChecks({ number: 7, headSha: HEAD, named: 'gate' });
    expect(checks).toHaveLength(1);
    expect(got.some((p) => p.startsWith(STATUS))).toBe(false);
  });

  it('still reads the statuses for a name no check run carries, and fails where they are forbidden', async () => {
    const { verbs } = doubles({ [RUNS]: gateRun('success'), [STATUS]: forbidden });
    await expect(verbs.readChecks(HEAD, { named: 'jenkins/build' })).rejects.toThrow('HTTP 403');
  });

  it('finds a gate GitHub holds as a commit status context', async () => {
    const { verbs } = doubles({
      [RUNS]: { total_count: 0, check_runs: [] },
      [STATUS]: { statuses: [{ id: 5, context: 'gate', state: 'success' }] },
    });
    const checks = await verbs.readChecks(HEAD, { named: 'gate' });
    expect(checks.map((c) => [c.name, c.conclusion])).toEqual([['gate', 'success']]);
  });

  it('reads both, as before, where no check is named', async () => {
    const { verbs } = doubles({ [RUNS]: gateRun('success'), [STATUS]: forbidden });
    await expect(verbs.readChecks(HEAD)).rejects.toThrow('HTTP 403');
  });
});

describe('github readChangeRequest', () => {
  it('reads an open pull request and keeps its test merge commit out of the landing', async () => {
    const { verbs } = doubles({ '/repos/acme/shop/pulls/7': pull() });
    expect(await verbs.readChangeRequest(7)).toEqual({
      number: 7,
      url: 'https://github.com/acme/shop/pull/7',
      title: 'Fix',
      state: 'open',
      draft: false,
      headRef: 'fix/x-iss-2',
      headSha: HEAD,
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      updatedAt: '2026-10-26T08:00:00Z',
      body: 'Delivers ISS-2',
      mergedAt: null,
      mergeCommitSha: null,
    });
  });

  it('reads a merged pull request as merged, with its landing', async () => {
    const { verbs } = doubles({
      '/repos/acme/shop/pulls/7': pull({
        state: 'closed',
        merged: true,
        merged_at: '2026-10-26T09:00:00Z',
        merge_commit_sha: MERGE,
      }),
    });
    expect(await verbs.readChangeRequest(7)).toMatchObject({
      state: 'merged',
      mergedAt: '2026-10-26T09:00:00Z',
      mergeCommitSha: MERGE,
    });
  });
});

describe('github updateChangeRequest and closeChangeRequest', () => {
  it('edits by PATCH as the App, sending only what it was given', async () => {
    const { verbs, writes } = doubles({}, () => pull({ title: 'Better' }));
    expect((await verbs.updateChangeRequest({ number: 7, title: 'Better' })).title).toBe('Better');
    expect(writes).toEqual([
      { method: 'PATCH', path: '/repos/acme/shop/pulls/7', body: { title: 'Better' } },
    ]);
  });

  it('closes an open pull request, answers a closed one as it stands, and refuses a merged one', async () => {
    const open = doubles({ '/repos/acme/shop/pulls/7': pull() }, () => pull({ state: 'closed' }));
    expect((await open.verbs.closeChangeRequest({ number: 7 })).state).toBe('closed');
    expect(open.writes).toEqual([
      { method: 'PATCH', path: '/repos/acme/shop/pulls/7', body: { state: 'closed' } },
    ]);

    const closed = doubles({ '/repos/acme/shop/pulls/7': pull({ state: 'closed' }) });
    expect((await closed.verbs.closeChangeRequest({ number: 7 })).state).toBe('closed');
    expect(closed.writes).toEqual([]);

    const merged = doubles({
      '/repos/acme/shop/pulls/7': pull({ state: 'closed', merged: true, merged_at: 'x' }),
    });
    const err = await merged.verbs.closeChangeRequest({ number: 7 }).catch((e: unknown) => e);
    expect(isRefusal(err, 'SOURCE_HOST_INPUT_REFUSED')).toBe(true);
    expect(merged.writes).toEqual([]);
  });
});
