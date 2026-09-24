/**
 * ISS-1247 — what an agent gets when it asks what the product is erroring on.
 *
 * The four walls in front of the call, the four ways Sentry itself can refuse, and the filters a
 * caller joins on. Each refusal is planted and read back by `reason`: the whole point of the
 * classification is that rewording a message may not reclassify it, and a test matching the wording
 * would be the thing it guards against.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));

const listBindingsForProject = vi.fn(async (_projectId: string) => [] as unknown[]);
const updateConnection = vi.fn(async (_id: string, _patch: unknown) => undefined);
vi.mock('../store.js', () => ({
  listBindingsForProject: (projectId: string) => listBindingsForProject(projectId),
  updateConnection: (id: string, patch: unknown) => updateConnection(id, patch),
  buildContextFromBinding: (pair: {
    binding: Record<string, unknown>;
    connection: Record<string, unknown>;
  }) => ({
    connectionId: pair.connection.id,
    bindingId: pair.binding.id,
    projectId: pair.binding.projectId,
    provider: 'sentry',
    role: 'service',
    stages: [],
    config: pair.binding.config,
    secrets: pair.connection.secrets,
    integrationSecret: null,
  }),
}));
const recordDelivery = vi.fn(async (_input: { eventName: string }) => 'delivery-1');
vi.mock('../deliveries.js', () => ({
  recordDelivery: (input: { eventName: string }) => recordDelivery(input),
  updateDelivery: vi.fn(async () => undefined),
}));

const { registerAllIntegrations } = await import('../register-all.js');
const { readProjectSentryIssue, readProjectSentryIssues, sentryAgentQuery } = await import(
  './agent-read.js'
);

registerAllIntegrations();

const TOKEN = 'sntryu_the_secret_token_value';
const PROJECT = 'p-1';

interface Pair {
  binding: Record<string, unknown>;
  connection: Record<string, unknown>;
}

function pair(
  over: { binding?: Record<string, unknown>; connection?: Record<string, unknown> } = {},
): Pair {
  return {
    binding: {
      id: 'b-1',
      provider: 'sentry',
      projectId: PROJECT,
      active: true,
      agentAccess: 'all',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      config: {
        host: 'logs.canawan.com',
        targets: [{ label: 'core', organizationSlug: 'canawan', projectSlug: 'forge-core' }],
      },
      ...over.binding,
    },
    connection: { id: 'c-1', active: true, secrets: { authToken: TOKEN }, ...over.connection },
  };
}

/** Two targets under one organization — forge-dev's own shape, and where a guess writes wrong. */
const TWO_TARGETS = [
  { label: 'core', organizationSlug: 'canawan', projectSlug: 'forge-core' },
  { label: 'web', organizationSlug: 'canawan', projectSlug: 'forge-web' },
];

function sentryIssue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '5001',
    shortId: 'FORGE-CORE-7',
    status: 'unresolved',
    substatus: 'ongoing',
    level: 'error',
    count: 1,
    userCount: 1,
    firstSeen: '2026-09-24T10:00:00Z',
    lastSeen: '2026-09-24T11:00:00Z',
    permalink: 'https://logs.canawan.com/organizations/canawan/issues/5001/',
    project: { slug: 'forge-core' },
    title: 'TypeError: cannot read x',
    culprit: 'GET /api/issues',
    metadata: { value: 'cannot read x' },
    ...over,
  };
}

let calls: string[];

/** One fetch answer per call, in order; a string body stands for a non-JSON answer. */
function answerWith(...answers: Array<{ status?: number; body?: unknown; link?: string }>): void {
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(String(url));
      const answer = answers[Math.min(n++, answers.length - 1)] ?? {};
      const status = answer.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (name: string) => (name === 'link' ? (answer.link ?? null) : null) },
        json: async () => answer.body,
      };
    }),
  );
}

