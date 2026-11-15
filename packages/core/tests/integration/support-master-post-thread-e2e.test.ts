import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { addProjectMember, createTestProject, rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/support/rooms.ts
// @direct-test-of packages/core/src/integrations/rocketchat/support-binding.ts
// @direct-test-of packages/contracts/src/support-operations.ts
// @direct-test-of packages/core/src/support/thread.ts
// @direct-test-of packages/core/src/integrations/rocketchat/binding.ts
// @direct-test-of packages/core/src/schedules/daily-review-dispatch.ts
//
// ISS-934: Forge-Communicate is an operations room every project of the organization shares, one
// thread per project. A master's post there lands in its project's own thread, as the room's binding
// records it in `operations.threads`; with none recorded it is refused by name, saying where to record
// one, and never posted at the room's top level. Recording the thread through the binding door, as
// the refusal says, clears it.

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const BABO = {
  name: 'babo',
  persona:
    'You are Babo. You coordinate Forge and delivery for the team: projects, issues, runners and releases.',
  grants: ['read'],
};
const THREAD = 'XQHEiGjSv8HTytmpY';
const REVIEW = 'Hôm nay: 3 việc lên dev, 1 lỗi triển khai đã sửa; mai làm tiếp phần thông báo.';

const w = new SupportWorld();
let chat: StandInRocketChat;
let slug = '';
let bindingPath = '';

const post = (body: unknown) =>
  api(w.owner, 'POST', `/api/projects/${w.projectId}/support/master-posts`, body);
const refusalOf = (res: { body: unknown }) =>
  (res.body as { error?: { refusals?: { code: string; detail: string }[] } }).error?.refusals?.[0];

/** The binding's target with `operations` replaced, written through the binding door. */
async function writeOperations(operations: Record<string, unknown>) {
  const got = await api(w.owner, 'GET', bindingPath);
  expect(got.status, JSON.stringify(got.body)).toBe(200);
  const document = got.body.document as { target: Record<string, unknown> };
  return api(w.owner, 'PUT', bindingPath, {
    baseRevision: got.body.revision,
    document: { ...document, target: { ...document.target, operations } },
  });
}

beforeAll(async () => {
  await w.start();
  chat = w.chat as StandInRocketChat;
  [{ slug } = { slug: '' }] = await rows<{ slug: string }>(
    sql`SELECT slug FROM projects WHERE id = ${w.projectId}::uuid`,
  );
  const rc = await api(w.owner, 'POST', '/api/integration-connections', {
    provider: 'rocketchat',
    displayName: 'Babo',
    config: { serverUrl: chat.serverUrl, role: BABO },
    secrets: { authToken: chat.bot.authToken, userId: chat.bot.userId },
    bindings: [
      {
        projectId: w.projectId,
        role: 'service',
        target: { provider: 'rocketchat', rids: [chat.rid], operations: { scope: 'forge' } },
      },
    ],
  });
  expect(rc.status, JSON.stringify(rc.body)).toBe(201);
  w.rcConnectionId = String((rc.body.connection as { id: string }).id);
  const [b] = await rows<{ id: string }>(
    sql`SELECT id FROM integration_bindings WHERE connection_id = ${w.rcConnectionId}::uuid`,
  );
  bindingPath = `/api/projects/${w.projectId}/bindings/${String(b?.id)}`;
  await settleOutbox();
}, 120_000);

afterAll(() => w.stop());

describe("a master's post in the shared operations room (ISS-934)", () => {
  it('refuses by name where no thread is recorded for the project, saying where, and posts nothing', async () => {
    const res = await post({ text: REVIEW, rid: chat.rid });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const refusal = refusalOf(res);
    expect(refusal?.code).toBe('SUPPORT_PROJECT_THREAD_UNRECORDED');
    expect(refusal?.detail).toContain(
      `document.target.operations.threads["${chat.rid}"]["${slug}"]`,
    );
    expect(refusal?.detail).toContain(bindingPath);
    // with no rid, the project's one team room is the shared room, refused the same
    expect(refusalOf(await post({ text: REVIEW }))?.code).toBe('SUPPORT_PROJECT_THREAD_UNRECORDED');
    expect(chat.linesIn(chat.rid), 'nothing at the top level, nothing anywhere').toEqual([]);
  });

  it('refuses a thread recorded for a room the binding does not name', async () => {
    const res = await writeOperations({
      scope: 'forge',
      threads: { 'not-this-bindings-room': { [slug]: THREAD } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(JSON.stringify(res.body)).toContain('/target/operations/threads/not-this-bindings-room');
  });

  it('posts in the project’s own thread once the binding records it, never at the top level', async () => {
    // the remedy the refusal names, performed through the binding door
    const put = await writeOperations({
      scope: 'forge',
      threads: { [chat.rid]: { [slug]: THREAD } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const res = await post({ text: REVIEW, rid: chat.rid });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ rid: chat.rid, thread: THREAD });
    const lines = chat.linesIn(chat.rid);
    expect(lines.map((l) => [l.tmid, l.text])).toEqual([[THREAD, REVIEW]]);
    const [act] = await rows<{ kind: string; thread: string; by: string }>(sql`
      SELECT kind, thread, input->>'by' AS by FROM support_actions
       WHERE project_id = ${w.projectId}::uuid AND tool = 'master_post'`);
    expect(act).toEqual({ kind: 'announced', thread: THREAD, by: w.ownerId });
  });

  it('takes the recorded thread named as `thread`, though no member wrote there', async () => {
    const before = chat.linesIn(chat.rid).length;
    const res = await post({ text: REVIEW, thread: THREAD });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ rid: chat.rid, thread: THREAD });
    const after = chat.linesIn(chat.rid);
    expect(after.length).toBe(before + 1);
    expect(after.every((l) => l.tmid === THREAD)).toBe(true);
    // another thread nobody wrote in is still no asker's
    const other = await post({ text: REVIEW, thread: 'someOtherThread1' });
    expect(refusalOf(other)?.code).toBe('SUPPORT_THREAD_UNKNOWN');
  });

  // debts 416b6177 and 7fac533a (2026-11-13): a post into the project's own thread is screened as the
  // top level is, since the whole room reads it, but its refusal said "a post at the top level", so the
  // caller read the thread it named as ignored. The reason names the thread it was going to.
  it('refuses an issue key in the recorded thread, naming that thread, never the top level', async () => {
    const before = chat.linesIn(chat.rid).length;
    const keyed = await post({ text: `${REVIEW} ISS-123 xong rồi.`, thread: THREAD });
    expect(refusalOf(keyed)?.code, JSON.stringify(keyed.body)).toBe('SUPPORT_INTERNAL_CODE');
    expect(refusalOf(keyed)?.detail).toContain(
      `thread ${THREAD} of ${chat.rid} is read by everyone`,
    );
    expect(refusalOf(keyed)?.detail).not.toContain('top level of');
    expect(chat.linesIn(chat.rid).length).toBe(before);
  });
});

// ISS-1242: Forge-Communicate is bound by forge alone, and a second binding naming its rid is refused
// SUPPORT_ROOM_ANSWERED_TWICE, so every other project of the organization posts there through forge's
// binding, in its own thread that binding records. On 2026-11-13 catalog-api's master was refused
// SUPPORT_ROOM_UNKNOWN, and with epod's thread recorded on forge's binding the door still refused it.
describe("a sibling project's master in the shared operations room (ISS-1242)", () => {
  const SIBLING_THREAD = '86aGqsokzYezYNdvF';
  let siblingId = '';
  let siblingSlug = '';
  const postAs = (body: unknown) =>
    api(w.owner, 'POST', `/api/projects/${siblingId}/support/master-posts`, body);

  beforeAll(async () => {
    const [home] = await rows<{ org_id: string }>(
      sql`SELECT org_id FROM projects WHERE id = ${w.projectId}::uuid`,
    );
    const sibling = await createTestProject(w.ownerId, { orgId: String(home?.org_id) });
    siblingId = sibling.id;
    await addProjectMember(siblingId, w.ownerId, 'owner');
    [{ slug: siblingSlug } = { slug: '' }] = await rows<{ slug: string }>(
      sql`SELECT slug FROM projects WHERE id = ${siblingId}::uuid`,
    );
  });

  it('is refused by name while the room records no thread for it, naming the binding that would', async () => {
    const res = await postAs({ text: REVIEW, rid: chat.rid });
    const refusal = refusalOf(res);
    expect(refusal?.code, JSON.stringify(res.body)).toBe('SUPPORT_PROJECT_THREAD_UNRECORDED');
    expect(refusal?.detail).toContain(
      `document.target.operations.threads["${chat.rid}"]["${siblingSlug}"]`,
    );
    expect(refusal?.detail).toContain(bindingPath);
  });

  it('posts in its own thread the room’s binding records, recorded for it, and the daily review finds it', async () => {
    const put = await writeOperations({
      scope: 'forge',
      threads: { [chat.rid]: { [slug]: THREAD, [siblingSlug]: SIBLING_THREAD } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const before = chat.linesIn(chat.rid).length;
    const res = await postAs({ text: REVIEW, rid: chat.rid });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ rid: chat.rid, thread: SIBLING_THREAD });
    const named = await postAs({ text: REVIEW, rid: chat.rid, thread: SIBLING_THREAD });
    expect(named.status, JSON.stringify(named.body)).toBe(201);
    const lines = chat.linesIn(chat.rid).slice(before);
    expect(lines.map((l) => l.tmid)).toEqual([SIBLING_THREAD, SIBLING_THREAD]);
    const acts = await rows<{ thread: string; for: string | null }>(sql`
      SELECT thread, input->>'for' AS for FROM support_actions
       WHERE tool = 'master_post' AND input->>'for' = ${siblingId}`);
    expect(acts).toEqual([
      { thread: SIBLING_THREAD, for: siblingId },
      { thread: SIBLING_THREAD, for: siblingId },
    ]);
    // the thread the daily review hands the sibling's master is read from the room's binding
    const { projectThreadsOf } = await import('../../src/integrations/rocketchat/index.js');
    expect(await projectThreadsOf(siblingId, siblingSlug)).toEqual([]);
    expect(await projectThreadsOf(siblingId, siblingSlug, [w.projectId])).toEqual([
      expect.objectContaining({ rid: chat.rid, thread: SIBLING_THREAD }),
    ]);
  });

  it("is refused another project's thread there, naming its own, and posts nothing", async () => {
    const before = chat.linesIn(chat.rid).length;
    const res = await postAs({ text: REVIEW, rid: chat.rid, thread: THREAD });
    const refusal = refusalOf(res);
    expect(refusal?.code, JSON.stringify(res.body)).toBe('SUPPORT_THREAD_UNKNOWN');
    expect(refusal?.detail).toContain(`this project's own there is ${SIBLING_THREAD}`);
    expect(chat.linesIn(chat.rid).length).toBe(before);
  });

  it('is refused a project-scope operations room, which stays its home project’s', async () => {
    const put = await writeOperations({
      scope: 'project',
      threads: { [chat.rid]: { [slug]: THREAD, [siblingSlug]: SIBLING_THREAD } },
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    // the binding's change declares its rooms again, the room's scope with them
    await settleOutbox();
    const res = await postAs({ text: REVIEW, rid: chat.rid });
    expect(refusalOf(res)?.code, JSON.stringify(res.body)).toBe('SUPPORT_ROOM_UNKNOWN');
    const { projectThreadsOf } = await import('../../src/integrations/rocketchat/index.js');
    expect(await projectThreadsOf(siblingId, siblingSlug, [w.projectId])).toEqual([]);
  });
});
