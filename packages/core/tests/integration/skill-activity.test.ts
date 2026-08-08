import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { checkSkillActivityChainIntegrity as CheckChainIntegrityFn } from '../../src/skills/activity-chain-integrity.js';
import type {
  listByDevice as ListByDeviceFn,
  listByPacket as ListByPacketFn,
  listBySkill as ListBySkillFn,
  summarizeByEventType as SummarizeByEventTypeFn,
} from '../../src/skills/activity-views.js';
import type { recordSkillActivityEvent as RecordEventFn } from '../../src/skills/activity.js';
import {
  type TestDatabase,
  createTestDevice,
  createTestProject,
  createTestUser,
  setupTestDatabase,
  truncateAll,
} from '../helpers/index.js';

// cm:why real Postgres, not a mocked `tx` (see src/skills/activity.test.ts) — only a real rollback proves §9.11's same-transaction invariant actually holds.
describe('skill-activity log integration (ISS-797)', () => {
  let harness: TestDatabase;
  let schema: typeof import('../../src/db/schema.js');
  let recordSkillActivityEvent: RecordEventFn;
  let applyReconcileRun: (runId: string, actorUserId: string) => Promise<void>;
  let checkSkillActivityChainIntegrity: CheckChainIntegrityFn;
  let listBySkill: ListBySkillFn;
  let listByDevice: ListByDeviceFn;
  let listByPacket: ListByPacketFn;
  let summarizeByEventType: SummarizeByEventTypeFn;

  beforeAll(async () => {
    harness = await setupTestDatabase();
    process.env.DATABASE_URL = harness.url;
    process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
    process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
    process.env.SMTP_HOST ??= 'localhost';
    process.env.SMTP_PORT ??= '1025';
    process.env.SMTP_USER ??= 'test';
    process.env.SMTP_PASS ??= 'test';
    process.env.SMTP_FROM ??= 'test@example.com';
    process.env.APP_BASE_URL ??= 'http://localhost:3000';
    process.env.CORS_ORIGINS ??= 'http://localhost:3000';
    process.env.NODE_ENV ??= 'test';

    schema = await import('../../src/db/schema.js');
    ({ recordSkillActivityEvent } = await import('../../src/skills/activity.js'));
    ({ applyReconcileRun } = await import('../../src/skills/reconcile-service.js'));
    ({ checkSkillActivityChainIntegrity } = await import(
      '../../src/skills/activity-chain-integrity.js'
    ));
    ({ listBySkill, listByDevice, listByPacket, summarizeByEventType } = await import(
      '../../src/skills/activity-views.js'
    ));
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedProjectSkill(contentHash = 'hash-v1') {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const [skill] = await harness.db
      .insert(schema.skills)
      .values({
        name: 'forge-release',
        description: 'test skill',
        scope: 'project',
        projectId: project.id,
        prompt: 'body v1',
        source: 'user',
        contentHash,
      })
      .returning();
    if (!skill) throw new Error('insert into skills returned no row');
    return { user, project, skill };
  }

  it('rolls back the activity event together with the state change it describes', async () => {
    const { project, skill } = await seedProjectSkill();

    await expect(
      harness.db.transaction(async (tx) => {
        await tx
          .update(schema.skills)
          .set({ contentHash: 'hash-v2' })
          .where(eq(schema.skills.id, skill.id));
        await recordSkillActivityEvent(tx, {
          eventType: 'skill.body.changed',
          actor: 'agent:master',
          trigger: 'poll',
          projectId: project.id,
          skillId: skill.id,
          beforeHash: 'hash-v1',
          afterHash: 'hash-v2',
          deltaSummary: '+1/-1',
          reason: 'test-forced-rollback',
        });
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const [reloaded] = await harness.db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, skill.id));
    expect(reloaded?.contentHash).toBe('hash-v1');

    const events = await listBySkill({ projectId: project.id, skillId: skill.id });
    expect(events).toHaveLength(0);
  });

  it('commits the `skill.body.changed` event together with the skills row update', async () => {
    const { project, skill } = await seedProjectSkill();

    await harness.db.transaction(async (tx) => {
      await tx
        .update(schema.skills)
        .set({ contentHash: 'hash-v2' })
        .where(eq(schema.skills.id, skill.id));
      await recordSkillActivityEvent(tx, {
        eventType: 'skill.body.changed',
        actor: 'agent:master',
        trigger: 'poll',
        packetId: 'P-1',
        projectId: project.id,
        skillId: skill.id,
        beforeHash: 'hash-v1',
        afterHash: 'hash-v2',
        deltaSummary: '+1/-1',
        reason: 'reconcile apply',
      });
    });

    const [reloaded] = await harness.db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, skill.id));
    expect(reloaded?.contentHash).toBe('hash-v2');

    const events = await listBySkill({ projectId: project.id, skillId: skill.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'skill.body.changed',
      beforeHash: 'hash-v1',
      afterHash: 'hash-v2',
      outcome: 'ok',
    });

    const report = await checkSkillActivityChainIntegrity();
    expect(report.brokenChains).toEqual([]);
    expect(report.skillHashMismatches).toEqual([]);
  });

  it('commits the `device.skill.applied` event together with the device_skills upsert', async () => {
    const { user, project, skill } = await seedProjectSkill();
    const device = await createTestDevice(harness.db, user.id);

    await harness.db.transaction(async (tx) => {
      await tx.insert(schema.deviceSkills).values({
        deviceId: device.id,
        projectId: project.id,
        skillId: skill.id,
        installedHash: 'hash-v1',
        syncedAt: new Date(),
      });
      await recordSkillActivityEvent(tx, {
        eventType: 'device.skill.applied',
        actor: `runner:${device.id}`,
        trigger: 'poll',
        packetId: 'P-1',
        projectId: project.id,
        skillId: skill.id,
        deviceId: device.id,
        afterHash: 'hash-v1',
        reason: 'sync',
      });
    });

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'device.skill.applied', afterHash: 'hash-v1' });

    const packetEvents = await listByPacket('P-1');
    expect(summarizeByEventType(packetEvents)).toEqual({ 'device.skill.applied': 1 });

    const report = await checkSkillActivityChainIntegrity();
    expect(report.deviceHashMismatches).toEqual([]);
  });

  it('chain-integrity detects a broken hash chain and a device hash mismatch', async () => {
    const { user, project, skill } = await seedProjectSkill('hash-v1');
    const device = await createTestDevice(harness.db, user.id);

    await harness.db.insert(schema.skillActivityEvents).values([
      {
        eventType: 'skill.body.changed',
        actor: 'agent:master',
        trigger: 'poll',
        projectId: project.id,
        skillId: skill.id,
        beforeHash: 'hash-v1',
        afterHash: 'hash-v2',
      },
    ]);
    await harness.db.insert(schema.skillActivityEvents).values([
      {
        eventType: 'skill.body.changed',
        actor: 'agent:master',
        trigger: 'poll',
        projectId: project.id,
        skillId: skill.id,
        // cm:why deliberately wrong: chain expects hash-v2 here, proving findBrokenActivityChains detects the gap.
        beforeHash: 'hash-v3',
        afterHash: 'hash-v4',
      },
    ]);
    await harness.db.insert(schema.deviceSkills).values({
      deviceId: device.id,
      projectId: project.id,
      skillId: skill.id,
      installedHash: 'hash-installed',
      syncedAt: new Date(),
    });
    await harness.db.insert(schema.skillActivityEvents).values([
      {
        eventType: 'device.skill.applied',
        actor: `runner:${device.id}`,
        trigger: 'poll',
        projectId: project.id,
        skillId: skill.id,
        deviceId: device.id,
        afterHash: 'hash-logged-mismatch',
      },
    ]);

    const report = await checkSkillActivityChainIntegrity();
    expect(report.ok).toBe(false);
    expect(report.brokenChains).toHaveLength(1);
    expect(report.brokenChains[0]).toMatchObject({
      projectId: project.id,
      skillId: skill.id,
      expectedBeforeHash: 'hash-v2',
      actualBeforeHash: 'hash-v3',
    });
    expect(report.skillHashMismatches).toHaveLength(1);
    expect(report.deviceHashMismatches).toHaveLength(1);
    expect(report.deviceHashMismatches[0]).toMatchObject({
      deviceId: device.id,
      loggedHash: 'hash-logged-mismatch',
      installedHash: 'hash-installed',
    });
  });

  it('applyReconcileRun emits skill.body.changed with afterHash = hashSkillBody(body, files) — real hash path (ISS-798 BLOCKER C)', async () => {
    // cm:why exercises the REAL reconcile->publish path with a skill that has files.
    // Prior fix hand-seeded skill.body.changed with an arbitrary hash, masking the formula mismatch.
    const { hashSkillBody } = await import('../../src/skills/hash.js');

    const { user, project, skill } = await seedProjectSkill('old-hash');
    const files = [{ path: 'GUIDE.md', content: '# Guide\nReference content.' }];
    // give the skill reference files (the pattern that caused BLOCKER C)
    await harness.db
      .update(schema.skills)
      .set({ files })
      .where(eq(schema.skills.id, skill.id));

    const candidateBody = 'updated skill body v2';
    const expectedHash = hashSkillBody(candidateBody, files);
    // a files-less hash would differ — assert the test would catch the wrong formula
    const filesLessHash = hashSkillBody(candidateBody, null);
    expect(expectedHash).not.toBe(filesLessHash);

    // seed a decided reconcile run for the skill
    const [run] = await harness.db
      .insert(schema.reconcileRuns)
      .values({
        projectId: project.id,
        skillId: skill.id,
        status: 'decided',
        verdict: 'apply',
        gate: 'human',
        candidateBody,
        lastGoodHash: 'old-hash',
        // bundle has a DB default of {} — omit to let the default apply
      })
      .returning();
    if (!run) throw new Error('reconcileRuns insert returned no row');

    await applyReconcileRun(run.id, user.id);

    const events = await listBySkill({ projectId: project.id, skillId: skill.id });
    const changed = events.find((e: { eventType: string }) => e.eventType === 'skill.body.changed');
    expect(changed).toBeDefined();
    expect(changed?.afterHash).toBe(expectedHash);

    // verify contentHash on the skills row was also updated correctly
    const [updatedSkill] = await harness.db
      .select({ contentHash: schema.skills.contentHash })
      .from(schema.skills)
      .where(eq(schema.skills.id, skill.id));
    expect(updatedSkill?.contentHash).toBe(expectedHash);
  });
});
