/**
 * A design the requirement an issue delivers links or pins, read through the issue. A job on
 * adminhub-fe ISS-114, which delivers adminhub-api REQ-14, is pointed at the designs REQ-14's latest
 * baseline pins; those are adminhub-api's, and the run's credential, fenced to adminhub-fe, was
 * refused `PAT_PROJECT_OUTSIDE_FENCE` on the project route. Through the app's own routes, against
 * real Postgres: the read through the issue, authorised on the issue's project alone, and each
 * refusal — a design the requirement neither links nor pins, an issue delivering none, a
 * credential without read on the issue's project.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { api, patToken, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestIssue,
  createTestProject,
  createTestUser,
  makeAgreeReady,
  type TestProject,
  truncateAll,
} from '../helpers/factories.js';

type Body = Record<string, unknown>;

let apiProject: TestProject;
let feProject: TestProject;
let ownerId: string;
let owner: string;
/** The front end's agent: a member of both projects, its credential fenced to the front end. */
let feAgent: string;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  apiProject = await createTestProject(ownerId);
  feProject = await createTestProject(ownerId, { orgId: apiProject.orgId });
  owner = await userToken(ownerId);
  const agent = (await createTestUser({ kind: 'agent' })).id;
  await addProjectMember(feProject.id, agent, 'member');
  await addProjectMember(apiProject.id, agent, 'member');
  feAgent = await patToken(agent, [feProject.id]);
});

async function ok(r: Promise<{ status: number; body: Body }>): Promise<Body> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

/** REQ-n on the api project, agreed at revision 1; its baseline pins the design `ready-<n>`. */
async function agreedRequirement(title: string): Promise<string> {
  const on = (path: string, body: unknown) =>
    ok(api(owner, 'POST', `/api/projects/${apiProject.id}${path}`, body));
  const key = String(
    (
      await on('/requirements', {
        title,
        reason: 'planted',
        criteria: [{ body: `${title} works` }],
      })
    ).key,
  );
  await makeAgreeReady(apiProject.id, Number(key.slice(4)), ownerId);
  await on(`/requirements/${key}/revisions/1/propose`, {});
  await on(`/requirements/${key}/revisions/1/accept`, { reason: 'BA review' });
  await on(`/requirements/${key}/agree`, { revision: 1, reason: 'agreed' });
  return key;
}

/** The design `key`'s latest baseline pins, read as its project's owner. */
async function pinnedDesign(key: string): Promise<string> {
  const detail = await ok(api(owner, 'GET', `/api/projects/${apiProject.id}/requirements/${key}`));
  const [latest] = detail.baselines as Body[];
  const pin = ((latest?.pins ?? []) as Body[]).find((p) => p.kind === 'workflow-design');
  if (!pin) throw new Error(`${key}'s latest baseline pins no design`);
  return String(pin.workflowId);
}

/** fe ISS-<seq>, delivering the api project's `key`. */
async function feIssueDelivering(seq: number, key: string): Promise<string> {
  const { id } = await createTestIssue(feProject.id, ownerId, seq, {
    status: 'draft',
    createdAt: new Date(),
  });
  await ok(
    api(owner, 'POST', `/api/projects/${apiProject.id}/requirements/${key}/issues`, { issue: id }),
  );
  return id;
}

const through = (token: string, issue: string, workflow: string, query = '') =>
  api(token, 'GET', `/api/issues/${issue}/requirement/designs/${workflow}${query}`);

describe('a design of the requirement an issue delivers, read through the issue', () => {
  it("serves a sibling's pinned design to a credential fenced to the issue's project", async () => {
    const key = await agreedRequirement('Order history');
    const workflow = await pinnedDesign(key);
    const id = await feIssueDelivering(114, key);

    // the gap: the design's own route is outside the run's fence
    const direct = await api(
      feAgent,
      'GET',
      `/api/projects/${apiProject.id}/workflows/${workflow}/design?view=steps&revision=1`,
    );
    expect(direct.status, JSON.stringify(direct.body)).toBe(403);
    expect(JSON.stringify(direct.body)).toContain('PAT_PROJECT_OUTSIDE_FENCE');

    const read = await ok(through(feAgent, id, workflow, '?revision=1'));
    expect(read).toMatchObject({ workflowId: workflow, flow: 'ready-1', approvedRevision: 1 });
    expect('builds' in read).toBe(false);
    // its document reads as the project route's steps view reads it to one who may read there
    const own = await ok(
      api(
        owner,
        'GET',
        `/api/projects/${apiProject.id}/workflows/${workflow}/design?view=steps&revision=1`,
      ),
    );
    expect(read.document).toEqual(own.document);
    expect(((read.document as Body).steps as unknown[]).length).toBeGreaterThan(0);

    const ranged = await ok(through(feAgent, id, workflow, '?revision=1&stepFrom=1&stepTo=1'));
    expect(((ranged.document as Body).steps as unknown[]).length).toBe(1);
  });

  it('refuses a design its requirement neither links nor pins, by name', async () => {
    const key = await agreedRequirement('Order history');
    const other = await agreedRequirement('Refunds');
    const elsewhere = await pinnedDesign(other);
    const id = await feIssueDelivering(114, key);
    const res = await through(feAgent, id, elsewhere);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(JSON.stringify(res.body)).toContain(
      `neither linked to nor pinned by ${apiProject.slug}/${key}`,
    );
    expect(JSON.stringify(res.body)).not.toContain('ready-2');
  });

  it('refuses an issue delivering no requirement', async () => {
    const key = await agreedRequirement('Order history');
    const workflow = await pinnedDesign(key);
    const { id } = await createTestIssue(feProject.id, ownerId, 9, {
      status: 'draft',
      createdAt: new Date(),
    });
    const res = await through(feAgent, id, workflow);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(JSON.stringify(res.body)).toContain('delivers no requirement');
  });

  it("refuses a credential without read on the issue's project, whatever it holds on the design's", async () => {
    const key = await agreedRequirement('Order history');
    const workflow = await pinnedDesign(key);
    const id = await feIssueDelivering(114, key);

    const apiOnly = (await createTestUser({ verified: true })).id;
    await addProjectMember(apiProject.id, apiOnly, 'owner');
    const person = await through(await userToken(apiOnly), id, workflow);
    expect(person.status, JSON.stringify(person.body)).toBe(403);
    expect(JSON.stringify(person.body)).toContain(`project.read on project ${feProject.id}`);
    expect(JSON.stringify(person.body)).not.toContain('ready-1');

    const agent = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(feProject.id, agent, 'member');
    await addProjectMember(apiProject.id, agent, 'member');
    const fencedToApi = await patToken(agent, [apiProject.id], 'api-only');
    const refused = await through(fencedToApi, id, workflow);
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain('ready-1');
  });
});
