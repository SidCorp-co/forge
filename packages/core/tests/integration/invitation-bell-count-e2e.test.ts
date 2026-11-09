/**
 * The bell's badge and its list agree about invitations (ISS-1188). The badge is the open count; the
 * list is the open rows less every `invitation_received` delivery, plus the invitations still pending,
 * each as its actionable item. An invitation answered, revoked, expired or replaced after its notice
 * was delivered left that delivery open: counted by the badge and shown nowhere (forge-dev's QA
 * identity read 2 against an empty bell).
 *
 * @direct-test-of packages/core/src/notifications/read.ts
 * @direct-test-of packages/core/src/projects/members-routes.ts
 * @direct-test-of packages/core/src/projects/invitations-routes.ts
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { api, userToken } from '../helpers/api.js';
import { addProjectMember, createTestProject, createTestUser } from '../helpers/factories.js';

let adminToken = '';
let projectId = '';

interface Invitee {
  email: string;
  token: string;
}

async function newInvitee(): Promise<Invitee> {
  const user = await createTestUser({ verified: true });
  return { email: user.email, token: await userToken(user.id) };
}

async function invite(email: string): Promise<void> {
  const res = await api(adminToken, 'POST', `/api/projects/${projectId}/members/invite`, {
    email,
    role: 'member',
  });
  expect(res.status).toBe(201);
}

async function pending(who: Invitee): Promise<{ ref: string }[]> {
  const res = await api(who.token, 'GET', '/api/invitations/pending');
  expect(res.status).toBe(200);
  return res.body as unknown as { ref: string }[];
}

/** What the badge reads, and how many items the bell's list shows (`notifications-bell.tsx`). */
async function bell(who: Invitee): Promise<{ badge: number; shown: number }> {
  const count = await api(who.token, 'GET', '/api/notifications/open-count');
  expect(count.status).toBe(200);
  const open = await api(who.token, 'GET', '/api/notifications?openOnly=true&pageSize=100');
  expect(open.status).toBe(200);
  const rows = (open.body.items as { type: string }[]).filter(
    (r) => r.type !== 'invitation_received',
  );
  return { badge: count.body.count as number, shown: rows.length + (await pending(who)).length };
}

beforeAll(async () => {
  const admin = await createTestUser({ verified: true });
  adminToken = await userToken(admin.id);
  projectId = (await createTestProject(admin.id)).id;
  await addProjectMember(projectId, admin.id, 'admin');
});

describe('an invitation in the bell', () => {
  it('shows once, as its actionable item, and counts once while it is pending', async () => {
    const who = await newInvitee();
    await invite(who.email);
    expect(await bell(who)).toEqual({ badge: 1, shown: 1 });
  });

  it('stops counting once the invitee accepts it', async () => {
    const who = await newInvitee();
    await invite(who.email);
    const [inv] = await pending(who);
    const res = await api(who.token, 'POST', `/api/invitations/ref/${inv?.ref}/accept`);
    expect(res.status).toBe(200);
    expect(await bell(who)).toEqual({ badge: 0, shown: 0 });
  });

  it('stops counting once the invitee declines it', async () => {
    const who = await newInvitee();
    await invite(who.email);
    const [inv] = await pending(who);
    const res = await api(who.token, 'POST', `/api/invitations/ref/${inv?.ref}/decline`);
    expect(res.status).toBe(200);
    expect(await bell(who)).toEqual({ badge: 0, shown: 0 });
  });

  it('stops counting once an admin revokes it', async () => {
    const who = await newInvitee();
    await invite(who.email);
    const res = await api(
      adminToken,
      'DELETE',
      `/api/projects/${projectId}/members/invitations?email=${encodeURIComponent(who.email)}`,
    );
    expect(res.status).toBe(204);
    expect(await bell(who)).toEqual({ badge: 0, shown: 0 });
  });

  it('stops counting once it expires, with nothing written to it', async () => {
    const who = await newInvitee();
    await invite(who.email);
    await db.execute(sql`
      UPDATE project_invitations SET expires_at = now() - interval '1 minute'
       WHERE project_id = ${projectId} AND email = ${who.email}
    `);
    expect(await bell(who)).toEqual({ badge: 0, shown: 0 });
  });

  it('counts once when invited again, the second invitation replacing the first', async () => {
    const who = await newInvitee();
    await invite(who.email);
    await invite(who.email);
    expect(await bell(who)).toEqual({ badge: 1, shown: 1 });
  });
});
