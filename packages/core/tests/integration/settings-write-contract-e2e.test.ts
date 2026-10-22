import { sql } from 'drizzle-orm';
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
  readEnvironments: typeof import('../../src/projects/environments-service.js').readEnvironments;
  writeEnvironmentsLimits: typeof import('../../src/projects/environments-service.js').writeEnvironmentsLimits;
};
let ownerId: string;
let projectId: string;

async function call(
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
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
  return { status: res.status, json };
}

async function storedPipeline(): Promise<Record<string, unknown>> {
  const ac = ((await mods.readAgentConfig(projectId)) ?? {}) as Record<string, unknown>;
  return (ac.pipelineConfig ?? {}) as Record<string, unknown>;
}

const SEED = {
  states: {
    open: { enabled: true, allowedTools: ['Read'] },
    in_progress: { enabled: true, disallowedTools: ['Workflow'] },
  },
  intakeGate: { enabled: false },
  legacyKeyNoSchemaSurfaces: { kept: true },
};

const SEED_ENVIRONMENTS = {
  live: { url: 'https://live.example', apiUrl: 'https://api.live.example' },
  preview: { url: 'https://preview.example', shownNowhere: 'a key the form does not render' },
  testCredentials: [{ label: 'qa', username: 'qa@example.com', password: 'secret' }],
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const [jwt, agentConfig, environments] = await Promise.all([
    import('../../src/auth/jwt.js'),
    import('../../src/projects/agent-config.js'),
    import('../../src/projects/environments-service.js'),
  ]);
  mods = {
    signUserToken: jwt.signUserToken,
    readAgentConfig: agentConfig.readAgentConfig,
    readEnvironments: environments.readEnvironments,
    writeEnvironmentsLimits: environments.writeEnvironmentsLimits,
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
    agentConfig: { pipelineConfig: SEED },
    environments: SEED_ENVIRONMENTS,
  });
  projectId = project.id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

async function readPipeline(): Promise<Record<string, unknown>> {
  const res = await call('GET', `/api/projects/${projectId}/pipeline-config`);
  return res.json.pipelineConfig as Record<string, unknown>;
}

function stage(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  return (doc.states as Record<string, unknown>)[name] as Record<string, unknown>;
}

describe('two settings sections writing from one read', () => {
  it('keeps both writes when they touch different leaves of states', async () => {
    const base = await readPipeline();

    const pools = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { states: { in_progress: { disallowedTools: ['Workflow', 'CronList'] } } },
    });
    expect(pools.status).toBe(200);

    const permissions = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { states: { open: { allowedTools: ['Read', 'Grep'] } } },
    });
    expect(permissions.status).toBe(200);

    const stored = await storedPipeline();
    expect(stage(stored, 'in_progress').disallowedTools).toEqual(['Workflow', 'CronList']);
    expect(stage(stored, 'open').allowedTools).toEqual(['Read', 'Grep']);
  });

  it('leaves every key the patch does not name exactly as it was', async () => {
    const base = await readPipeline();
    const before = await storedPipeline();

    const res = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { states: { open: { allowedTools: ['Read', 'Grep'] } } },
    });
    expect(res.status).toBe(200);

    const after = await storedPipeline();
    expect(after.legacyKeyNoSchemaSurfaces).toEqual(before.legacyKeyNoSchemaSurfaces);
    expect(after.intakeGate).toEqual({ enabled: false });
    expect(stage(after, 'open').enabled).toBe(true);
    expect(stage(after, 'in_progress')).toEqual(stage(before, 'in_progress'));
  });

  it('deletes the key a patch sets to null and leaves its siblings', async () => {
    const base = await readPipeline();
    const res = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { states: { open: { allowedTools: null } } },
    });
    expect(res.status).toBe(200);

    const open = stage(await storedPipeline(), 'open');
    expect('allowedTools' in open).toBe(false);
    expect(open.enabled).toBe(true);
  });

  // The stored document is sparse and stays sparse: a save writes the keys the patch named and
  // no others. A project that has never saved a stage is the case that shows it — the read it
  // is compared against carries this codebase's default `states`, and writing THAT into storage
  // would freeze today's defaults into the row and make an unrelated edit rewrite every stage.
  it('writes no key the patch did not name, not even a default its read showed it', async () => {
    await harness.db.execute(sql`
      UPDATE projects
      SET agent_config = ${JSON.stringify({ pipelineConfig: { intakeGate: { enabled: false } } })}::jsonb
      WHERE id = ${projectId}
    `);
    const base = await readPipeline();
    expect(base.states).toBeDefined();
    expect(base.enabled).toBe(true);

    const res = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { intakeGate: { enabled: true } },
    });
    expect(res.status).toBe(200);

    const after = await storedPipeline();
    expect(Object.keys(after)).toEqual(['intakeGate']);
    expect(after.states).toBeUndefined();
  });
});

