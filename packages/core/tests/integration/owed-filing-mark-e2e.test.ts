/**
 * The owed-filings ask and the mark that answers it are one rule (ISS-774). Under a gate profile
 * with `issue_before_code` off, a merge into the default branch that delivers no issue is owed the
 * master as "file the issue for it, then mark it merged at that commit". Every such merge is owed
 * BECAUSE its commit names no issue, and the mark judged a commit by the issue its subject names, so
 * the forge dev master's mark of ISS-784 at #1233's merge (132998bdf, 2026-10-30) was refused
 * COMMIT_NOT_THIS_ISSUE and the ask could never clear. The mark now takes a merge its project owes a
 * filing for, naming no issue, as the landing of the one issue that answers it, and nothing else.
 *
 * @direct-test-of packages/core/src/issues/owed-merges.ts
 * @direct-test-of packages/core/src/issues/commit-landing.ts
 * @direct-test-of packages/core/src/issues/merge-identity.ts
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { owedFilings } from '../../src/issues/owed-merges.js';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestDevice, createTestProject, seedIssueStatus } from '../helpers/factories.js';
import {
  BRANCH,
  hostMerged,
  issue,
  issueRow,
  mergeOf,
  mergeRequest,
  rows,
  seedWorld,
  world,
} from '../helpers/host-merge-world.js';
import { alreadyMerged, messages } from '../helpers/planted-gitlab-merges.js';
import { boxToken } from '../helpers/preview-world.js';
import { seedProjectDocument } from '../helpers/release-world.js';

vi.mock('../../src/integrations/source-host/resolve.js', async (importOriginal) => {
  const planted = await import('../helpers/planted-gitlab-merges.js');
  return {
    ...(await importOriginal<typeof import('../../src/integrations/source-host/resolve.js')>()),
    resolveSourceHost: async () => planted.plantedRepository(),
    sourceHostForBinding: async () => planted.plantedSourceHost(),
  };
});

beforeAll(async () => {
  testEnv();
  await startQueue();
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

/** The profile that lets code come first, so a merge naming no issue is owed a filing. */
const CODE_FIRST = { gates: { profile: 'standard', overrides: { issue_before_code: 'off' } } };
const PR_1233 = '132998bd'.repeat(5);
const UNLINKED_MESSAGE = 'Merge pull request #1233 from SidCorp-co/fix/archived-project-no-master';

let box = '';

async function world_(release: Record<string, unknown> | null, extra: Record<string, unknown>) {
  await settleOutbox();
  await seedWorld(release, extra);
  box = await boxToken(world.ownerId, await createTestDevice(world.ownerId));
}

/** A merge into the default branch whose request links no issue, its commit saying `message`. */
async function unlinkedMerge(number: number, sha: string, message: string) {
  const branch = `fix/no-key-${number}`;
  await mergeRequest(number, branch, `${String(number).padStart(4, '0')}${'e'.repeat(36)}`, null);
  messages.set(sha, message);
  await hostMerged(number, branch, sha);
}

/** The issue a master files for a merge: a draft, nothing of its work recorded. */
const filed = (seq: number) => issue(seq, 'draft');

const mark = (issueId: string, commit: string, token = box) =>
  api(token, 'POST', `/api/issues/${issueId}/merge`, {
    commit,
    target: BRANCH,
    mergedAt: '2026-10-28T09:00:00.000Z',
    note: 'filed for the merge the owed-filings list named',
  });

const owedCommits = async () => (await owedFilings(world.projectId)).map((f) => f.commit);

