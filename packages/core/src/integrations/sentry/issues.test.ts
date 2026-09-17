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

const { dispatchSentryOutbound, readSentryIssue, setSentryIssueStatus } = await import(
  './issues.js'
);

const CONN_ID = 'conn-sentry-1';
const BINDING_ID = 'bind-sentry-1';
const ISSUE_URL = 'https://logs.canawan.com/api/0/organizations/canawan/issues/4411/';

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
    connectionId: CONN_ID,
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

/** The single `updateDelivery` patch, so a test names the row it asserts on. */
function deliveryPatch() {
  return updateDeliveryMock.mock.calls[0]?.[1] as {
    status: string;
    response?: unknown;
    errorMessage?: string;
    durationMs?: number;
  };
}

describe('readSentryIssue — criterion 4', () => {
  it('issues one GET to the org-scoped issue URL carrying the token as a bearer', async () => {
    const calls = answerOnce(sentryBody());

    const { issue, result } = await readSentryIssue(buildCtx(), {
      issueId: '4411',
      targetLabel: 'forge-core',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ISSUE_URL);
    expect(calls[0]?.init.method).toBe('GET');
    expect(((calls[0]?.init.headers ?? {}) as Record<string, string>).Authorization).toBe(
      'Bearer sntryu_current',
    );
    expect(calls[0]?.init.body).toBeUndefined();
    expect(issue.shortId).toBe('FORGE-CORE-9K');
    // Sentry answers `count` as a string on some versions and a number on others.
    expect(issue.count).toBe(17);
    expect(issue.userCount).toBe(3);
    expect(result.externalId).toBe('FORGE-CORE-9K');
  });
});

describe('setSentryIssueStatus — criteria 5 and 6', () => {
  it('issues one PUT to the same URL whose body carries the new status', async () => {
    const calls = answerOnce(sentryBody({ status: 'resolvedInNextRelease' }));

    const { issue } = await setSentryIssueStatus(buildCtx(), {
      issueId: '4411',
      targetLabel: 'forge-core',
      status: 'resolvedInNextRelease',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(ISSUE_URL);
    expect(calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: 'resolvedInNextRelease' });
    expect(issue.status).toBe('resolvedInNextRelease');
  });

  it('refuses a status Sentry does not accept, naming the value it was given', async () => {
    const calls = answerOnce(sentryBody());

    await expect(
      setSentryIssueStatus(buildCtx(), {
        issueId: '4411',
        targetLabel: 'forge-core',
        // biome-ignore lint/suspicious/noExplicitAny: the whole point is a value outside the union
        status: 'done' as any,
      }),
    ).rejects.toThrow(/"done" is not a Sentry issue status/);
    // The refusal happens before any call reaches Sentry.
    expect(calls).toHaveLength(0);
    expect(deliveryPatch().status).toBe('failed');
    expect(deliveryPatch().errorMessage).toMatch(
      /resolved, resolvedInNextRelease, ignored, unresolved/,
    );
  });

  it('refuses a dispatch naming no issueId', async () => {
    answerOnce(sentryBody());
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: a caller that omitted the field
      setSentryIssueStatus(buildCtx(), { targetLabel: 'forge-core', status: 'resolved' } as any),
    ).rejects.toThrow(/names no `issueId`/);
  });
});

describe('target refusals — criteria 7, 8 and 9', () => {
  it('refuses a label the binding does not declare, listing the ones it does', async () => {
    const calls = answerOnce(sentryBody());
    await expect(
      readSentryIssue(buildCtx(), { issueId: '4411', targetLabel: 'forge-mobile' }),
    ).rejects.toThrow(
      'sentry: no target labelled "forge-mobile" — this binding declares: forge-core, forge-web',
    );
    expect(calls).toHaveLength(0);
  });

  it('refuses an absent label where the binding declares more than one target', async () => {
    answerOnce(sentryBody());
    await expect(readSentryIssue(buildCtx(), { issueId: '4411' })).rejects.toThrow(
      'sentry: no target label was named and this binding declares 2: forge-core, forge-web',
    );
  });

  it('takes the only target where the binding declares exactly one', async () => {
    const calls = answerOnce(sentryBody());
    await readSentryIssue(buildCtx({ authToken: 'sntryu_current' }, [TWO_TARGETS[0]]), {
      issueId: '4411',
    });
    expect(calls[0]?.url).toBe(ISSUE_URL);
  });

  it('refuses a target that declares no organizationSlug, naming that target', async () => {
    await expect(
      readSentryIssue(buildCtx({ authToken: 'sntryu_current' }, [{ label: 'forge-core' }]), {
        issueId: '4411',
      }),
    ).rejects.toThrow('sentry: target "forge-core" declares no organizationSlug');
  });

  it('refuses a binding that declares no targets at all', async () => {
    await expect(
      readSentryIssue(buildCtx({ authToken: 'sntryu_current' }, []), { issueId: '4411' }),
    ).rejects.toThrow('sentry: this binding declares no targets');
  });
});

describe('the delivery log — criterion 10', () => {
  it('records one outbound row per dispatch and settles it ok', async () => {
    answerOnce(sentryBody());
    await readSentryIssue(buildCtx(), { issueId: '4411', targetLabel: 'forge-core' }, 'req-9');

    expect(recordDeliveryMock).toHaveBeenCalledTimes(1);
    const row = recordDeliveryMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row.bindingId).toBe(BINDING_ID);
    expect(row.direction).toBe('outbound');
    expect(row.eventName).toBe('sentry.issue.read');
    expect(row.status).toBe('pending');
    expect(row.requestId).toBe('req-9');
    // The recorded payload IS the request, which is what makes a retry a replay.
    expect(row.payload).toEqual({ issueId: '4411', targetLabel: 'forge-core' });

    expect(updateDeliveryMock).toHaveBeenCalledTimes(1);
    expect(deliveryPatch().status).toBe('ok');
    expect(typeof deliveryPatch().durationMs).toBe('number');
  });

  it('settles the row failed, carrying the message, when Sentry answers an HTTP error', async () => {
    answerOnce('boom', 500);
    await expect(
      readSentryIssue(buildCtx(), { issueId: '4411', targetLabel: 'forge-core' }),
    ).rejects.toThrow(/Sentry answered HTTP 500/);
    expect(deliveryPatch().status).toBe('failed');
    expect(deliveryPatch().errorMessage).toMatch(/Sentry answered HTTP 500/);
  });

  it('settles the row failed when the refusal never reaches Sentry at all', async () => {
    await expect(
      readSentryIssue(buildCtx(), { issueId: '4411', targetLabel: 'nope' }),
    ).rejects.toThrow();
    expect(recordDeliveryMock).toHaveBeenCalledTimes(1);
    expect(deliveryPatch().status).toBe('failed');
  });
});

