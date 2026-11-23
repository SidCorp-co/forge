/**
 * A mark naming a commit the repository vouches for is a merge Forge observed, whoever marks it and
 * whatever work evidence the issue already carries. On forge dev, 2026-10-30, the repository was read
 * only for an agent's mark on an issue with no work evidence: ISS-781's mark at 8cf12bc1e read
 * `observed`, while ISS-562's at 61043f926 (its run had recorded its branch; the subject names
 * ISS-562) and ISS-783's at e54c95e12 (a person's mark at the merge of #1235, which links ISS-783,
 * made before the host's report of that merge reached the projection) read `asserted`, with
 * `merged_commit_sha` empty. A commit the repository does not vouch for is still recorded as the
 * caller's claim, as before, and the mark says why the repository did not take it; one the
 * repository answers it does not hold also names the route for code landing elsewhere (ISS-1340).
 *
 * @direct-test-of packages/core/src/issues/merge-marker.ts
 * @direct-test-of packages/core/src/issues/commit-landing.ts
 * @direct-test-of packages/core/src/issues/merge-identity.ts
 * @direct-test-of packages/core/src/issues/mark-writes.ts
 * @direct-test-of packages/core/src/issues/asserted-amend.ts
 * @direct-test-of packages/core/src/issues/merge-record.ts
 * @direct-test-of packages/core/src/projects/commit-owners.ts
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
import { createTestDevice, seedIssueStatus } from '../helpers/factories.js';
import {
  BRANCH,
  issue,
  issueRow,
  mergeRequest,
  rows,
  seedWorld,
  world,
} from '../helpers/host-merge-world.js';
import { messages } from '../helpers/planted-gitlab-merges.js';
import { boxToken } from '../helpers/preview-world.js';

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

const C4 = '61043f92'.repeat(5);
const PR_1235 = 'e54c95e1'.repeat(5);
let box = '';

async function world_() {
  await settleOutbox();
  await seedWorld(null);
  box = await boxToken(world.ownerId, await createTestDevice(world.ownerId));
}

const mark = (token: string, issueId: string, commit: string) =>
  api(token, 'POST', `/api/issues/${issueId}/merge`, { commit, target: BRANCH });

const detailOf = (body: unknown) => JSON.stringify(body);

describe('a mark naming a commit the repository vouches for is observed', () => {
  it('observes a run’s mark on an issue that carries its branch (ISS-562 at 61043f926)', async () => {
    await world_();
    messages.set(C4, 'test(core): the old-query probe types its query builders (ISS-562)');
    const iss562 = await issue(562, 'in_progress');
    // the branch its run recorded: work evidence, which kept the mark from reading the repository
    await rows(sql`
      INSERT INTO issue_work_state (issue_id, branch) VALUES (${iss562}, 'fix/iss562-c4-retired-query')
      ON CONFLICT (issue_id) DO UPDATE SET branch = excluded.branch`);

    const res = await mark(box, iss562, C4);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss562))?.merged_commit_sha).toBe(C4);
    expect(detailOf(res.body)).toContain('this mark is a merge Forge observed');
  });

  it('observes a person’s mark at a request’s merge that links the issue, before the host reports it (ISS-783 at e54c95e12)', async () => {
    await world_();
    const iss783 = await issue(783, 'in_progress');
    await mergeRequest(1235, 'req-80-env-variables', 'a'.repeat(40), 'Delivers ISS-783.');
    messages.set(PR_1235, 'Merge pull request #1235 from SidCorp-co/req-80-env-variables');

    const res = await mark(world.token, iss783, PR_1235);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss783))?.merged_commit_sha).toBe(PR_1235);
    expect(detailOf(res.body)).toContain('this mark is a merge Forge observed');
  });

  // ISS-766 at 486dcd5a2: marked from its run, again 30 s later, again from a worktree, each one
  // asserted; a mark the repository vouches for now turns the standing claim into the observed merge
  it('turns a standing claim into the observed merge when the same commit is marked again (ISS-766)', async () => {
    await world_();
    const fix = '486dcd5a'.repeat(5);
    messages.set(
      fix,
      'fix(core): a refused requirement revision names the act that frees the caller (ISS-766)',
    );
    const iss766 = await issue(766, 'awaiting_release');
    await rows(sql`
      INSERT INTO issue_work_state (issue_id, branch) VALUES (${iss766}, 'fix/iss766-revision-way-out')
      ON CONFLICT (issue_id) DO UPDATE SET branch = excluded.branch`);
    // the claim the three earlier marks left: merged_at stamped, no commit observed
    await rows(
      sql`UPDATE issues SET merged_at = now() - interval '5 minutes' WHERE id = ${iss766}`,
    );

    const res = await mark(box, iss766, fix);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss766))?.merged_commit_sha).toBe(fix);
    expect(detailOf(res.body)).toContain('this mark is a merge Forge observed');
  });

  it('keeps a commit declaring another issue as the caller’s claim, and says why', async () => {
    await world_();
    const other = 'd5'.repeat(20);
    messages.set(other, 'fix(core): the header keeps its height (ISS-55)');
    const iss562 = await issue(562, 'in_progress');

    const res = await mark(world.token, iss562, other);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(iss562))?.merged_commit_sha).toBeNull();
    const detail = detailOf(res.body);
    expect(detail).toContain('this mark is a CLAIM Forge did not observe');
    expect(detail).toContain('COMMIT_NOT_THIS_ISSUE');
    expect(detail).toContain('it declares ISS-55');
  });

  // ISS-1340 (FB-750): ISS-1339 marked at forge-plugin's c49b46a stood with no word of the route, and
  // its release could never ship it
  it('keeps a commit the repository does not hold as the caller’s claim, says why, and names the route', async () => {
    await world_();
    const iss562 = await issue(562, 'in_progress');

    const res = await mark(world.token, iss562, 'f0'.repeat(20));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await issueRow(iss562);
    expect(row?.merged_at).not.toBeNull();
    expect(row?.merged_commit_sha).toBeNull();
    const detail = detailOf(res.body);
    expect(detail).toContain('COMMIT_NOT_IN_REPOSITORY');
    expect(detail).toContain(`commit ${'f0'.repeat(20)} is not an object in acme/canawan-api`);
    expect(detail).toContain(
      "land this project's half here, at least its changelog fragment, and mark at that commit",
    );
    expect(detail).toContain('(not_found, COMMIT_NOT_IN_REPOSITORY');
  });
});

// ISS-1445 (sidpeak FB-845): sidpeak 0.32.0's release run marked ISS-32, 45, 47, 48 and 50 at its
// shared commit, an asserted claim, and closed them; their own key-named commits stood on staging,
// a re-mark at one was refused, and the beta mirror refused their rows for an empty
// merged_commit_sha. e45996c9 "merge: ISS-46/47/48 — …" was observed for ISS-46 alone.
describe('a later observed commit amends an asserted mark in place (ISS-1445)', () => {
  const RELEASE = 'bcb5995e'.repeat(5);
  const OWN = '37c01802'.repeat(5);

  async function trail(id: string) {
    return rows<{ payload: { commit: string | null; stamped: boolean } }>(sql`
      SELECT payload FROM activity_log WHERE issue_id = ${id} AND action = 'issue.mergeMarked'
       ORDER BY created_at ASC`);
  }

  async function assertedAndClosed(seq: number): Promise<{ id: string; at: Date }> {
    messages.set(RELEASE, 'chore(release): v0.32.0');
    const id = await issue(seq, 'in_progress');
    const first = await mark(box, id, RELEASE);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.mark).toBe('asserted');
    await seedIssueStatus(id, 'closed');
    return { id, at: await markedAt(id) };
  }

  async function markedAt(id: string): Promise<Date> {
    const [row] = await rows<{ at: string }>(sql`
      SELECT to_json(merged_at) #>> '{}' AS at FROM issues WHERE id = ${id}`);
    return new Date(String(row?.at));
  }

  it('fills merged_commit_sha on a closed issue without a reopen, keeping its time, status and first record', async () => {
    await world_();
    const { id, at } = await assertedAndClosed(47);
    messages.set(OWN, 'fix(ui): ISS-47 — keep cumulative 6-month figure, relabel');

    const res = await mark(box, id, OWN);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.action).toBe('merged');
    expect(res.body.mark).toBe('observed');
    const row = await issueRow(id);
    expect(row?.status).toBe('closed');
    expect(row?.merged_commit_sha).toBe(OWN);
    expect(row?.merged_target).toBe(BRANCH);
    expect(await markedAt(id)).toEqual(at);
    const detail = String(res.body.detail);
    expect(detail).toContain('this mark is a merge Forge observed');
    expect(detail).toContain(
      `It amends in place the asserted mark standing since ${at.toISOString()}`,
    );
    expect(detail).toContain(`which claimed commit ${RELEASE}`);
    expect((await trail(id)).map((t) => [t.payload.commit, t.payload.stamped])).toEqual([
      [RELEASE, true],
      [OWN, true],
    ]);
    const [comment] = await rows<{ body: string }>(sql`
      SELECT body FROM comments WHERE issue_id = ${id} ORDER BY created_at DESC LIMIT 1`);
    expect(comment?.body).toContain(`which claimed commit ${RELEASE}`);
  });

  // the release run's mark carried the paths its box read at the shared commit, so the re-mark with
  // the paths read at the issue's own commit was refused MARK_ALREADY_STANDS on `/changedPaths`
  it('drops the paths a box read at the claimed commit, and records those read at its own', async () => {
    await world_();
    const paths = (commit: string, path: string) => ({
      commit,
      changes: [{ path, change: 'changed' }],
    });
    messages.set(RELEASE, 'chore(release): v0.32.0');
    const id = await issue(50, 'in_progress');
    const first = await api(box, 'POST', `/api/issues/${id}/merge`, {
      commit: RELEASE,
      target: BRANCH,
      changedPaths: paths(RELEASE, 'CHANGELOG.md'),
    });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    await seedIssueStatus(id, 'closed');
    const own = 'a6370a82'.repeat(5);
    messages.set(own, "merge: ISS-50 — Approvals 'Mọi ngày' trigger as field hover [beta 652]");

    const res = await api(box, 'POST', `/api/issues/${id}/merge`, {
      commit: own,
      target: BRANCH,
      changedPaths: paths(own, 'src/approvals.tsx'),
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mark).toBe('observed');
    expect(String(res.body.detail)).toContain(`the paths a box read at ${RELEASE} were dropped`);
    const [row] = await rows<{ sha: string; paths: { commit: string } }>(sql`
      SELECT merged_commit_sha AS sha, merged_paths AS paths FROM issues WHERE id = ${id}`);
    expect(row?.sha).toBe(own);
    expect(row?.paths.commit).toBe(own);
  });

  it('observes a commit whose subject names several keys as each named issue’s own (e45996c9)', async () => {
    await world_();
    const merge = 'e45996c9'.repeat(5);
    messages.set(
      merge,
      'merge: ISS-46/47/48 — dashboard nav labels, turnover chart fix, department rollup (FB-34/35/36)',
    );
    const { id: iss48 } = await assertedAndClosed(48);
    const iss46 = await issue(46, 'in_progress');

    for (const id of [iss46, iss48]) {
      const res = await mark(box, id, merge);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.mark).toBe('observed');
      expect((await issueRow(id))?.merged_commit_sha).toBe(merge);
    }
  });

  it('changes nothing where the later mark is itself only asserted', async () => {
    await world_();
    const { id } = await assertedAndClosed(45);
    messages.set(OWN, 'fix(ui): ISS-44 — another issue’s fix');

    const res = await mark(box, id, OWN);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.action).toBe('already_merged');
    expect((await issueRow(id))?.merged_commit_sha).toBeNull();
  });

  it('never writes over an observed mark: a later observed commit is refused MARK_ALREADY_STANDS', async () => {
    await world_();
    const id = await issue(32, 'in_progress');
    messages.set(OWN, 'test(ui): ISS-32 — guard that a tab bar shows only with >=2 visible tabs');
    expect((await mark(box, id, OWN)).status).toBe(200);
    await seedIssueStatus(id, 'closed');
    const later = '2f09f094'.repeat(5);
    messages.set(later, 'fix(ui): ISS-32 — a later fix');

    const res = await mark(box, id, later);

    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(JSON.stringify(res.body)).toContain('MARK_ALREADY_STANDS');
    expect((await issueRow(id))?.merged_commit_sha).toBe(OWN);
    expect((await mark(box, id, OWN)).status).toBe(200);
  });
});