async function refusalOf(run: () => Promise<unknown>): Promise<{
  reason: string;
  message: string;
  httpStatus: number | null;
}> {
  try {
    await run();
  } catch (err) {
    const refusal = err as { reason: string; message: string; httpStatus: number | null };
    return { reason: refusal.reason, message: refusal.message, httpStatus: refusal.httpStatus };
  }
  throw new Error('the call answered where a refusal was planted');
}

beforeEach(() => {
  calls = [];
  recordDelivery.mockClear();
  listBindingsForProject.mockReset();
  listBindingsForProject.mockResolvedValue([pair()]);
  answerWith({ body: [sentryIssue()] });
});

describe('the search Sentry is asked', () => {
  it('asks for unresolved issues when the caller narrows nothing', () => {
    expect(sentryAgentQuery({ projectId: PROJECT })).toBe('is:unresolved');
  });

  it('drops the status term on `any`', () => {
    expect(sentryAgentQuery({ projectId: PROJECT, status: 'any' })).toBe('');
  });

  it('joins every filter the caller holds', () => {
    const query = sentryAgentQuery({
      projectId: PROJECT,
      release: '83f0c9b',
      path: '/api/issues/next',
      method: 'GET',
      errorCode: 'ISSUE_LEASE_HELD',
      requestId: 'req-9',
    });
    expect(query).toBe(
      'is:unresolved release:"83f0c9b" http.path:"/api/issues/next" http.method:"GET" error.code:"ISSUE_LEASE_HELD" request.id:"req-9"',
    );
  });

  it('adds a caller query to the filters rather than replacing them', () => {
    expect(
      sentryAgentQuery({ projectId: PROJECT, release: 'abc', query: 'environment:live' }),
    ).toBe('is:unresolved release:"abc" environment:live');
  });

  it('quotes a value that would otherwise end the term', () => {
    expect(sentryAgentQuery({ projectId: PROJECT, path: 'a"b' })).toContain('http.path:"a\\"b"');
  });
});

describe('a read that reaches Sentry', () => {
  it('answers the issues Sentry returned, with the search it was asked', async () => {
    const listing = await readProjectSentryIssues({ projectId: PROJECT });
    expect(listing.issues).toHaveLength(1);
    expect(listing.issues[0]).toMatchObject({
      id: '5001',
      shortId: 'FORGE-CORE-7',
      title: 'TypeError: cannot read x',
      culprit: 'GET /api/issues',
      level: 'error',
      status: 'unresolved',
      count: 1,
      userCount: 1,
      firstSeen: '2026-09-24T10:00:00Z',
      lastSeen: '2026-09-24T11:00:00Z',
      permalink: 'https://logs.canawan.com/organizations/canawan/issues/5001/',
    });
    expect(listing.query).toBe('is:unresolved project:forge-core');
    expect(listing.target).toBe('core');
  });

  it('answers a one-event, one-user issue, which the filing intake would hold back', async () => {
    answerWith({ body: [sentryIssue({ count: '1', userCount: '1' })] });
    const listing = await readProjectSentryIssues({ projectId: PROJECT });
    expect(listing.issues[0]?.count).toBe(1);
    expect(listing.issues[0]?.userCount).toBe(1);
  });

  it('answers an empty list only because Sentry returned no issues', async () => {
    answerWith({ body: [] });
    const listing = await readProjectSentryIssues({ projectId: PROJECT });
    expect(listing.issues).toEqual([]);
    expect(listing.truncated).toBe(false);
  });

  it('sends the release, the window and the tag filters to Sentry', async () => {
    await readProjectSentryIssues({
      projectId: PROJECT,
      release: '83f0c9b',
      window: '1h',
      path: '/api/next',
      method: 'POST',
      errorCode: 'BAD_REQUEST',
      requestId: 'req-9',
    });
    const asked = new URL(calls[0] as string);
    expect(asked.searchParams.get('statsPeriod')).toBe('1h');
    expect(asked.searchParams.get('query')).toBe(
      'is:unresolved release:"83f0c9b" http.path:"/api/next" http.method:"POST" error.code:"BAD_REQUEST" request.id:"req-9" project:forge-core',
    );
  });

  it('names the answers this target is not scoped to rather than dropping them', async () => {
    answerWith({
      body: [sentryIssue(), sentryIssue({ id: '5002', project: { slug: 'forge-web' } })],
    });
    const listing = await readProjectSentryIssues({ projectId: PROJECT });
    expect(listing.issues.map((i) => i.id)).toEqual(['5001']);
    expect(listing.refused).toHaveLength(1);
    expect(listing.refused[0]?.belongsTo).toBe('forge-web');
  });

  it('says so where Sentry still had more than the adapter walks', async () => {
    answerWith({
      body: [sentryIssue()],
      link: '<https://x/?cursor=c1>; rel="next"; results="true"; cursor="c1"',
    });
    const listing = await readProjectSentryIssues({ projectId: PROJECT });
    expect(listing.truncated).toBe(true);
    expect(listing.pages).toBe(10);
  });

  it('reads one issue by id', async () => {
    answerWith({ body: sentryIssue() });
    const issue = await readProjectSentryIssue({ projectId: PROJECT, issueId: '5001' });
    expect(issue.shortId).toBe('FORGE-CORE-7');
  });

  it('asks Sentry for every status where the caller asked for any', async () => {
    await readProjectSentryIssues({ projectId: PROJECT, status: 'any' });
    const query = new URL(calls[0] as string).searchParams.get('query');
    expect(query).toBe('project:forge-core');
    expect(query).not.toContain('is:unresolved');
  });

  it('records both actions as reads, and never a write, on the delivery log', async () => {
    await readProjectSentryIssues({ projectId: PROJECT });
    answerWith({ body: sentryIssue() });
    await readProjectSentryIssue({ projectId: PROJECT, issueId: '5001' });
    const events = recordDelivery.mock.calls.map(([input]) => input.eventName);
    expect(events).toEqual(['sentry.issue.list', 'sentry.issue.read']);
  });
});

