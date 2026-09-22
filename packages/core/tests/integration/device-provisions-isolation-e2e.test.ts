/**
 * `GET /api/devices/me/provisions`, against real Postgres — ISS-1184.
 *
 * The defect was measured on `sid-xeon-1` as three projects presenting as one
 * outage: a device with any row at `provisionStatus = 'queued'` answered
 * `500 INTERNAL_ERROR`, so one unprovisionable project stopped every other
 * project on the box from being provisioned.
 *
 * Two propositions, and the second decides whether this is a fix rather than a
 * better error message: the collision that threw is gone, AND a row that cannot
 * be built takes nothing else down with it. The second is proved by queueing a
 * healthy project beside a failing one and reading the healthy one back out.
 *
 * Real Postgres is the point. The unit test that covered
 * `issueWorkspaceCredential` mocked `db` entirely, so `pat_user_name_uniq` was
 * not representable in the runtime that ran it and its green said nothing about
 * this at all.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestIdVars } from '../../src/middleware/request-id.js';
import {
  createTestProject,
  createTestUser,
  seedOrg,
  setupTestDatabase,
  type TestDatabase,
  truncateAll,
} from '../helpers/index.js';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

/**
 * How one project's mint is made to fail, keyed by project id. Default is the
 * real thing: every test here runs the real credential path unless it says
 * otherwise, so the reproduction above is a reproduction and not a mock of one.
 */
const { failures, recordingFailure } = vi.hoisted(() => ({
  failures: new Map<string, () => Promise<string>>(),
  recordingFailure: { next: null as Error | null },
}));

vi.mock('../../src/devices/provision-reports.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/devices/provision-reports.js')>();
  return {
    ...real,
    recordProvisionReports: async (reports: Parameters<typeof real.recordProvisionReports>[0]) => {
      const err = recordingFailure.next;
      if (err) {
        recordingFailure.next = null;
        throw err;
      }
      return real.recordProvisionReports(reports);
    },
  };
});

vi.mock('../../src/devices/workspace-credential.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/devices/workspace-credential.js')>();
  return {
    ...real,
    issueWorkspaceCredential: async (args: {
      deviceId: string;
      projectId: string;
      holderUserId: string;
    }) => {
      const fail = failures.get(args.projectId);
      if (fail) return fail();
      return real.issueWorkspaceCredential(args);
    },
  };
});

let harness: TestDatabase;
let app: Hono<{ Variables: RequestIdVars }>;
let schema: typeof import('../../src/db/schema.js');
let pairDevice: typeof import('../helpers/pair-device.js').pairDevice;

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-abc';
  process.env.SMTP_HOST ??= 'localhost';
  process.env.SMTP_PORT ??= '1025';
  process.env.SMTP_USER ??= 'test';
  process.env.SMTP_PASS ??= 'test';
  process.env.SMTP_FROM ??= 'test@example.com';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  process.env.NODE_ENV ??= 'test';

  const { deviceProvisionRoutes } = await import('../../src/devices/me-provisions.js');
  const { errorHandler } = await import('../../src/middleware/error.js');
  const { requestId } = await import('../../src/middleware/request-id.js');
  schema = await import('../../src/db/schema.js');
  pairDevice = (await import('../helpers/pair-device.js')).pairDevice;

  app = new Hono<{ Variables: RequestIdVars }>();
  app.use('*', requestId());
  app.route('/api/devices', deviceProvisionRoutes);
  app.onError(errorHandler);
}, 180_000);

afterAll(async () => {
  if (harness) await harness.cleanup();
});

beforeEach(async () => {
  failures.clear();
  recordingFailure.next = null;
  await truncateAll(harness.db);
});

interface SeededProject {
  id: string;
  slug: string;
  runnerId: string;
}

async function seed(slugs: string[]) {
  const user = await createTestUser(harness.db);
  const org = await seedOrg(harness.db, user.id);
  const { device, plaintext: deviceToken } = await pairDevice({
    ownerId: user.id,
    name: 'sid-xeon-1',
    platform: 'linux',
  });
  const seeded: SeededProject[] = [];
  for (const slug of slugs) {
    const project = await createTestProject(harness.db, user.id, {
      orgId: org.id,
      slug: `${slug}-${randomUUID().slice(0, 8)}`,
    });
    const [runner] = await harness.db
      .insert(schema.runners)
      .values({
        projectId: project.id,
        type: 'claude-code',
        deviceId: device.id,
        name: 'sid-xeon-1',
        provisionStatus: 'queued',
        provisionRequestedAt: new Date(),
      })
      .returning({ id: schema.runners.id });
    seeded.push({ id: project.id, slug: project.slug, runnerId: runner?.id as string });
  }
  return { user, device, deviceToken, org, projects: seeded };
}

