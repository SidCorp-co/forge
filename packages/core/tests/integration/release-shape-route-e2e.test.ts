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

/**
 * ISS-1189 — the declaration and the stored blob may not disagree, judged at the door.
 *
 * `shapeGapOf` is proved as a pure function in `projects/release-shape.test.ts`. What only a real
 * row can prove is the half the rule is actually about: a PATCH is judged against the
 * configuration it would LEAVE BEHIND, so a body carrying one side alone is measured against the
 * stored other. And criterion 4 is a claim about a value NOT being stored, which a mocked db
 * cannot witness at all.
 */
let harness: TestDatabase;
let server: TestServer;
let mods: {
  signUserToken: typeof import('../../src/auth/jwt.js').signUserToken;
  projects: typeof import('../../src/db/schema.js').projects;
};
let ownerId: string;
let projectId: string;

/** forge-dev's own value, as it stood until 2026-09-22. */
const FORGE_DEV_BEFORE_THE_FIX = {
  preview: {
    url: 'https://forge-beta.sidcorp.co',
    apiUrl: 'https://forge-beta-api.sidcorp.co',
    urls: [{ label: 'Beta Version (Staging Here)', url: 'https://forge-beta.sidcorp.co' }],
  },
  live: {
    url: 'https://forge-beta.sidcorp.co',
    apiUrl: 'https://forge-beta-api.sidcorp.co',
    commitUrl: 'https://forge-beta-api.sidcorp.co/health',
    commitPath: 'sourceCommit',
  },
};

const A_REAL_PREVIEW = {
  preview: { url: 'https://staging.example.com', apiUrl: 'https://api.staging.example.com' },
  live: { url: 'https://app.example.com', apiUrl: 'https://api.example.com' },
};

async function patch(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const token = await mods.signUserToken(ownerId);
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

async function get(): Promise<Record<string, unknown>> {
  const token = await mods.signUserToken(ownerId);
  const res = await fetch(`${server.baseUrl}/api/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()) as Record<string, unknown>;
}

async function stored(): Promise<{ previewShape: string; environments: unknown }> {
  const [row] = await harness.db
    .select({
      previewShape: mods.projects.previewShape,
      environments: mods.projects.environments,
    })
    .from(mods.projects)
    .where(eq(mods.projects.id, projectId));
  return row as { previewShape: string; environments: unknown };
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  const [jwt, schema] = await Promise.all([
    import('../../src/auth/jwt.js'),
    import('../../src/db/schema.js'),
  ]);
  mods = { signUserToken: jwt.signUserToken, projects: schema.projects };
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
  projectId = (await createTestProject(harness.db, ownerId, { orgId: org.id })).id;
  await createTestProjectMember(harness.db, { userId: ownerId, projectId, role: 'admin' });
});

describe('the declaration is a field of the project', () => {
  it('starts every project at `local`, which is a one-box project and not a gap', async () => {
    expect((await get()).previewShape).toBe('local');
  });

  it('takes `deployed` alongside the preview side it declares', async () => {
    const res = await patch({ previewShape: 'deployed', environments: A_REAL_PREVIEW });
    expect(res.status).toBe(200);
    expect((await get()).previewShape).toBe('deployed');
  });

  it('refuses a value that is neither', async () => {
    expect((await patch({ previewShape: 'localhost' })).status).toBe(400);
  });
});

describe('a PATCH is judged against the configuration it would leave behind', () => {
  it('refuses `local` sent alone over a stored preview host', async () => {
    await patch({ previewShape: 'deployed', environments: A_REAL_PREVIEW });
    const res = await patch({ previewShape: 'local' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('PREVIEW_SHAPE_LOCAL_WITH_HOST');
  });

  it('refuses a preview host sent alone over a stored `local`', async () => {
    const res = await patch({ environments: A_REAL_PREVIEW });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('PREVIEW_SHAPE_LOCAL_WITH_HOST');
  });

  it('refuses `deployed` sent alone over a stored blob naming no preview host', async () => {
    const res = await patch({ previewShape: 'deployed' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('PREVIEW_SHAPE_DEPLOYED_WITHOUT_HOST');
  });

  it('takes both sides changed together, which is how the screen sends them', async () => {
    await patch({ previewShape: 'deployed', environments: A_REAL_PREVIEW });
    const res = await patch({
      previewShape: 'local',
      environments: { preview: null, live: A_REAL_PREVIEW.live },
    });
    expect(res.status).toBe(200);
    expect((await stored()).previewShape).toBe('local');
  });
});

describe('forge-dev’s pre-fix blob, sent at the door it was stored through', () => {
  it('is refused rather than stored', async () => {
    const res = await patch({ previewShape: 'deployed', environments: FORGE_DEV_BEFORE_THE_FIX });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.json)).toContain('PREVIEW_IS_LIVE_HOST');
  });

  it('names the host the two sides share, in the refusal itself', async () => {
    const res = await patch({ previewShape: 'deployed', environments: FORGE_DEV_BEFORE_THE_FIX });
    expect(res.status).toBe(400);
    expect(String(res.json.message ?? '')).toContain('forge-beta.sidcorp.co');
  });

  it('leaves the stored environments untouched', async () => {
    await patch({ previewShape: 'deployed', environments: FORGE_DEV_BEFORE_THE_FIX });
    expect((await stored()).environments).toBeNull();
  });
});
