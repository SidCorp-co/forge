import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestProjectMember,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  startTestServer,
  type TestDatabase,
  type TestServer,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let server: TestServer;
let mods: {
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  readAgentConfig: typeof import('../../src/projects/agent-config.js').readAgentConfig;
  patchAgentConfigKeys: typeof import('../../src/projects/agent-config.js').patchAgentConfigKeys;
  buildSystemPrompt: typeof import('../../src/assistant/system-prompt.js').buildSystemPrompt;
  projects: typeof import('../../src/db/schema.js').projects;
};
let ownerId: string;
let projectId: string;

async function call(
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const token = await mods.signUserToken(ownerId);
  const res = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status, text, json };
}

async function storedConfig(): Promise<Record<string, unknown>> {
  return ((await mods.readAgentConfig(projectId)) ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const [jwt, agentConfig, systemPrompt, schema] = await Promise.all([
    import('../../src/auth/jwt.js'),
    import('../../src/projects/agent-config.js'),
    import('../../src/assistant/system-prompt.js'),
    import('../../src/db/schema.js'),
  ]);
  mods = {
    signUserToken: jwt.signUserToken,
    readAgentConfig: agentConfig.readAgentConfig,
    patchAgentConfigKeys: agentConfig.patchAgentConfigKeys,
    buildSystemPrompt: systemPrompt.buildSystemPrompt,
    projects: schema.projects,
  };
  server = await startTestServer();
}, 180_000);

afterAll(async () => {
  await server?.close?.();
  await harness?.cleanup?.();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  const project = await createTestProject(harness.db, ownerId, {
    orgId: org.id,
    agentConfig: { personaStyle: 'be terse' },
  });
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

describe('the named doors write one key each', () => {
  it('stores systemPrompt through its own field and leaves every sibling key alone', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}`, {
      systemPrompt: 'answer in Vietnamese',
    });
    expect(res.status).toBe(200);
    expect(await storedConfig()).toEqual({
      personaStyle: 'be terse',
      systemPrompt: 'answer in Vietnamese',
    });
  });

  it('stores categories through its own field and leaves every sibling key alone', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}`, { categories: ['bug', 'chore'] });
    expect(res.status).toBe(200);
    expect(await storedConfig()).toEqual({
      personaStyle: 'be terse',
      categories: ['bug', 'chore'],
    });
  });

  it('clears a key on null rather than storing a null value', async () => {
    await call('PATCH', `/api/projects/${projectId}`, { systemPrompt: 'temporary' });
    const res = await call('PATCH', `/api/projects/${projectId}`, { systemPrompt: null });
    expect(res.status).toBe(200);
    const stored = await storedConfig();
    expect('systemPrompt' in stored).toBe(false);
    expect(stored.personaStyle).toBe('be terse');
  });

  it('serves a stored systemPrompt to the assistant prompt builder', async () => {
    await call('PATCH', `/api/projects/${projectId}`, { systemPrompt: 'answer in Vietnamese' });
    const [row] = await harness.db
      .select({ agentConfig: mods.projects.agentConfig, name: mods.projects.name })
      .from(mods.projects)
      .where(eq(mods.projects.id, projectId))
      .limit(1);

    const prompt = mods.buildSystemPrompt({
      project: { name: row?.name ?? 'p', agentConfig: row?.agentConfig },
    } as Parameters<typeof mods.buildSystemPrompt>[0]);
    expect(prompt).toContain('answer in Vietnamese');
    expect(prompt).toContain('be terse');
  });
});

describe('the raw agentConfig record is refused by name', () => {
  it.each([
    ['repoPath', '/tmp/elsewhere', 'projects.repo_path'],
    ['baseBranch', 'main', 'projects.base_branch'],
    ['productionBranch', 'main', 'projects.live_branch'],
    ['activeDeviceId', '85644100-e4f5-455a-9754-6af76c19e50a', 'projects.default_device_id'],
    ['runnerFallback', 'claude-code', 'decides nothing'],
    ['whateverThisIs', 1, 'is not a key this project'],
    ['plugins', [], '/plugins'],
  ])('refuses agentConfig.%s and writes nothing', async (key, value, names) => {
    const before = await storedConfig();
    const res = await call('PATCH', `/api/projects/${projectId}`, {
      agentConfig: { [key as string]: value },
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain(names as string);
    expect(await storedConfig()).toEqual(before);
  });

  it.each([
    ['an empty record', {}],
    ['a list', []],
    ['null', null],
  ])(
    'refuses agentConfig given as %s even beside a field that would have succeeded',
    async (_label, agentConfig) => {
      const before = await storedConfig();
      const res = await call('PATCH', `/api/projects/${projectId}`, {
        name: 'A New Name',
        agentConfig,
      });
      expect(res.status).toBe(400);
      expect(res.text).toContain('no longer a field on PATCH /api/projects/:id');
      expect(await storedConfig()).toEqual(before);

      const [row] = await harness.db
        .select({ name: mods.projects.name })
        .from(mods.projects)
        .where(eq(mods.projects.id, projectId))
        .limit(1);
      expect(row?.name).not.toBe('A New Name');
    },
  );
});

describe('a wholesale write cannot lose a sibling key', () => {
  it('loses the sibling key when the write is the read-modify-write this replaced', async () => {
    const stale = await storedConfig();
    await mods.patchAgentConfigKeys(projectId, { systemPrompt: 'set by the other request' });

    await harness.db
      .update(mods.projects)
      .set({ agentConfig: { ...stale, plugins: [] } })
      .where(eq(mods.projects.id, projectId));

    expect('systemPrompt' in (await storedConfig())).toBe(false);
  });

  it('keeps the sibling key when the write names only its own key', async () => {
    const stale = await storedConfig();
    await mods.patchAgentConfigKeys(projectId, { systemPrompt: 'set by the other request' });

    void stale;
    await mods.patchAgentConfigKeys(projectId, { plugins: [] });

    expect(await storedConfig()).toEqual({
      personaStyle: 'be terse',
      systemPrompt: 'set by the other request',
      plugins: [],
    });
  });

  it('keeps both keys when two real doors are driven at once', async () => {
    const results = await Promise.all([
      call('PATCH', `/api/projects/${projectId}`, { systemPrompt: 'from the settings form' }),
      call('PATCH', `/api/projects/${projectId}/plugins`, {
        plugins: [{ marketplace: 'SidCorp-co/forge-plugin', name: 'forge' }],
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const stored = await storedConfig();
    expect(stored.systemPrompt).toBe('from the settings form');
    expect(stored.plugins).toHaveLength(1);
    expect(stored.personaStyle).toBe('be terse');
  });
});

describe('a failed sibling field rolls the config write back', () => {
  async function projectHolding(prefix: string): Promise<void> {
    const other = await createTestProject(harness.db, ownerId, {
      orgId: (await seedOrg(harness.db, ownerId, { slug: `other-${prefix.toLowerCase()}` })).id,
    });
    const res = await call('PATCH', `/api/projects/${other.id}`, { issuePrefix: prefix });
    expect(res.status).toBe(200);
  }

  it.each([
    ['systemPrompt', 'answer in Vietnamese'],
    ['categories', ['bug']],
  ])(
    'leaves agent_config untouched when %s and a taken issuePrefix arrive together',
    async (field, value) => {
      await projectHolding('TAKEN');
      const before = await storedConfig();

      const res = await call('PATCH', `/api/projects/${projectId}`, {
        [field as string]: value,
        issuePrefix: 'TAKEN',
      });
      expect(res.status).toBe(409);
      expect(await storedConfig()).toEqual(before);
    },
  );
});
