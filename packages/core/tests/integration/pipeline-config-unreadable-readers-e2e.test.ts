/**
 * ISS-1368 — a stored `pipelineConfig` the schema refuses is refused by name by every reader that
 * acts on it, never read as no configuration or as the defaults. Real Postgres, because what is
 * asserted is what each reader does with the document a project stores.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDevice,
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';
import {
  expectNamed,
  REFUSED,
  refusalOf,
  storeConfig,
} from '../helpers/refused-pipeline-config.js';

let harness: TestDatabase;
let ownerId: string;
let refusedId: string;
let soundId: string;
let deviceId: string;

const named = (said: string) => expectNamed(said, refusedId);
const LOCK_REFUSED = { lockedSkills: ['forge-code', 7] };

async function issueAt(projectId: string, status: string, seq: number): Promise<string> {
  const id = randomUUID();
  await harness.db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${projectId}, ${seq}, ${`issue ${seq}`}, ${status}, ${ownerId})
  `);
  return id;
}

async function bindDevice(projectId: string): Promise<void> {
  await harness.db.execute(sql`
    INSERT INTO runners (id, project_id, type, device_id, name, status, last_seen_at, labels)
    VALUES (${randomUUID()}, ${projectId}, 'claude-code', ${deviceId}, ${`runner-${projectId}`},
            'online', now(), '[]'::jsonb)
  `);
}

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
}, 180_000);

afterAll(async () => {
  await harness?.cleanup();
});

beforeEach(async () => {
  await truncateAll(harness.db);
  ownerId = (await createTestUser(harness.db, { emailVerifiedAt: new Date() })).id;
  const org = await seedOrg(harness.db, ownerId);
  const project = (agentConfig: Record<string, unknown>) =>
    createTestProject(harness.db, ownerId, { orgId: org.id, agentConfig });
  refusedId = (await project({ pipelineConfig: REFUSED })).id;
  soundId = (await project({ pipelineConfig: { poolBacklog: { statuses: ['confirmed'] } } })).id;
  deviceId = (await createTestDevice(harness.db, ownerId)).id;
});

describe('every reader refuses a stored pipelineConfig the schema refuses, by name', () => {
  it('readPipelineConfig refuses it, rather than answering no configuration', async () => {
    const { readPipelineConfig } = await import('../../src/pipeline/autonomous-project.js');
    named(await refusalOf(() => readPipelineConfig(refusedId)));
  });

  it('refuses a stored null rather than reading it as absent', async () => {
    const { readPipelineConfig } = await import('../../src/pipeline/autonomous-project.js');
    await storeConfig(harness.db, refusedId, null);

    const said = await refusalOf(() => readPipelineConfig(refusedId));

    expect(said).toContain(refusedId);
    expect(said).toContain('pipelineConfig: ');
  });

  it('a status transition on that project is refused naming it', async () => {
    const { transitionIssueStatus } = await import('../../src/issues/apply-transition.js');
    const id = await issueAt(refusedId, 'open', 1);
    const row = { id, projectId: refusedId, status: 'open' as const, reopenCount: 0 };
    const actor = { type: 'user' as const, id: ownerId };
    named(await refusalOf(() => transitionIssueStatus(row, 'confirmed', actor)));
  });

  it('an autonomous dispatch on that project is refused naming it', async () => {
    const { reEnqueueForIssue } = await import('../../src/pipeline/orchestrator.js');
    const issueId = await issueAt(refusedId, 'open', 2);
    const actor = { type: 'user' as const, id: ownerId, agency: 'human' as const };
    const args = { projectId: refusedId, issueId, status: 'open' as const, actor, reason: {} };
    named(await refusalOf(() => reEnqueueForIssue(args)));
  });

  it('a manual run on that project is refused naming it', async () => {
    const { triggerPipelineStepManual } = await import('../../src/pipeline/orchestrator.js');
    const issueId = await issueAt(refusedId, 'open', 3);
    const actor = { type: 'user' as const, id: ownerId, agency: 'human' as const };
    const args = { projectId: refusedId, issueId, status: 'open' as const, actor, reason: {} };
    named(await refusalOf(() => triggerPipelineStepManual(args)));
  });

  it("a device's admissible read names the refused project and still answers for the other", async () => {
    const { readAdmissibleIssues } = await import('../../src/devices/admissible.js');
    await bindDevice(refusedId);
    await bindDevice(soundId);
    const sound = await issueAt(soundId, 'confirmed', 4);
    await issueAt(refusedId, 'confirmed', 5);
    const refused: Array<{ projectId: string; code: string; message: string }> = [];

    const items = await readAdmissibleIssues({ deviceId, refused });

    expect(items.map((i) => i.issueId)).toEqual([sound]);
    expect(refused.map((r) => r.projectId)).toEqual([refusedId]);
    named(refused[0]?.message ?? '');
    named(await refusalOf(() => readAdmissibleIssues({ deviceId, projectId: refusedId })));
  });

  it('a release weighing refuses a refused key outside releaseRuntimes', async () => {
    const { readWeighingNow } = await import('../../src/release-batch/runtime-weighing.js');
    const sound = [{ name: 'runner', paths: ['packages/runner'], servedBy: 'project-runners' }];
    await storeConfig(harness.db, refusedId, { releaseRuntimes: sound, ...LOCK_REFUSED });
    const serving = { kind: 'serving' as const, served: [], unread: [], readAt: '2026-10-02' };

    const said = await refusalOf(() => readWeighingNow(refusedId, serving));

    expect(said).toContain(refusedId);
    expect(said).toContain('pipelineConfig.lockedSkills');
  });

  it("a skill write is refused where the project's lockedSkills is refused, not read as unlocked", async () => {
    const { assertSkillNameWritable } = await import('../../src/skills/lock-context.js');
    await storeConfig(harness.db, refusedId, LOCK_REFUSED);

    const said = await refusalOf(() => assertSkillNameWritable('forge-code', refusedId));

    expect(said).toContain(refusedId);
    expect(said).toContain('pipelineConfig.lockedSkills');
  });
});
