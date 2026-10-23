/**
 * REQ-63 BC-6: on a project that releases by merging its change requests, the issue's head is the
 * head of the open change request linked to it, read through the one predicate
 * (`release-batch/change-request-build.ts`) by every reader of "the issue's head": its detail's
 * work state, its standing and the steward's facts. Planted from adminhub-api ISS-10 on dev.296
 * (2026-10-23 08:39): !5009's head stood unchanged at 4d2198e9d95a, but ISS-10's work state still
 * carried the worklog capture of the old local branch `feat/iss-10-openapi-foundation` at
 * 39587a27d, which does not contain the MR head; the steward read that capture as "the current
 * request head" and asked the master to judge all seven criteria again.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { stewardReleaseFacts } from '../../src/release-batch/index.js';
import { api, userToken } from '../helpers/api.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const BRANCH = 'release/stg';
const MR_BRANCH = 'feat/req1-openapi-iss-10-13';
const MR_HEAD = '4d2198e9d95a713381442d7e3a9e9df59347fb7f';
const WORK_BRANCH = 'feat/iss-10-openapi-foundation';
const WORK_HEAD = '39587a27d716466215a1cdc647327d64cbeb1c35';

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };

async function seedWorld(release: Record<string, unknown>): Promise<void> {
  await truncateAll();
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: {},
    defaultBranch: BRANCH,
    source: {
      type: 'git',
      git: { repository: 'gitlab.com/acme/canawan-api', defaultBranch: BRANCH, branches: [BRANCH] },
    },
    extra: { delivery: { verdictsRequired: true }, release } as never,
  });
  const connectionId = randomUUID();
  world.bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${world.ownerId}, 'gitlab', true)
  `);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${world.bindingId}, ${connectionId}, ${world.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ repository: 'acme/canawan-api' })}::jsonb)
  `);
}

/** ISS-10 at the gate, its work state holding the worklog's capture of the old local branch. */
async function iss10(): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
    VALUES (${id}, ${world.projectId}, 10, 'OpenAPI foundation', 'in_progress', ${world.ownerId})
  `);
  await seedIssueStatus(id, 'awaiting_release');
  await db.execute(sql`
    INSERT INTO issue_work_state (issue_id, branch, head_sha, updated_at)
    VALUES (${id}, ${WORK_BRANCH}, ${WORK_HEAD}, now())
    ON CONFLICT (issue_id) DO UPDATE SET branch = EXCLUDED.branch, head_sha = EXCLUDED.head_sha
  `);
  return id;
}

async function mr5009() {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'update',
      pull_request: {
        number: 5009,
        title: '[2/6] REQ-1: OpenAPI for orders, finance, design and products',
        body: 'Stacked on !5008.',
        html_url: 'https://gitlab.com/acme/canawan-api/-/merge_requests/5009',
        state: 'open',
        head: { ref: MR_BRANCH, sha: MR_HEAD },
        base: { ref: BRANCH, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/canawan-api' },
    },
  );
}

type WorkState = { branch: string | null; headSha: string | null; captured?: unknown };

describe('BC-6: the issue’s head is its change request’s head, for every reader', () => {
  beforeEach(() => seedWorld({ approval: { required: true }, changeRequests: true }));

  it('gives ISS-10’s detail !5009’s head, and keeps the worklog capture apart, named', async () => {
    const issue = await iss10();
    await mr5009();

    const res = await api(world.token, 'GET', `/api/issues/${issue}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ws = (res.body as { workState: WorkState }).workState;
    expect(ws).toMatchObject({ branch: MR_BRANCH, headSha: MR_HEAD });
    expect(ws.captured).toEqual({ branch: WORK_BRANCH, headSha: WORK_HEAD });
  });

  it('gives ISS-10’s standing !5009’s head', async () => {
    await iss10();
    await mr5009();

    const res = await api(
      world.token,
      'GET',
      `/api/projects/${world.projectId}/issues/standing/ISS-10`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ standing: { branch: MR_BRANCH, headSha: MR_HEAD } });
  });

  it('tells the steward the head is !5009’s, and that the captured branch is not', async () => {
    const issue = await iss10();
    await mr5009();

    const facts = await stewardReleaseFacts(world.projectId, issue);
    expect(facts).toContain('!5009');
    expect(facts).toContain(MR_HEAD.slice(0, 12));
    expect(facts).toContain(`${WORK_HEAD.slice(0, 12)}`);
    expect(facts).toContain('not the head');
  });

  it('defaults a verdict on ISS-10 to !5009’s head, never the capture', async () => {
    const issue = await iss10();
    await mr5009();

    const res = await api(world.token, 'GET', `/api/issues/${issue}/judged-build`);
    expect(res.body).toMatchObject({ sha: MR_HEAD, source: 'change-request' });
  });
});

describe('on any other project the work state is the run’s own record', () => {
  beforeEach(() => seedWorld({ approval: { required: true } }));

  it('keeps ISS-10’s captured branch and head as written', async () => {
    const issue = await iss10();

    const res = await api(world.token, 'GET', `/api/issues/${issue}`);
    const ws = (res.body as { workState: WorkState }).workState;
    expect(ws).toMatchObject({ branch: WORK_BRANCH, headSha: WORK_HEAD });
    expect(ws.captured).toBeUndefined();
  });
});
