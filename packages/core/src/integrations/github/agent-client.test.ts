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
  },
}));
vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../store.js', () => ({
  listBindingsForProject: (...a: unknown[]) => listBindingsForProjectMock(...(a as [])),
  decryptConnectionSecrets: (connection: { secretsPlain?: Record<string, unknown> }) =>
    connection.secretsPlain ?? {},
  effectiveConfig: (pair: {
    connection: { config?: Record<string, unknown> };
    binding: { config?: Record<string, unknown> };
  }) => ({ ...(pair.connection.config ?? {}), ...(pair.binding.config ?? {}) }),
}));
vi.mock('./app-auth.js', async () => {
  const real = await vi.importActual<typeof import('./app-auth.js')>('./app-auth.js');
  return { ...real, installationToken: (...a: unknown[]) => installationTokenMock(...(a as [])) };
});

const {
  GitHubAgentCallError,
  GitHubAgentRefusal,
  githubAgentBindings,
  githubAgentClient,
  resolveGrantedGitHubBinding,
} = await import('./agent-client.js');
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
      id: 'conn-1',
      active: opts.connectionActive ?? true,
      config: {},
      secretsEnc: Buffer.from('x'),
      lastHealthStatus: 'ok',
      secretsPlain: opts.secrets ?? { appId: '1234', privateKey: 'k'.repeat(120) },
    },
  };
}

beforeEach(() => {
  listBindingsForProjectMock.mockReset();
  installationTokenMock.mockReset();
  installationTokenMock.mockResolvedValue('ghs_installation_token_value');
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

describe('list reports what exists, whatever the grant says', () => {
  // ISS-1074 criterion 13.
  it('reports an ungranted binding with agentGranted false, and contacts GitHub not at all', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    listBindingsForProjectMock.mockResolvedValue([
      row({ id: 'bind-ungranted', agentAccess: 'none' }),
    ]);

    await expect(githubAgentBindings(PROJECT)).resolves.toEqual([
      {
        bindingId: 'bind-ungranted',
        repository: 'SidCorp-co/forge-dev',
        installed: true,
        bindingActive: true,
        connectionActive: true,
        agentGranted: false,
        lastHealthStatus: 'ok',
      },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(installationTokenMock).not.toHaveBeenCalled();
  });

  it('answers an empty list for a project that has bound nothing, rather than refusing', async () => {
    listBindingsForProjectMock.mockResolvedValue([]);
    await expect(githubAgentBindings(PROJECT)).resolves.toEqual([]);
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

  // cm:guard the raw body is NOT what a caller is handed. GitHub's error body is a third party's response and has carried internal hostnames; `message` is the field it documents as the human-readable refusal, and everything else is dropped.
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
