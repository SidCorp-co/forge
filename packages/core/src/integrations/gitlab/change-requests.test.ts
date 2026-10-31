import { describe, expect, it } from 'vitest';
import { isRefusal } from '../../lib/refusal.js';
import { gitlabChangeRequestVerbs } from './change-requests.js';
import type { GitLabClient } from './client.js';

// adminhub-fe's binding to sidcorp-it/canawan-admin-hub-fe, 2026-10-26: no webhook, so these reads
// are the only way Forge learns a merge request's state and a commit's pipeline.

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'm'.repeat(40);

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function clientAnswering(answer: (call: Call) => unknown, pages: unknown[] = []) {
  const calls: Call[] = [];
  const client = {
    bindingId: 'b1',
    baseUrl: 'https://gitlab.example',
    host: 'gitlab.example',
    fullName: 'sidcorp-it/canawan-admin-hub-fe',
    webUrl: 'https://gitlab.example/sidcorp-it/canawan-admin-hub-fe',
    project: (suffix: string) => `/projects/1${suffix}`,
    json: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      calls.push({ method, path, body });
      return answer({ method, path, body }) as T;
    },
    pages: async <T>(path: string): Promise<T[]> => {
      calls.push({ method: 'GET', path });
      return pages as T[];
    },
  } as unknown as GitLabClient;
  return { verbs: gitlabChangeRequestVerbs(client), calls };
}

const mr = (over: Record<string, unknown> = {}) => ({
  iid: 12,
  title: 'release: stg',
  description: 'Delivers ISS-4',
  state: 'opened',
  web_url: 'https://gitlab.example/x/-/merge_requests/12',
  source_branch: 'feat/x-iss-4',
  target_branch: 'release/stg',
  sha: HEAD,
  diff_refs: { base_sha: BASE, head_sha: HEAD },
  updated_at: '2026-10-26T08:00:00Z',
  ...over,
});

describe('gitlab readChecks: a commit pipeline in the shape the Pipeline Hook stores', () => {
  it('reads the pipelines of the sha and writes each as the hook does', async () => {
    const { verbs, calls } = clientAnswering(
      () => null,
      [
        {
          id: 901,
          sha: HEAD,
          status: 'success',
          web_url: 'https://gitlab.example/p/901',
          created_at: '2026-10-26T08:00:00Z',
          updated_at: '2026-10-26T08:05:00Z',
        },
        {
          id: 902,
          name: 'nightly',
          sha: HEAD,
          status: 'running',
          created_at: '2026-10-26T09:00:00Z',
        },
        { sha: HEAD, status: 'failed' },
      ],
    );
    const checks = await verbs.readChecks(HEAD);
    expect(calls[0]?.path).toBe(`/projects/1/pipelines?sha=${HEAD}`);
    expect(checks).toEqual([
      {
        id: '901',
        name: 'pipeline',
        app: 'gitlab-ci',
        headSha: HEAD,
        status: 'completed',
        conclusion: 'success',
        detailsUrl: 'https://gitlab.example/p/901',
        startedAt: '2026-10-26T08:00:00Z',
        completedAt: '2026-10-26T08:05:00Z',
      },
      {
        id: '902',
        name: 'nightly',
        app: 'gitlab-ci',
        headSha: HEAD,
        status: 'in_progress',
        conclusion: null,
        detailsUrl: 'https://gitlab.example/sidcorp-it/canawan-admin-hub-fe/-/pipelines/902',
        startedAt: '2026-10-26T09:00:00Z',
        completedAt: null,
      },
    ]);
  });
});

describe('gitlab readChangeRequest', () => {
  it('reads an open request with its description, base and head', async () => {
    const { verbs } = clientAnswering(() => mr());
    expect(await verbs.readChangeRequest(12)).toEqual({
      number: 12,
      url: 'https://gitlab.example/x/-/merge_requests/12',
      title: 'release: stg',
      state: 'open',
      draft: false,
      headRef: 'feat/x-iss-4',
      headSha: HEAD,
      baseRef: 'release/stg',
      baseSha: BASE,
      updatedAt: '2026-10-26T08:00:00Z',
      body: 'Delivers ISS-4',
      mergedAt: null,
      mergeCommitSha: null,
    });
  });

  it('reads a merged request with its landing, and a closed one as closed', async () => {
    const merged = clientAnswering(() =>
      mr({ state: 'merged', merge_commit_sha: MERGE, merged_at: '2026-10-26T09:00:00Z' }),
    );
    expect(await merged.verbs.readChangeRequest(12)).toMatchObject({
      state: 'merged',
      mergeCommitSha: MERGE,
      mergedAt: '2026-10-26T09:00:00Z',
    });
    const closed = clientAnswering(() => mr({ state: 'closed', merge_commit_sha: MERGE }));
    expect(await closed.verbs.readChangeRequest(12)).toMatchObject({
      state: 'closed',
      mergeCommitSha: null,
    });
  });
});

