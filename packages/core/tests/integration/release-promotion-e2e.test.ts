/**
 * REQ-63 BC-9..12, the promotion release (adminhub-api, 2026-10-29): production is deployed outside
 * Forge from `release/production`, and one promotion crosses into it from `release/stg`, where the
 * issue merge requests land. A release is that promotion's merge request: the agent cuts it naming the
 * request (`promotion.request`) and the roster it states, a merge done on GitLab is seen in the
 * projection, and the operator's record of the deploy closes the roster. ISS-774 owner ruling
 * (2026-10-29): Forge never asks the host which issues a request carries, so no read or record
 * compares: the planted host counts every compare it is asked. Against real Postgres.
 *
 * @direct-test-of packages/core/src/release-batch/promotion-release.ts
 * @direct-test-of packages/core/src/release-batch/promotion-standing.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { admitChangeRequestMerge } from '../../src/release-batch/change-request-merge.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { declareGate, seedProjectDocument } from '../helpers/release-world.js';

const planted = vi.hoisted(() => ({
  compares: 0,
  /** The checks GitLab answers for a request's head, and every head it was asked about. */
  checks: [] as Array<Record<string, unknown>>,
  askedAbout: [] as string[],
}));

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => ({
    provider: 'gitlab',
    fullName: 'acme/adminhub-api',
    // every ancestry question is counted, and answered "diverged": nothing here may depend on it
    compare: async () => {
      planted.compares += 1;
      return 'diverged';
    },
    readChangeRequestChecks: async ({ headSha }: { headSha: string }) => {
      planted.askedAbout.push(headSha);
      return planted.checks.map((c) => ({ ...c, headSha }));
    },
  }),
}));

const STG = 'release/stg';
const PROD = 'release/production';
const HEAD = 'a1'.repeat(20);
const MERGE = 'b2'.repeat(20);
const DEPLOYED = 'c3'.repeat(20);
const LANDED = ['d4'.repeat(20), 'e5'.repeat(20)];
const NOTE = { section: 'Added', title: 'Site writes', userFacing: 'A site writes through.' };

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };
const rows = async <T>(q: ReturnType<typeof sql>) => [...(await db.execute(q))] as T[];
const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  api(world.token, method, `/api/projects/${world.projectId}${path}`, body);
const codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

async function seed(environment: Record<string, unknown>) {
  await truncateAll();
  planted.compares = 0;
  planted.checks = [];
  planted.askedAbout = [];
  world.ownerId = (await createTestUser({ verified: true })).id;
  world.projectId = (await createTestProject(world.ownerId)).id;
  await addProjectMember(world.projectId, world.ownerId, 'admin');
  world.token = await userToken(world.ownerId);
  await seedProjectDocument(world.projectId, world.ownerId, {
    environments: { production: environment as never },
    promotions: [{ from: STG, to: PROD, via: 'merge' } as never],
    defaultBranch: STG,
    source: {
      type: 'git',
      git: {
        repository: 'gitlab.com/acme/adminhub-api',
        defaultBranch: STG,
        branches: [STG, PROD],
      },
    },
    extra: { delivery: { verdictsRequired: false } } as never,
  });
  const connectionId = randomUUID();
  world.bindingId = randomUUID();
  await db.execute(sql`
    INSERT INTO integration_connections (id, owner_type, owner_id, provider, active)
    VALUES (${connectionId}, 'user', ${world.ownerId}, 'gitlab', true)`);
  await db.execute(sql`
    INSERT INTO integration_bindings (id, connection_id, project_id, provider, role, active, config)
    VALUES (${world.bindingId}, ${connectionId}, ${world.projectId}, 'gitlab', 'source', true,
            ${JSON.stringify({ repository: 'acme/adminhub-api' })}::jsonb)`);
}

const EXTERNAL = {
  tier: 'production',
  deploysFrom: PROD,
  deployment: { mode: 'external' },
  url: 'https://adminhub-api.example.test',
};

/** Issues whose merge requests already merged into release/stg, waiting at the release gate. */
async function landedIssues(shas: readonly string[] = LANDED, after = 0): Promise<string[]> {
  const ids: string[] = [];
  for (const [n, sha] of shas.entries()) {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes,
                          merged_at, merged_commit_sha, merged_target)
      VALUES (${id}, ${world.projectId}, ${after + n + 1}, ${`issue ${after + n + 1}`}, 'in_progress', ${world.ownerId},
              ${JSON.stringify(NOTE)}::jsonb, now() - interval '1 hour', ${sha}, ${STG})`);
    await seedIssueStatus(id, 'awaiting_release');
    ids.push(id);
  }
  return ids;
}

/** The promotion merge request as GitLab's hook writes it into the projection. */
async function promotionRequest(number: number, head: string, from = STG, into = PROD) {
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'open',
      pull_request: {
        number,
        title: 'Promote release/stg to production',
        body: null,
        html_url: `https://gitlab.com/acme/adminhub-api/-/merge_requests/${number}`,
        state: 'open',
        head: { ref: from, sha: head },
        base: { ref: into, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/adminhub-api' },
    },
  );
}

