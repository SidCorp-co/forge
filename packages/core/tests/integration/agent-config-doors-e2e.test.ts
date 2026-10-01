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
  projects: typeof import('../../src/db/schema.js').projects;
};
let ownerId: string;
let projectId: string;

const FORGE = { marketplace: 'SidCorp-co/forge-plugin', name: 'forge' };
const WEEKLY = {
  enabled: true,
  pinnedIssue: 'ISS-1',
  judgeProviderId: 'p-1',
  judgeModel: 'sonnet',
};

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
  const [jwt, agentConfig, schema] = await Promise.all([
    import('../../src/auth/jwt.js'),
    import('../../src/projects/agent-config.js'),
    import('../../src/db/schema.js'),
  ]);
  mods = {
    signUserToken: jwt.signUserToken,
    readAgentConfig: agentConfig.readAgentConfig,
    patchAgentConfigKeys: agentConfig.patchAgentConfigKeys,
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
    agentConfig: { plugins: [FORGE] },
  });
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

describe('the named doors write one key each', () => {
  it('stores assistantWeekly through its own field and leaves every sibling key alone', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}`, { assistantWeekly: WEEKLY });
    expect(res.status).toBe(200);
    expect(await storedConfig()).toEqual({ plugins: [FORGE], assistantWeekly: WEEKLY });
  });

  it('clears a key on null rather than storing a null value', async () => {
    await call('PATCH', `/api/projects/${projectId}`, { assistantWeekly: WEEKLY });
    const res = await call('PATCH', `/api/projects/${projectId}`, { assistantWeekly: null });
    expect(res.status).toBe(200);
    expect(await storedConfig()).toEqual({ plugins: [FORGE] });
  });

  it.each([
    ['personaStyle', 'be terse'],
    ['systemPrompt', 'answer in Vietnamese'],
    ['rocketChatAnswerMode', 'agent'],
    ['categories', ['bug', 'chore']],
    ['description', 'a project'],
    ['kind', 'website'],
  ])('refuses the deleted field %s by name and writes nothing', async (field, value) => {
    const before = await storedConfig();
    const res = await call('PATCH', `/api/projects/${projectId}`, {
      issuePrefix: 'ANN',
      [field as string]: value,
    });
    expect(res.status).toBe(400);
    expect(res.text).toContain(`\`${field}\` is not a field of PATCH /api/projects/:id`);
    expect(await storedConfig()).toEqual(before);
    const [row] = await harness.db
      .select({ issuePrefix: mods.projects.issuePrefix })
      .from(mods.projects)
      .where(eq(mods.projects.id, projectId))
      .limit(1);
    expect(row?.issuePrefix).not.toBe('ANN');
  });
});

describe('the raw agentConfig record is refused by name', () => {
  it.each([
    ['repoPath', '/tmp/elsewhere', 'device binding'],
    ['baseBranch', 'main', 'source.git.defaultBranch'],
    ['productionBranch', 'main', 'PUT /api/projects/:id/config'],
    ['activeDeviceId', '85644100-e4f5-455a-9754-6af76c19e50a', 'a device bound to the project'],
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
        issuePrefix: 'ANN',
        agentConfig,
      });
      expect(res.status).toBe(400);
      expect(res.text).toContain('no longer a field on PATCH /api/projects/:id');
      expect(await storedConfig()).toEqual(before);

      const [row] = await harness.db
        .select({ issuePrefix: mods.projects.issuePrefix })
        .from(mods.projects)
        .where(eq(mods.projects.id, projectId))
        .limit(1);
      expect(row?.issuePrefix).not.toBe('ANN');
    },
  );
});

describe('a wholesale write cannot lose a sibling key', () => {
  it('loses the sibling key when the write is the read-modify-write this replaced', async () => {
    const stale = await storedConfig();
    await mods.patchAgentConfigKeys(projectId, { assistantWeekly: WEEKLY });

    await harness.db
      .update(mods.projects)
      .set({ agentConfig: { ...stale, plugins: [] } })
      .where(eq(mods.projects.id, projectId));

    expect('assistantWeekly' in (await storedConfig())).toBe(false);
  });

  it('keeps the sibling key when the write names only its own key', async () => {
    await mods.patchAgentConfigKeys(projectId, { assistantWeekly: WEEKLY });
    await mods.patchAgentConfigKeys(projectId, { plugins: [] });

    expect(await storedConfig()).toEqual({ assistantWeekly: WEEKLY, plugins: [] });
  });

  it('keeps both keys when two real doors are driven at once', async () => {
    const results = await Promise.all([
      call('PATCH', `/api/projects/${projectId}`, { assistantWeekly: WEEKLY }),
      call('PATCH', `/api/projects/${projectId}/plugins`, {
        plugins: [FORGE, { ...FORGE, name: 'code-quality' }],
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const stored = await storedConfig();
    expect(stored.assistantWeekly).toEqual(WEEKLY);
    expect(stored.plugins).toHaveLength(2);
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

  it.each([['assistantWeekly', WEEKLY]])(
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