describe('gitlab updateChangeRequest', () => {
  it('sends only what it was given, the description under GitLab’s own name', async () => {
    const { verbs, calls } = clientAnswering(() => mr({ description: 'fixed body' }));
    const read = await verbs.updateChangeRequest({ number: 12, body: 'fixed body' });
    expect(calls).toEqual([
      { method: 'PUT', path: '/projects/1/merge_requests/12', body: { description: 'fixed body' } },
    ]);
    expect(read.body).toBe('fixed body');
  });
});

describe('gitlab closeChangeRequest', () => {
  it('closes an open request with state_event close', async () => {
    const { verbs, calls } = clientAnswering((c) =>
      c.method === 'PUT' ? mr({ state: 'closed' }) : mr(),
    );
    expect((await verbs.closeChangeRequest({ number: 12 })).state).toBe('closed');
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/projects/1/merge_requests/12',
      body: { state_event: 'close' },
    });
  });

  it('answers a closed request as it stands and sends nothing', async () => {
    const { verbs, calls } = clientAnswering(() => mr({ state: 'closed' }));
    expect((await verbs.closeChangeRequest({ number: 12 })).state).toBe('closed');
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });

  it('refuses a merged request by name and sends nothing', async () => {
    const { verbs, calls } = clientAnswering(() =>
      mr({ state: 'merged', merge_commit_sha: MERGE, merged_at: '2026-10-26T09:00:00Z' }),
    );
    const err = await verbs.closeChangeRequest({ number: 12 }).catch((e: unknown) => e);
    expect(isRefusal(err, 'SOURCE_HOST_INPUT_REFUSED')).toBe(true);
    expect(String(err)).toContain('!12');
    expect(calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });
});

// adminhub-api → sidcorp-it/canawan-api, 2026-10-28: a merge through Forge stored no checks for
// MR 5047, since its pipeline ran as a merge request pipeline at a merge ref the head's `sha`
// filter never finds (REQ-63 BC-7)
describe('gitlab readChangeRequestChecks: the merge request pipeline is read at the head it ran for', () => {
  const ownPipeline = {
    id: 3000879911,
    sha: MERGE,
    status: 'success',
    web_url: 'https://gitlab.example/p/3000879911',
    created_at: '2026-10-28T19:25:58Z',
    updated_at: '2026-10-28T19:29:28Z',
  };

  it("adds the request's own head pipeline, recorded at the head, to the head's commit pipelines", async () => {
    const { verbs, calls } = clientAnswering(() => mr({ head_pipeline: ownPipeline }), []);
    const checks = await verbs.readChangeRequestChecks({ number: 12, headSha: HEAD });
    expect(calls.map((c) => c.path)).toEqual([
      `/projects/1/pipelines?sha=${HEAD}`,
      '/projects/1/merge_requests/12',
    ]);
    expect(checks).toEqual([
      {
        id: '3000879911',
        name: 'pipeline',
        app: 'gitlab-ci',
        headSha: HEAD,
        status: 'completed',
        conclusion: 'success',
        detailsUrl: 'https://gitlab.example/p/3000879911',
        startedAt: '2026-10-28T19:25:58Z',
        completedAt: '2026-10-28T19:29:28Z',
      },
    ]);
  });

  it('counts a head pipeline the commit read already holds once', async () => {
    const { verbs } = clientAnswering(
      () => mr({ head_pipeline: { ...ownPipeline, sha: HEAD } }),
      [{ ...ownPipeline, sha: HEAD }],
    );
    const checks = await verbs.readChangeRequestChecks({ number: 12, headSha: HEAD });
    expect(checks.map((c) => c.id)).toEqual(['3000879911']);
  });

  it('answers the head commit pipelines alone where the request ran none of its own', async () => {
    const { verbs } = clientAnswering(() => mr({ head_pipeline: null }), []);
    expect(await verbs.readChangeRequestChecks({ number: 12, headSha: HEAD })).toEqual([]);
  });
});