describe('the issue filed for a merge naming no issue is marked at that merge', () => {
  it('takes the mark the nudge asks for, and the mark clears the ask', async () => {
    await world_(null, CODE_FIRST);
    await unlinkedMerge(1233, PR_1233, UNLINKED_MESSAGE);
    expect(await owedCommits()).toEqual([PR_1233]);
    const iss784 = await filed(784);

    const res = await mark(iss784, PR_1233);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss784))?.merged_commit_sha).toBe(PR_1233);
    expect(JSON.stringify(res.body)).toContain(
      'as the filing this project owed for change request 1233',
    );
    expect(await owedCommits()).toEqual([]);

    // the same mark again reads its own answer, never "another issue answers it"
    const again = await mark(iss784, PR_1233);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect((again.body as { action: string }).action).toBe('already_merged');

    // one merge, one filing: a second issue filed for it is refused, the first answers it
    const twice = await filed(785);
    const second = await mark(twice, PR_1233);
    expect(second.status).toBe(422);
    expect(JSON.stringify(second.body)).toContain('COMMIT_NOT_THIS_ISSUE');
    expect((await issueRow(twice))?.merged_at).toBeNull();
  });

  it('refuses a commit that declares another issue, though its merge links none', async () => {
    await world_(null, CODE_FIRST);
    const sha = 'd5'.repeat(20);
    await unlinkedMerge(1240, sha, 'fix(core): the header keeps its height (ISS-55)');
    expect(await owedCommits()).toEqual([sha]);
    const iss784 = await filed(784);

    const res = await mark(iss784, sha);
    expect(res.status).toBe(422);
    const body = JSON.stringify(res.body);
    expect(body).toContain('COMMIT_NOT_THIS_ISSUE');
    expect(body).toContain('it declares ISS-55');
    expect((await issueRow(iss784))?.merged_at).toBeNull();
    expect(await owedCommits()).toEqual([sha]);
  });

  it('refuses a commit that is no merge this project owes a filing for', async () => {
    await world_(null, CODE_FIRST);
    const plain = 'c4'.repeat(20);
    messages.set(plain, 'chore: tidy the lockfile');
    const iss784 = await filed(784);

    const res = await mark(iss784, plain);
    expect(res.status).toBe(422);
    const body = JSON.stringify(res.body);
    expect(body).toContain('COMMIT_NOT_THIS_ISSUE');
    expect(body).toContain(
      'it is not the merge of a change request this project owes a filing for',
    );
    expect((await issueRow(iss784))?.merged_at).toBeNull();
  });

  it('refuses the merge where the profile owes no filing (issue_before_code enforced)', async () => {
    await world_(null, {});
    await unlinkedMerge(1233, PR_1233, UNLINKED_MESSAGE);
    expect(await owedCommits()).toEqual([]);
    const iss784 = await filed(784);

    const res = await mark(iss784, PR_1233);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('COMMIT_NOT_THIS_ISSUE');
  });

  it('refuses an issue of another project marking this project’s owed merge', async () => {
    await world_(null, CODE_FIRST);
    await unlinkedMerge(1233, PR_1233, UNLINKED_MESSAGE);
    const other = (await createTestProject(world.ownerId)).id;
    await seedProjectDocument(other, world.ownerId, {
      environments: {},
      defaultBranch: BRANCH,
      source: {
        type: 'git',
        git: {
          repository: 'gitlab.com/acme/canawan-api',
          defaultBranch: BRANCH,
          branches: [BRANCH],
        },
      },
      extra: { delivery: { verdictsRequired: false }, ...CODE_FIRST } as never,
    });
    const foreign = randomUUID();
    await rows(sql`
      INSERT INTO issues (id, project_id, iss_seq, title, status, created_by_id)
      VALUES (${foreign}, ${other}, 784, 'filed in the wrong project', 'in_progress', ${world.ownerId})`);
    await seedIssueStatus(foreign, 'draft');

    const res = await mark(foreign, PR_1233);
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body)).toContain('COMMIT_NOT_THIS_ISSUE');
    expect(await owedCommits()).toEqual([PR_1233]);
  });

  // the window bounds what the master is asked, never what a filing in flight may answer
  it('takes the mark of a merge that aged out of the asked window while its filing was in flight', async () => {
    await world_(null, CODE_FIRST);
    await unlinkedMerge(1233, PR_1233, UNLINKED_MESSAGE);
    const iss784 = await filed(784);
    await rows(sql`
      UPDATE repo_pull_requests SET merged_at = now() - interval '20 days'
       WHERE project_id = ${world.projectId} AND number = 1233`);
    expect(await owedCommits()).toEqual([]);

    const res = await mark(iss784, PR_1233);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss784))?.merged_commit_sha).toBe(PR_1233);
  });

  it('asks for the merge again once the mark that answered it is withdrawn', async () => {
    await world_(null, CODE_FIRST);
    await unlinkedMerge(1233, PR_1233, UNLINKED_MESSAGE);
    const iss784 = await filed(784);
    // a claim kept only in the trail, as an asserted mark keeps it: a stamped mark naming the commit
    const trail = (action: string, payload: Record<string, unknown>, at: string) =>
      rows(sql`
        INSERT INTO activity_log (issue_id, actor_type, actor_id, actor_agency, action, payload, created_at)
        VALUES (${iss784}, 'user', ${world.ownerId}, 'human', ${action}, ${JSON.stringify(payload)}::jsonb,
                ${at}::timestamptz)`);
    await trail(
      'issue.mergeMarked',
      { commit: PR_1233, target: BRANCH, stamped: true, commentId: null },
      '2026-10-29T10:00:00Z',
    );
    expect(await owedCommits()).toEqual([]);

    await trail('issue.mergeUnmarked', { commentId: null }, '2026-10-29T11:00:00Z');
    expect(await owedCommits()).toEqual([PR_1233]);
  });
});

describe('on a project that releases through change requests', () => {
  const CR = { approval: { required: false }, changeRequests: true };

  it('takes the filed issue’s mark at the merge the host holds', async () => {
    await world_(CR, CODE_FIRST);
    await unlinkedMerge(1233, PR_1233, UNLINKED_MESSAGE);
    const iss784 = await filed(784);

    const res = await mark(iss784, PR_1233);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss784))?.merged_commit_sha).toBe(PR_1233);
    expect(await owedCommits()).toEqual([]);
  });

  it('refuses the mark at an unlinked merge whose commit declares another issue', async () => {
    await world_(CR, CODE_FIRST);
    const sha = 'd5'.repeat(20);
    await unlinkedMerge(1240, sha, 'fix(core): the header keeps its height (ISS-55)');
    const iss784 = await filed(784);

    const res = await mark(iss784, sha);
    expect(res.status).toBe(422);
    const body = JSON.stringify(res.body);
    expect(body).toContain('MARK_NOT_A_HOST_MERGE');
    expect(body).toContain('it declares ISS-55');
    expect((await issueRow(iss784))?.merged_at).toBeNull();
  });

  // adminhub-fe !1979 (2026-10-26): a stale request the host marks merged at another's commit. Only a
  // mark naming the commit answers a filing; a stamp a request's links ask for never does.
  it('stamps no linked issue through an owed merge’s commit', async () => {
    await world_({ approval: { required: true } }, CODE_FIRST);
    await unlinkedMerge(1233, PR_1233, UNLINKED_MESSAGE);
    const stale = await issue(37, 'awaiting_release');
    await mergeRequest(1979, 'iss-37-login', 'e5'.repeat(20), null);
    alreadyMerged.set(1979, PR_1233);

    const res = await mergeOf(stale, 1979);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = res.body as { refusedStamps: { issueId: string; code: string }[] };
    expect(body.refusedStamps).toEqual([
      expect.objectContaining({ issueId: stale, code: 'COMMIT_NOT_THIS_ISSUE' }),
    ]);
    expect((await issueRow(stale))?.merged_commit_sha).toBeNull();
    expect(await owedCommits()).toEqual([PR_1233]);
  });
});
