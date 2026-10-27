/**
 * ISS-1315 r6 — an invitation whose first token is already taken is issued on the next draw. Both
 * issuers caught the unique violation and inserted again on the same transaction, which the failed
 * insert had already aborted, so the retry could only fail with 25P02 and the invitation with it.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  createTestUser,
  setupTestDatabase,
  type TestDatabase,
} from '../helpers/index.js';

/** The 32-byte draws a case forces before the real ones resume. */
const forced = vi.hoisted(() => [] as Buffer[]);

vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = ((size: number, ...rest: []) =>
    size === 32 && forced.length > 0
      ? (forced.shift() as Buffer)
      : real.randomBytes(size, ...rest)) as typeof real.randomBytes;
  return { ...real, default: { ...real, randomBytes }, randomBytes };
});

let harness: TestDatabase;
let issuers: {
  project: typeof import('../../src/projects/invitation-token.js').issueInvitationToken;
  org: typeof import('../../src/orgs/invitations.js').issueOrgInvitationToken;
};

beforeAll(async () => {
  harness = await setupTestDatabase();
  process.env.DATABASE_URL = harness.url;
  process.env.JWT_SECRET ??= 'test-secret-at-least-32-chars-long-abcdef-123456';
  process.env.DEVICE_TOKEN_PEPPER ??= 'test-device-pepper-at-least-32-chars-long-aa';
  process.env.PAT_PEPPER ??= 'test-pat-pepper-at-least-32-chars-long-aaaa';
  process.env.APP_BASE_URL ??= 'http://localhost:3000';
  process.env.CORS_ORIGINS ??= 'http://localhost:3000';
  issuers = {
    project: (await import('../../src/projects/invitation-token.js')).issueInvitationToken,
    org: (await import('../../src/orgs/invitations.js')).issueOrgInvitationToken,
  };
});

afterAll(async () => {
  if (harness) await harness.cleanup();
});

/** A token a row already holds, and the draw that would make it again. */
function taken(fill: number): { draw: Buffer; token: string } {
  const draw = Buffer.alloc(32, fill);
  return { draw, token: draw.toString('base64url') };
}

describe('an invitation whose first token is already taken', () => {
  it('is issued for a project on the next draw', async () => {
    const inviter = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, inviter.id);
    const first = taken(1);
    await harness.db.execute(sql`
      INSERT INTO project_invitations (token, project_id, email, role, inviter_id, expires_at)
      VALUES (${first.token}, ${project.id}, 'held@test.forge.local', 'member', ${inviter.id},
              now() + interval '1 day')`);
    forced.push(first.draw);

    const got = await issuers.project({
      projectId: project.id,
      inviterId: inviter.id,
      email: 'new@test.forge.local',
      role: 'member',
    });

    expect(forced).toHaveLength(0);
    expect(got.token).not.toBe(first.token);
    const rows = await harness.db.execute<{ email: string }>(
      sql`SELECT email FROM project_invitations WHERE token = ${got.token}`,
    );
    expect([...rows].map((r) => r.email)).toEqual(['new@test.forge.local']);
  });

  it('is issued for an organisation on the next draw', async () => {
    const inviter = await createTestUser(harness.db);
    const project = await createTestProject(harness.db, inviter.id);
    const first = taken(2);
    await harness.db.execute(sql`
      INSERT INTO org_invitations (token, org_id, email, role, inviter_id, expires_at)
      VALUES (${first.token}, ${project.orgId}, 'held@test.forge.local', 'member', ${inviter.id},
              now() + interval '1 day')`);
    forced.push(first.draw);

    const got = await issuers.org({
      orgId: project.orgId,
      inviterId: inviter.id,
      email: 'new@test.forge.local',
      role: 'member',
    });

    expect(forced).toHaveLength(0);
    expect(got.token).not.toBe(first.token);
    const rows = await harness.db.execute<{ email: string }>(
      sql`SELECT email FROM org_invitations WHERE token = ${got.token}`,
    );
    expect([...rows].map((r) => r.email)).toEqual(['new@test.forge.local']);
  });
});
