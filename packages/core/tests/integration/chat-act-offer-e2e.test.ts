/**
 * Asked in chat to run, continue, close or release an issue, the assistant offers a button instead
 * of a redirect (chat mining 2026-10-07: 30 asks, 38 replies saying chat cannot). The offer is made
 * only for a move the issue's status allows and the asker holds, and pressing it is the issue page's
 * own route under the asker's own token, which checks both again. The asks are the production ones,
 * anonymised.
 */

import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';

const { db } = await import('../../src/db/client.js');
const { buildOfferActToolset } = await import('../../src/assistant/tools/offer-act-tool.js');
const { api, userToken } = await import('../helpers/api.js');
const { addProjectMember, createTestIssue, createTestProject, createTestUser } = await import(
  '../helpers/factories.js'
);

let projectId = '';
let owner = '';
let ownerToken = '';
let viewer = '';
let viewerToken = '';
const ids: Record<string, string> = {};

type Said = { offer?: Record<string, unknown>; refused?: string };

async function offer(userId: string, args: Record<string, unknown>): Promise<Said> {
  const tools = buildOfferActToolset({ projectId, userId });
  const result = await tools.execute('offer_act', JSON.stringify(args));
  const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  if (result.isError) return { refused: (JSON.parse(text) as { error: string }).error };
  return { offer: (JSON.parse(text) as { offer: Record<string, unknown> }).offer };
}

beforeAll(async () => {
  owner = (await createTestUser({ verified: true })).id;
  ownerToken = await userToken(owner);
  projectId = (await createTestProject(owner)).id;
  viewer = (await createTestUser({ verified: true })).id;
  await addProjectMember(projectId, viewer, 'viewer');
  viewerToken = await userToken(viewer);
  const at = new Date();
  for (const [seq, status] of [
    [378, 'draft'],
    [379, 'open'],
    [744, 'open'],
    [748, 'needs_info'],
    [750, 'awaiting_release'],
    [751, 'closed'],
  ] as const) {
    ids[seq] = (
      await createTestIssue(projectId, owner, seq, {
        status,
        createdAt: at,
        ...(status === 'needs_info' ? { waitingKind: 'needs_answer' } : {}),
        ...(status === 'closed' ? { mergedAt: at } : {}),
      })
    ).id;
  }
  await db.execute(
    sql`INSERT INTO issue_work_state (issue_id, left_status) VALUES (${ids[748]}, 'open')`,
  );
});

describe('an act asked for in chat is offered as a button the asker may press', () => {
  it('"cho chạy ISS-378" on a draft offers to admit it into the pipeline', async () => {
    const said = await offer(owner, { act: 'run', issue: 'ISS-378' });
    expect(said.offer).toMatchObject({
      act: 'run',
      effect: 'admit',
      from: 'draft',
      to: 'open',
      key: 'ISS-378',
    });
  });

  it('run on an open issue offers its next pipeline step', async () => {
    expect((await offer(owner, { act: 'run', issue: 'ISS-379' })).offer).toMatchObject({
      effect: 'run-step',
      from: 'open',
    });
  });

  it('"continue ISS-748" at needs_info offers to resume where the park left off', async () => {
    expect((await offer(owner, { act: 'continue', issue: 'ISS-748' })).offer).toMatchObject({
      effect: 'transition',
      from: 'needs_info',
      to: 'open',
    });
  });

  it('"đóng ISS-744 do không cần nữa" offers a drop carrying their reason, and none without one', async () => {
    const said = await offer(owner, {
      act: 'drop',
      issue: 'ISS-744',
      reason: 'hiện tại không cần nữa',
    });
    expect(said.offer).toMatchObject({
      effect: 'transition',
      to: 'dropped',
      reason: 'hiện tại không cần nữa',
    });
    expect((await offer(owner, { act: 'drop', issue: 'ISS-744' })).refused).toMatch(
      /^CHAT_ACT_REASON_REQUIRED: /,
    );
  });

  it('"publish và close" offers a release only for an issue awaiting release, naming where the other stands', async () => {
    expect((await offer(owner, { act: 'release', issue: 'ISS-750' })).offer).toMatchObject({
      effect: 'release',
      from: 'awaiting_release',
    });
    const refused = (await offer(owner, { act: 'release', issue: 'ISS-744' })).refused;
    expect(refused).toMatch(/^CHAT_ACT_NOT_FROM_STATUS: ISS-744 is at open/);
    expect((await offer(owner, { act: 'drop', issue: 'ISS-751', reason: 'x' })).refused).toMatch(
      /^CHAT_ACT_NOT_FROM_STATUS: ISS-751 is at closed/,
    );
  });

  it('offers nothing to a person who could not press it, an unknown issue, or a malformed call', async () => {
    expect((await offer(viewer, { act: 'run', issue: 'ISS-379' })).refused).toMatch(
      /^CHAT_ACT_FORBIDDEN: the person asking does not hold project\.write/,
    );
    expect((await offer(owner, { act: 'run', issue: 'ISS-99999' })).refused).toMatch(
      /^CHAT_ACT_ISSUE_UNKNOWN: /,
    );
    expect((await offer(owner, { act: 'close', issue: 'ISS-379' })).refused).toMatch(
      /^CHAT_ACT_INVALID: act: /,
    );
  });

  it('pressing the drop is the issue route under the presser’s own token, which refuses a viewer', async () => {
    const said = await offer(owner, { act: 'drop', issue: 'ISS-744', reason: 'không cần nữa' });
    const issueId = String(said.offer?.issueId);
    const byViewer = await api(viewerToken, 'POST', `/api/issues/${issueId}/transition`, {
      toStatus: 'dropped',
      reason: 'không cần nữa',
    });
    expect(byViewer.status).toBe(403);
    const byOwner = await api(ownerToken, 'POST', `/api/issues/${issueId}/transition`, {
      toStatus: 'dropped',
      reason: 'không cần nữa',
    });
    expect(byOwner.status).toBe(200);
    expect((await offer(owner, { act: 'drop', issue: 'ISS-744', reason: 'x' })).refused).toMatch(
      /ISS-744 is at dropped/,
    );
  });
});
