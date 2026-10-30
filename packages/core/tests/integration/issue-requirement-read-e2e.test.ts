/**
 * An issue's run reads the requirement its issue delivers, whichever project of the organization
 * holds it. adminhub-fe ISS-114 delivers adminhub-api REQ-14, and the adminhub-fe master's
 * credential, fenced to adminhub-fe, was refused `PAT_PROJECT_OUTSIDE_FENCE` reading REQ-14, so it
 * could not read the criteria its issue traces (dev, 2026-10-30). Through the app's own routes,
 * against real Postgres: the read through the issue on REST and MCP, authorised on the issue's
 * project alone; what the run is given at its open; and each refusal — an issue delivering none, a
 * credential without read on the issue's project, the sibling's other requirements.
 */

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { givenAtDispatch } from '../../src/issues/index.js';
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

/** REQ-n on `project`, agreed at revision 1 with the business criteria given. */
async function agreedRequirement(
  project: TestProject,
  title: string,
  criteria: string[],
): Promise<string> {
  const on = (method: 'POST', path: string, body: unknown) =>
    ok(api(owner, method, `/api/projects/${project.id}${path}`, body));
  const key = String(
    (
      await on('POST', '/requirements', {
        title,
        reason: 'planted',
        spec: { goal: `${title}: the goal` },
        criteria: criteria.map((body) => ({ body })),
      })
    ).key,
  );
  await makeAgreeReady(project.id, Number(key.slice(4)), ownerId);
  await on('POST', `/requirements/${key}/revisions/1/propose`, {});
  await on('POST', `/requirements/${key}/revisions/1/accept`, { reason: 'BA review' });
  await on('POST', `/requirements/${key}/agree`, { revision: 1, reason: 'agreed' });
  return key;
}

/** fe ISS-<seq>, linked to the api project's `key`. */
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

async function mcpGet(token: string, projectId: string, issue: string) {
  const res = await api(
    token,
    'POST',
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'forge_issues', arguments: { action: 'get', projectId, issue } },
    },
    { accept: 'application/json, text/event-stream' },
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const result = res.body.result as { content: { text: string }[]; isError?: boolean };
  return { isError: result.isError === true, text: result.content[0]?.text ?? '' };
}