/** GitLab's merge of the request, done by the owner on GitLab, as the projection reads it. */
const mergedOnHost = (number: number, merge = MERGE) =>
  db.execute(sql`
    UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${merge}, merged_at = now()
     WHERE project_id = ${world.projectId} AND number = ${number}`);

/** The agent's cut: the roster it states, and the request it says carries it. */
const cutNaming = (issueIds: string[], request?: number) =>
  call('POST', '/release-batches', {
    issueIds,
    ...(request === undefined ? {} : { promotion: { request } }),
  });

const record = (issueIds: string[], commit = DEPLOYED) =>
  call('POST', '/release-records', {
    issueIds,
    commit,
    account: 'Deployed release/production through forge-ops (k8s rollout adminhub-api).',
  });

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

beforeEach(async () => {
  await settleOutbox();
  await seed(EXTERNAL);
});

describe('BC-9: an external production with one declared promotion is a release target', () => {
  it('cuts the release as the request the agent names, never RELEASE_TARGET_UNDECLARED', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    const roster = await call('GET', '/release-batches/roster');
    expect(JSON.stringify(roster.body)).not.toContain('RELEASE_TARGET_UNDECLARED');
    const cut = await cutNaming(ids, 5053);
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    expect(cut.body).toMatchObject({
      jobId: null,
      verification: 'deployment',
      changeRequests: [{ number: 5053, label: '!5053', headSha: HEAD }],
    });
    expect(planted.compares).toBe(0);
  });

  // adminhub-fe !2055: the promotion is cut from a branch pinning a judged head, not from release/stg itself
  it('takes a request into release/production from a branch cut to pin the head', async () => {
    const ids = await landedIssues();
    await promotionRequest(2055, HEAD, 'promote/prod-2026-10-29');
    const cut = await cutNaming(ids, 2055);
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    expect(cut.body).toMatchObject({ changeRequests: [{ number: 2055, headSha: HEAD }] });
  });

  it('refuses the cut by name where no promotion request is open or merged and unreleased', async () => {
    const ids = await landedIssues();
    const roster = await call('GET', '/release-readiness');
    // the readiness names which issues wait on the promotion, not only how many
    expect(JSON.stringify(roster.body)).toContain(
      'None is open, or merged and not yet released, so nothing would ship 2 issues named here (`ISS-1`, `ISS-2`).',
    );
    const none = await cutNaming(ids, 5053);
    expect(codeOf(none.body), JSON.stringify(none.body)).toBe('RELEASE_PROMOTION_MISSING');
  });

  // (c) the agent says which request carries its roster; Forge does not guess it from the host
  it('refuses a cut that names no promotion request, and one naming a request the projection lacks', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    const unnamed = await cutNaming(ids);
    expect(codeOf(unnamed.body), JSON.stringify(unnamed.body)).toBe(
      'RELEASE_PROMOTION_REQUEST_UNNAMED',
    );
    expect(JSON.stringify(unnamed.body)).toContain('!5053');
    const unknown = await cutNaming(ids, 9999);
    expect(codeOf(unknown.body), JSON.stringify(unknown.body)).toBe(
      'RELEASE_PROMOTION_REQUEST_UNKNOWN',
    );
    const empty = await cutNaming([], 5053);
    expect(codeOf(empty.body), JSON.stringify(empty.body)).toBe('RELEASE_ISSUES_UNNAMED');
    const runs = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE project_id = ${world.projectId}`,
    );
    expect(runs[0]?.n).toBe(0);
  });
});

/** ISS-809 (REQ-71 BC-9): the declared validation gate is read at the head the promotion carries. */
describe('a promotion release is cut only where the declared gate check passes at the request head', () => {
  const pipeline = (conclusion: string | null, status = 'completed') => ({
    id: '77',
    name: 'pipeline',
    app: 'gitlab-ci',
    status,
    conclusion,
    detailsUrl: null,
    startedAt: '2026-10-30T10:00:00Z',
    completedAt: status === 'completed' ? '2026-10-30T10:05:00Z' : null,
  });

  beforeEach(async () => {
    await declareGate(world.projectId, { type: 'gitlab-pipeline', name: 'pipeline' });
  });

  it('refuses the cut by name while the pipeline at the request head is red, and opens no run', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    planted.checks = [pipeline('failed')];

    const cut = await cutNaming(ids, 5053);

    expect(codeOf(cut.body), JSON.stringify(cut.body)).toBe('RELEASE_GATE_CHECK_RED');
    expect(JSON.stringify(cut.body)).toContain('`pipeline`');
    expect(JSON.stringify(cut.body)).toContain(HEAD.slice(0, 12));
    expect(planted.askedAbout).toEqual([HEAD]);
    const runs = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM pipeline_runs WHERE project_id = ${world.projectId}`,
    );
    expect(runs[0]?.n).toBe(0);
  });

  it('holds it while the pipeline runs, and cuts it once the pipeline passes at that head', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    planted.checks = [pipeline(null, 'running')];

    const waiting = await cutNaming(ids, 5053);
    expect(codeOf(waiting.body), JSON.stringify(waiting.body)).toBe('RELEASE_GATE_CHECK_PENDING');

    planted.checks = [pipeline('success')];
    const cut = await cutNaming(ids, 5053);
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
  });
});

