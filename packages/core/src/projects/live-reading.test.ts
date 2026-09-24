import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubClientError, type GitHubRepoClient } from '../integrations/github/client.js';
import {
  forgetAllLiveReadings,
  forgetLiveReading,
  LIVE_READING_FIRST_WAIT_MS,
  LIVE_READING_HOLD_MS,
  type LiveReadingDeps,
  liveReadingForRow,
  type ProjectReleaseRow,
} from './live-reading.js';

const row: ProjectReleaseRow = {
  id: 'p1',
  releaseModel: 'promote',
  releaseStrategy: 'merge-branch',
  baseBranch: 'staging',
  liveBranch: 'master',
};

let clock = new Date('2026-09-23T14:00:00Z').getTime();
let compares = 0;

function fakeClient(delayMs = 0): GitHubRepoClient {
  return {
    bindingId: 'b',
    appId: '1',
    owner: 'o',
    repo: 'r',
    fullName: 'o/r',
    get: (async (path: string) => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (path.includes('/heads/'))
        return { object: { sha: path.endsWith('staging') ? 'b1' : 'l1' } };
      compares += 1;
      return { ahead_by: 0, commits: [] };
    }) as GitHubRepoClient['get'],
    publish: async () => {
      throw new Error('no publish');
    },
  };
}

function deps(client: () => Promise<GitHubRepoClient>): LiveReadingDeps {
  return { clientFor: client, now: () => new Date(clock) };
}

beforeEach(() => {
  forgetAllLiveReadings();
  clock = new Date('2026-09-23T14:00:00Z').getTime();
  compares = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('liveReadingForRow', () => {
  it('gives nothing for a project whose release model is not promote', async () => {
    const d = deps(async () => fakeClient());
    await expect(liveReadingForRow({ ...row, releaseModel: 'publish' }, d)).resolves.toBeNull();
    expect(compares).toBe(0);
  });

  it('holds a reading for five minutes and takes a new one on the first read after', async () => {
    const d = deps(async () => fakeClient());
    const first = await liveReadingForRow(row, d);
    expect(first?.kind).toBe('measured');
    clock += LIVE_READING_HOLD_MS - 1;
    expect(await liveReadingForRow(row, d)).toBe(first);
    expect(compares).toBe(1);
    clock += 2;
    const next = await liveReadingForRow(row, d);
    expect(compares).toBe(2);
    expect(next).not.toBe(first);
  });

  it('shares one in-flight reading between concurrent reads', async () => {
    const d = deps(async () => fakeClient());
    await Promise.all([
      liveReadingForRow(row, d),
      liveReadingForRow(row, d),
      liveReadingForRow(row, d),
    ]);
    expect(compares).toBe(1);
  });

  it('takes a new reading once a push has dropped the held one', async () => {
    const d = deps(async () => fakeClient());
    await liveReadingForRow(row, d);
    forgetLiveReading('p1');
    await liveReadingForRow(row, d);
    expect(compares).toBe(2);
  });

  it('takes a new reading when the branches it was taken for changed', async () => {
    const d = deps(async () => fakeClient());
    await liveReadingForRow(row, d);
    await liveReadingForRow({ ...row, liveBranch: 'production' }, d);
    expect(compares).toBe(2);
  });

  it('waits no longer than three seconds for a first reading, then says it is still being taken', async () => {
    vi.useFakeTimers();
    const d = deps(async () => fakeClient(LIVE_READING_FIRST_WAIT_MS * 3));
    const read = liveReadingForRow(row, d);
    await vi.advanceTimersByTimeAsync(LIVE_READING_FIRST_WAIT_MS);
    const r = await read;
    expect(r).toMatchObject({ kind: 'pending', baseBranch: 'staging', liveBranch: 'master' });
    expect(r?.kind === 'pending' && r.reason).toMatch(/still being taken/);
    await vi.advanceTimersByTimeAsync(LIVE_READING_FIRST_WAIT_MS * 10);
    expect((await liveReadingForRow(row, d))?.kind).toBe('measured');
  });

  it('refuses a cherry-pick project by name without asking GitHub', async () => {
    const clientFor = vi.fn(async () => fakeClient());
    const r = await liveReadingForRow({ ...row, releaseStrategy: 'cherry-pick' }, deps(clientFor));
    expect(r?.kind === 'refused' && r.reason).toMatch(/cherry-pick/);
    expect(clientFor).not.toHaveBeenCalled();
  });

  it('refuses a promote project naming no base branch', async () => {
    const r = await liveReadingForRow(
      { ...row, baseBranch: null },
      deps(async () => fakeClient()),
    );
    expect(r).toMatchObject({ kind: 'refused', baseBranch: null, liveBranch: 'master' });
    expect(r?.kind === 'refused' && r.reason).toMatch(/names no base branch/);
  });

  it('carries the client sentence when the project cannot be read as the App', async () => {
    const r = await liveReadingForRow(
      row,
      deps(async () => {
        throw new GitHubClientError('no_binding', 'this project has no active GitHub binding');
      }),
    );
    expect(r).toMatchObject({
      kind: 'refused',
      reason: 'this project has no active GitHub binding',
    });
  });
});
