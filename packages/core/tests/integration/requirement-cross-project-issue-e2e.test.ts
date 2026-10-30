/**
 * A requirement is delivered by an issue of a sibling project in its own organization: adminhub-api's
 * REQ-14 BC-6 has its front-end half in adminhub-fe. Linking adminhub-fe ISS-114 on adminhub-api was
 * refused 404 "issue … is not an issue of project …" even for the org owner, so that half could not
 * be traced, counted or gated (dev, 2026-10-30). Through the app's own routes, against real Postgres:
 * the link, the coverage that counts the sibling's verdict on the sibling's own build, the issue
 * reading its requirement with its project, the issue-ready move judged against it, and each refusal
 * by name — another organization, a caller without rights on either side, an agent's credential
 * fenced to one side, a requirement not agreed.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import {
  provideRequirementDependents,
  requirementDependents,
} from '../../src/requirements/dependents.js';
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

/** The commit the front end shipped and was judged at: its own live build holds it, the api's does not. */
const FE_COMMIT = 'fe00000000000000000000000000000000000001';

let apiProject: TestProject;
let feProject: TestProject;
let ownerId: string;
let owner: string;
let restore: (() => void) | null = null;

type Body = Record<string, unknown>;

beforeEach(async () => {
  await truncateAll();
  ownerId = (await createTestUser({ verified: true })).id;
  apiProject = await createTestProject(ownerId);
  feProject = await createTestProject(ownerId, { orgId: apiProject.orgId });
  owner = await userToken(ownerId);
  // each project's live build answers for itself: only the front end's holds its own commit
  const booted = requirementDependents();
  provideRequirementDependents({
    ...booted,
    liveBuildHolds: async (projectId, asked) => ({
      sha: projectId === feProject.id ? FE_COMMIT : null,
      holds: new Map(asked.commits.map((c) => [c.toLowerCase(), projectId === feProject.id])),
      runtimes: new Map(),
      unanswered: new Map(),
    }),
  });
  restore = () => provideRequirementDependents(booted);
});

afterEach(() => {
  restore?.();
  restore = null;
});

