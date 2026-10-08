import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetReleaseContainment,
  mainRunnerHead,
  refreshMainRunnerHead,
  releaseContainsRunnerHead,
  setMainRunnerHead,
} from './main-runner-head.js';

const HEAD = 'fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8';

const ok = (body: unknown) =>
  vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  setMainRunnerHead(null);
  forgetReleaseContainment();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setMainRunnerHead(null);
});

describe('refreshMainRunnerHead', () => {
  it('reads the newest commit under the runner package on the default branch', async () => {
    const fetchMock = ok([{ sha: HEAD }, { sha: 'older' }]);
    vi.stubGlobal('fetch', fetchMock);
    expect(await refreshMainRunnerHead()).toBe(HEAD);
    expect(mainRunnerHead()).toBe(HEAD);
  });

  it('asks for one commit on the branch, filtered to the runner package', async () => {
    const fetchMock = ok([{ sha: HEAD }]);
    vi.stubGlobal('fetch', fetchMock);
    await refreshMainRunnerHead();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/commits?');
    expect(url).toContain('sha=main');
    expect(url).toContain(`path=${encodeURIComponent('packages/runner')}`);
    expect(url).toContain('per_page=1');
  });

  it('answers null rather than throwing when GitHub refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    );
    await expect(refreshMainRunnerHead()).resolves.toBeNull();
  });

  it('answers null rather than throwing when the request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    await expect(refreshMainRunnerHead()).resolves.toBeNull();
  });

  it('answers null where the branch holds no commit under that path', async () => {
    vi.stubGlobal('fetch', ok([]));
    await expect(refreshMainRunnerHead()).resolves.toBeNull();
  });

  it('keeps the head it last read when a later read fails', async () => {
    vi.stubGlobal('fetch', ok([{ sha: HEAD }]));
    await refreshMainRunnerHead();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await refreshMainRunnerHead();
    // A failed read is not evidence that the branch moved: dropping the head would
    // flip every box's verdict from behind to unknown on one bad response.
    expect(mainRunnerHead()).toBe(HEAD);
  });

  it('has no head before anything has been read', () => {
    expect(mainRunnerHead()).toBeNull();
  });
});

describe('releaseContainsRunnerHead', () => {
  // The release is stamped at the merge that brought the newest runner commit in, so it
  // is a descendant of that commit and not equal to it. GitHub's compare answers
  // `ahead` for exactly that, with the runner head as the base.
  const RELEASE = '54a2e89e229d68d34086bc77ae8705acc9842c44';
  const compare = (status: string) => ok({ status });

  it('asks GitHub to compare the runner head, as base, with the release commit', async () => {
    const fetchMock = compare('ahead');
    vi.stubGlobal('fetch', fetchMock);
    await releaseContainsRunnerHead(RELEASE, HEAD);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain(`/compare/${HEAD}...${RELEASE}`);
  });

  it('holds a release that is a descendant of the runner head', async () => {
    vi.stubGlobal('fetch', compare('ahead'));
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBe(true);
  });

  it('holds a release that is the runner head itself', async () => {
    vi.stubGlobal('fetch', compare('identical'));
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBe(true);
  });

  it('does not hold a release older than the runner head', async () => {
    vi.stubGlobal('fetch', compare('behind'));
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBe(false);
  });

  it('does not hold a release on a line that has diverged from the runner head', async () => {
    vi.stubGlobal('fetch', compare('diverged'));
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBe(false);
  });

  it('cannot say where GitHub refuses, and where it names a status it has no meaning for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 })),
    );
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBeNull();
    vi.stubGlobal('fetch', compare('sideways'));
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBeNull();
    vi.stubGlobal('fetch', ok({}));
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBeNull();
  });

  it('cannot say where the request itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBeNull();
  });

  it('asks once for a pair, because the ancestry of two commits cannot change', async () => {
    const fetchMock = compare('ahead');
    vi.stubGlobal('fetch', fetchMock);
    await releaseContainsRunnerHead(RELEASE, HEAD);
    await releaseContainsRunnerHead(RELEASE, HEAD);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('asks again after an answer it could not read, which says nothing about the commits', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    await releaseContainsRunnerHead(RELEASE, HEAD);
    const fetchMock = compare('ahead');
    vi.stubGlobal('fetch', fetchMock);
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps one answer per pair', async () => {
    vi.stubGlobal('fetch', compare('ahead'));
    await releaseContainsRunnerHead(RELEASE, HEAD);
    vi.stubGlobal('fetch', compare('behind'));
    await expect(releaseContainsRunnerHead(RELEASE, 'a'.repeat(40))).resolves.toBe(false);
    await expect(releaseContainsRunnerHead(RELEASE, HEAD)).resolves.toBe(true);
  });
});
