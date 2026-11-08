import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostCallRefused } from '../../integration-door/source-door.js';
import { SourceHostCallError } from '../source-host/index.js';
import { buildGitLabClient } from './client.js';
import { clearGitLabHolds, retryAtOf } from './cooldown.js';
import { clearGitLabCompares, gitlabSourceHost } from './source-host.js';

// dev core, 2026-10-30: 1,884 of 2,524 compare calls in ten minutes answered 429 under
// `burst_traffic_per_user_free_plan`, each followed by the next call at once.

const NOW = Date.parse('2026-10-30T10:00:00Z');

function clientAs(token: string) {
  return buildGitLabClient({
    bindingId: 'b1',
    config: { projectPath: 'acme/api' } as never,
    secrets: { token } as never,
  });
}

/** A per-user 429 as gitlab.com sends it. */
const perUser = () =>
  new Response(JSON.stringify({ message: 'Retry later' }), {
    status: 429,
    headers: {
      'ratelimit-name': 'burst_traffic_per_user_free_plan',
      'ratelimit-limit': '100',
      'retry-after': '30',
    },
  });
/** The 429 naming no limit: plain "Too many requests", Retry-After 60. */
const bare = () =>
  new Response('Too many requests', { status: 429, headers: { 'retry-after': '60' } });
const ok = () => new Response('{}', { status: 200 });

async function refusalOf(p: Promise<unknown>): Promise<SourceHostCallError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SourceHostCallError);
  return err as SourceHostCallError;
}

describe('a GitLab 429 holds the calls behind it until the wait the host named', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    clearGitLabHolds();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends nothing on that token before Retry-After, and the refusal carries when it may', async () => {
    fetchMock.mockResolvedValueOnce(perUser());
    const first = await refusalOf(clientAs('t1').json('GET', '/projects/1/repository/compare'));
    expect(first.status).toBe(429);
    expect(first.retryAt?.getTime()).toBe(NOW + 30_000);

    vi.setSystemTime(NOW + 29_000);
    const held = await refusalOf(clientAs('t1').json('GET', '/projects/1/repository/compare'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(held.status).toBe(429);
    expect(held.retryAt?.getTime()).toBe(NOW + 30_000);
    expect(held.message).toContain('was not sent');

    // another token on the host is its own user: a per-user limit does not hold it
    fetchMock.mockResolvedValueOnce(ok());
    await clientAs('t2').json('GET', '/projects/1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends again once the wait has passed', async () => {
    fetchMock.mockResolvedValueOnce(perUser());
    await refusalOf(clientAs('t1').json('GET', '/projects/1'));
    vi.setSystemTime(NOW + 30_000);
    fetchMock.mockResolvedValueOnce(ok());
    await expect(clientAs('t1').json('GET', '/projects/1')).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('holds every token on the host where the 429 names no limit', async () => {
    fetchMock.mockResolvedValueOnce(bare());
    const first = await refusalOf(clientAs('t1').json('GET', '/projects/1'));
    expect(first.retryAt?.getTime()).toBe(NOW + 60_000);
    const other = await refusalOf(clientAs('t2').json('GET', '/projects/1'));
    expect(other.retryAt?.getTime()).toBe(NOW + 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('retryAtOf', () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it('reads Retry-After seconds, then an HTTP date, then RateLimit-Reset, then a minute', () => {
    expect(retryAtOf(h({ 'retry-after': '12' }), NOW)).toBe(NOW + 12_000);
    expect(retryAtOf(h({ 'retry-after': 'Fri, 30 Oct 2026 10:00:45 GMT' }), NOW)).toBe(
      NOW + 45_000,
    );
    expect(retryAtOf(h({ 'ratelimit-reset': String(NOW / 1000 + 20) }), NOW)).toBe(NOW + 20_000);
    expect(retryAtOf(h({}), NOW)).toBe(NOW + 60_000);
  });
  it('clamps a wait past fifteen minutes', () => {
    expect(retryAtOf(h({ 'retry-after': '86400' }), NOW)).toBe(NOW + 15 * 60_000);
  });
});

// ISS-1144 (FB-582): a master's change-request read was refused 429 on every pass for 23 hours while
// the connection's budget went elsewhere. A sweep yields the window each wait opens to the read
// someone waits on, and a compare of two commits already read is never asked again.
describe('a 429 that clears goes to the read someone waits on first', () => {
  const fetchMock = vi.fn<typeof fetch>();
  const sweep = () =>
    buildGitLabClient({
      bindingId: 'b1',
      config: { projectPath: 'acme/api' } as never,
      secrets: { token: 't1' } as never,
      background: true,
    });
  beforeEach(() => {
    clearGitLabHolds();
    clearGitLabCompares();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('lets a read go at Retry-After and holds a sweep a minute past it, doubling on a repeat, until it clears', async () => {
    fetchMock.mockResolvedValueOnce(perUser());
    await refusalOf(sweep().json('GET', '/projects/1'));
    vi.setSystemTime(NOW + 30_000);
    const held = await refusalOf(sweep().json('GET', '/projects/1'));
    expect(held.retryAt?.getTime()).toBe(NOW + 90_000);
    fetchMock.mockResolvedValueOnce(ok());
    await expect(clientAs('t1').json('GET', '/projects/1')).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // the host refuses again inside half an hour: the sweep's extra wait doubles
    const again = NOW + 40_000;
    vi.setSystemTime(again);
    fetchMock.mockResolvedValueOnce(perUser());
    await refusalOf(clientAs('t1').json('GET', '/projects/1'));
    vi.setSystemTime(again + 30_000);
    expect((await refusalOf(sweep().json('GET', '/projects/1'))).retryAt?.getTime()).toBe(
      again + 30_000 + 120_000,
    );
    // cleared: the sweep sends again
    vi.setSystemTime(again + 30_000 + 120_000);
    fetchMock.mockResolvedValueOnce(ok());
    await expect(sweep().json('GET', '/projects/1')).resolves.toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('asks GitLab once for the compare of two commits, and every time for a branch', async () => {
    const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
    fetchMock.mockImplementation(async () => new Response('{"commits":[],"diffs":[]}'));
    const host = gitlabSourceHost.build({
      bindingId: 'b1',
      config: { projectPath: 'acme/api' },
      secrets: { token: 't1' },
      background: true,
    });
    expect(await host.compare(a, b)).toBe('identical');
    expect(await host.compare(a, b)).toBe('identical');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await host.compare('main', b);
    await host.compare('main', b);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('names when a refused read may be asked again', () => {
    const err = new SourceHostCallError(429, 'GET /projects/1 on acme/api returned HTTP 429', null);
    err.retryAt = new Date(NOW + 45_000);
    const refused = hostCallRefused(err, NOW);
    expect(refused.refusals[0]?.code).toBe('HOST_UNAVAILABLE');
    expect(refused.refusals[0]?.detail).toContain(
      'Ask again at 2026-10-30T10:00:45.000Z (in 45 s)',
    );
    expect(refused.details).toEqual({ retryAt: '2026-10-30T10:00:45.000Z', retryAfterSeconds: 45 });
  });
});
