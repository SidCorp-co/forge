/**
 * ISS-1085 slice 3 — the Sentry issue LISTING: the request core issues, and the confinement that
 * makes a declared target label load-bearing rather than decorative.
 *
 * Its own file because `issues.test.ts` reached the 500-line budget: these cases share that file's
 * subject but none of its assertions, and the scaffolding below is deliberately a second copy
 * rather than an import, so neither file can silently change the other's fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordDeliveryMock = vi.fn();
const updateDeliveryMock = vi.fn();
const updateConnectionMock = vi.fn();

vi.mock('../deliveries.js', () => ({
  recordDelivery: (...a: unknown[]) => recordDeliveryMock(...(a as [])),
  updateDelivery: (...a: unknown[]) => updateDeliveryMock(...(a as [])),
}));
vi.mock('../store.js', () => ({
  updateConnection: (...a: unknown[]) => updateConnectionMock(...(a as [])),
}));

const { dispatchSentryOutbound, listSentryIssues, SENTRY_ISSUE_LIST } = await import('./issues.js');

const BINDING_ID = 'bind-sentry-1';
const LIST_URL_PREFIX = 'https://logs.canawan.com/api/0/organizations/canawan/issues/?';

const TWO_TARGETS = [
  { label: 'forge-core', organizationSlug: 'canawan', projectSlug: 'forge-core' },
  { label: 'forge-web', organizationSlug: 'canawan', projectSlug: 'forge-web' },
];

const originalFetch = globalThis.fetch;

beforeEach(() => {
  recordDeliveryMock.mockResolvedValue('del-1');
  updateDeliveryMock.mockResolvedValue(undefined);
  updateConnectionMock.mockResolvedValue({});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

function buildCtx(
  secrets: Record<string, unknown> = { authToken: 'sntryu_current' },
  targets: unknown[] = TWO_TARGETS,
) {
  return {
    projectId: '33333333-3333-4333-8333-333333333333',
    connectionId: 'conn-sentry-1',
    bindingId: BINDING_ID,
    provider: 'sentry',
    role: 'service',
    stages: [],
    config: { host: 'logs.canawan.com', targets },
    secrets,
    integrationSecret: null,
    // biome-ignore lint/suspicious/noExplicitAny: adapter ctx generics are resolved at registration
  } as any;
}

/** The shape Sentry answers with, trimmed to the fields core keeps. */
function sentryBody(over: Record<string, unknown> = {}) {
  return {
    id: '4411',
    shortId: 'FORGE-CORE-9K',
    status: 'unresolved',
    substatus: 'ongoing',
    level: 'error',
    count: '17',
    userCount: 3,
    firstSeen: '2026-09-01T00:00:00Z',
    lastSeen: '2026-09-17T09:00:00Z',
    permalink: 'https://logs.canawan.com/organizations/canawan/issues/4411/',
    project: { slug: 'forge-core' },
    title: 'TypeError: cannot read x',
    culprit: 'app/chat/send',
    metadata: { value: 'cannot read x of undefined' },
    ...over,
  };
}

function answerOnce(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return calls;
}

function deliveryResponse(): Record<string, unknown> {
  const patch = updateDeliveryMock.mock.calls.at(-1)?.[1] as { response?: unknown } | undefined;
  return (patch?.response ?? {}) as Record<string, unknown>;
}