describe('a write whose ground moved', () => {
  it("is refused, writes nothing, and leaves the first writer's value standing", async () => {
    const base = await readPipeline();

    const first = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { states: { open: { allowedTools: ['Read', 'Grep'] } } },
    });
    expect(first.status).toBe(200);

    const second = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { states: { open: { allowedTools: ['Bash'] } } },
    });
    expect(second.status).toBe(409);

    expect(stage(await storedPipeline(), 'open').allowedTools).toEqual(['Read', 'Grep']);
  });

  it('names the path, what the caller read and what is stored now', async () => {
    const base = await readPipeline();
    await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { states: { open: { allowedTools: ['Read', 'Grep'] } } },
    });
    const refused = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { states: { open: { allowedTools: ['Bash'] } } },
    });

    expect(refused.json.code).toBe('CONFIG_STALE');
    expect(String(refused.json.message)).toContain('states.open.allowedTools');
    expect(String(refused.json.message)).toContain('["Read"]');
    expect(String(refused.json.message)).toContain('["Read","Grep"]');
  });

  it('lets a write through when what moved is a path it does not touch', async () => {
    const base = await readPipeline();

    await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { states: { open: { allowedTools: ['Read', 'Grep'] } } },
    });
    const other = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { intakeGate: { enabled: true } },
    });

    expect(other.status).toBe(200);
    expect((await storedPipeline()).intakeGate).toEqual({ enabled: true });
  });

  it('applies exactly one of two writes racing from the same base at the same path', async () => {
    const base = await readPipeline();
    const send = (tools: string[]) =>
      call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
        base,
        patch: { states: { open: { allowedTools: tools } } },
      });

    const [a, b] = await Promise.all([send(['Read', 'Grep']), send(['Bash'])]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 409]);

    const stored = stage(await storedPipeline(), 'open').allowedTools;
    expect([['Read', 'Grep'], ['Bash']]).toContainEqual(stored);
  });
});

describe('the shape a write has to take', () => {
  it('refuses a bare document by name, naming the shape and the read', async () => {
    const base = await readPipeline();
    const res = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      ...base,
      intakeGate: { enabled: true },
    });

    expect(res.status).toBe(400);
    expect(res.json.code).toBe('CONFIG_PATCH_SHAPE');
    expect(String(res.json.message)).toContain('{ base, patch }');
    expect(String(res.json.message)).toContain('GET /api/projects/:id/pipeline-config');
    expect((await storedPipeline()).intakeGate).toEqual({ enabled: false });
  });

  it('refuses a key this config does not have rather than dropping it', async () => {
    const base = await readPipeline();
    const res = await call('PATCH', `/api/projects/${projectId}/pipeline-config`, {
      base,
      patch: { intakeGates: { enabled: true } },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('is not a pipeline config key');
  });
});

