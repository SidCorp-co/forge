import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

// cm:why exercises the real route handler (not a hand-crafted tx like skill-activity.test.ts) — the original gap was that nothing called this endpoint from a test at all.
describe('device skills report -> activity log (ISS-798 fix)', () => {
  let harness: TestDatabase;
  let app: Hono<{ Variables: RequestIdVars }>;
  let pairDevice: typeof import('../helpers/pair-device.js').pairDevice;
  let schema: typeof import('../../src/db/schema.js');
  let listByDevice: typeof import('../../src/skills/activity-views.js').listByDevice;

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

    const { deviceSkillRoutes } = await import('../../src/devices/skills-routes.js');
    const { errorHandler } = await import('../../src/middleware/error.js');
    const { requestId } = await import('../../src/middleware/request-id.js');
    pairDevice = (await import('../helpers/pair-device.js')).pairDevice;
    schema = await import('../../src/db/schema.js');
    ({ listByDevice } = await import('../../src/skills/activity-views.js'));

    app = new Hono<{ Variables: RequestIdVars }>();
    app.use('*', requestId());
    app.route('/api/devices', deviceSkillRoutes);
    app.onError(errorHandler);
  }, 120_000);

  afterAll(async () => {
    if (harness) await harness.cleanup();
  });

  beforeEach(async () => {
    await truncateAll(harness.db);
  });

  async function seedBoundDevice() {
    const user = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, user.id);
    const { device, plaintext: deviceToken } = await pairDevice({
      ownerId: user.id,
      name: 'test-device',
      platform: 'linux',
    });
    const [skill] = await harness.db
      .insert(schema.skills)
      .values({
        name: 'forge-release',
        description: 'test skill',
        scope: 'project',
        projectId: project.id,
        prompt: 'body v1',
        source: 'user',
        contentHash: 'h1',
      })
      .returning();
    if (!skill) throw new Error('insert into skills returned no row');
    await harness.db.execute(sql`
      INSERT INTO runners (id, project_id, type, device_id, name, status)
      VALUES (${randomUUID()}, ${project.id}, 'claude-code', ${device.id}, 'e2e-runner', 'online')
    `);
    return { project, device, skill, deviceToken };
  }

  async function report(
    projectId: string,
    deviceToken: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return app.request(`/api/devices/me/skills/report?projectId=${projectId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify(body),
    });
  }

  it('first report emits device.skill.applied + device.skill.observed', async () => {
    const { project, device, skill, deviceToken } = await seedBoundDevice();

    const res = await report(project.id, deviceToken, {
      skills: [{ skillId: skill.id, installedHash: 'h1', observedSha: 'h1' }],
    });
    expect(res.status).toBe(200);

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    const types = events.map((e) => e.eventType).sort();
    expect(types).toEqual(['device.skill.applied', 'device.skill.observed']);
  });

  it('an unchanged re-report (poll) emits nothing', async () => {
    const { project, device, skill, deviceToken } = await seedBoundDevice();
    await report(project.id, deviceToken, {
      skills: [{ skillId: skill.id, installedHash: 'h1', observedSha: 'h1' }],
    });

    const res = await report(project.id, deviceToken, {
      skills: [{ skillId: skill.id, installedHash: 'h1', observedSha: 'h1' }],
    });
    expect(res.status).toBe(200);

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    expect(events).toHaveLength(2);
  });

  it('a hash change on a later report emits a second device.skill.applied', async () => {
    const { project, device, skill, deviceToken } = await seedBoundDevice();
    await report(project.id, deviceToken, {
      skills: [{ skillId: skill.id, installedHash: 'h1', observedSha: 'h1' }],
    });

    await report(project.id, deviceToken, {
      skills: [{ skillId: skill.id, installedHash: 'h2', observedSha: 'h2' }],
    });

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    const applied = events.filter((e) => e.eventType === 'device.skill.applied');
    expect(applied).toHaveLength(2);
    expect(applied[1]).toMatchObject({ beforeHash: 'h1', afterHash: 'h2' });
  });

  it('a shadow appearing emits device.skill.shadowed, not device.skill.observed', async () => {
    const { project, device, skill, deviceToken } = await seedBoundDevice();
    await report(project.id, deviceToken, {
      skills: [{ skillId: skill.id, installedHash: 'h1', observedSha: 'h1' }],
    });

    const res = await report(project.id, deviceToken, {
      skills: [
        {
          skillId: skill.id,
          installedHash: 'h1',
          observedSha: 'shadow-hash',
          shadowedBy: '/home/user/.claude/skills/forge-release',
        },
      ],
    });
    expect(res.status).toBe(200);

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    const shadowed = events.filter((e) => e.eventType === 'device.skill.shadowed');
    const observed = events.filter((e) => e.eventType === 'device.skill.observed');
    expect(shadowed).toHaveLength(1);
    expect(observed).toHaveLength(1);
    expect(shadowed[0]).toMatchObject({
      deltaSummary: '/home/user/.claude/skills/forge-release',
    });

    const [row] = await harness.db
      .select({ shadowedBy: schema.deviceSkills.shadowedBy })
      .from(schema.deviceSkills)
      .where(sql`device_id = ${device.id} AND skill_id = ${skill.id}`);
    expect(row?.shadowedBy).toBe('/home/user/.claude/skills/forge-release');
  });

  it('POST /me/skills/sync-failed records device.sync.failed', async () => {
    const { project, device, deviceToken } = await seedBoundDevice();

    const res = await app.request(`/api/devices/me/skills/sync-failed?projectId=${project.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({ error: 'manifest pull failed: network timeout' }),
    });
    expect(res.status).toBe(200);

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'device.sync.failed',
      outcome: 'failed',
      reason: 'manifest pull failed: network timeout',
    });
  });

  it('a repeat sync-failed with the SAME reason emits nothing (dedup)', async () => {
    const { project, device, deviceToken } = await seedBoundDevice();
    const body = JSON.stringify({ error: 'manifest pull failed: network timeout' });
    const post = () =>
      app.request(`/api/devices/me/skills/sync-failed?projectId=${project.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
        body,
      });

    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    expect(events.filter((e) => e.eventType === 'device.sync.failed')).toHaveLength(1);
  });

  it('a sync-failed with a DIFFERENT reason after a repeat still records', async () => {
    const { project, device, deviceToken } = await seedBoundDevice();
    const fail = (error: string) =>
      app.request(`/api/devices/me/skills/sync-failed?projectId=${project.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${deviceToken}` },
        body: JSON.stringify({ error }),
      });

    await fail('manifest pull failed: network timeout');
    await fail('manifest pull failed: network timeout');
    await fail('manifest pull failed: 500 from core');

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    expect(events.filter((e) => e.eventType === 'device.sync.failed')).toHaveLength(2);
  });

  it('clearing a shadow (shadowedBy -> null) with an unchanged observedSha still emits device.skill.observed', async () => {
    const { project, device, skill, deviceToken } = await seedBoundDevice();
    await report(project.id, deviceToken, {
      skills: [
        {
          skillId: skill.id,
          installedHash: 'h1',
          observedSha: 'shadow-hash',
          shadowedBy: '/home/user/.claude/skills/forge-release',
        },
      ],
    });

    const res = await report(project.id, deviceToken, {
      skills: [{ skillId: skill.id, installedHash: 'h1', observedSha: 'shadow-hash' }],
    });
    expect(res.status).toBe(200);

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    const observed = events.filter((e) => e.eventType === 'device.skill.observed');
    expect(observed).toHaveLength(1);
  });

  it('an applied event stamps packetId when installedHash matches a skill.body.changed packet', async () => {
    const { project, device, skill, deviceToken } = await seedBoundDevice();

    await harness.db.insert(schema.skillActivityEvents).values({
      eventType: 'skill.body.changed',
      actor: 'agent:master',
      trigger: 'manual',
      projectId: project.id,
      skillId: skill.id,
      packetId: 'packet-1',
      beforeHash: 'h0',
      afterHash: 'h1',
    });

    const res = await report(project.id, deviceToken, {
      skills: [{ skillId: skill.id, installedHash: 'h1', observedSha: 'h1' }],
    });
    expect(res.status).toBe(200);

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    const applied = events.find((e) => e.eventType === 'device.skill.applied');
    expect(applied).toMatchObject({ packetId: 'packet-1' });
    const observed = events.find((e) => e.eventType === 'device.skill.observed');
    expect(observed).toMatchObject({ packetId: 'packet-1' });
  });

  it('a shadowed device: applied stamps packetId (packet reached), shadowed withholds it (shadow body is user-authored)', async () => {
    const { project, device, skill, deviceToken } = await seedBoundDevice();

    await harness.db.insert(schema.skillActivityEvents).values({
      eventType: 'skill.body.changed',
      actor: 'agent:master',
      trigger: 'manual',
      projectId: project.id,
      skillId: skill.id,
      packetId: 'packet-1',
      beforeHash: 'h0',
      afterHash: 'h1',
    });

    const res = await report(project.id, deviceToken, {
      skills: [
        {
          skillId: skill.id,
          installedHash: 'h1',
          observedSha: 'shadow-hash',
          shadowedBy: '/home/user/.claude/skills/forge-release',
        },
      ],
    });
    expect(res.status).toBe(200);

    const events = await listByDevice({ projectId: project.id, deviceId: device.id });
    const applied = events.find((e) => e.eventType === 'device.skill.applied');
    // cm:why applied always carries packetId because the packet DID reach the device (BLOCKER D)
    expect(applied?.packetId).toBe('packet-1');
    const shadowed = events.find((e) => e.eventType === 'device.skill.shadowed');
    // cm:why shadowed withholds packetId because the shadow body is user-authored, not from the packet
    expect(shadowed?.packetId).toBeNull();
  });
});
