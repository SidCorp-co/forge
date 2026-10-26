/**
 * REQ-63 BC-4 through the host's own report: a merge GitLab reports (`source.merged`, from its merge
 * request hook) stamps every issue the request delivers, not only the one its branch leads with, and
 * the report of a change-request release's last merge closes that release. The outbox runs as the
 * server boots it, so the stamp and the settle are the consumer's own.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/client.js';
import { applyPullRequestEvent } from '../../src/integrations/source-host/projection.js';
import { emitEvent } from '../../src/outbox/index.js';
import { api, userToken } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import {
  addProjectMember,
  createTestProject,
  createTestUser,
  seedIssueStatus,
  truncateAll,
} from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';

const merged = new Map<number, string>();
const merges: number[] = [];
/** What the planted host answers: whether a head's tree is its merge commit's, or a read failure. */
const trees: { same: boolean | Error } = { same: true };
/** Each merge commit's message, as GitLab writes one: the branch it merged and the request it was. */
const messages = new Map<string, string>();
const mergeMessage = (number: number, headRef: string) =>
  `Merge branch '${headRef}' into 'release/stg'\n\nMR ${number}\n\nSee merge request acme/canawan-api!${number}`;

/** The repository read every stamp's identity is judged from (`issues/merge-identity.ts`). */
const repository = () => ({
  provider: 'gitlab',
  fullName: 'acme/canawan-api',
  readCommit: async (sha: string) => {
    const message = messages.get(sha.toLowerCase());
    return message
      ? { sha: sha.toLowerCase(), message, committedAt: '2026-10-23T09:00:00Z' }
      : null;
  },
  branchContains: async () => true,
});

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
  resolveSourceHost: async () => repository(),
  sourceHostForBinding: async () => ({
    ...repository(),
    words: { mergeMethods: ['merge', 'squash'], changeRequest: 'merge request', sigil: '!' },
    merge: async ({ number }: { number: number }) => {
      const landed = alreadyMerged.get(number);
      if (landed) {
        // GitLab's answer for a request whose commits landed through another one
        return {
          kind: 'already-merged',
          commitSha: landed,
          mergedAt: new Date(Date.UTC(2026, 9, 23, 12, 0)),
          target: 'release/stg',
          head: null,
        };
      }
      merges.push(number);
      const commitSha = `${String(number).padStart(4, '0')}${'c'.repeat(36)}`;
      merged.set(number, commitSha);
      const headRef = heads.get(number) ?? `mr-${number}`;
      if (!messages.has(commitSha)) messages.set(commitSha, mergeMessage(number, headRef));
      // each request merges a minute after the one numbered below it, into release/stg, at its head
      return {
        kind: 'merged',
        commitSha,
        mergedAt: new Date(Date.UTC(2026, 9, 23, 9, number)),
        target: 'release/stg',
        head: `${String(number).padStart(4, '0')}${'a'.repeat(36)}`,
      };
    },
    sameTree: async () => {
      if (trees.same instanceof Error) throw trees.same;
      return trees.same;
    },
  }),
}));

const BRANCH = 'release/stg';
const HEAD_A = 'a1'.repeat(20);
const HEAD_B = 'b2'.repeat(20);
const _HEAD_C = 'c3'.repeat(20);
const NOTE = { section: 'Added', userFacing: 'A site writes through to the catalog.' };

const world = { projectId: '', ownerId: '', token: '', bindingId: '' };
/** Each stored request's branch, as the planted host merges it. */
const heads = new Map<number, string>();
/** Requests the planted host answers as already merged, at the commit that landed them. */
const alreadyMerged = new Map<number, string>();

const rows = async <T>(query: ReturnType<typeof sql>) =>
  [...(await db.execute(query))] as unknown as T[];

async function seedWorld(release: Record<string, unknown> | null): Promise<void> {
  await truncateAll();
  merged.clear();
  merges.length = 0;
  trees.same = true;
  messages.clear();
  heads.clear();
  alreadyMerged.clear();
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
      delivery: { verdictsRequired: false },
      ...(release ? { release } : {}),
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
}

const THROUGH_CHANGE_REQUESTS = { approval: { required: true }, changeRequests: true };

