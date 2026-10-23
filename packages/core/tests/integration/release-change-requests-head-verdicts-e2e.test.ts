/**
 * REQ-63 BC-6: on a project that releases by merging its change requests, a pass judged at the head
 * of an open change request linked to the issue counts while that head is unchanged, and the steward
 * does not send the issue back for a landing it has none of. Planted from adminhub-api ISS-10 on
 * dev.293 (2026-10-23): reopened to re-ship through !5009, judged pass at !5009's head with commit
 * identity, moved to awaiting_release, and reopened by the steward two minutes later for "no
 * recorded landing on its working branch". The reopen had cleared the local stamp, as BC-3 asks, so
 * nothing counted a verdict taken at the head the release merges.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { replaceCriteria } from '../../src/issues/criteria/service.js';
import { api, userToken } from '../helpers/api.js';
import { testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const BRANCH = 'release/stg';
const HEAD = '4d2198e9d95a713381442d7e3a9e9df59347fb7f';
const MOVED = 'e7'.repeat(20);
const MERGE = '9c'.repeat(20);
const NOTE = {
  section: 'Added',
  userFacing: 'Orders, finance, design and product routes are documented.',
};

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };

const rows = async <T>(query: ReturnType<typeof sql>) =>
  [...(await db.execute(query))] as unknown as T[];

// a reopen the steward is let through, and an approval, each enqueue what follows on the job queue
beforeAll(async () => {
  testEnv();
  await (await import('../../src/queue/boss.js')).startBoss();
  await (await import('../../src/outbox/index.js')).declareOutboxQueues();
}, 120_000);

afterAll(async () => {
  await (await import('../../src/queue/boss.js')).stopBoss();
});

beforeEach(async () => {
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
    extra: {
      // adminhub-api's own policy: every criterion owes a counting verdict before release
      delivery: { verdictsRequired: true },
      release: { approval: { required: true }, changeRequests: true },
    } as never,
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
});

/** ISS-10 at the gate after its reopen: three criteria, its release note, no merge stamp. */
async function iss10(): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
    VALUES (${id}, ${world.projectId}, 10, 'OpenAPI foundation', 'in_progress', ${world.ownerId},
            ${JSON.stringify(NOTE)}::jsonb)
  `);
  await replaceCriteria(id, [
    { n: 1, statement: 'openapi.yaml documents every route the suite calls' },
    { n: 2, statement: 'The suite fails on a route with no documentation' },
    { n: 3, statement: 'An unmatched route is named, not skipped' },
  ]);
  await seedIssueStatus(id, 'awaiting_release');
  return id;
}

/** !5009 as GitLab's hook delivers it: its branch names ISS-10, its head as given. */
async function mr5009(head: string, state: 'open' | 'merged' = 'open') {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: state === 'open' ? 'update' : 'merge',
      pull_request: {
        number: 5009,
        title: '[2/6] REQ-1: OpenAPI for orders, finance, design and products',
        body: 'Stacked on !5008.',
        html_url: 'https://gitlab.com/acme/canawan-api/-/merge_requests/5009',
        state,
        merged: state === 'merged',
        head: { ref: 'feat/req1-openapi-iss-10-13', sha: head },
        base: { ref: BRANCH, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/canawan-api' },
    },
  );
}

/** The judge's pass on each criterion, its identity the commit it ran at. */
async function judgedAll(issueId: string, commit: string) {
  const criteria = await rows<{ id: string; n: number }>(sql`
    SELECT id, n FROM issue_criteria WHERE issue_id = ${issueId} AND retired_at IS NULL ORDER BY n`);
  for (const c of criteria) {
    await db.execute(sql`
      INSERT INTO criterion_verdicts (criterion_id, issue_id, verdict, reason, identity_kind, commit_sha,
                                      author_user_id, author_agency, judge)
      VALUES (${c.id}, ${issueId}, 'pass', ${`suite green at ${commit}`}, 'commit', ${commit},
              ${world.ownerId}, 'agent', 'qa')
    `);
  }
}

async function stewardReopens(issueId: string) {
  const { callStewardDoor } = await import('../../src/steward/doors.js');
  const [run] = await rows<{ id: string }>(sql`
    INSERT INTO steward_runs (project_id, subject_kind, subject_id, subject_key, trigger, events,
                              acts_to_run, state, not_before, started_at)
    VALUES (${world.projectId}, 'issue', ${issueId}, 'ISS-10', 'release.asked', '[]'::jsonb,
            ARRAY['output_check']::text[], 'running', now(), now())
    RETURNING id`);
  const ctx = {
    projectId: world.projectId,
    runId: run?.id ?? '',
    act: 'output_check' as const,
    subject: { kind: 'issue', id: issueId, key: 'ISS-10' },
    standing: null,
    token: world.token,
    refused: [] as string[],
    broken: [] as string[],
    acts: [] as string[],
  };
  return callStewardDoor(
    'steward_move_issue',
    JSON.stringify({
      issue: 'ISS-10',
      to: 'reopen',
      // the steward's own words on dev.293
      reason: `pass verdicts only at commit ${HEAD.slice(0, 12)}. ISS-10 has no recorded landing on its working branch, so none is a counting verdict for this project with no production environment.`,
    }),
    ctx,
  );
}

const statusOf = async (id: string) =>
  (await rows<{ status: string }>(sql`SELECT status FROM issues WHERE id = ${id}`))[0]?.status;

const judgedBuild = async (id: string) => {
  const res = await api(world.token, 'GET', `/api/issues/${id}/judged-build`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as { sha: string | null; source: string | null; basis: string };
};

describe('BC-6: a pass at an open linked change request’s unchanged head counts', () => {
  it('refuses the steward’s reopen of ISS-10 when every criterion passes at !5009’s head', async () => {
    const issue = await iss10();
    await mr5009(HEAD);
    await judgedAll(issue, HEAD);

    const answer = await stewardReopens(issue);

    expect(answer.ok, answer.text).toBe(false);
    expect(answer.text).toContain('STEWARD_REOPEN_COUNTED');
    expect(answer.text).toContain('!5009');
    expect(await statusOf(issue)).toBe('awaiting_release');
  });

  it('defaults a verdict on ISS-10 to !5009’s head', async () => {
    const issue = await iss10();
    await mr5009(HEAD);

    expect(await judgedBuild(issue)).toMatchObject({ sha: HEAD, source: 'change-request' });
  });

  it('stops counting a pass once !5009’s head moves, and says so by name', async () => {
    const issue = await iss10();
    await mr5009(HEAD);
    await judgedAll(issue, HEAD);
    await mr5009(MOVED);

    const build = await judgedBuild(issue);
    expect(build).toMatchObject({ sha: MOVED, source: 'change-request' });
    expect(build.basis).toContain(`\`${HEAD.slice(0, 12)}\``);
    expect(build.basis).toContain('moved');

    const answer = await stewardReopens(issue);
    expect(answer.ok, answer.text).toBe(true);
    expect(await statusOf(issue)).toBe('reopen');
  });

  it('takes the host merge commit as the landing once !5009 merges', async () => {
    const issue = await iss10();
    await mr5009(HEAD);
    await judgedAll(issue, HEAD);
    await mr5009(HEAD, 'merged');
    await db.execute(sql`
      UPDATE issues SET merged_at = now(), merged_commit_sha = ${MERGE} WHERE id = ${issue}`);

    expect(await judgedBuild(issue)).toMatchObject({ sha: MERGE, source: 'merged' });
  });

  it('refuses to approve a release whose request moved since the cut, naming the move', async () => {
    const issue = await iss10();
    await mr5009(HEAD);
    await judgedAll(issue, HEAD);
    const cut = await api(world.token, 'POST', `/api/projects/${world.projectId}/release-batches`, {
      issueIds: [issue],
      changeRequests: [5009],
    });
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    await mr5009(MOVED);

    const [pending] = await rows<{ id: string }>(sql`
      SELECT id FROM release_approvals WHERE run_id = ${String(cut.body.runId)} AND decision IS NULL`);
    const res = await api(
      world.token,
      'POST',
      `/api/projects/${world.projectId}/release-batches/${String(cut.body.runId)}/approvals/${pending?.id}/decision`,
      { decision: 'approve', reason: 'the owner read !5009 and accepts it' },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(JSON.stringify(res.body)).toContain('moved');
    expect(JSON.stringify(res.body)).toContain(MOVED.slice(0, 12));
  });
});