describe('the environments document', () => {
  async function readEnv(): Promise<Record<string, unknown>> {
    const res = await call('GET', `/api/projects/${projectId}/environments`);
    return res.json.environments as Record<string, unknown>;
  }

  it('refuses environments on the project route by name, naming the door it moved to', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}`, {
      environments: { live: { url: 'https://elsewhere.example' } },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ENVIRONMENTS_MOVED');
    expect(String(res.json.message)).toContain('PATCH /api/projects/:id/environments');
    expect((await mods.readEnvironments(projectId)).live).toEqual(SEED_ENVIRONMENTS.live);
  });

  it('leaves the keys the form never showed when every rendered field is cleared', async () => {
    const base = await readEnv();
    const res = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base,
      patch: { preview: { url: null, apiUrl: null, urls: [] } },
    });
    expect(res.status).toBe(200);

    const preview = (await mods.readEnvironments(projectId)).preview as Record<string, unknown>;
    expect(preview.shownNowhere).toBe('a key the form does not render');
    expect('url' in preview).toBe(false);
    expect((await mods.readEnvironments(projectId)).testCredentials).toEqual(
      SEED_ENVIRONMENTS.testCredentials,
    );
  });

  it('refuses a write whose ground moved and leaves the first writer standing', async () => {
    const base = await readEnv();
    const first = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base,
      patch: { limits: 'no outbound email' },
    });
    expect(first.status).toBe(200);

    const second = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base,
      patch: { limits: 'something else' },
    });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe('ENVIRONMENTS_STALE');
    expect((await mods.readEnvironments(projectId)).limits).toBe('no outbound email');
  });

  it('refuses a bare document by name', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}/environments`, {
      live: { url: 'https://elsewhere.example' },
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ENVIRONMENTS_WRITE_SHAPE');
  });

  /** The stored column as Postgres prints it, so "unchanged" means the bytes and not a reading. */
  async function storedText(): Promise<string> {
    const rows = await harness.db.execute<{ text: string }>(
      sql`SELECT environments::text AS text FROM projects WHERE id = ${projectId}`,
    );
    return rows[0]?.text ?? '';
  }

  // ISS-1339 r2, judge-98: `{"patch":{"live.commitUrl":"…"}}` answered 200 and stored a top-level key
  // literally named `live.commitUrl`, because only the merged document was parsed and it passes
  // keys it does not name. What a write SENDS is now held to the document's keys.
  it.each([
    ['a dotted top-level name', { 'live.commitUrl': 'https://x.example/v' }, ['live.commitUrl']],
    ['a top-level key', { futureKnob: 1, limits: 'written beside it' }, ['futureKnob']],
    ['a key under live', { live: { url: 'https://y.example', region: 'eu' } }, ['live.region']],
    [
      'a key under preview',
      { preview: { commitUrl: 'https://p.example/v' } },
      ['preview.commitUrl'],
    ],
    ['a null for a key nothing stores', { futureKnob: null }, ['futureKnob']],
  ])('refuses %s by name, with the valid shape, and writes nothing', async (_, patch, keys) => {
    const before = await storedText();
    const res = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base: await readEnv(),
      patch,
    });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('ENVIRONMENTS_INVALID');
    const message = String(res.json.message);
    for (const key of keys) expect(message).toContain(`\`${key}\``);
    expect(message).toContain(
      '{ preview: { url, apiUrl, urls[] } | null, live: { url, apiUrl }, testCredentials[], limits }',
    );
    const conflicts = (res.json.details as { conflicts: { path: string }[] }).conflicts;
    expect(conflicts.map((c) => c.path)).toEqual(keys);
    expect(await storedText()).toBe(before);
  });

  it('refuses both retired live keys in one message that names each once', async () => {
    const before = await storedText();
    const res = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base: await readEnv(),
      patch: {
        live: { commitUrl: 'https://api.x/version', commitPath: 'sourceCommit' },
        limits: 'x',
      },
    });
    expect(res.status).toBe(400);
    const message = String(res.json.message);
    const count = (part: string) => message.split(part).length - 1;
    expect(count('environments.live.commitUrl')).toBe(1);
    expect(count('environments.live.commitPath')).toBe(1);
    expect(count('Nothing was written.')).toBe(1);
    expect(await storedText()).toBe(before);
  });

  it('deletes a stray the stored document holds when a patch sends it as null', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base: await readEnv(),
      patch: { preview: { shownNowhere: null }, limits: 'written with it' },
    });
    expect(res.status).toBe(200);
    const after = await mods.readEnvironments(projectId);
    expect(after.preview).toEqual({ url: 'https://preview.example' });
    expect(after.limits).toBe('written with it');
  });

  it('refuses a stray the stored document holds when a patch sends it a value', async () => {
    const before = await storedText();
    const res = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base: await readEnv(),
      patch: { preview: { shownNowhere: 'rewritten' } },
    });
    expect(res.status).toBe(400);
    expect(String(res.json.message)).toContain('`preview.shownNowhere`');
    expect(await storedText()).toBe(before);
  });

  it('carries a stray the stored document holds through a write that does not name it', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}/environments`, {
      base: await readEnv(),
      patch: { preview: { apiUrl: 'https://api.preview.example' } },
    });
    expect(res.status).toBe(200);
    expect((await mods.readEnvironments(projectId)).preview).toEqual({
      ...SEED_ENVIRONMENTS.preview,
      apiUrl: 'https://api.preview.example',
    });
  });

  it('refuses a scoped limits write whose stored value moved under it', async () => {
    await mods.writeEnvironmentsLimits({ projectId, base: null, value: 'no outbound email' });
    await expect(
      mods.writeEnvironmentsLimits({ projectId, base: null, value: 'written blind' }),
    ).rejects.toMatchObject({ name: 'EnvironmentsError', code: 'ENVIRONMENTS_STALE' });
    expect((await mods.readEnvironments(projectId)).limits).toBe('no outbound email');
  });
});