/** An issue at `status`, its release note written; `stamp` writes a local merge with no commit. */
async function issue(seq: number, status: string, stamp = false): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id, release_notes)
    VALUES (${id}, ${world.projectId}, ${seq}, ${`issue ${seq}`}, 'in_progress', ${world.ownerId},
            ${JSON.stringify(NOTE)}::jsonb)
  `);
  if (stamp) await db.execute(sql`UPDATE issues SET merged_at = now() WHERE id = ${id}`);
  await seedIssueStatus(id, status);
  return id;
}

/** A merge request as the GitLab hook delivers it into the projection. */
async function mergeRequest(number: number, headRef: string, head: string, body: string | null) {
  heads.set(number, headRef);
  await applyPullRequestEvent(
    { projectId: world.projectId, bindingId: world.bindingId, host: 'gitlab' },
    {
      action: 'open',
      pull_request: {
        number,
        title: `MR ${number}`,
        body,
        html_url: `https://gitlab.com/acme/canawan-api/-/merge_requests/${number}`,
        state: 'open',
        head: { ref: headRef, sha: head },
        base: { ref: BRANCH, sha: 'f'.repeat(40) },
        updated_at: new Date().toISOString(),
      },
      repository: { full_name: 'acme/canawan-api' },
    },
  );
}

const _linkedTo = (number: number) =>
  rows<{ key: number; linked_by: string }>(sql`
    SELECT i.iss_seq AS key, l.linked_by FROM repo_pull_request_issues l
      JOIN repo_pull_requests p ON p.id = l.pull_request_id
      JOIN issues i ON i.id = l.issue_id
     WHERE p.project_id = ${world.projectId} AND p.number = ${number}
     ORDER BY i.iss_seq`);

const issueRow = async (id: string) =>
  (
    await rows<{
      status: string;
      merged_at: Date | null;
      merged_commit_sha: string | null;
      merged_target: string | null;
      merged_head: { sha: string; treeIdentical: boolean | null; why: string | null } | null;
    }>(sql`
      SELECT status, merged_at, merged_commit_sha, merged_target, merged_head FROM issues WHERE id = ${id}`)
  )[0];

const cut = (issueIds: string[], changeRequests?: number[]) =>
  api(world.token, 'POST', `/api/projects/${world.projectId}/release-batches`, {
    issueIds,
    ...(changeRequests ? { changeRequests } : {}),
  });

const mergeOf = (issueId: string, pullRequest: number) =>
  api(world.token, 'POST', `/api/issues/${issueId}/merge-pull-request`, { pullRequest });

const _codeOf = (body: unknown) => {
  const b = body as { error?: { code?: string; refusals?: Array<{ code: string }> } };
  return b.error?.refusals?.[0]?.code ?? b.error?.code ?? null;
};

/** Two requests over three issues: !10 delivers ISS-1 and ISS-2 by branch and ISS-3 by description. */
async function stack() {
  const one = await issue(1, 'awaiting_release');
  const two = await issue(2, 'awaiting_release');
  const three = await issue(3, 'awaiting_release');
  const four = await issue(4, 'awaiting_release');
  await mergeRequest(
    10,
    'feat/req3-site-write-iss-1-2',
    HEAD_A,
    'Also delivers ISS-3. Serves REQ-4.',
  );
  await mergeRequest(11, 'fix/req4-token-iss-4', HEAD_B, null);
  return { one, two, three, four };
}

async function approve(runId: string) {
  const [pending] = await rows<{ id: string }>(sql`
    SELECT id FROM release_approvals WHERE run_id = ${runId} AND decision IS NULL`);
  const res = await api(
    world.token,
    'POST',
    `/api/projects/${world.projectId}/release-batches/${runId}/approvals/${pending?.id}/decision`,
    { decision: 'approve', reason: 'the owner read both merge requests and accepts them' },
  );
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
}

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** GitLab's report that it merged the request on `headRef` at `commitSha`, as its hook emits it. */
async function hostMerged(
  number: number,
  headRef: string,
  commitSha: string,
  mergedAt = '2026-10-23T10:00:00.000Z',
) {
  // a commit GitLab made for another request keeps that request's message
  if (!messages.has(commitSha)) messages.set(commitSha, mergeMessage(number, headRef));
  await db.execute(sql`
    UPDATE repo_pull_requests SET state = 'merged', merge_commit_sha = ${commitSha}, merged_at = now()
     WHERE project_id = ${world.projectId} AND number = ${number}`);
  await emitEvent(db, 'source.merged', {
    projectId: world.projectId,
    headRef,
    baseRef: BRANCH,
    commitSha,
    mergedAt,
    head: null,
  });
  await settleOutbox();
  // the settle that ran before its stamp was written is retried later; bring that retry to now
  await db.execute(sql`
    UPDATE pgboss_v12.job SET start_after = now()
     WHERE name = 'outbox.release-merge-settle' AND state = 'retry'`);
  await settleOutbox();
}

