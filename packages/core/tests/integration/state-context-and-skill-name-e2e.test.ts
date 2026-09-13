/**
 * ISS-1000 — migration 0237 against a real Postgres, over a document shaped like
 * the ones on the fleet, plus the permissive read the retirement depends on.
 *
 * A unit test over the schema shows what a PARSE drops. It cannot show what a
 * stored document still holds, and the stored document is the whole defect:
 * `GET /api/projects/:id` and `forge_config` action=get both return
 * `agent_config` raw, so a key the schema strips on the write door is a key an
 * operator still reads on those two.
 *
 * This is also the only place the pair of criteria about a STORED retired key
 * can be judged. Once 0236 has run on the deployment there is no such key left
 * to read a permissive parse against, and no pre-migration row left to compare a
 * preserved sibling to, so the fixture below is seeded rather than found.
 *
 * The migration has already run by the time this file starts, so it is
 * re-applied here against a row seeded to carry both removable keys. It deletes
 * jsonb keys and nothing else, so re-applying it is the same operation twice.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pipelineConfigSchema } from '../../src/pipeline/pipeline-config-schema.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

const migrationPath = fileURLToPath(
  new URL('../../drizzle/migrations/0239_state_context_and_stage_skill_name.sql', import.meta.url),
);

/** Both retired keys, beside the neighbours that must survive untouched. */
const STORED_PIPELINE = {
  enabled: true,
  maxResumeTokens: 150_000,
  states: {
    open: { enabled: true, mode: 'manual', skillName: 'forge-triage', model: 'opus' },
    in_progress: { enabled: true, skillName: 'forge-code' },
    needs_info: { disallowedTools: ['Workflow'] },
    awaiting_release: { enabled: true, skillName: 'forge-release' },
    // cm:guard a stage ISS-897 deleted, and the reason the migration rebuilds the whole `states` map rather than deleting four named paths: a document holding one of the old stage names would otherwise keep its `skillName`, which `GET /api/projects/:id` and `forge_config` action=get both still show raw.
    confirmed: { skillName: 'forge-review', model: 'sonnet' },
  },
};

const STORED_STATE_CONTEXT = {
  triage: {
    modelOverride: 'claude-haiku-4-5-20251001',
    budget: { perRunUsd: 7, perMonthUsd: 150, action: 'warn' },
  },
};

type StoredConfig = Record<string, unknown> & { states?: Record<string, unknown> };

describe('migration 0237 removes stateContext and the stage skillName (ISS-1000)', () => {
  let harness: TestDatabase;
  let projectId: string;
  let untouchedId: string;
  let afterAc: Record<string, unknown>;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    await truncateAll(harness.db);
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id, {
      agentConfig: {
        pipelineConfig: STORED_PIPELINE,
        stateContext: STORED_STATE_CONTEXT,
        personaStyle: 'kept',
        plugins: [{ marketplace: 'SidCorp-co/forge-plugin', name: 'forge' }],
      },
    });
    projectId = project.id;
    const untouched = await createTestProject(harness.db, user.id, { agentConfig: {} });
    untouchedId = untouched.id;

    await harness.db.execute(sql.raw(readFileSync(migrationPath, 'utf8')));

    const rows = (await harness.db.execute(
      sql`SELECT agent_config FROM projects WHERE id = ${projectId}`,
    )) as unknown as { agent_config: Record<string, unknown> }[];
    afterAc = rows[0]?.agent_config as Record<string, unknown>;
  }, 180_000);

  afterAll(async () => {
    await harness?.cleanup?.();
  });

  // cm:guard the assertion is on the STORED document, not on a parse of it. The schema has dropped both keys since this change landed, so a test that read them back through `pipelineConfigSchema` would pass against an un-migrated database and prove nothing.
  it('removes stateContext from the stored agentConfig', () => {
    expect(afterAc).not.toHaveProperty('stateContext');
  });

  it('removes skillName from every stage of the stored pipelineConfig, deleted stages included', () => {
    const pc = afterAc.pipelineConfig as StoredConfig;
    for (const stage of Object.keys(pc.states ?? {})) {
      expect(pc.states?.[stage]).not.toHaveProperty('skillName');
    }
    expect(Object.keys(pc.states ?? {}).sort()).toEqual([
      'awaiting_release',
      'confirmed',
      'in_progress',
      'needs_info',
      'open',
    ]);
    expect(pc.states?.confirmed).toEqual({ model: 'sonnet' });
  });

  it('leaves every other key of the stage documents alone, open.mode included', () => {
    const pc = afterAc.pipelineConfig as StoredConfig;
    expect(pc.states?.open).toEqual({ enabled: true, mode: 'manual', model: 'opus' });
    expect(pc.states?.in_progress).toEqual({ enabled: true });
    expect(pc.states?.needs_info).toEqual({ disallowedTools: ['Workflow'] });
    expect(pc.enabled).toBe(true);
    expect(pc.maxResumeTokens).toBe(150_000);
  });

  it('leaves the sibling agentConfig keys alone', () => {
    expect(afterAc.personaStyle).toBe('kept');
    expect(afterAc.plugins).toEqual([{ marketplace: 'SidCorp-co/forge-plugin', name: 'forge' }]);
    expect(Object.keys(afterAc).sort()).toEqual(['personaStyle', 'pipelineConfig', 'plugins']);
  });

  it('leaves a project with no pipelineConfig and no stateContext alone', async () => {
    const rows = (await harness.db.execute(
      sql`SELECT agent_config FROM projects WHERE id = ${untouchedId}`,
    )) as unknown as { agent_config: Record<string, unknown> }[];
    expect(rows[0]?.agent_config).toEqual({});
  });

  // cm:guard the READ stays permissive and that asymmetry is deliberate: a canonical schema that REFUSED a stored `skillName` would make every project still holding one parse to `cfg = null`, `isAutonomous` false, and dispatch nothing in silence — the shape ISS-994's own guard measured on 2026-09-10. This is the assertion that goes red if the refusal is moved onto the canonical schema.
  it('parses a document that still stores both keys, dropping skillName rather than refusing', () => {
    const { confirmed: _deletedStage, ...states } = STORED_PIPELINE.states;
    const parsed = pipelineConfigSchema.parse({ ...STORED_PIPELINE, states });
    expect(parsed.states?.open).toEqual({ enabled: true, mode: 'manual', model: 'opus' });
    expect(parsed.states?.in_progress).toEqual({ enabled: true });
  });
});
