/**
 * ISS-994 — what `forge_skills.list_registrations` says about `mode`.
 *
 * The tool's job here is to tell a caller whether a stage is gated. `mode`
 * gates at the entry status and nowhere else, and reporting the stored value
 * (or defaulting to `'auto'`) at any other stage answered a question the
 * config cannot answer: the field is inert there.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

type Mods = {
  // biome-ignore format: keep typeof-import member access on one line (esbuild transform fails otherwise)
  listSkillRegistrations: typeof import('../../src/skills/registration-service.js').listSkillRegistrations;
};

describe('list_registrations reports mode only where it gates (ISS-994)', () => {
  let harness: TestDatabase;
  let mods: Mods;
  let projectId: string;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    await truncateAll(harness.db);

    const user = await createTestUser(harness.db);
    // cm:why the fixture names `mode` at three stages because that is what sidpeak and forge-dev stored when ISS-994 was filed; a fixture with only `open.mode` could not tell the fix from the old default
    const project = await createTestProject(harness.db, user.id, {
      agentConfig: {
        pipelineConfig: {
          states: {
            open: { enabled: true, mode: 'manual' },
            in_progress: { enabled: true, mode: 'manual' },
            awaiting_release: { enabled: false, mode: 'manual' },
          },
        },
      },
    });
    projectId = project.id;

    for (const stage of ['open', 'in_progress', 'awaiting_release']) {
      const skillId = randomUUID();
      await harness.db.execute(sql`
        INSERT INTO skills (id, name, description, scope, prompt, source, content_hash)
        VALUES (${skillId}, ${`s-${stage}`}, 'integration', 'global', 'noop', 'builtin', ${`h-${skillId}`})
      `);
      await harness.db.execute(sql`
        INSERT INTO skill_registrations (project_id, skill_id, stage, registered_by)
        VALUES (${projectId}, ${skillId}, ${stage}, ${user.id})
      `);
    }

    mods = (await import('../../src/skills/registration-service.js')) as unknown as Mods;
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  it('reports the stored mode at the entry status, where isEntryGateClosed reads it', async () => {
    const rows = await mods.listSkillRegistrations(projectId);
    expect(rows.find((r) => r.stage === 'open')?.mode).toBe('manual');
  });

  it('reports null at a stage where mode gates nothing, rather than a value', async () => {
    const rows = await mods.listSkillRegistrations(projectId);
    expect(rows.find((r) => r.stage === 'in_progress')?.mode).toBeNull();
    expect(rows.find((r) => r.stage === 'awaiting_release')?.mode).toBeNull();
  });

  // cm:guard `enabled` is NOT inert off the entry status — `buildLadder` filters the rendered status ladder by it — so narrowing `mode` must leave this reading the stored value at every stage.
  it('keeps reporting enabled at every stage', async () => {
    const rows = await mods.listSkillRegistrations(projectId);
    expect(rows.find((r) => r.stage === 'awaiting_release')?.enabled).toBe(false);
    expect(rows.find((r) => r.stage === 'in_progress')?.enabled).toBe(true);
  });
});