describe('the four walls in front of the call', () => {
  it('refuses a project nobody bound Sentry to', async () => {
    listBindingsForProject.mockResolvedValue([]);
    const refusal = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
    expect(refusal.reason).toBe('no_binding');
    expect(refusal.message).toContain('no Sentry binding on this project');
    expect(calls).toEqual([]);
  });

  it('refuses a binding switched off for this project', async () => {
    listBindingsForProject.mockResolvedValue([pair({ binding: { active: false } })]);
    expect((await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }))).reason).toBe(
      'binding_disabled',
    );
  });

  it('refuses a credential switched off for every project sharing it', async () => {
    listBindingsForProject.mockResolvedValue([pair({ connection: { active: false } })]);
    expect((await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }))).reason).toBe(
      'connection_disabled',
    );
  });

  it('refuses a binding no agent on this project may use', async () => {
    listBindingsForProject.mockResolvedValue([pair({ binding: { agentAccess: 'none' } })]);
    const refusal = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
    expect(refusal.reason).toBe('not_granted');
    expect(calls).toEqual([]);
  });

  it('refuses a binding declaring nothing to address', async () => {
    listBindingsForProject.mockResolvedValue([
      pair({ binding: { config: { host: 'logs.canawan.com', targets: [] } } }),
    ]);
    expect((await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }))).reason).toBe(
      'no_targets',
    );
  });
});