describe('BC-10..12: the release shows its promotion, sees it merged on GitLab, and closes on the record', () => {
  it('shows the request and the stated roster, refuses the record until merged, and closes on it', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    const cut = await cutNaming(ids, 5053);
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    const version = String(cut.body.version);

    const read = await call('GET', `/releases/${version}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect((read.body.release as { promotion: unknown }).promotion).toEqual({
      label: '!5053',
      number: 5053,
      title: 'Promote release/stg to production',
      url: 'https://gitlab.com/acme/adminhub-api/-/merge_requests/5053',
      state: 'open',
      from: STG,
      to: PROD,
      headSha: HEAD,
      mergeCommitSha: null,
      roster: ['ISS-1', 'ISS-2'],
    });

    // Forge merges the promotion only on the owner's go: named through a roster issue, it is refused before approval
    const early = await api(world.token, 'POST', `/api/issues/${ids[0]}/merge-pull-request`, {
      pullRequest: 5053,
    });
    expect(codeOf(early.body), JSON.stringify(early.body)).toBe('RELEASE_MERGE_NOT_APPROVED');

    const unmerged = await record(ids);
    expect(codeOf(unmerged.body), JSON.stringify(unmerged.body)).toBe('RELEASE_PROMOTION_UNMERGED');

    await mergedOnHost(5053);
    const seen = await call('GET', `/releases/${version}`);
    expect(
      (seen.body.release as { promotion: { state: string; mergeCommitSha: string } }).promotion,
    ).toMatchObject({ state: 'merged', mergeCommitSha: MERGE });

    const partial = await record([ids[0] as string]);
    expect(codeOf(partial.body)).toBe('RELEASE_PROMOTION_ROSTER');

    const closed = await record(ids);
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect(closed.body).toMatchObject({ version, verification: 'deployment', failed: [] });
    const statuses = await rows<{ status: string }>(
      sql`SELECT status FROM issues WHERE project_id = ${world.projectId} ORDER BY iss_seq`,
    );
    expect(statuses.map((s) => s.status)).toEqual(['closed', 'closed']);
    const [run] = await rows<{ status: string; released: Date | null }>(
      sql`SELECT status, release_released_at AS released FROM pipeline_runs WHERE id = ${String(cut.body.runId)}`,
    );
    expect(run?.status).toBe('completed');
    expect(run?.released).not.toBeNull();
    expect(planted.compares).toBe(0);
  });

  it('refuses a record with no release running, naming the cut that comes first', async () => {
    const ids = await landedIssues();
    await promotionRequest(5053, HEAD);
    await mergedOnHost(5053);
    const refused = await record(ids);
    expect(codeOf(refused.body), JSON.stringify(refused.body)).toBe('RELEASE_PROMOTION_MISSING');
    expect(JSON.stringify(refused.body)).toContain('promotion: { request: <number> }');
  });
});

// (a) the read paths: GET /releases, /release-readiness and a draft once asked GitLab, per read, which
// roster issues the promotion head carries, and a burst of them was a GitLab 429 storm (ISS-774).
describe('the reads of a pending promotion compare nothing on the host', () => {
  it('makes 0 host compares across 3 reads each of the list, the readiness and the draft', async () => {
    await landedIssues();
    await promotionRequest(5053, HEAD);
    for (let n = 0; n < 3; n += 1) {
      for (const path of ['/releases', '/release-readiness', '/releases/0.1.0']) {
        const read = await call('GET', path);
        expect(read.status, `${path} ${JSON.stringify(read.body)}`).toBe(200);
      }
    }
    expect(planted.compares).toBe(0);
  });

  it('shows the open request and every waiting issue on the draft, with no split or partial gate', async () => {
    const shas = Array.from({ length: 9 }, (_, n) => (n + 0x31).toString(16).repeat(20));
    await landedIssues(shas);
    const head = '73b2be31'.repeat(5);
    await promotionRequest(2055, head, 'promote/prod-2026-10-29');
    const draft = await call('GET', '/releases/0.1.0');
    expect(draft.status, JSON.stringify(draft.body)).toBe(200);
    const release = draft.body.release as {
      state: string;
      promotion: unknown;
      split: unknown;
      gates: Array<{ code: string }>;
    };
    expect(release.state).toBe('draft');
    expect(release.promotion).toMatchObject({
      label: '!2055',
      state: 'open',
      from: 'promote/prod-2026-10-29',
      to: PROD,
      headSha: head,
      roster: Array.from({ length: 9 }, (_, n) => `ISS-${n + 1}`),
    });
    expect(release.gates.map((g) => g.code)).toEqual([]);
    expect(release.split).toBeNull();
    expect(planted.compares).toBe(0);
  });
});

// (b) catalog-api 0.3.0, ISS-762: commit 307f35d8 was already on release/production through !1023 and the
// release still asked to promote it. The agent names the merged request at the cut; the merge was the go.
describe('ISS-762: a promotion already merged is cut as merged and asks nothing to promote', () => {
  it('cuts naming !1023 with no approval, records the deploy, and closes', async () => {
    const ids = await landedIssues();
    const merge = '307f35d8'.repeat(5);
    await promotionRequest(1023, HEAD);
    await mergedOnHost(1023, merge);

    const readiness = await call('GET', '/release-readiness');
    expect(JSON.stringify(readiness.body)).not.toContain('RELEASE_PROMOTION_MISSING');

    const cut = await cutNaming(ids, 1023);
    expect(cut.status, JSON.stringify(cut.body)).toBe(201);
    expect(cut.body).toMatchObject({ jobId: null, changeRequests: [{ number: 1023 }] });
    const approvals = await rows<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM release_approvals WHERE run_id = ${String(cut.body.runId)}`,
    );
    expect(approvals[0]?.n).toBe(0);

    const closed = await record(ids, merge);
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect(closed.body).toMatchObject({ failed: [] });
    const statuses = await rows<{ status: string }>(
      sql`SELECT status FROM issues WHERE project_id = ${world.projectId} ORDER BY iss_seq`,
    );
    expect(statuses.map((s) => s.status)).toEqual(['closed', 'closed']);
    expect(planted.compares).toBe(0);
  });

  it('never asks to promote that merged request again once a release took it', async () => {
    const ids = await landedIssues();
    await promotionRequest(1023, HEAD);
    await mergedOnHost(1023, MERGE);
    expect((await cutNaming(ids, 1023)).status).toBe(201);
    expect((await record(ids, MERGE)).status).toBe(201);

    const later = (await landedIssues(['f7'.repeat(20)], 2)).at(0) as string;
    const readiness = await call('GET', '/release-readiness');
    expect(JSON.stringify(readiness.body)).toContain('RELEASE_PROMOTION_MISSING');
    // the spent !1023 is not a request to promote: the cut is refused for the want of a new one
    const again = await cutNaming([later], 1023);
    expect(codeOf(again.body), JSON.stringify(again.body)).toBe('RELEASE_PROMOTION_MISSING');
  });
});

