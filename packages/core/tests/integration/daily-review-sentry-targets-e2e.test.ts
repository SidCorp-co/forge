/**
 * ISS-973: the daily review's brief named the project's Sentry read with no `target`, and a binding
 * declaring several targets (forge declares core and web) refuses that bare read
 * SENTRY_TARGET_AMBIGUOUS, so the review's own first Sentry read failed. The brief now names one
 * link per target, read from the binding as the read resolves it, and each answers 200; the bare
 * link the old brief named is planted on the same binding and refused. One target names the bare
 * route, and no Sentry binding names none. Against real Postgres, Sentry's own API stubbed.
 *
 * @direct-test-of packages/core/src/masters/daily-review.ts
 * @direct-test-of packages/core/src/integrations/sentry/agent-read.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeWorld,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import {
  bindTestRunner,
  createTestDevice,
  createTestProject,
  createTestUser,
  rows,
} from '../helpers/factories.js';

type Who = 'owner' | 'box';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let ownerId = '';
let deviceId = '';
const SENTRY_HOST = 'sentry.iss973.test';

/** Sentry's own API answers an empty issue list; every other call goes where it went. */
const realFetch = globalThis.fetch;
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) =>
  String(input).includes(SENTRY_HOST)
    ? new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
    : realFetch(input, init),
);

beforeAll(async () => {
  testEnv();
  await import('../../src/index.js');
  await startQueue();
  ownerId = (await createTestUser({ verified: true })).id;
  deviceId = await createTestDevice(ownerId);
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await closeWorld();
});

/** A project with a live master, and a Sentry binding declaring `labels` (none: no binding). */
async function projectWith(labels: string[] | null): Promise<string> {
  const { app } = await import('../../src/index.js');
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const { createConnection } = await import('../../src/integrations/index.js');
  const { db } = await import('../../src/db/client.js');
  const { integrationBindings } = await import('../../src/db/schema.js');
  const projectId = (await createTestProject(ownerId)).id;
  await bindTestRunner(projectId, deviceId);
  const box = await mintPat({
    permissions: ['*'],
    userId: ownerId,
    name: `box-${projectId}`,
    deviceId,
    projectIds: [projectId],
  });
  say = requester(app, { owner: await signUserToken(ownerId), box: box.plaintext }) as typeof say;
  if (labels) {
    const connection = await createConnection({
      ownerId,
      provider: 'sentry',
      config: { host: SENTRY_HOST },
      secrets: { authToken: 'sntryu_iss973' },
    });
    await db.insert(integrationBindings).values({
      connectionId: connection.id,
      projectId,
      provider: 'sentry',
      role: 'service',
      agentAccess: 'all',
      config: {
        targets: labels.map((label) => ({
          label,
          organizationSlug: 'acme',
          projectSlug: `forge-${label}`,
        })),
      },
    });
  }
  ok(
    await say('box', 'POST', '/api/devices/me/master-session', {
      projectId,
      name: 'forge-master',
      maxJobPanes: 1,
    }),
  );
  return projectId;
}

/** Fire the project's daily review and read the brief its master was handed. */
async function briefOf(projectId: string): Promise<string> {
  const schedule = ok(
    await say('owner', 'POST', '/api/schedules', {
      projectId,
      name: 'Daily review',
      cron: '0 18 * * *',
      timeZone: 'Asia/Ho_Chi_Minh',
      kind: 'daily_review',
    }),
    201,
  ).id as string;
  const run = await say('owner', 'POST', `/api/schedules/${schedule}/run`);
  expect(run.status, JSON.stringify(run.json)).toBe(202);
  const [brief] = await rows<{ body: string }>(sql`
    SELECT i.body FROM session_inbox i
      JOIN agent_sessions s ON s.id = i.agent_session_id
     WHERE s.project_id = ${projectId} AND i.intent_id LIKE 'daily-review:%'`);
  if (!brief) throw new Error('the fire left no brief in the master inbox');
  return brief.body;
}

const sentryLinks = (brief: string) =>
  brief.match(/\/api\/projects\/[0-9a-f-]+\/integrations\/sentry\/issues[^ ·]*/g) ?? [];

describe("the daily review's Sentry reads (ISS-973)", () => {
  it('names one link per declared target, and each answers 200', async () => {
    const projectId = await projectWith(['core', 'web']);
    const links = sentryLinks(await briefOf(projectId));
    const door = `/api/projects/${projectId}/integrations/sentry/issues`;
    expect(links).toEqual([`${door}?target=core`, `${door}?target=web`]);
    for (const link of links) {
      const read = await say('box', 'GET', link);
      expect(read.status, `${link}: ${JSON.stringify(read.json)}`).toBe(200);
    }
    // the plant: the bare link the old brief named is refused on this binding, by name
    const bare = await say('box', 'GET', door);
    expect(bare.status).toBe(400);
    expect(JSON.stringify(bare.json)).toContain('SENTRY_TARGET_AMBIGUOUS');
  });

  it('names the bare route for one target, and it answers 200', async () => {
    const projectId = await projectWith(['core']);
    const links = sentryLinks(await briefOf(projectId));
    expect(links).toEqual([`/api/projects/${projectId}/integrations/sentry/issues`]);
    const read = await say('box', 'GET', links[0] ?? '');
    expect(read.status, JSON.stringify(read.json)).toBe(200);
  });

  it('names no Sentry link where no Sentry is bound', async () => {
    const projectId = await projectWith(null);
    expect(sentryLinks(await briefOf(projectId))).toEqual([]);
  });
});