const onApi = (token: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
  api(token, method, `/api/projects/${apiProject.id}${path}`, body);

async function ok(r: Promise<{ status: number; body: Body }>): Promise<Body> {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  return res.body;
}

function refusalOf(body: Body): Body {
  const error = body.error as Body;
  return ((error.refusals as Body[] | undefined)?.[0] ?? error) as Body;
}

/** REQ-n on the api project, agreed at revision 1 with one business criterion. */
async function agreedRequirement(): Promise<string> {
  const key = String(
    (
      await ok(
        onApi(owner, 'POST', '/requirements', {
          title: 'Order history',
          reason: 'planted',
          criteria: [{ body: 'A shopper sees every past order' }],
        }),
      )
    ).key,
  );
  await makeAgreeReady(apiProject.id, Number(key.slice(4)), ownerId);
  await ok(onApi(owner, 'POST', `/requirements/${key}/revisions/1/propose`, {}));
  await ok(
    onApi(owner, 'POST', `/requirements/${key}/revisions/1/accept`, { reason: 'BA review' }),
  );
  await ok(onApi(owner, 'POST', `/requirements/${key}/agree`, { revision: 1, reason: 'agreed' }));
  return key;
}

const feIssue = (seq: number, status: 'draft' | 'closed') =>
  createTestIssue(feProject.id, ownerId, seq, {
    status,
    createdAt: new Date(),
    ...(status === 'closed' ? { mergedAt: new Date() } : {}),
  });

describe("a sibling project's issue delivering a requirement", () => {
  it('links by uuid, and coverage counts its verdict on its own build', async () => {
    const req = await agreedRequirement();
    const { id } = await feIssue(114, 'closed');

    await ok(onApi(owner, 'POST', `/requirements/${req}/issues`, { issue: id }));
    await ok(api(owner, 'POST', `/api/issues/${id}/criteria/traces`, { codes: ['BC-1'] }));
    await ok(
      api(owner, 'POST', `/api/issues/${id}/verdicts`, {
        criterion: 1,
        verdict: 'pass',
        reason: 'pass on the running front end',
        identity: { kind: 'commit', sha: FE_COMMIT },
        evidence: ['shot.png'],
      }),
    );

    const detail = await ok(onApi(owner, 'GET', `/requirements/${req}`));
    const link = (detail.issues as Body[])[0] as Body;
    expect(link.displayId).toBe(`${feProject.slug}/ISS-114`);
    expect((link.otherProject as Body).slug).toBe(feProject.slug);
    const bc = ((detail.standing as Body).coverage as Body[])[0] as Body;
    expect(bc.verdict, JSON.stringify(bc)).toBe('passing');
    expect((bc.counts as Body).displayId).toBe(`${feProject.slug}/ISS-114`);
    const traced = (bc.issues as Body[])[0] as Body;
    expect(traced.inLiveBuild).toBe(true);
    expect((traced.otherProject as Body).id).toBe(feProject.id);

    const issue = await ok(api(owner, 'GET', `/api/issues/${id}`));
    const requirement = issue.requirement as Body;
    expect(requirement.key).toBe(req);
    expect((requirement.project as Body).slug).toBe(apiProject.slug);

    await ok(onApi(owner, 'DELETE', `/requirements/${req}/issues/${id}`));
    expect((await ok(api(owner, 'GET', `/api/issues/${id}`))).requirement).toBeNull();
  });

  it("opens through the issue-ready checklist on the sibling's agreed requirement", async () => {
    const req = await agreedRequirement();
    const { id } = await feIssue(115, 'draft');
    await ok(onApi(owner, 'POST', `/requirements/${req}/issues`, { issue: id }));
    await ok(api(owner, 'POST', `/api/issues/${id}/criteria/traces`, { codes: ['BC-1'] }));

    const moved = await api(owner, 'POST', `/api/issues/${id}/transition`, { toStatus: 'open' });
    expect(moved.status, JSON.stringify(moved.body)).toBeLessThan(300);
    const [row] = (await db.execute(
      sql`SELECT status FROM issues WHERE id = ${id}`,
    )) as unknown as { status: string }[];
    expect(row?.status).toBe('open');
  });

  it("is refused opening on a sibling's draft requirement, naming it with its project", async () => {
    const key = String(
      (
        await ok(
          onApi(owner, 'POST', '/requirements', {
            title: 'Not agreed yet',
            reason: 'planted',
            criteria: [{ body: 'It is not agreed' }],
          }),
        )
      ).key,
    );
    const { id } = await feIssue(116, 'draft');
    const linked = await onApi(owner, 'POST', `/requirements/${key}/issues`, { issue: id });
    expect(linked.status, JSON.stringify(linked.body)).toBe(422);
    expect(refusalOf(linked.body).code).toBe('REQUIREMENT_NOT_AGREED');

    // held to the checklist whichever way the link was written
    await db.execute(sql`
      UPDATE issues SET requirement_id = (
        SELECT id FROM requirements WHERE project_id = ${apiProject.id} AND req_seq = ${Number(key.slice(4))}
      ) WHERE id = ${id}`);
    const moved = await api(owner, 'POST', `/api/issues/${id}/transition`, { toStatus: 'open' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(422);
    expect(JSON.stringify(moved.body)).toContain(
      `linked to ${apiProject.slug}/${key}, which is draft`,
    );
  });

  it("refuses an issue of another organization's project by name", async () => {
    const req = await agreedRequirement();
    const elsewhere = await createTestProject(ownerId);
    const { id } = await createTestIssue(elsewhere.id, ownerId, 7, {
      status: 'draft',
      createdAt: new Date(),
    });
    const res = await onApi(owner, 'POST', `/requirements/${req}/issues`, { issue: id });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(refusalOf(res.body).code).toBe('REQUIREMENT_ISSUE_OTHER_ORG');
  });

  it('refuses a caller without read on the issue, or without write on the requirement', async () => {
    const req = await agreedRequirement();
    const { id } = await feIssue(117, 'draft');

    const apiOnly = (await createTestUser({ verified: true })).id;
    await addProjectMember(apiProject.id, apiOnly, 'member');
    const noRead = await onApi(await userToken(apiOnly), 'POST', `/requirements/${req}/issues`, {
      issue: id,
    });
    expect(noRead.status, JSON.stringify(noRead.body)).toBe(403);
    expect(JSON.stringify(noRead.body)).toContain(`project.read on project ${feProject.id}`);

    const feViewer = (await createTestUser({ verified: true })).id;
    await addProjectMember(feProject.id, feViewer, 'member');
    await addProjectMember(apiProject.id, feViewer, 'viewer');
    const noWrite = await onApi(await userToken(feViewer), 'POST', `/requirements/${req}/issues`, {
      issue: id,
    });
    expect(noWrite.status, JSON.stringify(noWrite.body)).toBe(403);
    expect(JSON.stringify(noWrite.body)).toContain('project.write');

    const [row] = (await db.execute(
      sql`SELECT requirement_id FROM issues WHERE id = ${id}`,
    )) as unknown as { requirement_id: string | null }[];
    expect(row?.requirement_id).toBeNull();
  });

  it("takes the front end's agent only on a credential reaching both projects", async () => {
    const req = await agreedRequirement();
    const { id } = await feIssue(118, 'draft');
    const agent = (await createTestUser({ kind: 'agent' })).id;
    await addProjectMember(feProject.id, agent, 'member');
    await addProjectMember(apiProject.id, agent, 'member');

    const fenced = await onApi(
      await patToken(agent, [feProject.id]),
      'POST',
      `/requirements/${req}/issues`,
      {
        issue: id,
      },
    );
    expect(fenced.status, JSON.stringify(fenced.body)).toBe(403);
    expect(JSON.stringify(fenced.body)).toContain('PAT_PROJECT_OUTSIDE_FENCE');

    const both = await patToken(agent, [feProject.id, apiProject.id], `both-${randomUUID()}`);
    await ok(onApi(both, 'POST', `/requirements/${req}/issues`, { issue: id }));
  });
});