describe('the requirement an issue delivers, read through the issue', () => {
  it("serves a sibling project's requirement to a credential fenced to the issue's project", async () => {
    const key = await agreedRequirement(apiProject, 'Order history', [
      'A shopper sees every past order',
      'An order lists its lines',
    ]);
    const id = await feIssueDelivering(114, key);

    // the gap: the requirement's own routes are outside the run's fence
    const direct = await api(feAgent, 'GET', `/api/projects/${apiProject.id}/requirements/${key}`);
    expect(direct.status, JSON.stringify(direct.body)).toBe(403);
    expect(JSON.stringify(direct.body)).toContain('PAT_PROJECT_OUTSIDE_FENCE');

    const read = await ok(api(feAgent, 'GET', `/api/issues/${id}/requirement`));
    expect(read.issueId).toBe(id);
    const requirement = read.requirement as Body;
    expect(requirement).toMatchObject({
      key,
      displayKey: `${apiProject.slug}/${key}`,
      project: { id: apiProject.id, slug: apiProject.slug },
      otherProject: { id: apiProject.id, slug: apiProject.slug },
      title: 'Order history',
      status: 'agreed',
      currentRevision: 1,
      plannedRevision: null,
      changedSincePlan: false,
    });
    const revision = requirement.revision as Body;
    expect(revision.revision).toBe(1);
    expect(revision.state).toBe('current');
    // the revision reads exactly as the requirement's own read serves it to one who may read there
    const own = await ok(api(owner, 'GET', `/api/projects/${apiProject.id}/requirements/${key}`));
    expect(revision).toEqual((own.revisions as Body[]).find((r) => r.revision === 1));
    expect((revision.spec as Body).goal).toEqual(expect.any(String));
    expect((revision.criteria as Body[]).map((c) => ({ code: c.code, body: c.body }))).toEqual([
      { code: 'BC-1', body: 'A shopper sees every past order' },
      { code: 'BC-2', body: 'An order lists its lines' },
    ]);
    expect((requirement.agreed as Body).revision).toBe(1);

    // the same read by key, scoped to the issue's project
    const byKey = await ok(
      api(feAgent, 'GET', `/api/issues/ISS-114/requirement?projectId=${feProject.id}`),
    );
    expect(byKey).toEqual(read);

    // and on MCP, the same requirement on the issue's own read
    const got = await mcpGet(feAgent, feProject.id, id);
    expect(got.isError, got.text).toBe(false);
    expect(JSON.parse(got.text).requirement).toEqual(requirement);
  });

  it("reads a requirement of the issue's own project the same way, naming no other project", async () => {
    const key = await agreedRequirement(feProject, 'Checkout', ['A shopper pays by card']);
    const { id } = await createTestIssue(feProject.id, ownerId, 5, {
      status: 'draft',
      createdAt: new Date(),
    });
    await ok(
      api(owner, 'POST', `/api/projects/${feProject.id}/requirements/${key}/issues`, { issue: id }),
    );
    const requirement = (await ok(api(feAgent, 'GET', `/api/issues/${id}/requirement`)))
      .requirement as Body;
    expect(requirement).toMatchObject({ key, displayKey: key, otherProject: null });
    expect(((requirement.revision as Body).criteria as Body[])[0]?.body).toBe(
      'A shopper pays by card',
    );
  });

  it('answers null for an issue delivering no requirement', async () => {
    const { id } = await createTestIssue(feProject.id, ownerId, 9, {
      status: 'draft',
      createdAt: new Date(),
    });
    expect(await ok(api(feAgent, 'GET', `/api/issues/${id}/requirement`))).toEqual({
      issueId: id,
      requirement: null,
    });
    const got = await mcpGet(feAgent, feProject.id, id);
    expect(got.isError, got.text).toBe(false);
    expect(JSON.parse(got.text).requirement).toBeNull();
  });

  it("refuses a credential without read on the issue's project, whatever it holds on the requirement's", async () => {
    const key = await agreedRequirement(apiProject, 'Order history', [
      'A shopper sees every past order',
    ]);
    const id = await feIssueDelivering(114, key);

    // a person of the requirement's project only
    const apiOnly = (await createTestUser({ verified: true })).id;
    await addProjectMember(apiProject.id, apiOnly, 'owner');
    const person = await api(await userToken(apiOnly), 'GET', `/api/issues/${id}/requirement`);
    expect(person.status, JSON.stringify(person.body)).toBe(403);
    expect(JSON.stringify(person.body)).toContain(`project.read on project ${feProject.id}`);
    expect(JSON.stringify(person.body)).not.toContain('A shopper sees every past order');

    // an agent whose credential reaches only the requirement's project: the issue's is fenced out
    const agent = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(feProject.id, agent, 'member');
    await addProjectMember(apiProject.id, agent, 'member');
    const fencedToApi = await patToken(agent, [apiProject.id], 'api-only');
    const refused = await api(fencedToApi, 'GET', `/api/issues/${id}/requirement`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(404);
    expect(JSON.stringify(refused.body)).not.toContain('A shopper sees every past order');
  });

  it("leaves the sibling's other requirements unreadable to the issue's credential", async () => {
    const key = await agreedRequirement(apiProject, 'Order history', [
      'A shopper sees every past order',
    ]);
    const other = await agreedRequirement(apiProject, 'Refunds', ['A refund returns the money']);
    const id = await feIssueDelivering(114, key);

    const read = await ok(api(feAgent, 'GET', `/api/issues/${id}/requirement`));
    expect(JSON.stringify(read)).not.toContain('Refunds');
    expect(JSON.stringify(read)).not.toContain('A refund returns the money');
    for (const path of [`/requirements/${other}`, '/requirements', `/requirements/${key}`]) {
      const res = await api(feAgent, 'GET', `/api/projects/${apiProject.id}${path}`);
      expect(res.status, `${path} ${JSON.stringify(res.body)}`).toBe(403);
      expect(JSON.stringify(res.body)).toContain('PAT_PROJECT_OUTSIDE_FENCE');
    }
    // an issue of the sibling project is not read through this door on the front end's credential
    const { id: apiIssue } = await createTestIssue(apiProject.id, ownerId, 3, {
      status: 'draft',
      createdAt: new Date(),
    });
    await ok(
      api(owner, 'POST', `/api/projects/${apiProject.id}/requirements/${other}/issues`, {
        issue: apiIssue,
      }),
    );
    const sibling = await api(feAgent, 'GET', `/api/issues/${apiIssue}/requirement`);
    expect(sibling.status, JSON.stringify(sibling.body)).toBe(404);
    expect(JSON.stringify(sibling.body)).not.toContain('A refund returns the money');
  });

  it("names the sibling's project on what the run is given at its open", async () => {
    const key = await agreedRequirement(apiProject, 'Order history', [
      'A shopper sees every past order',
    ]);
    await feIssueDelivering(114, key);
    const given = await givenAtDispatch(db, feProject.id, [114]);
    expect(given['ISS-114']?.requirement).toMatchObject({
      key,
      project: { id: apiProject.id, slug: apiProject.slug },
      currentRevision: 1,
    });
    const [row] = (await db.execute(
      sql`SELECT requirement_id FROM issues WHERE project_id = ${feProject.id} AND iss_seq = 114`,
    )) as unknown as { requirement_id: string | null }[];
    expect(row?.requirement_id).not.toBeNull();
  });
});

describe("the issue's criteria traced to the sibling's requirement", () => {
  it("re-traces the issue's criteria to the sibling's BCs on the issue's credential", async () => {
    const key = await agreedRequirement(apiProject, 'API keys', [
      'The key screen shows only to a holder of the permission',
      'The create form sends a name and an expiry',
      'A key reads nowhere but its one reveal',
    ]);
    const other = await agreedRequirement(apiProject, 'Refunds', ['A refund returns the money']);
    const id = await feIssueDelivering(114, key);
    const put = (criteria: Body[]) =>
      api(feAgent, 'PUT', `/api/issues/${id}/criteria`, { criteria });
    const traces = async () =>
      ((await ok(api(feAgent, 'GET', `/api/issues/${id}/criteria`))).criteria as Body[]).map(
        (c) => ({ n: c.n, id: c.requirementCriterionId }),
      );

    // every line traced at first to BC-3, by its lead tag, resolved on the sibling's requirement
    await ok(
      put([
        { n: 1, statement: `(${key} BC-3) The key is never in the URL` },
        { n: 2, statement: `(${key} BC-3) The screen is hidden without the permission` },
        { n: 3, statement: `(${key} BC-3) The form sends name and expires_at` },
      ]),
    );

    // re-tagging two lines away from BC-3 drops its trace there, and the refusal says where the ids read
    const retagged = await put([
      { n: 1, statement: `(${key} BC-3) The key is never in the URL` },
      { n: 2, statement: `(${key} BC-1) The screen is hidden without the permission` },
      { n: 3, statement: `(${key} BC-2) The form sends name and expires_at` },
    ]);
    expect(retagged.status, JSON.stringify(retagged.body)).toBe(422);
    expect(JSON.stringify(retagged.body)).toContain('CRITERIA_TRACE_DROPPED');
    expect(JSON.stringify(retagged.body)).toContain('GET /api/issues/:id/requirement');

    // the ids the run states on every line read through the issue, on the same fenced credential
    const bcs = (
      ((await ok(api(feAgent, 'GET', `/api/issues/${id}/requirement`))).requirement as Body)
        .revision as Body
    ).criteria as Body[];
    const bc = (code: string) => bcs.find((c) => c.code === code)?.id as string;
    await ok(
      put([
        { n: 1, statement: 'The key is never in the URL', requirementCriterionId: bc('BC-3') },
        {
          n: 2,
          statement: 'The screen is hidden without the permission',
          requirementCriterionId: bc('BC-1'),
        },
        {
          n: 3,
          statement: 'The form sends name and expires_at',
          requirementCriterionId: bc('BC-2'),
        },
      ]),
    );
    expect(await traces()).toEqual([
      { n: 1, id: bc('BC-3') },
      { n: 2, id: bc('BC-1') },
      { n: 3, id: bc('BC-2') },
    ]);

    // a BC of another requirement of the sibling is refused by name, and nothing is written
    const refund = (
      (await ok(api(owner, 'GET', `/api/projects/${apiProject.id}/requirements/${other}`)))
        .criteria as Body[]
    )[0]?.id as string;
    const foreign = await put([
      { n: 1, statement: 'The key is never in the URL', requirementCriterionId: refund },
      {
        n: 2,
        statement: 'The screen is hidden without the permission',
        requirementCriterionId: bc('BC-1'),
      },
      { n: 3, statement: 'The form sends name and expires_at', requirementCriterionId: bc('BC-2') },
    ]);
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(422);
    expect(JSON.stringify(foreign.body)).toContain('CRITERIA_TRACE_UNRESOLVED');
    expect(JSON.stringify(foreign.body)).toContain(`no business criterion of ${key}`);
    expect((await traces())[0]).toEqual({ n: 1, id: bc('BC-3') });
  });
});
