/**
 * The agent face's door: which of the refusals a caller meets, and what the request path does with
 * what GitHub sends back.
 *
 * ISS-1074 criteria 13, 14, 15, 5 and 7. The cases that matter here are the ones where two
 * conditions look alike from the outside and must not: an ungranted binding against no binding at
 * all, and a truncated answer against a small one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listBindingsForProjectMock = vi.fn();
const installationTokenMock = vi.fn();

// A whole mock rather than a partial one: the real module imports `db/client`, which parses the
// server env at import time, and nothing here needs a database. `effectiveConfig` is restated
// because it is pure and the binding-over-connection overlay is what decides which repository a
// refusal names.
vi.mock('../../config/env.js', () => ({
  env: {
    JWT_SECRET: 'test-secret-at-least-32-chars-long-abcdef',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://x/y',
    DEVICE_TOKEN_PEPPER: 'pepper',
    PUBLIC_API_BASE_URL: 'https://api.example.test',
  },
}));
// ISS-1140: `list` now reads the project's slug to build the URL this binding needs GitHub to
// call. One row, one query, and `db` is otherwise untouched here.
let projectSlug: string | null = 'forge-dev';
vi.mock('../../db/client.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (projectSlug ? [{ slug: projectSlug }] : []) }),
      }),
    }),
  },
}));
vi.mock('../store.js', () => ({
  listBindingsForProject: (...a: unknown[]) => listBindingsForProjectMock(...(a as [])),
  decryptConnectionSecrets: (connection: { secretsPlain?: Record<string, unknown> }) =>
    connection.secretsPlain ?? {},
  effectiveConfig: (pair: {
    connection: { config?: Record<string, unknown> };
    binding: { config?: Record<string, unknown> };
  }) => ({ ...(pair.connection.config ?? {}), ...(pair.binding.config ?? {}) }),
}));
// ISS-1123, ISS-1140. The door's traffic is a database reading and `db/client` is a stub here, so
// the reading is mocked and what is asserted is what the report DOES with it: a binding installed,
// active, granted and green on its outbound probe that has received nothing must not read `ok`.
const NO_TRAFFIC = {
  accepted: 0,
  lastAcceptedAt: null as Date | null,
  refused: 0,
  lastRefusedAt: null as Date | null,
  lastRefusalCode: null as string | null,
};
const trafficMock = vi.fn(async (_bindingId: string) => ({ ...NO_TRAFFIC }));
vi.mock('../inbound-door.js', async () => {
  const real = await vi.importActual<typeof import('../inbound-door.js')>('../inbound-door.js');
  return { ...real, readInboundDoorTraffic: (id: string) => trafficMock(id) };
});
vi.mock('./app-auth.js', async () => {
  const real = await vi.importActual<typeof import('./app-auth.js')>('./app-auth.js');
  return { ...real, installationToken: (...a: unknown[]) => installationTokenMock(...(a as [])) };
});

const { GitHubAgentCallError, GitHubAgentRefusal, githubAgentClient, resolveGrantedGitHubBinding } =
  await import('./agent-client.js');
const { GitHubClientError } = await import('./client.js');

// The grant is asked of the registry, so github's declaration has to be in it. An empty registry
// would refuse every case in this file for the wrong reason while still going red.
const { registerAllIntegrations } = await import('../register-all.js');
registerAllIntegrations();

const PROJECT = '66666666-6666-4666-8666-666666666666';
const originalFetch = globalThis.fetch;

function row(opts: {
  id?: string;
  bindingActive?: boolean;
  connectionActive?: boolean;
  agentAccess?: string;
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  createdAt?: Date;
  provider?: string;
  connectionId?: string;
  lastHealthStatus?: string | null;
  lastHealthDetail?: string | null;
  observed?: {
    url: string | null;
    active: boolean | null;
    observedAt: string;
    readError?: string;
  } | null;
}) {
  return {
    binding: {
      id: opts.id ?? 'bind-1',
      connectionId: 'conn-1',
      projectId: PROJECT,
      provider: opts.provider ?? 'github',
      config: opts.config ?? { owner: 'SidCorp-co', repo: 'forge-dev', installationId: 42 },
      active: opts.bindingActive ?? true,
      agentAccess: opts.agentAccess ?? 'all',
      createdAt: opts.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    },
    connection: {
      id: opts.connectionId ?? 'conn-1',
      active: opts.connectionActive ?? true,
      config: {},
      secretsEnc: Buffer.from('x'),
      lastHealthStatus: opts.lastHealthStatus === undefined ? 'ok' : opts.lastHealthStatus,
      lastHealthDetail: opts.lastHealthDetail ?? null,
      inboundEndpointObserved:
        opts.observed === undefined
          ? { url: HERE, active: true, observedAt: '2026-09-21T00:00:00.000Z' }
          : opts.observed,
      secretsPlain: opts.secrets ?? { appId: '1234', privateKey: 'k'.repeat(120) },
    },
  };
}

/** The URL a `forge-dev` binding on this core needs GitHub to call. */
const HERE = 'https://api.example.test/api/webhooks/in/forge-dev';

