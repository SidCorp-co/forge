import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { db } from '../../src/db/client.js';
import { addProjectMember, createTestIssue, createTestUser, rows } from '../helpers/factories.js';
import { AgentWorld } from '../helpers/support-agent-world.js';
import { code } from '../helpers/support-channel.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';

// @direct-test-of packages/core/src/support/release-decision.ts
// @direct-test-of packages/core/src/support/acts.ts
// @direct-test-of packages/core/src/support/routes.ts
//
// ISS-1206 (adminhub-api 0.19.0, 2026-11-10): the owner approved a release in his own room, in his
// own words, and nothing recorded it: a room had no door for a person's release decision, so the
// release waited for him to click it again on the web. The room now records it as him, cited back
// to his message: his own message in that thread, he a Forge person holding releases.approve on the
// release's project, and an approval pending on that release. Anything else is refused by name and
// nothing is decided.

const w = new AgentWorld();
let chat: StandInRocketChat;
let slug = '';
let chuong = '';
let viewer = '';
let runId = '';
let approvalId = '';

/** A release run cut as `version` on the agent's project, carrying one landed issue, its approval asked. */
async function cutAndAsk(version: string): Promise<{ runId: string; approvalId: string }> {
  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO pipeline_runs (id, project_id, kind, status, started_at, release_version, metadata)
    VALUES (${id}, ${w.projectId}, 'system', 'running', now(), ${version},
            ${JSON.stringify({ source: 'release-batch', issueIds: [] })}::jsonb)`);
  const at = new Date();
  const issue = await createTestIssue(
    w.projectId,
    w.ownerId,
    9000 + Number(version.split('.')[1]),
    {
      status: 'awaiting_release',
      createdAt: at,
      mergedAt: at,
    },
  );
  await db.execute(sql`
    UPDATE issues SET release_batch_run_id = ${id} WHERE id = ${issue.id}`);
  await db.execute(sql`
    UPDATE pipeline_runs SET metadata = ${JSON.stringify({ source: 'release-batch', issueIds: [issue.id] })}::jsonb
     WHERE id = ${id}`);
  const [asked] = await rows<{ id: string }>(sql`
    INSERT INTO release_approvals (project_id, run_id, requested_by_user, evidence_commit, evidence_reading)
    VALUES (${w.projectId}, ${id}, ${w.ownerId}, ${'c'.repeat(40)}, 'served on staging')
    RETURNING id`);
  return { runId: id, approvalId: String(asked?.id) };
}

const approval = async (id: string) =>
  (
    await rows<{ decision: string | null; decided_by_user: string | null; reason: string | null }>(
      sql`SELECT decision, decided_by_user, reason FROM release_approvals WHERE id = ${id}`,
    )
  )[0];

/** `who` writes `text`; the session cites `cite(message)` as that release's decision. */
async function decideBy(
  who: typeof chat.alice,
  text: string,
  args: Record<string, unknown>,
  cite: (heard: { thread: string; message: string }) => { thread: string; message: string } = (h) =>
    h,
) {
  let out: Record<string, unknown> = {};
  const heard = await w.hear(
    () => chat.say(who, text),
    async (_t, act, message) => {
      out = await act({
        action: 'release_decision',
        ...cite({ thread: message().thread, message: message().message }),
        project: slug,
        decision: 'approve',
        ...args,
      });
    },
  );
  return { id: heard.id, thread: heard.message.thread, out };
}

beforeAll(async () => {
  await w.openAgent();
  chat = w.stand;
  [{ slug }] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}`,
  );
  // alice, the room's owner, is chuong in Forge, who holds releases.approve (admin); bob is a viewer
  chuong = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, chuong, 'admin');
  viewer = (await createTestUser({ verified: true })).id;
  await addProjectMember(w.projectId, viewer, 'viewer');
  const namespace = new URL(chat.serverUrl).host;
  for (const [member, userId] of [
    [chat.alice, chuong],
    [chat.bob, viewer],
  ] as const) {
    await db.execute(sql`
      INSERT INTO assistant_speaker_links (source, external_namespace, external_id, external_label, user_id, confirmed_via)
      VALUES ('rocketchat', ${namespace}, ${member.userId}, ${member.username}, ${userId}, 'channel_email_match')`);
  }
  ({ runId, approvalId } = await cutAndAsk('0.19.0'));
}, 120_000);

afterAll(async () => {
  await w.stop();
});

describe("ISS-1206: a room records a person's release decision from his own message", () => {
  it("refuses a message that is not the member's own in the thread named, and decides nothing", async () => {
    const earlier = await decideBy(chat.alice, 'duyệt 0.19.0 nhé', { version: '0.19.0' }, (h) => ({
      thread: `${h.thread}-elsewhere`,
      message: h.message,
    }));
    expect(code(earlier.out), JSON.stringify(earlier.out)).toBe(
      'SUPPORT_RELEASE_DECISION_NOT_HIS_MESSAGE',
    );
    expect(await approval(approvalId)).toMatchObject({ decision: null });
  });

  it('refuses a member who holds no releases.approve on the project, naming the permission', async () => {
    const bobs = await decideBy(chat.bob, 'release 0.19.0 đi', { version: '0.19.0' });
    expect(code(bobs.out), JSON.stringify(bobs.out)).toBe('SUPPORT_RELEASE_DECISION_NOT_PERMITTED');
    expect(JSON.stringify(bobs.out)).toContain('releases.approve');
    expect(await approval(approvalId)).toMatchObject({ decision: null });
  });

  it('refuses a version that names no one release, and one nobody cut, by name', async () => {
    const partial = await decideBy(chat.alice, 'duyệt bản 0.19 đi', { version: '0.19' });
    expect(code(partial.out), JSON.stringify(partial.out)).toBe(
      'SUPPORT_RELEASE_VERSION_AMBIGUOUS',
    );
    const unknown = await decideBy(chat.alice, 'duyệt 4.0.0', { version: '4.0.0' });
    expect(code(unknown.out), JSON.stringify(unknown.out)).toBe('RELEASE_VERSION_UNKNOWN');
    expect(await approval(approvalId)).toMatchObject({ decision: null });
  });

  it("records the owner's plain approval as him, quoting his message with its id and thread", async () => {
    const his = await decideBy(chat.alice, 'Duyệt 0.19.0, lên đi', { version: '0.19.0' });
    expect(code(his.out), JSON.stringify(his.out)).toBeUndefined();
    expect(his.out).toMatchObject({ decision: 'approve', version: '0.19.0', project: slug });
    const stored = await approval(approvalId);
    expect(stored).toMatchObject({ decision: 'approved', decided_by_user: chuong });
    expect(stored?.reason).toContain(his.id);
    expect(stored?.reason).toContain(his.thread);
    expect(stored?.reason).toContain('Duyệt 0.19.0, lên đi');
    // the act is on the room's record beside his message
    const [act] = await rows<{ kind: string; tool: string }>(sql`
      SELECT kind, tool FROM support_actions
       WHERE project_id = ${w.projectId} AND tool = 'release_decision' AND kind = 'operation'`);
    expect(act).toEqual({ kind: 'operation', tool: 'release_decision' });
    expect(runId).not.toBe('');
  });

  it('refuses a release with no approval pending, and keeps the decision that stands', async () => {
    const again = await decideBy(chat.alice, 'duyệt lại 0.19.0', { version: '0.19.0' });
    expect(code(again.out), JSON.stringify(again.out)).toBe('RELEASE_APPROVAL_NOT_PENDING');
    expect(await approval(approvalId)).toMatchObject({
      decision: 'approved',
      decided_by_user: chuong,
    });
  });
});
