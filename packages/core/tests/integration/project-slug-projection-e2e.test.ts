/**
 * ISS-34 — a project's slug and name are the document's `project.slug` and `project.name`;
 * `projects.slug` and `projects.name` are their projection, written by `casProject` in the
 * document's own transaction. Against real Postgres, because the
 * defect was a column nothing wrote, and a mocked store holds whatever it is handed.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

let harness: TestDatabase;
let userId: string;
let service: typeof import('../../src/project-config/service.js');
let projects: typeof import('../../src/projects/service.js');
let store: typeof import('../../src/project-config/store.js');

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.NODE_ENV ??= 'test';
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  service = await import('../../src/project-config/service.js');
  projects = await import('../../src/projects/service.js');
  store = await import('../../src/project-config/store.js');
}, 60_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  userId = (await createTestUser(harness.db)).id;
});

const doc = (projectId: string, slug: string, name = 'Slugged') => ({
  $schema: 'https://forge.sidcorp.co/schemas/project-v1.json',
  version: 1,
  project: { id: projectId, slug, name },
  source: { type: 'none' },
  workspace: { isolation: 'none' },
  validation: { gate: { type: 'none' } },
  environments: {},
  promotions: [],
  rollback: { strategy: 'revert-and-redeploy' },
  execution: {
    plugin: { source: 'SidCorp-co/forge-plugin', ref: '73225dedb41b5da26b4ce73518086e26e81f91b8' },
  },
});

async function column(projectId: string): Promise<string | undefined> {
  const rows = (await harness.db.execute(
    sql`SELECT slug FROM projects WHERE id = ${projectId}`,
  )) as unknown as Array<{ slug: string }>;
  return rows[0]?.slug;
}

describe('a slug changed through the project document', () => {
  it('is the column, and the lookup by slug, in the same write', async () => {
    const { id, slug: before } = await createTestProject(harness.db, userId);
    const written = await service.writeProjectConfig({
      projectId: id,
      userId,
      baseRevision: null,
      raw: doc(id, 'renamed-by-document'),
    });
    expect(written.ok, JSON.stringify(written)).toBe(true);

    expect(await column(id)).toBe('renamed-by-document');
    expect(await projects.findProjectIdBySlug('renamed-by-document')).toBe(id);
    expect(await projects.findProjectIdBySlug(before)).toBeNull();
  });

  it("is refused SLUG_TAKEN where another project's column holds it, and nothing is written", async () => {
    const holder = await createTestProject(harness.db, userId, { slug: 'held-slug' });
    const { id, slug: before } = await createTestProject(harness.db, userId);
    const written = await service.writeProjectConfig({
      projectId: id,
      userId,
      baseRevision: null,
      raw: doc(id, 'held-slug'),
    });
    expect(written).toMatchObject({
      ok: false,
      refusals: [expect.objectContaining({ code: 'SLUG_TAKEN' })],
    });
    expect(await column(id)).toBe(before);
    expect(await projects.findProjectIdBySlug('held-slug')).toBe(holder.id);
  });

  it('is refused SLUG_TAKEN by the projection itself when the check above it was passed', async () => {
    await createTestProject(harness.db, userId, { slug: 'raced-slug' });
    const { id, slug: before } = await createTestProject(harness.db, userId);
    const result = await store.drizzleConfigStore.casProject({
      projectId: id,
      baseRevision: null,
      document: doc(id, 'raced-slug'),
      userId,
    });
    expect(result).toMatchObject({ ok: false, refusal: { code: 'SLUG_TAKEN' } });
    expect(await column(id)).toBe(before);
    expect(await service.readProjectConfig(id)).toBeNull();
  });

  it('answers slugTakenBy from the column alone', async () => {
    const other = randomUUID();
    const { id } = await createTestProject(harness.db, userId, { id: other, slug: 'col-slug' });
    expect(await store.drizzleConfigStore.slugTakenBy(randomUUID(), 'col-slug')).toBe(id);
    expect(await store.drizzleConfigStore.slugTakenBy(id, 'col-slug')).toBeNull();
  });
});

async function nameColumn(projectId: string): Promise<string | undefined> {
  const rows = (await harness.db.execute(
    sql`SELECT name FROM projects WHERE id = ${projectId}`,
  )) as unknown as Array<{ name: string }>;
  return rows[0]?.name;
}

describe('a name changed through the project document', () => {
  it('is the column in the same write, at its first revision and at every one after', async () => {
    const { id, slug } = await createTestProject(harness.db, userId, { name: 'Before' });
    const first = await service.writeProjectConfig({
      projectId: id,
      userId,
      baseRevision: null,
      raw: doc(id, slug, 'Named by the document'),
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(await nameColumn(id)).toBe('Named by the document');

    const second = await service.writeProjectConfig({
      projectId: id,
      userId,
      baseRevision: 1,
      raw: doc(id, slug, 'Renamed again'),
    });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(await nameColumn(id)).toBe('Renamed again');
    expect((await projects.readProjectSummary(id))?.name).toBe('Renamed again');
  });

  it('leaves the column as it was when the write is refused', async () => {
    const { id, slug } = await createTestProject(harness.db, userId, { name: 'Kept' });
    const refused = await service.writeProjectConfig({
      projectId: id,
      userId,
      baseRevision: 7,
      raw: doc(id, slug, 'Never written'),
    });
    expect(refused).toMatchObject({
      ok: false,
      refusals: [expect.objectContaining({ code: 'STALE_BASE' })],
    });
    expect(await nameColumn(id)).toBe('Kept');
  });
});