describe('listSentryIssues — the request core issues', () => {
  it('issues ONE org-scoped GET carrying the connection auth token as a bearer', async () => {
    const calls = answerOnce([sentryBody()]);
    await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error('no call recorded');
    expect(call.url.startsWith(LIST_URL_PREFIX)).toBe(true);
    expect(call.init.method).toBe('GET');
    expect((call.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer sntryu_current',
    );
    expect(call.init.body).toBeUndefined();
  });

  it("puts the target's own project slug into the query rather than assuming the org is scoped", async () => {
    const calls = answerOnce([sentryBody()]);
    await listSentryIssues(buildCtx(), { targetLabel: 'forge-web' });
    const url = new URL(String(calls[0]?.url));
    expect(url.searchParams.get('query')).toBe('is:unresolved project:forge-web');
    expect(url.pathname).toBe('/api/0/organizations/canawan/issues/');
  });

  it('refuses a limit that is not a whole number of at least 1, before any call is made', async () => {
    const calls = answerOnce([]);
    await expect(
      listSentryIssues(buildCtx(), { targetLabel: 'forge-core', limit: 0 }),
    ).rejects.toThrow(
      'sentry: 0 is not a listing limit — it has to be a whole number of at least 1',
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses a body that is not an array rather than reading zero issues out of it', async () => {
    answerOnce({ detail: 'nope' });
    await expect(listSentryIssues(buildCtx(), { targetLabel: 'forge-core' })).rejects.toThrow(
      /answered object, and an issue listing has to be an array/,
    );
    expect(updateDeliveryMock.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'failed' });
  });
});

describe('listSentryIssues — confinement to the named target', () => {
  it('admits only the answers belonging to the target project', async () => {
    answerOnce([
      sentryBody({ id: '1', shortId: 'A-1', project: { slug: 'forge-core' } }),
      sentryBody({ id: '2', shortId: 'B-2', project: { slug: 'forge-web' } }),
      sentryBody({ id: '3', shortId: 'C-3', project: {} }),
    ]);
    const listing = await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' });
    expect(listing.issues.map((i) => i.shortId)).toEqual(['A-1']);
  });

  it('names EACH refused answer by its issue id and the project it belongs to, never a count', async () => {
    answerOnce([
      sentryBody({ id: '1', shortId: 'A-1', project: { slug: 'forge-core' } }),
      sentryBody({ id: '2', shortId: 'B-2', project: { slug: 'forge-web' } }),
      sentryBody({ id: '3', shortId: 'C-3', project: {} }),
    ]);
    const listing = await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' });

    expect(listing.refused).toEqual([
      {
        issueId: '2',
        shortId: 'B-2',
        belongsTo: 'forge-web',
        reason: 'belongs to project forge-web, and target "forge-core" is scoped to forge-core',
      },
      {
        issueId: '3',
        shortId: 'C-3',
        belongsTo: null,
        reason:
          'Sentry named no project for this issue, so it cannot be confined to target "forge-core" (scoped to forge-core)',
      },
    ]);
    // and the same, in the row an operator reads
    expect(deliveryResponse()).toMatchObject({ admitted: 1, refused: listing.refused });
  });

  it('confines nothing where the target declares no project slug — org-wide is the operator own declaration', async () => {
    answerOnce([
      sentryBody({ id: '1', shortId: 'A-1', project: { slug: 'forge-core' } }),
      sentryBody({ id: '2', shortId: 'B-2', project: { slug: 'anything-else' } }),
    ]);
    const ctx = buildCtx({ authToken: 'sntryu_current' }, [
      { label: 'whole-org', organizationSlug: 'canawan' },
    ]);
    const listing = await listSentryIssues(ctx, { targetLabel: 'whole-org' });
    expect(listing.issues.map((i) => i.shortId)).toEqual(['A-1', 'B-2']);
    expect(listing.refused).toEqual([]);
  });

  it('records one outbound delivery row named for the listing event', async () => {
    answerOnce([sentryBody()]);
    await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' }, 'req-list-1');
    expect(recordDeliveryMock).toHaveBeenCalledTimes(1);
    expect(recordDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: BINDING_ID,
        direction: 'outbound',
        eventName: SENTRY_ISSUE_LIST,
        requestId: 'req-list-1',
      }),
    );
    expect(updateDeliveryMock.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'ok' });
  });

  it('is reachable through the generic dispatch door under its own event name', async () => {
    answerOnce([sentryBody()]);
    await dispatchSentryOutbound(buildCtx(), {
      eventName: SENTRY_ISSUE_LIST,
      payload: { targetLabel: 'forge-core' },
      // biome-ignore lint/suspicious/noExplicitAny: OutboundDispatchInput carries more than this test needs
    } as any);
    expect(recordDeliveryMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventName: SENTRY_ISSUE_LIST }),
    );
  });

  it('refuses an undeclared target label before any call is made', async () => {
    const calls = answerOnce([]);
    await expect(listSentryIssues(buildCtx(), { targetLabel: 'forge-mobile' })).rejects.toThrow(
      'sentry: no target labelled "forge-mobile" — this binding declares: forge-core, forge-web',
    );
    expect(calls).toHaveLength(0);
  });
});

// ── F1 from the review of the landing head: the listing followed one page and said nothing ───────

const { nextSentryCursor, SENTRY_LIST_MAX_PAGES } = await import('./issues.js');