describe('the credential and the health it earns — criteria 11, 12 and 13', () => {
  function answerByToken(reject: string[]) {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? '';
      seen.push(auth);
      if (reject.includes(auth)) return new Response('nope', { status: 401 });
      return new Response(JSON.stringify(sentryBody()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return seen;
  }

  it('retries once with the previous token while the rotation window is open', async () => {
    const seen = answerByToken(['Bearer sntryu_current']);
    await readSentryIssue(
      buildCtx({
        authToken: 'sntryu_current',
        previousAuthToken: 'sntryu_previous',
        previousTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      { issueId: '4411', targetLabel: 'forge-core' },
    );
    expect(seen).toEqual(['Bearer sntryu_current', 'Bearer sntryu_previous']);
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'ok' }),
    );
  });

  it('does not retry once the rotation window has expired, and leaves needs_reauth', async () => {
    const seen = answerByToken(['Bearer sntryu_current']);
    await expect(
      readSentryIssue(
        buildCtx({
          authToken: 'sntryu_current',
          previousAuthToken: 'sntryu_previous',
          previousTokenExpiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        { issueId: '4411', targetLabel: 'forge-core' },
      ),
    ).rejects.toThrow(/auth token was rejected/);
    expect(seen).toEqual(['Bearer sntryu_current']);
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_reauth' }),
    );
  });

  it('leaves needs_scope on a 403 rather than needs_reauth', async () => {
    answerOnce('forbidden', 403);
    await expect(
      readSentryIssue(buildCtx(), { issueId: '4411', targetLabel: 'forge-core' }),
    ).rejects.toThrow(/lacks the scope/);
    expect(updateConnectionMock).toHaveBeenCalledWith(
      CONN_ID,
      expect.objectContaining({ lastHealthStatus: 'needs_scope' }),
    );
  });

  it('refuses before any call when the connection holds no auth token', async () => {
    const calls = answerOnce(sentryBody());
    await expect(
      readSentryIssue(buildCtx({}), { issueId: '4411', targetLabel: 'forge-core' }),
    ).rejects.toThrow(/holds no auth token/);
    expect(calls).toHaveLength(0);
  });
});

describe('the free text a Sentry issue carries — criterion 14', () => {
  it('strips the invisible and bidi characters while keeping tabs and line breaks', async () => {
    answerOnce(
      sentryBody({
        // zero-width space, bidi override, and a Unicode tag-block character
        title: 'TypeError:​ cannot‮ read\u{E0041} x',
        culprit: 'app/chat‍/send',
        metadata: { value: 'line one\n\tline two﻿' },
      }),
    );

    const { issue } = await readSentryIssue(buildCtx(), {
      issueId: '4411',
      targetLabel: 'forge-core',
    });

    expect(issue.title).toBe('TypeError: cannot read x');
    expect(issue.culprit).toBe('app/chat/send');
    expect(issue.metadataValue).toBe('line one\n\tline two');
    // And the stored response carries the stripped text, not the raw text.
    expect(JSON.stringify(deliveryPatch().response)).not.toContain('‮');
  });

  it('answers null for a free-text field Sentry did not send', async () => {
    answerOnce(sentryBody({ culprit: null, metadata: {} }));
    const { issue } = await readSentryIssue(buildCtx(), {
      issueId: '4411',
      targetLabel: 'forge-core',
    });
    expect(issue.culprit).toBeNull();
    expect(issue.metadataValue).toBeNull();
  });
});

describe('dispatchSentryOutbound — criterion 3', () => {
  it('routes the read event', async () => {
    const calls = answerOnce(sentryBody());
    const res = await dispatchSentryOutbound(buildCtx(), {
      eventName: 'sentry.issue.read',
      payload: { issueId: '4411', targetLabel: 'forge-core' },
    });
    expect(calls[0]?.init.method).toBe('GET');
    expect(res.deliveryId).toBe('del-1');
  });

  it('routes the set-status event', async () => {
    const calls = answerOnce(sentryBody());
    await dispatchSentryOutbound(buildCtx(), {
      eventName: 'sentry.issue.set-status',
      payload: { issueId: '4411', targetLabel: 'forge-core', status: 'ignored' },
    });
    expect(calls[0]?.init.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: 'ignored' });
  });

  it('refuses an event it does not implement, naming it and the two it does', async () => {
    const calls = answerOnce(sentryBody());
    await expect(
      dispatchSentryOutbound(buildCtx(), {
        eventName: 'release.deploy',
        payload: { issueId: '4411' },
      }),
    ).rejects.toThrow(
      'sentry: no outbound event named "release.deploy" — this adapter implements sentry.issue.read, sentry.issue.set-status',
    );
    expect(calls).toHaveLength(0);
    // The refusal is auditable: it leaves a failed row rather than nothing.
    expect(recordDeliveryMock).toHaveBeenCalledTimes(1);
    expect(recordDeliveryMock.mock.calls[0]?.[0]).toMatchObject({ eventName: 'release.deploy' });
    expect(deliveryPatch().status).toBe('failed');
  });
});