beforeEach(() => {
  listBindingsForProjectMock.mockReset();
  installationTokenMock.mockReset();
  installationTokenMock.mockResolvedValue('ghs_installation_token_value');
  projectSlug = 'forge-dev';
  trafficMock.mockReset();
  trafficMock.mockImplementation(async () => ({ ...NO_TRAFFIC }));
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('which refusal a caller meets', () => {
  it('names no binding when the project has bound no repository', async () => {
    listBindingsForProjectMock.mockResolvedValue([]);
    await expect(resolveGrantedGitHubBinding(PROJECT)).rejects.toMatchObject({
      name: 'GitHubAgentRefusal',
      reason: 'no_binding',
    });
    await expect(resolveGrantedGitHubBinding(PROJECT)).rejects.toThrow(/Integrations page/);
  });

  it('a github binding is found past another provider s, so a coolify row is not mistaken for none', async () => {
    listBindingsForProjectMock.mockResolvedValue([
      row({ provider: 'coolify', id: 'other' }),
      row({ id: 'bind-gh' }),
    ]);
    const pair = await resolveGrantedGitHubBinding(PROJECT);
    expect(pair.binding.id).toBe('bind-gh');
  });

  it('separates a binding switched off for this project from a credential switched off for every one', async () => {
    listBindingsForProjectMock.mockResolvedValue([row({ bindingActive: false })]);
    await expect(resolveGrantedGitHubBinding(PROJECT)).rejects.toThrow(
      /switched off for this project/,
    );
    listBindingsForProjectMock.mockResolvedValue([row({ connectionActive: false })]);
    await expect(resolveGrantedGitHubBinding(PROJECT)).rejects.toThrow(
      /switched off for every project sharing it/,
    );
  });

  // ISS-1074 criterion 14. The distinction this asserts is the whole reason discovery and
  // authorization are two steps: a granted-only lookup would answer `no_binding` here, and send an
  // operator to bind a repository that is already bound.
  it('refuses an ungranted binding BY NAME, naming the binding and where the switch is', async () => {
    listBindingsForProjectMock.mockResolvedValue([
      row({ id: 'bind-ungranted', agentAccess: 'none' }),
    ]);
    const caught = await resolveGrantedGitHubBinding(PROJECT).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(GitHubAgentRefusal);
    expect((caught as InstanceType<typeof GitHubAgentRefusal>).reason).toBe('not_granted');
    expect((caught as Error).message).toContain('bind-ungranted');
    expect((caught as Error).message).toContain('Settings → Integrations');
    expect((caught as Error).message).not.toMatch(/no GitHub binding/);
  });

  // ISS-1074 criterion 15 — the three configuration refusals, each sending an operator somewhere
  // different, raised by `buildRepoClient` rather than restated here.
  it('tells no repository, no installation and no App credential apart', async () => {
    listBindingsForProjectMock.mockResolvedValue([row({ config: { installationId: 42 } })]);
    await expect(githubAgentClient(PROJECT)).rejects.toMatchObject({ reason: 'no_repository' });

    listBindingsForProjectMock.mockResolvedValue([
      row({ config: { owner: 'SidCorp-co', repo: 'forge-dev' } }),
    ]);
    await expect(githubAgentClient(PROJECT)).rejects.toMatchObject({ reason: 'no_installation' });

    listBindingsForProjectMock.mockResolvedValue([row({ secrets: {} })]);
    const caught = await githubAgentClient(PROJECT).catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(GitHubClientError);
    expect((caught as { reason: string }).reason).toBe('no_credential');
  });
});

describe('what the request path does with GitHub s answer', () => {
  beforeEach(() => {
    listBindingsForProjectMock.mockResolvedValue([row({})]);
  });

  // ISS-1074 criterion 5. The figure that must not be the returned length: a caller told the slice's
  // size cannot tell a truncated diff from a small one.
  it('reports the WHOLE length beside a slice, not the slice s own length', async () => {
    const whole = 'd'.repeat(5000);
    globalThis.fetch = vi.fn(
      async () => new Response(whole, { status: 200 }),
    ) as unknown as typeof fetch;

    const client = await githubAgentClient(PROJECT);
    const got = await client.text({ path: '/x', accept: 'text/plain', maxBytes: 1000 });
    expect(got.truncated).toBe(true);
    expect(got.bytes).toBe(5000);
    expect(got.body).toHaveLength(1000);
  });

  it('reports a body at exactly the cap as whole, and one byte over as truncated', async () => {
    const at = 'a'.repeat(1000);
    globalThis.fetch = vi.fn(
      async () => new Response(at, { status: 200 }),
    ) as unknown as typeof fetch;
    const client = await githubAgentClient(PROJECT);
    await expect(
      client.text({ path: '/x', accept: 'text/plain', maxBytes: 1000 }),
    ).resolves.toEqual({ body: at, bytes: 1000, truncated: false });

    globalThis.fetch = vi.fn(
      async () => new Response(`${at}a`, { status: 200 }),
    ) as unknown as typeof fetch;
    const over = await client.text({ path: '/x', accept: 'text/plain', maxBytes: 1000 });
    expect(over).toMatchObject({ bytes: 1001, truncated: true });
  });

  // Answers finding F3 of ISS-1074's whole-set review: `text` returned third-party text unredacted,
  // and only the check-log caller scrubbed what it got. A diff carries credentials as readily as a
  // log does — a committed `.env`, a workflow file — and the caller that forgot is the one that
  // leaks.
  it('redacts the WHOLE answer before the cap, so a credential straddling the cut leaves nothing', async () => {
    const token = 'ghs_installation_token_value';
    const whole = `${'a'.repeat(900)}\nsecret=${token}\nAuthorization: Bearer abcdef123456\n${'b'.repeat(900)}`;
    globalThis.fetch = vi.fn(
      async () => new Response(whole, { status: 200 }),
    ) as unknown as typeof fetch;

    const client = await githubAgentClient(PROJECT);
    // The cut is placed 14 characters INTO the token (900 filler + `\nsecret=` is 908, and the
    // token is 28 long): a scrub applied to the slice instead keeps `ghs_installat`, which is a
    // credential fragment and the start of a real one. Measured — at a cut of 910 the slice holds
    // two characters of it and the assertion below cannot fail.
    const got = await client.text({ path: '/x', accept: 'text/plain', maxBytes: 922 });
    expect(got.truncated).toBe(true);
    expect(got.body).not.toContain('ghs_installation');
    expect(got.body).not.toContain('ghs_');
  });

  // The token `installationToken` answers is FRESH per call, so redacting with a second mint
  // redacts a string the text cannot contain. The read has one in hand already, and that is the one
  // a workflow echoing `${{ secrets.GITHUB_TOKEN }}` would have printed.
  it('redacts the token THIS request was made with, not whatever a second mint answers', async () => {
    installationTokenMock.mockReset();
    installationTokenMock
      .mockResolvedValueOnce('ghs_the_one_the_request_used')
      .mockResolvedValue('ghs_a_later_different_token');
    globalThis.fetch = vi.fn(
      async () => new Response('echo: ghs_the_one_the_request_used\ndone', { status: 200 }),
    ) as unknown as typeof fetch;

    const client = await githubAgentClient(PROJECT);
    const got = await client.text({ path: '/x', accept: 'text/plain', maxBytes: 10_000 });
    expect(got.body).not.toContain('ghs_the_one_the_request_used');
    expect(got.body).toContain('done');
  });

  // Answers finding F4. A log is read for its END — the failure — and a cap that keeps the head
  // returns output from before it, under a `truncated` flag that says something was dropped but not
  // which end.
  it('keeps the END of an over-cap answer when the caller asks for the tail', async () => {
    const whole = `${'x'.repeat(5000)}\nFAILED: the sentinel line`;
    globalThis.fetch = vi.fn(
      async () => new Response(whole, { status: 200 }),
    ) as unknown as typeof fetch;

    const client = await githubAgentClient(PROJECT);
    const tail = await client.text({
      path: '/x',
      accept: 'text/plain',
      maxBytes: 40,
      keep: 'tail',
    });
    expect(tail.body).toContain('FAILED: the sentinel line');
    expect(tail.truncated).toBe(true);
    expect(tail.bytes).toBe(Buffer.byteLength(whole, 'utf8'));

    const head = await client.text({ path: '/x', accept: 'text/plain', maxBytes: 40 });
    expect(head.body).not.toContain('FAILED');
  });

  it('carries GitHub s own message and nothing else off a refusal', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            message: 'Validation Failed',
            documentation_url: 'https://docs.github.com/…',
            internal_host: 'gh-internal-42.invalid',
          }),
          { status: 422 },
        ),
    ) as unknown as typeof fetch;

    const client = await githubAgentClient(PROJECT);
    const caught = await client
      .json({ method: 'POST', path: '/repos/x/y/pulls', body: {} })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(GitHubAgentCallError);
    expect((caught as InstanceType<typeof GitHubAgentCallError>).status).toBe(422);
    expect((caught as InstanceType<typeof GitHubAgentCallError>).detail).toBe('Validation Failed');
    expect(JSON.stringify(caught)).not.toContain('gh-internal-42');
  });

  // ISS-1074 criterion 7, the half that is this module's: the token this very read minted is passed
  // to the scrubber, so a workflow that echoed it does not hand it back to the caller.
  it('redacts its own installation token out of third-party text', async () => {
    const client = await githubAgentClient(PROJECT);
    const scrubbed = await client.scrub(
      'Run echo $GH: ghs_installation_token_value\nAuthorization: Bearer abcdef123456\nDEPLOY_TOKEN=hunter2\nok',
    );
    expect(scrubbed).not.toContain('ghs_installation_token_value');
    expect(scrubbed).not.toContain('abcdef123456');
    expect(scrubbed).not.toContain('hunter2');
    expect(scrubbed).toContain('ok');
  });

  it('still scrubs the generic shapes when the token cannot be minted', async () => {
    installationTokenMock.mockResolvedValueOnce('ghs_installation_token_value');
    const client = await githubAgentClient(PROJECT);
    installationTokenMock.mockRejectedValue(new Error('no network'));
    const scrubbed = await client.scrub('Authorization: Bearer abcdef123456\nkept');
    expect(scrubbed).not.toContain('abcdef123456');
    expect(scrubbed).toContain('kept');
  });
});
