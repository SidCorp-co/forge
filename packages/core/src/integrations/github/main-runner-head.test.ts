import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mainRunnerHead, refreshMainRunnerHead, setMainRunnerHead } from './main-runner-head.js';

const HEAD = 'fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8';

const ok = (body: unknown) =>
  vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  setMainRunnerHead(null);
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
