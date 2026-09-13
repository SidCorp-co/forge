/**
 * ISS-994 — migration 0234, run against a real Postgres over documents shaped
 * like the ones on the fleet.
 *
 * A unit test over the schema shows what a PARSE drops. It cannot show what a
 * stored document still holds, and the stored document is the whole defect:
 * `forge_config` action=get returns it raw, so a key the schema strips on the
 * REST door is a key an operator still reads on the MCP one.
 *
 * The migration has already run by the time this file starts, so it is
 * re-applied here against rows seeded to carry every removable key. It deletes
 * jsonb keys and nothing else, so re-applying it is the same operation twice.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const migrationPath = fileURLToPath(
  new URL('../../drizzle/migrations/0234_pipeline_config_phantom_keys.sql', import.meta.url),
);

/** Every removable key, plus the neighbours that must survive untouched. */
const STORED = {
  enabled: true,
  recoveryMaxAttempts: 3,
  recoveryWindowHours: 24,
  recoveryByFailureKind: { unknown: 2, permanent: 0, transient: 5 },
  maxResumeTokens: 150_000,
  states: {
    open: { enabled: true, mode: 'manual', model: 'opus', disallowedTools: ['CronCreate'] },
    in_progress: { enabled: true, mode: 'manual', model: 'sonnet' },
    needs_info: { mode: 'auto' },
    awaiting_release: { enabled: true, mode: 'auto', disallowedTools: ['Workflow'] },
  },
};

type StoredConfig = Record<string, unknown> & { states?: Record<string, unknown> };

describe('migration 0234 removes the phantom pipelineConfig keys (ISS-994)', () => {
  let harness: TestDatabase;
  let projectId: string;
  let untouchedId: string;
  let after: StoredConfig;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id, {
      agentConfig: { pipelineConfig: STORED, stateContext: { code: { note: 'kept' } } },
    });
    projectId = project.id;
    const untouched = await createTestProject(harness.db, user.id, { agentConfig: {} });
    untouchedId = untouched.id;

    await harness.db.execute(sql.raw(readFileSync(migrationPath, 'utf8')));

    const rows = (await harness.db.execute(
      sql`SELECT agent_config FROM projects WHERE id = ${projectId}`,
    )) as unknown as { agent_config: { pipelineConfig: StoredConfig } }[];
    after = rows[0]?.agent_config.pipelineConfig as StoredConfig;
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  it('removes all three recovery keys from the stored document', () => {
    expect(after.recoveryMaxAttempts).toBeUndefined();
    expect(after.recoveryWindowHours).toBeUndefined();
    expect(after.recoveryByFailureKind).toBeUndefined();
  });

  it('removes mode from every stage that is not the entry status', () => {
    expect(after.states?.in_progress).toEqual({ enabled: true, model: 'sonnet' });
    expect(after.states?.needs_info).toEqual({});
    expect(after.states?.awaiting_release).toEqual({
      enabled: true,
      disallowedTools: ['Workflow'],
    });
  });

  // cm:guard `open.mode` is the ONE representable way to close the entry gate — `pipeline-config-service.ts` refuses `open.enabled = false` outright — so a migration that took it would silently release every project a human was holding.
  it('leaves the entry status untouched, mode included', () => {
    expect(after.states?.open).toEqual({
      enabled: true,
      mode: 'manual',
      model: 'opus',
      disallowedTools: ['CronCreate'],
    });
  });

  it('leaves every other key of the document alone', () => {
    expect(after.enabled).toBe(true);
    expect(after.maxResumeTokens).toBe(150_000);
    expect(Object.keys(after).sort()).toEqual(['enabled', 'maxResumeTokens', 'states']);
  });

  it('leaves a project with no pipelineConfig alone', async () => {
    const rows = (await harness.db.execute(
      sql`SELECT agent_config FROM projects WHERE id = ${untouchedId}`,
    )) as unknown as { agent_config: Record<string, unknown> }[];
    expect(rows[0]?.agent_config).toEqual({});
  });

  it('leaves sibling agentConfig keys alone', async () => {
    const rows = (await harness.db.execute(
      sql`SELECT agent_config FROM projects WHERE id = ${projectId}`,
    )) as unknown as { agent_config: Record<string, unknown> }[];
    expect(rows[0]?.agent_config.stateContext).toEqual({ code: { note: 'kept' } });
  });
});
