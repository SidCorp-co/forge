import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token is sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

import { api } from '../helpers/api.js';
import { settleOutbox } from '../helpers/ecosystem-world.js';
import { rows } from '../helpers/factories.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/master-post.ts
// @direct-test-of packages/core/src/support/rooms.ts
// @direct-test-of packages/core/src/integrations/rocketchat/support-binding.ts
// @direct-test-of packages/contracts/src/support-operations.ts
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
    expect(refusal?.detail).toContain(`operations.threads["${chat.rid}"]["${slug}"]`);
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
});