const HOST_SHA = 'd4'.repeat(20);

describe('BC-4: a merge the host reports stamps every issue its request delivers', () => {
  it('stamps ISS-1, ISS-2 and ISS-3 from one report of !10', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one, two, three, four } = await stack();
    await hostMerged(10, 'feat/req3-site-write-iss-1-2', HOST_SHA);
    for (const id of [one, two, three]) {
      expect((await issueRow(id))?.merged_commit_sha).toBe(HOST_SHA);
    }
    expect((await issueRow(four))?.merged_commit_sha).toBeNull();
  });

  it('closes a change-request release when the host reports its last merge', async () => {
    await settleOutbox();
    await seedWorld(THROUGH_CHANGE_REQUESTS);
    const { one, two, three, four } = await stack();
    const runId = String((await cut([one, two, three, four], [10, 11])).body.runId);
    await approve(runId);
    expect((await mergeOf(one, 10)).status).toBe(200);
    await settleOutbox();

    await hostMerged(11, 'fix/req4-token-iss-4', HOST_SHA);

    expect(await issueRow(four)).toMatchObject({ status: 'closed', merged_commit_sha: HOST_SHA });
    for (const id of [one, two, three]) expect((await issueRow(id))?.status).toBe('closed');
    const [run] = await rows<{ status: string }>(sql`
      SELECT status FROM pipeline_runs WHERE id = ${runId}`);
    expect(run?.status).toBe('completed');
  });
});

// adminhub-api ISS-1, 2026-10-26: merged through Forge as !5008 into release/stg at cf94a1e6, and the
// stamp held merged_at with no target; 21 of 22 issues stamped by the route read the same.
describe('a merge through Forge records the target and the head on every issue it stamps', () => {
  it('stamps the base branch and the head, with its tree read identical, on ISS-1, ISS-2 and ISS-3', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one, two, three, four } = await stack();

    const res = await mergeOf(one, 10);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ target: BRANCH });

    for (const id of [one, two, three]) {
      expect(await issueRow(id)).toMatchObject({
        merged_commit_sha: merged.get(10),
        merged_target: BRANCH,
        merged_head: { sha: `0010${'a'.repeat(36)}`, treeIdentical: true, why: null },
      });
    }
    expect((await issueRow(four))?.merged_target).toBeNull();
  });

  it('keeps the head unread, with why, where the host could not say whether the trees match', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one } = await stack();
    trees.same = new Error('GitLab answered 503');

    expect((await mergeOf(one, 10)).status).toBe(200);

    const row = await issueRow(one);
    expect(row?.merged_head?.treeIdentical).toBeNull();
    expect(row?.merged_head?.why).toContain('GitLab answered 503');
  });

  it('keeps a tree reading when the host replays the same merge with no head or an unread one', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one } = await stack();
    expect((await mergeOf(one, 10)).status).toBe(200);
    const read = { sha: `0010${'a'.repeat(36)}`, treeIdentical: true, why: null };

    for (const head of [
      {
        ...read,
        treeIdentical: null,
        why: 'GitLab answered 503',
        readAt: new Date().toISOString(),
      },
      null,
    ]) {
      await emitEvent(db, 'source.merged', {
        projectId: world.projectId,
        headRef: 'feat/req3-site-write-iss-1-2',
        baseRef: BRANCH,
        commitSha: merged.get(10) as string,
        mergedAt: '2026-10-25T09:10:00.000Z',
        head,
      });
      await settleOutbox();
      expect((await issueRow(one))?.merged_head).toMatchObject(read);
    }
  });

  // catalog-fe ISS-11..19, 2026-10-26: !312 and !313 merged into `dev`, and the column read
  // `release/stg`, which a mark wrote into the column the route had left empty
  it('keeps the target the merge read when a later mark names another branch', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one } = await stack();
    expect((await mergeOf(one, 10)).status).toBe(200);

    const mark = await api(world.token, 'POST', `/api/issues/${one}/merge`, {
      target: 'release/prod',
      commit: merged.get(10),
    });
    expect(mark.status, JSON.stringify(mark.body)).toBe(200);

    expect((await issueRow(one))?.merged_target).toBe(BRANCH);
    expect(String(mark.body.detail)).toContain(
      '`release/prod`, which this call named, is recorded as its claim',
    );
  });

  // adminhub-api ISS-2, 2026-10-26: linked to !5011 and !5012; the first-wins stamp kept !5011
  // (68153bdf) though its work finished in !5012 (62bf8d33)
  it('lands an issue delivered across two requests at the later merge', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const one = await issue(1, 'awaiting_release');
    await mergeRequest(10, 'feat/req3-site-write-iss-1', HEAD_A, null);
    await mergeRequest(12, 'fix/req3-site-write-rest-iss-1', HEAD_B, null);

    const first = await mergeOf(one, 10);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await issueRow(one))?.merged_commit_sha).toBe(merged.get(10));
    expect((await mergeOf(one, 12)).status).toBe(200);

    const row = await issueRow(one);
    expect(row?.merged_commit_sha).toBe(merged.get(12));
    expect(new Date(String(row?.merged_at)).toISOString()).toBe('2026-10-23T09:12:00.000Z');
    expect(row?.merged_head?.sha).toBe(`0012${'a'.repeat(36)}`);
  });

  it('records the base branch a merge the host reports names', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { one } = await stack();

    await hostMerged(10, 'feat/req3-site-write-iss-1-2', HOST_SHA);

    expect(await issueRow(one)).toMatchObject({
      merged_commit_sha: HOST_SHA,
      merged_target: BRANCH,
    });
  });
});