/** Answer a sequence of pages, each with the Link header Sentry would send for it. */
function answerPages(pages: { body: unknown[]; more: boolean }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const page = pages[Math.min(n, pages.length - 1)];
    n += 1;
    const more = page?.more ?? false;
    return new Response(JSON.stringify(page?.body ?? []), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        link: `<https://x/prev>; rel="previous"; results="false"; cursor="p", <https://x/next>; rel="next"; results="${more}"; cursor="c${n}"`,
      },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe('nextSentryCursor', () => {
  it('reads the cursor only where Sentry says the next page has results', () => {
    expect(nextSentryCursor('<https://x>; rel="next"; results="true"; cursor="abc"')).toBe('abc');
  });

  // cm:guard Sentry ALWAYS emits a rel="next"; `results="false"` is the only thing that says the
  // page is empty. Reading the header's presence as "there is more" would make every listing walk
  // to its page bound and report itself incomplete on a complete answer.
  it('answers null where the next page has no results, although the link is present', () => {
    expect(nextSentryCursor('<https://x>; rel="next"; results="false"; cursor="abc"')).toBeNull();
  });

  it('answers null for no header at all', () => {
    expect(nextSentryCursor(null)).toBeNull();
  });
});

describe('listSentryIssues — pagination', () => {
  it('follows the cursor and returns the issues from BOTH pages', async () => {
    const calls = answerPages([
      { body: [sentryBody({ id: '1', shortId: 'A-1' })], more: true },
      { body: [sentryBody({ id: '2', shortId: 'B-2' })], more: false },
    ]);
    const listing = await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' });

    expect(calls).toHaveLength(2);
    expect(new URL(String(calls[1]?.url)).searchParams.get('cursor')).toBe('c1');
    expect(listing.issues.map((i) => i.shortId)).toEqual(['A-1', 'B-2']);
    expect(listing.pages).toBe(2);
    expect(listing.truncated).toBe(false);
  });

  it('makes ONE call where the first page is the last', async () => {
    const calls = answerPages([{ body: [sentryBody()], more: false }]);
    const listing = await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' });
    expect(calls).toHaveLength(1);
    expect(listing.pages).toBe(1);
    expect(listing.truncated).toBe(false);
  });

  it('stops at its page bound and reports truncated rather than reporting a complete listing', async () => {
    const calls = answerPages([{ body: [sentryBody()], more: true }]);
    const listing = await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' });

    expect(calls).toHaveLength(SENTRY_LIST_MAX_PAGES);
    expect(listing.pages).toBe(SENTRY_LIST_MAX_PAGES);
    expect(listing.truncated).toBe(true);
    expect(deliveryResponse()).toMatchObject({ truncated: true, pages: SENTRY_LIST_MAX_PAGES });
  });

  it('records the page count in the delivery row on a complete listing too', async () => {
    answerPages([
      { body: [sentryBody({ id: '1', shortId: 'A-1' })], more: true },
      { body: [sentryBody({ id: '2', shortId: 'B-2' })], more: false },
    ]);
    await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' });
    expect(deliveryResponse()).toMatchObject({ pages: 2, truncated: false, admitted: 2 });
  });
});

const { SentryListingFailed } = await import('./listing.js');

describe('listSentryIssues — a walk that fails part way keeps what it decided', () => {
  /** Page one answers; page two fails. */
  function answerThenFail(firstPage: unknown[], status: number) {
    let n = 0;
    globalThis.fetch = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return new Response(JSON.stringify(firstPage), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            link: '<https://x>; rel="next"; results="true"; cursor="c1"',
          },
        });
      }
      return new Response('{"detail":"boom"}', {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
  }

  // cm:guard this drives the REAL listing. An earlier version of this assertion built the error by
  // hand in the intake test and passed against a `listSentryIssues` that filled the partial with
  // nothing — the mutation that empties it survived. What is asserted here is that the production
  // walk puts its own findings on the failure.
  it('throws carrying the pages walked and the refusals already named', async () => {
    answerThenFail(
      [
        sentryBody({ id: '1', shortId: 'A-1', project: { slug: 'forge-core' } }),
        sentryBody({ id: '2', shortId: 'B-2', project: { slug: 'forge-web' } }),
      ],
      500,
    );

    const err = await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' }).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(SentryListingFailed);
    const failed = err as InstanceType<typeof SentryListingFailed>;
    expect(failed.partial.pages).toBe(1);
    expect(failed.partial.refused).toEqual([
      {
        issueId: '2',
        shortId: 'B-2',
        belongsTo: 'forge-web',
        reason: 'belongs to project forge-web, and target "forge-core" is scoped to forge-core',
      },
    ]);
    expect(failed.message).toMatch(/Sentry answered HTTP 500/);
  });

  it('still settles the delivery row failed — the partial does not soften the failure', async () => {
    answerThenFail([sentryBody({ id: '2', shortId: 'B-2', project: { slug: 'forge-web' } })], 500);
    await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' }).catch(() => undefined);
    expect(updateDeliveryMock.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'failed' });
  });

  it('carries a partial of zero where page ONE is the one that failed', async () => {
    answerThenFail([], 500);
    globalThis.fetch = vi.fn(
      async () => new Response('{"detail":"boom"}', { status: 500 }),
    ) as unknown as typeof fetch;

    const err = (await listSentryIssues(buildCtx(), { targetLabel: 'forge-core' }).catch(
      (e: unknown) => e,
    )) as InstanceType<typeof SentryListingFailed>;

    expect(err).toBeInstanceOf(SentryListingFailed);
    expect(err.partial).toEqual({ pages: 0, refused: [] });
  });
});
