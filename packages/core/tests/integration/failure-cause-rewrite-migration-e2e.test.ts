/**
 * Migration 0420, run by drizzle's own migrator over the rows the old code left: the two retired
 * cause spellings the read-time alias used to translate are rewritten to the cause each already read
 * as, in the two columns read as a failure cause and nowhere else. With the alias deleted, a row this
 * migration missed reads `unclassified` for ever, so each assertion reads the stored value back
 * through `resolveFailureCause`, the way every surface does.
 */

import { randomUUID } from 'node:crypto';
import { resolveFailureCause } from '@forge/contracts/failure-causes';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  groundBefore,
  type MigrationDb,
  type MigrationGround,
} from '../helpers/migration-ground.js';

const TAG = '0420_the_last_two_legacy_failure_causes_are_rewritten';

let ground: MigrationGround;
let m: MigrationDb;
let userId: string;
let projectId: string;
let runId: string;

beforeAll(async () => {
  ground = await groundBefore(TAG);
}, 120_000);

afterAll(async () => {
  await ground.drop();
});

beforeEach(async () => {
  m = await ground.fresh();
  userId = randomUUID();
  projectId = randomUUID();
  runId = randomUUID();
  const orgId = randomUUID();
  await m.sql`INSERT INTO users (id, email, password_hash, kind) VALUES (${userId}, ${`${userId}@forge.test`}, '!x', 'human')`;
  await m.sql`INSERT INTO organizations (id, slug, name, is_personal, created_by) VALUES (${orgId}, ${`org-${orgId.slice(0, 8)}`}, 'Org', false, ${userId})`;
  await m.sql`INSERT INTO projects (id, slug, name, org_id, created_by) VALUES (${projectId}, ${`p-${projectId.slice(0, 8)}`}, 'P', ${orgId}, ${userId})`;
  await m.sql`INSERT INTO pipeline_runs (id, project_id, kind, status) VALUES (${runId}, ${projectId}, 'system', 'running')`;
});

afterEach(async () => {
  await m.drop();
});

async function session(reason: string | null): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO agent_sessions (id, project_id, user_id, pipeline_run_id, kind, status, failure_reason)
    VALUES (${id}, ${projectId}, ${userId}, ${runId}, 'run_session', 'failed', ${reason})
  `;
  return id;
}

async function job(reason: string | null): Promise<string> {
  const id = randomUUID();
  await m.sql`
    INSERT INTO jobs (id, project_id, pipeline_run_id, created_by, type, status, payload, queued_at, failure_reason)
    VALUES (${id}, ${projectId}, ${runId}, ${userId}, 'code', 'failed', '{}'::jsonb, now(), ${reason})
  `;
  return id;
}

async function reasonOf(table: 'agent_sessions' | 'jobs', id: string): Promise<string | null> {
  const [row] = await m.sql<Array<{ failure_reason: string | null }>>`
    SELECT failure_reason FROM ${m.sql(table)} WHERE id = ${id}
  `;
  return row?.failure_reason ?? null;
}

describe.each(['agent_sessions', 'jobs'] as const)('%s.failure_reason', (table) => {
  const write = table === 'agent_sessions' ? session : job;

  it('reads job_failed as unclassified and usage_limit as provider_usage_limit, stored as such', async () => {
    const failed = await write('job_failed');
    const limited = await write('usage_limit');
    expect(resolveFailureCause('usage_limit')).toBe('unclassified');

    await m.migrate();

    expect(await reasonOf(table, failed)).toBe('unclassified');
    expect(await reasonOf(table, limited)).toBe('provider_usage_limit');
    expect(resolveFailureCause(await reasonOf(table, limited))).toBe('provider_usage_limit');
  });

  it('leaves a cause already in the vocabulary, and a row with none, as they were', async () => {
    const overloaded = await write('provider_overloaded');
    const none = await write(null);

    await m.migrate();

    expect(await reasonOf(table, overloaded)).toBe('provider_overloaded');
    expect(await reasonOf(table, none)).toBeNull();
  });
});

describe('a column holding the same spelling in another vocabulary', () => {
  it('keeps a kernel transition whose reason is job_failed, the session move it names', async () => {
    const id = await session('job_failed');
    await m.sql`
      INSERT INTO kernel_transitions (entity, entity_id, from_status, to_status, reason, actor_type, actor_agency, source)
      VALUES ('session', ${id}, 'running', 'failed', 'job_failed', 'runner', 'agent', 'session-close')
    `;

    await m.migrate();

    const [row] = await m.sql<Array<{ reason: string }>>`
      SELECT reason FROM kernel_transitions WHERE entity_id = ${id}
    `;
    expect(row?.reason).toBe('job_failed');
    expect(await reasonOf('agent_sessions', id)).toBe('unclassified');
  });
});
