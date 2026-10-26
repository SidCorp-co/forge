import { describe, expect, it } from 'vitest';
import type { GitLabClient } from './client.js';
import { type MergeabilityWait, type MergeRequestBody, mergeGitLabMergeRequest } from './merge.js';

// canawan-api !5010..!5013, 2026-10-26: each read `unchecked` right after the request below it in
// the stack merged, was refused `mergeability-unknown`, and merged on a plain retry 20-40s later.

const HEAD = 'a'.repeat(40);
const MERGE = 'm'.repeat(40);

const open = (status: string): MergeRequestBody => ({
  iid: 5011,
  state: 'opened',
  sha: HEAD,
  target_branch: 'release/stg',
  detailed_merge_status: status,
  head_pipeline: { id: 1, status: 'success' },
});

/** A client whose single-request reads answer `statuses` in turn, the last repeated. */
function clientReading(statuses: string[], merged: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string }> = [];
  let read = 0;
  const client = {
    bindingId: 'b1',
    baseUrl: 'https://gitlab.example',
    host: 'gitlab.example',
    fullName: 'acme/canawan-api',
    webUrl: null,
    project: (suffix: string) => `/projects/1${suffix}`,
    json: async <T>(method: string, path: string): Promise<T> => {
      calls.push({ method, path });
      if (path.endsWith('/approvals')) return { approvals_left: 0 } as T;
      if (method === 'PUT') {
        return {
          state: 'merged',
          merge_commit_sha: MERGE,
          merged_at: '2026-10-26T03:45:19.915Z',
          target_branch: 'release/stg',
          sha: HEAD,
          ...merged,
        } as T;
      }
      const status = statuses[Math.min(read, statuses.length - 1)] as string;
      read += 1;
      return open(status) as T;
    },
  } as unknown as GitLabClient;
  return { client, calls, reads: () => read };
}

/** A clock that only moves when the merge sleeps, so the budget is spent in no real time. */
function virtualWait(budgetMs = 30_000): MergeabilityWait & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    budgetMs,
    firstDelayMs: 1_000,
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

describe('mergeGitLabMergeRequest: a mergeability GitLab has not decided yet', () => {
  it('asks GitLab to recheck, waits while it reads `unchecked`, and merges once it reads `mergeable`', async () => {
    const { client, calls } = clientReading(['unchecked', 'checking', 'mergeable']);
    const wait = virtualWait();

    const result = await mergeGitLabMergeRequest(client, { number: 5011 }, wait);

    expect(result).toMatchObject({ kind: 'merged', commitSha: MERGE, target: 'release/stg' });
    const reads = calls.filter((c) => c.method === 'GET' && !c.path.endsWith('/approvals'));
    expect(reads).toHaveLength(3);
    for (const r of reads) {
      expect(r.path).toBe('/projects/1/merge_requests/5011?with_merge_status_recheck=true');
    }
    expect(wait.slept).toEqual([1_000, 2_000]);
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('refuses only once the budget is spent, naming how long it waited and how often it read', async () => {
    const { client, calls } = clientReading(['unchecked']);
    const wait = virtualWait(30_000);

    const result = await mergeGitLabMergeRequest(client, { number: 5011 }, wait);

    expect(result).toMatchObject({ kind: 'refused', reason: 'mergeability-unknown' });
    const detail = (result as { detail: string }).detail;
    expect(detail).toContain('`unchecked`');
    expect(detail).toContain('over 30s');
    expect(detail).toMatch(/read \d+ times/);
    expect(wait.slept.reduce((a, b) => a + b, 0)).toBe(30_000);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('does not wait on a status GitLab has decided', async () => {
    const { client } = clientReading(['broken_status']);
    const wait = virtualWait();

    const result = await mergeGitLabMergeRequest(client, { number: 5011 }, wait);

    expect(result).toMatchObject({ kind: 'refused', reason: 'not-mergeable' });
    expect(wait.slept).toEqual([]);
  });
});

describe('mergeGitLabMergeRequest: the landing it reports', () => {
  it('names the branch the request merged into and the head it merged', async () => {
    const { client } = clientReading(['mergeable']);

    const result = await mergeGitLabMergeRequest(client, { number: 5008 }, virtualWait());

    expect(result).toEqual({
      kind: 'merged',
      commitSha: MERGE,
      mergedAt: new Date('2026-10-26T03:45:19.915Z'),
      target: 'release/stg',
      head: HEAD,
    });
  });

  it('refuses a merge GitLab reports with no target branch, rather than a stamp with none', async () => {
    const { client } = clientReading(['mergeable'], { target_branch: undefined });

    const result = await mergeGitLabMergeRequest(client, { number: 5008 }, virtualWait());

    expect(result).toMatchObject({ kind: 'refused', reason: 'merged-without-evidence' });
    expect((result as { detail: string }).detail).toContain('no target branch');
  });
});