const get = (token: string) =>
  app.request('/api/devices/me/provisions', { headers: { authorization: `Bearer ${token}` } });

async function liveWorkspacePatCount(userId: string, name: string): Promise<number> {
  const rows = await harness.db
    .select({ id: schema.personalAccessTokens.id })
    .from(schema.personalAccessTokens)
    .where(
      and(
        eq(schema.personalAccessTokens.userId, userId),
        eq(schema.personalAccessTokens.name, name),
        isNull(schema.personalAccessTokens.revokedAt),
      ),
    );
  return rows.length;
}

async function runnerRow(runnerId: string) {
  const [row] = await harness.db
    .select({
      provisionStatus: schema.runners.provisionStatus,
      provisionDetail: schema.runners.provisionDetail,
    })
    .from(schema.runners)
    .where(eq(schema.runners.id, runnerId));
  return row;
}

describe('a device with one unprovisionable project still provisions the rest (ISS-1184)', () => {
  it('serves every queued project on the read after the first, where the mint meets its own revoked row', async () => {
    const { user, device, deviceToken, projects } = await seed(['epod-cli', 'epodsystem-core']);
    const { workspaceTokenNameFor } = await import('../../src/auth/pat-format.js');

    const first = await get(deviceToken);
    expect(first.status).toBe(200);
    expect(((await first.json()) as unknown[]).length).toBe(2);

    // The read that 500'd in the field: every pair now holds a revoked PAT under
    // the name the next mint wants.
    const second = await get(deviceToken);
    expect(second.status).toBe(200);
    const served = (await second.json()) as Array<{ projectId: string; mcpCredential: string }>;
    expect(served.map((p) => p.projectId).sort()).toEqual(projects.map((p) => p.id).sort());
    for (const p of served) expect(p.mcpCredential).toMatch(/^forge_pat_/);
    expect(second.headers.get('x-forge-provision-failures')).toBeNull();

    // One live credential per checkout, however many times it was provisioned.
    for (const p of projects) {
      expect(await liveWorkspacePatCount(user.id, workspaceTokenNameFor(device.id, p.id))).toBe(1);
    }
  });

  it('serves the healthy project and reports the failing one, rather than failing both', async () => {
    const { deviceToken, projects } = await seed(['healthy', 'poisoned']);
    const healthy = projects[0] as SeededProject;
    const poisoned = projects[1] as SeededProject;
    failures.set(poisoned.id, async () => {
      throw new Error('the credential vault is not reachable');
    });

    const res = await get(deviceToken);
    expect(res.status).toBe(200);
    const served = (await res.json()) as Array<{ projectId: string }>;
    expect(served.map((p) => p.projectId)).toEqual([healthy.id]);

    const header = res.headers.get('x-forge-provision-failures');
    expect(header).not.toBeNull();
    const parsed = JSON.parse(header as string) as {
      failures: Array<{ projectId: string; slug: string; kind: string; reason: string }>;
      dropped: number;
    };
    expect(parsed.dropped).toBe(0);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.projectId).toBe(poisoned.id);
    expect(parsed.failures[0]?.slug).toBe(poisoned.slug);
    expect(parsed.failures[0]?.reason).toContain('the credential vault is not reachable');

    // The healthy row is untouched and the failing one carries its reason.
    expect(await runnerRow(healthy.runnerId)).toMatchObject({
      provisionStatus: 'queued',
      provisionDetail: null,
    });
    const bad = await runnerRow(poisoned.runnerId);
    expect(bad?.provisionStatus).toBe('queued');
    expect(bad?.provisionDetail).toContain('the credential vault is not reachable');
  });

  it('takes a row out of the queue only when the same integrity violation happens twice', async () => {
    const { deviceToken, projects } = await seed(['permanent', 'transient']);
    const permanent = projects[0] as SeededProject;
    const transient = projects[1] as SeededProject;

    const violation = () => Object.assign(new Error('duplicate key value'), { code: '23505' });
    failures.set(permanent.id, async () => {
      throw violation();
    });
    let transientCalls = 0;
    failures.set(transient.id, async () => {
      transientCalls += 1;
      // The first build loses a race; the second finds the name free. That is
      // the concurrent case, and it must not cost the row its place in the queue.
      if (transientCalls === 1) throw violation();
      return 'forge_pat_dev_second_build_succeeded';
    });

    const res = await get(deviceToken);
    expect(res.status).toBe(200);

    const served = (await res.json()) as Array<{ projectId: string; mcpCredential: string }>;
    expect(served.map((p) => p.projectId)).toEqual([transient.id]);
    expect(served[0]?.mcpCredential).toBe('forge_pat_dev_second_build_succeeded');
    expect(transientCalls).toBe(2);

    const parsed = JSON.parse(res.headers.get('x-forge-provision-failures') as string) as {
      failures: Array<{ projectId: string; kind: string }>;
    };
    expect(parsed.failures.map((f) => f.projectId)).toEqual([permanent.id]);
    expect(parsed.failures[0]?.kind).toBe('omitted');

    const gone = await runnerRow(permanent.runnerId);
    expect(gone?.provisionStatus).toBe('failed');
    expect(gone?.provisionDetail).toContain('duplicate key value');

    // The one that cleared is still in the queue with nothing said against it.
    expect(await runnerRow(transient.runnerId)).toMatchObject({
      provisionStatus: 'queued',
      provisionDetail: null,
    });
  });

  it('serves a project whose stored ssh key cannot be decrypted, and says the key was dropped', async () => {
    const { deviceToken, org, projects } = await seed(['undecryptable']);
    const only = projects[0] as SeededProject;
    const [key] = await harness.db
      .insert(schema.workspaceSshKeys)
      .values({
        orgId: org.id,
        name: 'forge-undecryptable',
        source: 'forge_generated',
        publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 forge-undecryptable',
        privateKeyEnc: Buffer.from('not a vault ciphertext'),
      })
      .returning({ id: schema.workspaceSshKeys.id });
    await harness.db
      .insert(schema.projectGitCredentials)
      .values({ projectId: only.id, sshKeyId: key?.id as string });

    const res = await get(deviceToken);
    expect(res.status).toBe(200);
    const served = (await res.json()) as Array<{
      projectId: string;
      sshPrivateKey: string | null;
      sshPublicKey: string | null;
      mcpCredential: string;
    }>;
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({
      projectId: only.id,
      sshPrivateKey: null,
      sshPublicKey: null,
    });
    expect(served[0]?.mcpCredential).toMatch(/^forge_pat_/);

    const parsed = JSON.parse(res.headers.get('x-forge-provision-failures') as string) as {
      failures: Array<{ projectId: string; kind: string; reason: string }>;
    };
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]).toMatchObject({ projectId: only.id, kind: 'degraded' });
    expect(parsed.failures[0]?.reason).toContain('could not be decrypted');
  });

  it('still serves the healthy provisions when the diagnostic write itself fails', async () => {
    const { deviceToken, projects } = await seed(['healthy', 'poisoned']);
    const healthy = projects[0] as SeededProject;
    const poisoned = projects[1] as SeededProject;
    failures.set(poisoned.id, async () => {
      throw new Error('the credential vault is not reachable');
    });
    // `recordProvisionReports` contracts not to throw, and is proved not to in
    // its own file. This is the endpoint's own guard: even where that contract
    // breaks, the one thing this endpoint may never do again is lose every
    // project's provision to one row's fault.
    recordingFailure.next = new Error('canceling statement due to lock timeout');

    const res = await get(deviceToken);
    expect(res.status).toBe(200);
    const served = (await res.json()) as Array<{ projectId: string }>;
    expect(served.map((p) => p.projectId)).toEqual([healthy.id]);

    const parsed = JSON.parse(res.headers.get('x-forge-provision-failures') as string) as {
      failures: Array<{ projectId: string; reason: string }>;
    };
    expect(parsed.failures[0]?.projectId).toBe(poisoned.id);
    expect(parsed.failures[0]?.reason).toContain('the credential vault is not reachable');
  });
});