describe('a promotion gates only the requests into the branch production deploys from', () => {
  const idOf = async (number: number) => {
    const [row] = await rows<{ id: string }>(
      sql`SELECT id FROM repo_pull_requests WHERE project_id = ${world.projectId} AND number = ${number}`,
    );
    return String(row?.id);
  };

  // adminhub-api !5063, 2026-10-29: an ordinary fix into release/stg was refused RELEASE_MERGE_UNRELEASED
  it('admits a fix merge request into the promotion source as an ordinary landing', async () => {
    await promotionRequest(5063, 'a7'.repeat(20), 'fix/iss-71-site-write', STG);
    const admitted = await admitChangeRequestMerge({
      projectId: world.projectId,
      pullRequestId: await idOf(5063),
    });
    expect(admitted).toEqual({ kind: 'free' });
  });

  it('still refuses a request into release/production outside a release', async () => {
    await promotionRequest(5064, HEAD, STG, PROD);
    await expect(
      admitChangeRequestMerge({ projectId: world.projectId, pullRequestId: await idOf(5064) }),
    ).rejects.toMatchObject({ refusals: [{ code: 'RELEASE_MERGE_UNRELEASED' }] });
  });

  it('refuses by name a request whose target branch it cannot read, rather than letting it through', async () => {
    await expect(
      admitChangeRequestMerge({ projectId: world.projectId, pullRequestId: randomUUID() }),
    ).rejects.toMatchObject({ refusals: [{ code: 'RELEASE_MERGE_TARGET_UNREAD' }] });
  });
});
