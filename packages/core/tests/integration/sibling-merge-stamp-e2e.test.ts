/**
 * A request the host marks merged because its commits landed through another one stamps nothing
 * that is not its commit (adminhub-fe !1979 and !1982, 2026-10-26): every stamp a change request's
 * merge would write passes `issues/merge-identity.ts`, and each refusal is written on the issue.
 */

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '../helpers/api.js';
import { closeWorld, settleOutbox, startQueue, testEnv } from '../helpers/ecosystem-world.js';
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
import { alreadyMerged, merged, mergeMessage, messages } from '../helpers/planted-gitlab-merges.js';

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
    // a key the stale request still delivers in a delivery form, which ISS-705's rule keeps
    await mergeRequest(1979, 'iss-37-login', HEAD_SHARED, 'Delivers ISS-11.');
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
