/**
 * Who starts onboarding and asks for a re-analysis, and what the start hands the job, over the real
 * routes (REQ-10 BC-2: a start or a re-analysis is a person's ask, one analysis job runs at a time).
 *
 * @direct-test-of packages/core/src/onboarding/service.ts
 * @direct-test-of packages/contracts/src/onboarding.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  closeWorld,
  type Doc,
  ok,
  type Reply,
  requester,
  startQueue,
  testEnv,
} from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, createTestUser, rows } from '../helpers/factories.js';

type Who = 'owner' | 'viewer' | 'master' | 'agent';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let otherId = '';
let ownerEmail = '';
let thirdId = '';
let agentsId = '';

const REQUEST = 'Draw against REQ-1; leave every design proposed.';

beforeAll(async () => {
  testEnv();
  const { app } = await import('../../src/index.js');
  await startQueue();
  const { signUserToken } = await import('../../src/credentials/jwt.js');
  const { mintPat } = await import('../../src/credentials/pat.js');
  const owner = await createTestUser({ verified: true });
  ownerEmail = owner.email;
  const viewer = (await createTestUser({ verified: true })).id;
  const agent = (await createTestUser({ kind: 'agent' })).id;
  const project = await createTestProject(owner.id);
  projectId = project.id;
  otherId = (await createTestProject(owner.id)).id;
  thirdId = (await createTestProject(owner.id)).id;
  agentsId = (await createTestProject(owner.id)).id;
  await addProjectMember(projectId, viewer, 'viewer');
  // A project's agent is its handle, so it carries one on its org membership, as a minted one does.
  await db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role, handle)
    VALUES (${project.orgId}, ${agent}, 'member', 'onboarding-master')
  `);
  await addProjectMember(projectId, agent, 'admin');
  await addProjectMember(thirdId, agent, 'admin');
  await addProjectMember(agentsId, agent, 'admin');
  say = requester(app, {
    owner: await signUserToken(owner.id),
    viewer: await signUserToken(viewer),
    // a named grant: a full one holds onboarding.request as its holder does (REQ-27 BC-4)
    master: (
      await mintPat({
        permissions: ['projects:read', 'projects:write'],
        userId: agent,
        name: 'master',
        projectIds: [projectId],
      })
    ).plaintext,
    // a full grant holds onboarding.request as the agent's admin role does, so it asks as a person
    // holding it does (REQ-72 BC-4)
    agent: (
      await mintPat({
        permissions: ['*'],
        userId: agent,
        name: 'agent',
        projectIds: [projectId, thirdId, agentsId],
      })
    ).plaintext,
  });
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

const at = (id: string, path: string) => `/api/projects/${id}/onboarding${path}`;
const refusedBy = (r: Reply, status: number): string[] => {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return (r.json.error?.refusals ?? []).map((x: Doc) => x.code);
};

const jobsOf = (id: string) =>
  rows<{ type: string; skill_name: string; prompt: string }>(sql`
    SELECT type, payload->>'skillName' AS skill_name, payload->>'promptString' AS prompt
    FROM jobs WHERE project_id = ${id}
  `);

describe('a start is refused by name before anything is opened', () => {
  it('refuses a blank request and an unknown key, by the start shape', async () => {
    expect(
      refusedBy(await say('owner', 'POST', at(projectId, '/start'), { request: '  ' }), 400),
    ).toHaveLength(1);
    expect(
      refusedBy(await say('owner', 'POST', at(projectId, '/start'), { prompt: 'x' }), 400),
    ).toHaveLength(1);
    expect(await jobsOf(projectId)).toEqual([]);
  });

  it('refuses a viewer the onboarding.request it does not hold', async () => {
    expect(refusedBy(await say('viewer', 'POST', at(projectId, '/start'), {}), 403)).toEqual([
      'PERMISSION_FORBIDDEN',
    ]);
    expect(await jobsOf(projectId)).toEqual([]);
  });

  it('refuses an agent whose grant lacks onboarding.request by that permission, as it refuses a person', async () => {
    const master = await say('master', 'POST', at(projectId, '/start'), { request: REQUEST });
    expect(refusedBy(master, 403)).toEqual(['PERMISSION_FORBIDDEN']);
    expect(master.json.error.refusals[0].permission).toBe('onboarding.request');
    expect(await jobsOf(projectId)).toEqual([]);
  });

  it('lets an agent holding onboarding.request start onboarding, as a person holding it does (REQ-72 BC-4)', async () => {
    const started = await say('agent', 'POST', at(agentsId, '/start'), { request: REQUEST });
    expect([200, 201], JSON.stringify(started.json)).toContain(started.status);
    expect(await jobsOf(agentsId)).toHaveLength(1);
  });

  it('refuses the answers of a project with no onboarding', async () => {
    expect(refusedBy(await say('owner', 'GET', at(projectId, '/answers')), 422)).toEqual([
      'ONBOARDING_NOT_STARTED',
    ]);
  });
});

describe("the owner's request reaches the job that draws the designs", () => {
  it('opens the thread with the request as the starter’s first message, and queues one analysis', async () => {
    const started = await say('owner', 'POST', at(projectId, '/start'), {
      request: `  ${REQUEST}  `,
    });
    expect([200, 201], JSON.stringify(started.json)).toContain(started.status);
    const jobs = await jobsOf(projectId);
    expect(jobs).toEqual([
      expect.objectContaining({ type: 'onboarding', skill_name: 'onboarding-analyse' }),
    ]);
    expect(jobs[0]?.prompt).toContain(REQUEST);
    expect(jobs[0]?.prompt).toContain('`requests`');
  });

  it('answers the thread’s requests to the job, oldest first, by author', async () => {
    const answers = ok(await say('owner', 'GET', at(projectId, '/answers')));
    expect(answers.requests).toEqual([
      { at: expect.stringMatching(/^\d{4}-/), author: expect.any(String), text: REQUEST },
    ]);
    expect(answers.requests[0].author).toContain(ownerEmail.split('@')[0]);
  });

  it('refuses a second start while the analysis runs, and opens no second job', async () => {
    const again = await say('owner', 'POST', at(projectId, '/start'), { request: 'again' });
    expect(refusedBy(again, again.status)).toEqual(['ONBOARDING_ALREADY_RUNNING']);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await jobsOf(projectId)).toHaveLength(1);
  });

  it('starts without a request too, and the thread then holds no request', async () => {
    const started = await say('owner', 'POST', at(otherId, '/start'), {});
    expect([200, 201], JSON.stringify(started.json)).toContain(started.status);
    expect(ok(await say('owner', 'GET', at(otherId, '/answers'))).requests).toEqual([]);
    expect(await jobsOf(otherId)).toHaveLength(1);
  });
});

describe('BC-2: a re-analysis runs when whoever holds onboarding.request asks for it', () => {
  // the analysis ends, so no live job refuses the ask and only who asks decides it
  const settle = async (id: string) => {
    const { withKernelMarker } = await import('../../src/db/kernel-marker.js');
    await withKernelMarker(db, (tx) =>
      tx.execute(
        sql`UPDATE jobs SET status = 'done' WHERE project_id = ${id} AND type = 'onboarding'`,
      ),
    );
  };

  it('runs one for an agent holding onboarding.request (REQ-72 BC-4)', async () => {
    ok(await say('owner', 'POST', at(thirdId, '/start'), {}), 201);
    await settle(thirdId);
    ok(await say('agent', 'POST', at(thirdId, '/reanalyze'), { reason: 'refactor' }));
    expect(await jobsOf(thirdId)).toHaveLength(2);
  });

  it('runs one for a person holding onboarding.request', async () => {
    await settle(thirdId);
    ok(await say('owner', 'POST', at(thirdId, '/reanalyze'), { reason: 'refactor' }));
    expect(await jobsOf(thirdId)).toHaveLength(3);
  });

  it('refuses a person a second re-analysis while one runs, naming the running job', async () => {
    const again = await say('owner', 'POST', at(thirdId, '/reanalyze'), {});
    expect(refusedBy(again, again.status)).toEqual(['ONBOARDING_ALREADY_RUNNING']);
    expect(again.json.detail).toMatch(/analysis job [0-9a-f-]{36} is queued/);
    expect(await jobsOf(thirdId)).toHaveLength(3);
  });
});
