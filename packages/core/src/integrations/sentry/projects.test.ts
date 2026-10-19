/**
 * ISS-1380 — the Sentry projects a token can read, for the target picker.
 *
 * What is guarded is the difference between "this token reads no project" and "Sentry did not say":
 * every failure is planted and read back by `reason`, and the list a picker would show is never the
 * empty one for a failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerWith, calls, refusalOf } from './agent-read.fixture.js';
import { listSentryProjects, SENTRY_PROJECTS_MAX, SENTRY_PROJECTS_MAX_PAGES } from './projects.js';

const AUTH = { host: 'logs.canawan.com', authToken: 'sntryu_the_secret_token_value' };
const NEXT = (cursor: string) => `<https://x>; rel="next"; results="true"; cursor="${cursor}"`;
const NO_MORE = '<https://x>; rel="next"; results="false"; cursor="z"';
const project = (slug: string, extra: Record<string, unknown> = {}) => ({
  id: slug,
  slug,
  name: slug.toUpperCase(),
  platform: 'node',
  ...extra,
});

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => vi.unstubAllGlobals());

describe('listing one organization', () => {
  it('answers each project as organization, slug, name and platform', async () => {
    answerWith({ body: [project('forge-core'), project('forge-web', { platform: null })] });

    const listing = await listSentryProjects(AUTH, 'canawan');

    expect(listing).toEqual({
      projects: [
        { organizationSlug: 'canawan', slug: 'forge-core', name: 'FORGE-CORE', platform: 'node' },
        { organizationSlug: 'canawan', slug: 'forge-web', name: 'FORGE-WEB', platform: null },
      ],
      truncated: false,
    });
    expect(calls).toEqual(['https://logs.canawan.com/api/0/organizations/canawan/projects/']);
  });

  it('answers none of the project body beyond the four fields', async () => {
    answerWith({ body: [project('a', { dsn: 'https://secret@sentry/1', team: { slug: 't' } })] });

    expect(JSON.stringify(await listSentryProjects(AUTH, 'canawan'))).not.toMatch(
      /dsn|secret|team/,
    );
  });

  it('reads a host given with its scheme and a trailing slash as the same host', async () => {
    answerWith({ body: [] });

    await listSentryProjects({ ...AUTH, host: 'https://logs.canawan.com/' }, 'canawan');

    expect(calls[0]).toBe('https://logs.canawan.com/api/0/organizations/canawan/projects/');
  });
});

describe('listing every organization the token lists', () => {
  it('walks each organization and answers its projects beside its slug', async () => {
    answerWith(
      { body: [{ slug: 'canawan' }, { slug: 'other' }] },
      { body: [project('forge-core')] },
      { body: [project('billing')] },
    );

    const listing = await listSentryProjects(AUTH);

    expect(listing.projects.map((p) => `${p.organizationSlug}/${p.slug}`)).toEqual([
      'canawan/forge-core',
      'other/billing',
    ]);
    expect(calls[0]).toBe('https://logs.canawan.com/api/0/organizations/');
  });

  it('refuses a token that reads no organization, naming the host, instead of answering an empty list', async () => {
    answerWith({ body: [] });

    const refusal = await refusalOf(() => listSentryProjects(AUTH));

    expect(refusal.reason).toBe('no_organization');
    expect(refusal.message).toContain('logs.canawan.com');
  });
});

describe('a listing that is longer than one page', () => {
  it('follows the cursor and answers every project when it ends inside the bound', async () => {
    answerWith(
      { body: [project('a'), project('b')], link: NEXT('c1') },
      { body: [project('c')], link: NO_MORE },
    );

    const listing = await listSentryProjects(AUTH, 'canawan');

    expect(listing.projects.map((p) => p.slug)).toEqual(['a', 'b', 'c']);
    expect(listing.truncated).toBe(false);
    expect(calls[1]).toContain('cursor=c1');
  });

  it('stops at the page bound and says it did, with the projects it read', async () => {
    answerWith({ body: [project('a')], link: NEXT('forever') });

    const listing = await listSentryProjects(AUTH, 'canawan');

    expect(calls).toHaveLength(SENTRY_PROJECTS_MAX_PAGES);
    expect(listing.truncated).toBe(true);
    expect(listing.projects).toHaveLength(SENTRY_PROJECTS_MAX_PAGES);
  });

  it('stops at the project bound and says it did', async () => {
    const many = Array.from({ length: SENTRY_PROJECTS_MAX + 5 }, (_, i) => project(`p${i}`));
    answerWith({ body: many });

    const listing = await listSentryProjects(AUTH, 'canawan');

    expect(listing.projects).toHaveLength(SENTRY_PROJECTS_MAX);
    expect(listing.truncated).toBe(true);
  });

  it('does not call a list of exactly the bound truncated', async () => {
    answerWith({ body: Array.from({ length: SENTRY_PROJECTS_MAX }, (_, i) => project(`p${i}`)) });

    expect((await listSentryProjects(AUTH, 'canawan')).truncated).toBe(false);
  });
});

describe('what Sentry can answer instead of a list', () => {
  it.each([
    [401, 'credential_rejected'],
    [403, 'scope_missing'],
    [404, 'sentry_http_error'],
    [500, 'sentry_http_error'],
  ])('refuses an HTTP %i as %s, carrying the status', async (status, reason) => {
    answerWith({ status, body: { detail: 'no' } });

    const refusal = await refusalOf(() => listSentryProjects(AUTH, 'canawan'));

    expect(refusal.reason).toBe(reason);
    expect(refusal.httpStatus).toBe(status);
  });

  it('refuses a body that is not JSON as unreadable_answer, carrying the status Sentry sent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      })),
    );

    const refusal = await refusalOf(() => listSentryProjects(AUTH, 'canawan'));

    expect(refusal.reason).toBe('unreadable_answer');
    expect(refusal.httpStatus).toBe(200);
    expect(refusal.message).toContain('HTTP 200');
    expect(refusal.message).toContain('not JSON');
  });

  it('refuses an unreachable host as sentry_unreachable and names the URL it tried', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND logs.canawan.com');
      }),
    );

    const refusal = await refusalOf(() => listSentryProjects(AUTH, 'canawan'));

    expect(refusal.reason).toBe('sentry_unreachable');
    expect(refusal.message).toContain('/api/0/organizations/canawan/projects/');
  });

  it('never puts the token in a refusal, even where the transport error carries it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`socket closed while sending Bearer ${AUTH.authToken}`);
      }),
    );

    const refusal = await refusalOf(() => listSentryProjects(AUTH, 'canawan'));

    expect(refusal.message).not.toContain(AUTH.authToken);
    expect(refusal.message).toContain('[redacted]');
  });

  it.each([
    ['an object', { projects: [] }],
    ['null', null],
    ['a string', 'maintenance'],
  ])('refuses %s where a list was owed, instead of answering an empty one', async (_what, body) => {
    answerWith({ body });

    const refusal = await refusalOf(() => listSentryProjects(AUTH, 'canawan'));

    expect(refusal.reason).toBe('unreadable_answer');
  });

  it('refuses a project with no slug, because it cannot be offered as a target', async () => {
    answerWith({ body: [project('a'), { id: '9', name: 'nameless' }] });

    expect((await refusalOf(() => listSentryProjects(AUTH, 'canawan'))).reason).toBe(
      'unreadable_answer',
    );
  });

  it('refuses a failure on the second organization rather than answering the first one alone', async () => {
    answerWith(
      { body: [{ slug: 'canawan' }, { slug: 'other' }] },
      { body: [project('a')] },
      { status: 403, body: {} },
    );

    const refusal = await refusalOf(() => listSentryProjects(AUTH));

    expect(refusal.reason).toBe('scope_missing');
  });
});

describe('a token in its rotation overlap', () => {
  it('retries once with the previous token on a 401 and answers the list', async () => {
    const tokens: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
        tokens.push(init.headers.Authorization ?? '');
        const ok = init.headers.Authorization === 'Bearer sntryu_previous_token_value';
        return {
          ok,
          status: ok ? 200 : 401,
          headers: { get: () => null },
          json: async () => (ok ? [project('a')] : {}),
        };
      }),
    );

    const listing = await listSentryProjects(
      { ...AUTH, previousAuthToken: 'sntryu_previous_token_value' },
      'canawan',
    );

    expect(listing.projects).toHaveLength(1);
    expect(tokens).toEqual([`Bearer ${AUTH.authToken}`, 'Bearer sntryu_previous_token_value']);
  });
});