// adminhub-fe, 2026-10-26: !1979 and !1982 carried one head. !1979 was opened under keys later
// renumbered, so its branch named ISS-37; Forge merged !1982 at 17caff30, GitLab then marked !1979
// merged too, and ISS-37 (and two drafts) took 17caff30 through !1979's links, superseding the mark
// ISS-37 held from its own merge, with no activity saying so.
describe('a sibling request the host marks merged stamps nothing that is not its commit', () => {
  const HEAD_SHARED = 'e5'.repeat(20);
  const HEAD_OWN = 'f6'.repeat(20);
  const OWN_SHA = 'd2'.repeat(20);

  const refusals = (issueId: string, via = 'event') =>
    rows<{ action: string; payload: { commitSha: string; code: string; via: string } }>(sql`
      SELECT action, payload FROM activity_log
       WHERE issue_id = ${issueId} AND action = 'issue.mergeStampRefused'
         AND payload->>'via' = ${via}`);

  async function siblings() {
    const five = await issue(5, 'awaiting_release');
    const stale = await issue(37, 'awaiting_release');
    const draft = await issue(11, 'draft');
    await mergeRequest(1979, 'iss-37-login', HEAD_SHARED, 'Also ISS-11.');
    await mergeRequest(1982, 'fix/login-iss-5', HEAD_SHARED, null);
    return { five, stale, draft };
  }

  it('stamps the merged request’s issue and refuses the sibling’s, on the record', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { five, stale, draft } = await siblings();

    const res = await mergeOf(five, 1982);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const landing = merged.get(1982) as string;
    await hostMerged(1979, 'iss-37-login', landing);

    expect((await issueRow(five))?.merged_commit_sha).toBe(landing);
    const stampedRows = await rows<{ fields: string[] }>(sql`
      SELECT payload->'fields' AS fields FROM activity_log
       WHERE issue_id = ${five} AND action = 'issue.updated'`);
    expect(stampedRows.some((r) => r.fields.includes('mergedCommitSha'))).toBe(true);
    expect((await issueRow(stale))?.merged_commit_sha).toBeNull();
    expect((await issueRow(draft))?.merged_at).toBeNull();
    for (const id of [stale, draft]) {
      expect(await refusals(id)).toMatchObject([
        { payload: { commitSha: landing, code: 'COMMIT_NOT_THIS_ISSUE', via: 'event' } },
      ]);
    }
  });

  it('never supersedes the mark an issue holds from its own merge with a sibling’s commit', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { five, stale } = await siblings();
    await mergeRequest(1981, 'iss-37-session', HEAD_OWN, null);
    await hostMerged(1981, 'iss-37-session', OWN_SHA);
    expect((await issueRow(stale))?.merged_commit_sha).toBe(OWN_SHA);

    expect((await mergeOf(five, 1982)).status).toBe(200);
    // reported an hour after ISS-37's own merge, so only its identity keeps it from superseding
    await hostMerged(1979, 'iss-37-login', merged.get(1982) as string, '2026-10-23T11:00:00.000Z');

    expect((await issueRow(stale))?.merged_commit_sha).toBe(OWN_SHA);
  });

  it('marks an issue at its own merge, not at the commit a sibling was marked merged at', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true }, changeRequests: true });
    const { stale } = await siblings();
    await mergeRequest(1981, 'iss-37-session', HEAD_OWN, null);
    await hostMerged(1981, 'iss-37-session', OWN_SHA);
    // a merge outside a release is the release door's to refuse here, so GitLab merges !1982
    const landing = 'a7'.repeat(20);
    messages.set(landing, mergeMessage(1982, 'fix/login-iss-5'));
    await hostMerged(1982, 'fix/login-iss-5', landing);
    await hostMerged(1979, 'iss-37-login', landing);

    expect((await api(world.token, 'DELETE', `/api/issues/${stale}/merge`, {})).status).toBe(200);
    const mark = await api(world.token, 'POST', `/api/issues/${stale}/merge`, {
      commit: OWN_SHA,
      target: BRANCH,
    });
    expect(mark.status, JSON.stringify(mark.body)).toBe(200);
    expect((await issueRow(stale))?.merged_commit_sha).toBe(OWN_SHA);
    expect(await refusals(stale, 'mark')).toMatchObject([
      { payload: { commitSha: landing, code: 'COMMIT_NOT_THIS_ISSUE' } },
    ]);
  });

  it('refuses a mark naming another request’s merge commit, and records why', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true }, changeRequests: true });
    const { stale } = await siblings();
    const landing = 'a7'.repeat(20);
    messages.set(landing, mergeMessage(1982, 'fix/login-iss-5'));
    await hostMerged(1982, 'fix/login-iss-5', landing);
    await hostMerged(1979, 'iss-37-login', landing);

    const mark = await api(world.token, 'POST', `/api/issues/${stale}/merge`, {
      commit: landing,
      target: BRANCH,
    });
    expect(mark.status).toBe(422);
    expect(JSON.stringify(mark.body)).toContain(`is not ISS-37's landing`);
    expect((await issueRow(stale))?.merged_commit_sha).toBeNull();
    expect((await refusals(stale, 'mark')).map((r) => r.payload.commitSha)).toContain(landing);
  });

  it('judges by its commit a merge the host answers already made, not by the request named', async () => {
    await settleOutbox();
    await seedWorld({ approval: { required: true } });
    const { five, stale, draft } = await siblings();
    await mergeRequest(1981, 'iss-37-session', HEAD_OWN, null);
    await hostMerged(1981, 'iss-37-session', OWN_SHA);
    expect((await mergeOf(five, 1982)).status).toBe(200);
    const landing = merged.get(1982) as string;
    alreadyMerged.set(1979, landing);

    const res = await mergeOf(stale, 1979);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as {
      alreadyMerged: boolean;
      refusedStamps: { issueId: string; code: string }[];
    };
    expect(body.alreadyMerged).toBe(true);
    // !1979's links name ISS-37 and the draft ISS-11; neither is the landing's, and both are said
    expect(body.refusedStamps.map((r) => [r.issueId, r.code]).sort()).toEqual(
      [stale, draft].map((id) => [id, 'COMMIT_NOT_THIS_ISSUE']).sort(),
    );
    expect((await issueRow(stale))?.merged_commit_sha).toBe(OWN_SHA);
    expect(await refusals(stale, 'kernel')).toMatchObject([{ payload: { commitSha: landing } }]);
  });
});
