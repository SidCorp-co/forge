import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceHostCallError } from '../source-host/index.js';
import { buildGitLabClient } from './client.js';
import { clearGitLabHolds, retryAtOf } from './cooldown.js';

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