describe('what Sentry itself refused', () => {
  const cases = [
    { status: 401, reason: 'credential_rejected' },
    { status: 403, reason: 'scope_missing' },
    { status: 500, reason: 'sentry_http_error' },
  ];
  for (const { status, reason } of cases) {
    it(`reads HTTP ${status} as ${reason}, never as an empty stream`, async () => {
      answerWith({ status });
      const refusal = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
      expect(refusal.reason).toBe(reason);
      expect(refusal.httpStatus).toBe(status);
    });
  }

  it('reads a call that reached no status at all as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND logs.canawan.com');
      }),
    );
    const refusal = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
    expect(refusal.reason).toBe('sentry_unreachable');
    expect(refusal.httpStatus).toBeNull();
  });

  it('reads an answer that is not a list as unreachable rather than as no issues', async () => {
    answerWith({ body: { detail: 'nope' } });
    expect((await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }))).reason).toBe(
      'sentry_unreachable',
    );
  });

  it('keeps the classification when the message is reworded', async () => {
    answerWith({ status: 401 });
    const first = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
    answerWith({ status: 401 });
    const second = await refusalOf(() =>
      readProjectSentryIssues({ projectId: PROJECT, release: 'other' }),
    );
    expect(second.reason).toBe(first.reason);
    expect(second.message).not.toBe(first.message);
  });

  it('names a transport failure as one rather than only quoting the exception', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND logs.canawan.com');
      }),
    );
    const refusal = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
    expect(refusal.message).toContain('could not reach Sentry');
  });

  it('names an answer it could not read as one, rather than as no issues', async () => {
    answerWith({ body: { detail: 'nope' } });
    const refusal = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
    expect(refusal.message).toContain("could not read Sentry's answer");
  });

  it('takes the auth token out of anything it re-raises', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`upstream rejected Bearer ${TOKEN}`);
      }),
    );
    const refusal = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
    expect(refusal.message).not.toContain(TOKEN);
  });

  it('takes the rotation\u2019s previous token out of it too', async () => {
    const previous = 'sntryu_the_previous_token_value';
    listBindingsForProject.mockResolvedValue([
      pair({ connection: { secrets: { authToken: TOKEN, previousAuthToken: previous } } }),
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`upstream rejected Bearer ${previous}`);
      }),
    );
    const refusal = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
    expect(refusal.message).not.toContain(previous);
  });
});

describe('which target the call acts on', () => {
  beforeEach(() => {
    listBindingsForProject.mockResolvedValue([
      pair({ binding: { config: { host: 'logs.canawan.com', targets: TWO_TARGETS } } }),
    ]);
  });

  it('refuses a call naming none, and lists what the binding declares', async () => {
    const refusal = await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT }));
    expect(refusal.reason).toBe('target_ambiguous');
    expect(refusal.message).toContain('core, web');
  });

  it('reads the target the caller named, for a listing', async () => {
    answerWith({ body: [sentryIssue({ project: { slug: 'forge-web' } })] });
    const listing = await readProjectSentryIssues({ projectId: PROJECT, target: 'web' });
    expect(listing.target).toBe('web');
    expect(listing.query).toBe('is:unresolved project:forge-web');
  });

  it('reads the target the caller named, for one issue', async () => {
    answerWith({ body: sentryIssue({ project: { slug: 'forge-web' } }) });
    const issue = await readProjectSentryIssue({
      projectId: PROJECT,
      issueId: '5001',
      target: 'web',
    });
    expect(issue.projectSlug).toBe('forge-web');
  });

  it('refuses a label the binding does not declare', async () => {
    const refusal = await refusalOf(() =>
      readProjectSentryIssues({ projectId: PROJECT, target: 'mobile' }),
    );
    expect(refusal.reason).toBe('target_unknown');
    expect(refusal.message).toContain('core, web');
  });

  it('refuses one target reading another target’s issue, and answers no detail', async () => {
    answerWith({ body: sentryIssue({ project: { slug: 'forge-web' } }) });
    const refusal = await refusalOf(() =>
      readProjectSentryIssue({ projectId: PROJECT, issueId: '5001', target: 'core' }),
    );
    expect(refusal.reason).toBe('confined_out');
    expect(refusal).not.toHaveProperty('issue');
  });
});

describe('a window the caller asked for', () => {
  it('refuses a shape Sentry does not take rather than dropping it', async () => {
    const refusal = await refusalOf(() =>
      readProjectSentryIssues({ projectId: PROJECT, window: 'last tuesday' }),
    );
    expect(refusal.reason).toBe('bad_argument');
    expect(refusal.message).toContain('1h');
  });

  it('refuses a window past the ceiling Sentry holds', async () => {
    expect(
      (await refusalOf(() => readProjectSentryIssues({ projectId: PROJECT, window: '400d' })))
        .reason,
    ).toBe('bad_argument');
  });
});
