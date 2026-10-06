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

type Who = 'owner' | 'viewer' | 'master';
let say: (who: Who, method: string, path: string, body?: unknown) => Promise<Reply>;
let projectId = '';
let otherId = '';
let ownerEmail = '';

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
  await addProjectMember(projectId, viewer, 'viewer');
  // A project's agent is its handle, so it carries one on its org membership, as a minted one does.
  await db.execute(sql`
    INSERT INTO organization_members (org_id, user_id, role, handle)
    VALUES (${project.orgId}, ${agent}, 'member', 'onboarding-master')
  `);
  await addProjectMember(projectId, agent, 'admin');
  say = requester(app, {
    owner: await signUserToken(owner.id),
    viewer: await signUserToken(viewer),
    master: (await mintPat({ userId: agent, name: 'master', projectIds: [projectId] })).plaintext,
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

  it('refuses a viewer, and an agent token whose grant does not name onboarding.request', async () => {
    expect(refusedBy(await say('viewer', 'POST', at(projectId, '/start'), {}), 403)).toEqual([
      'PERMISSION_FORBIDDEN',
    ]);
    const agent = await say('master', 'POST', at(projectId, '/start'), { request: REQUEST });
    expect(refusedBy(agent, 403)).toEqual(['PERMISSION_FORBIDDEN']);
    expect(agent.json.detail).toMatch(
      /A token holds onboarding\.request only where its own grant names it/,
    );
    expect(await jobsOf(projectId)).toEqual([]);
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
